/**
 * Interactive fleet-wide session browser — the human front-end of `agents sessions`.
 *
 * One canonical filter state (device / agent / project / window / running / teams),
 * driven by single-key hotkeys, re-pulling live over the same fleet fan-out the flag
 * surface uses. The identical state is expressible as flags (the agent front-end);
 * `y` / `--print-cmd` round-trips a hand-built view into a copy-pasteable command.
 *
 * Built on {@link dynamicPicker}; every data source (discover, fleet, live index,
 * preview, resume dispatch) is reused from the existing sessions plumbing.
 */

import path from 'path';
import { spawnSync } from 'child_process';
import chalk from 'chalk';
import { dynamicPicker } from '../lib/picker.js';
import { isSessionTrackedAgent, type SessionMeta } from '@phnx-labs/sessions-cli/reader';
import type { ActiveSession } from '../lib/session/active.js';
import { discoverSessions } from '../lib/session/discover.js';
import { gatherRemoteList } from '../lib/session/remote-list.js';
import { resolveVersionAliasLoose } from '../lib/installations/versions.js';
import { AGENTS } from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import { enrichTeamOrigins, safeTeamText, shouldShowTeamSessions } from '@phnx-labs/sessions-cli/reader';
import { listBookmarks, toggleBookmark } from '../lib/session/bookmarks.js';
import { machineId, normalizeHost } from '../lib/session/sync/config.js';
import { buildPreview, setRemotePreviewRepaint } from './sessions-picker.js';
import {
  formatPickerLabel,
  pickerColumnsFor,
  type SshOriginTag,
  ticketLabel,
  mergeLocalFirst,
  gatherActiveSessions,
  liveHostLabel,
  LIVE_ROW_PREFIX,
  cleanPreview,
  handlePickedSession,
  shouldIncludeLocal,
  remoteHostsToDial,
  matchesTeam,
  formatLiveStatusHeadline,
  isRunningLiveSession,
  matchesLiveStatus,
  parseAgentFilter,
  resolveRoutineName,
  type LiveStatusFilter,
  type PickerColumns,
} from './sessions.js';

/**
 * The single canonical filter state. Every field has a flag equivalent, so the
 * same view is reachable interactively (hotkeys) or from the command line (flags).
 */
export interface BrowserFilter {
  /** running-only — the `R` key / `--active`. */
  running: boolean;
  /** include team-spawned sessions — the `C` key / `--teams`. */
  teams: boolean;
  /** filter to one agent, or all — the `A` key / `-a`. */
  agent?: string;
  /** filter to one machine, or all — the `D` key / `--device`. */
  device?: string;
  /** filter to one team's lineage, or all — the `T` key / `--in-team`. */
  team?: string;
  /** bookmarked-only — the `b` key / `--bookmarks`. */
  bookmarks: boolean;
  /** this-repo subtree vs every directory — the `P` key / `--all`. */
  projectScope: 'repo' | 'all';
  /** time window (undefined = all time) — the `W` key / `--since`. */
  window?: string;
  /** individual live states; an OR-union and, like the CLI flags, running-only. */
  statuses: LiveStatusFilter[];
  /** named project scope, independent of the repo/all hotkey. */
  project?: string;
  /** upper time bound from --until. */
  until?: string;
  /** retain only routine-origin sessions, optionally narrowed to one routine. */
  routine: boolean | string;
  /** indexed resource filters shared by the flag and focus surfaces. */
  skill?: string;
  plugin?: string;
  /** discovery cap. */
  limit: number;
  /** include unmanaged native-home transcripts. */
  unmanaged: boolean;
  /** candidate order shared with --sort. */
  sort: 'timestamp' | 'cost' | 'duration';
}

/**
 * Complete a seed into the filter the picker actually runs on.
 *
 * Every optional field of {@link BrowserFilter} has to be named here, because the
 * seed is copied field-by-field and an omission is silent: the field is optional,
 * so the compiler says nothing and the browser just opens without that filter.
 * `team` was dropped exactly this way, which made `--in-team` a no-op on the
 * interactive path while the scope half of the same seed still applied — so the
 * view opened wide and all-time and looked like the flag had worked.
 *
 * Exported so a test can assert the FILTER, not just the seed; testing the seed
 * alone cannot see this class of bug.
 */
export function buildInitialFilter(initial: Partial<BrowserFilter>): BrowserFilter {
  return {
    running: initial.running ?? false,
    teams: initial.teams ?? false,
    bookmarks: initial.bookmarks ?? false,
    agent: initial.agent,
    device: initial.device,
    team: initial.team,
    projectScope: initial.projectScope ?? 'repo',
    window: 'window' in initial ? initial.window : '30d',
    statuses: initial.statuses ?? [],
    project: initial.project,
    until: initial.until,
    routine: initial.routine ?? false,
    skill: initial.skill,
    plugin: initial.plugin,
    limit: initial.limit ?? 500,
    unmanaged: initial.unmanaged ?? false,
    sort: initial.sort ?? 'timestamp',
  };
}

/** Cache key for the transcript pool: every filter that changes what is FETCHED
 *  (window, team-origin inclusion, and the team filter's deeper limit) — not the
 *  ones applied in memory afterwards. */
function poolCacheKey(f: BrowserFilter): string {
  // The team filter contributes only whether it is SET, not which team: any team
  // fetches the same deep pool and is then narrowed in memory. Keying on the name
  // would make `t` the one hotkey that re-fans-out the fleet on every step of the
  // cycle, at up to REMOTE_TIMEOUT_MS per unreachable peer.
  const versionScoped = f.agent?.includes('@') ? f.agent : '';
  return [
    f.window ?? 'all', f.until ?? '', f.teams, f.team ? 'team' : '', versionScoped,
    f.project ?? '', f.routine, f.skill ?? '', f.plugin ?? '', f.limit, f.unmanaged, f.sort,
  ].join('|');
}

/** Pool size when a team filter is active; one team's rows can sit anywhere. */
const WHOLE_TEAM_POOL_LIMIT = 5000;
/** A cold peer may need to resolve an installed-version alias and scan its index. */
const BROWSER_PEER_TIMEOUT_MS = 30_000;

/** Ordered window cycle for the `W` key. `undefined` = all time. */
const WINDOW_CYCLE: (string | undefined)[] = [undefined, '1d', '7d', '30d'];

/** Return the next value in `[undefined, ...options]`, wrapping. */
export function cycle(current: string | undefined, options: string[]): string | undefined {
  const ring = [undefined, ...options];
  const idx = ring.findIndex((v) => v === current);
  return ring[(idx + 1) % ring.length];
}

export function cycleWindow(current: string | undefined): string | undefined {
  const idx = WINDOW_CYCLE.findIndex((v) => v === current);
  return WINDOW_CYCLE[(idx + 1) % WINDOW_CYCLE.length];
}

function distinct(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v))].sort();
}

/**
 * Cheap client-side match for the `S` search — a plain substring test over a
 * row's visible fields. Deliberately NOT the FTS `filterSessionsByQuery`: that
 * runs a content-index scan per call, which is fine once over a pool but a
 * CPU sink when a picker calls it per-row on every keystroke.
 */
export function sessionMatchesQuery(s: SessionMeta, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = [
    s.shortId,
    s.agent,
    s.project,
    s.cwd,
    s.topic,
    (s as { label?: string }).label,
    ticketLabel(s),
    s.machine,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return terms.every((t) => hay.includes(t));
}

/**
 * The canonical `ag sessions …` command for a filter state (+ optional search) —
 * the agent-facing twin of the interactive view. Shared by the `y` hotkey and
 * `--print-cmd`.
 */
export function browserFilterToArgv(f: BrowserFilter, query = ''): string[] {
  const a = ['sessions'];
  if (f.statuses.length === 0 && f.running) a.push('--active');
  for (const status of f.statuses) a.push(`--${status === 'orphaned' ? 'orphan' : status}`);
  if (f.teams) a.push('--teams');
  if (f.bookmarks) a.push('--bookmarks');
  if (f.agent) a.push('-a', f.agent);
  if (f.device) a.push('--device', f.device);
  if (f.team) a.push('--in-team', f.team);
  if (f.projectScope === 'all') a.push('--all');
  if (f.window) a.push('--since', f.window);
  if (f.until) a.push('--until', f.until);
  if (f.project) a.push('--project', f.project);
  if (f.routine) {
    a.push('--routine');
    if (typeof f.routine === 'string') a.push(f.routine);
  }
  if (f.skill) a.push('--skill', f.skill);
  if (f.plugin) a.push('--plugin', f.plugin);
  if (f.unmanaged) a.push('--unmanaged');
  if (f.sort !== 'timestamp') a.push('--sort', f.sort === 'cost' ? 'cost' : 'duration');
  if (f.limit !== 500) a.push('--limit', String(f.limit));
  const q = query.trim();
  if (q) a.push(JSON.stringify(q));
  return a;
}

/** Normalize a `--device`/`--device` token (`alias`, `user@host`, `host.domain`) to
 * the canonical machine id the rows carry in `.machine`, so a flag seed matches
 * (the `d` hotkey already cycles canonical ids). Mirrors sessions.ts `hostToken`. */
export function normalizeDeviceSeed(host: string | undefined): string | undefined {
  if (!host) return undefined;
  return normalizeHost(host.split('@').pop() || host);
}

/**
 * The initial filter for the `--active` browser: fleet-wide (matches the static
 * `renderActiveSessions`, which has no project scoping — the `p` hotkey narrows to
 * this repo), running-only, with the device seed normalized and `--since` seeding
 * the window. Pure, so the routing call site is unit-testable.
 */
export function activeBrowserSeed(opts: {
  teams?: boolean;
  agent?: string;
  host?: string[];
  since?: string;
  all?: boolean;
  bookmarks?: boolean;
  routine?: boolean | string;
}): Partial<BrowserFilter> {
  return {
    running: true,
    teams: !!opts.teams,
    bookmarks: !!opts.bookmarks,
    routine: opts.routine ?? false,
    agent: opts.agent,
    projectScope: 'all',
    device: normalizeDeviceSeed(opts.host?.[0]),
    // --all widens the window to all-time (project is already 'all' here);
    // --since still overrides.
    window: opts.since ?? (opts.all ? undefined : '30d'),
    statuses: [],
  };
}

/**
 * The initial filter for the bare interactive listing: current-repo subtree by
 * default (matches the static overview's cwd scoping). `--all` sets every
 * non-status filter to its "all" value — every directory (project) AND all-time
 * (window) — so one flag maxes the view; `--since` still overrides the window and
 * `-a`/`--device` still narrow their axis.
 */
export function bareBrowserSeed(opts: {
  teams?: boolean;
  agent?: string;
  all?: boolean;
  since?: string;
  host?: string[];
  inTeam?: string;
  bookmarks?: boolean;
  routine?: boolean | string;
}): Partial<BrowserFilter> {
  // An explicit --device scopes the pool to a peer, whose cwds live under that
  // machine's home — none of them can be under OUR process.cwd(), so the default
  // 'repo' scope would filter every fetched row away and render an empty list.
  // A host scope therefore implies all-directories, exactly as --all does.
  const scoped = (opts.host?.length ?? 0) > 0;
  // --in-team asks for ONE team's lineage, and a team's teammates run in their own
  // `.agents/worktrees/<slug>/` — a different cwd from ours — while the team itself
  // may be older than the default window. Both defaults would hide exactly the rows
  // the flag exists to surface, so it widens the scope the way --all does. The flag
  // path does this too (sessions.ts `wantsWholeTeam`); the browser is the one a
  // human actually reaches, so it must not be the one that stays narrow.
  const wholeTeam = !!opts.inTeam;
  return {
    teams: !!opts.teams,
    bookmarks: !!opts.bookmarks,
    routine: opts.routine ?? false,
    agent: opts.agent,
    // The filter carries one device; seed it only when the scope names exactly
    // one, so a two-device scope isn't narrowed to the first of them.
    device: opts.host?.length === 1 ? normalizeDeviceSeed(opts.host[0]) : undefined,
    team: opts.inTeam,
    // --all maxes every non-status filter: all dirs AND all-time. --since wins.
    projectScope: opts.all || scoped || wholeTeam ? 'all' : 'repo',
    window: opts.since ?? (opts.all || wholeTeam ? undefined : '30d'),
    statuses: [],
  };
}

/** Copy text to the OS clipboard (best-effort; silently no-ops if unavailable). */
function copyToClipboard(text: string): boolean {
  const candidates =
    process.platform === 'darwin'
      ? [['pbcopy', [] as string[]]]
      : [
          ['wl-copy', []],
          ['xclip', ['-selection', 'clipboard']],
          ['xsel', ['--clipboard', '--input']],
        ];
  for (const [cmd, args] of candidates as [string, string[]][]) {
    try {
      const res = spawnSync(cmd, args, { input: text });
      if (res.status === 0) return true;
    } catch {
      // try the next candidate
    }
  }
  return false;
}

/** The transcript pool: the local index + (unless --local) a live fleet fan-out.
 * The live index is fetched separately/lazily — it's the slow part and only the
 * running filter needs it, so a bare browse stays instant.
 *
 * `hosts` is the explicit `--device`/`--device` scope (if any): it restricts which
 * peers are dialed and whether local is included, honoring the flag's "scope,
 * not add" contract instead of always sweeping the whole fleet. */
async function fetchRawPool(
  f: BrowserFilter,
  self: string,
  local: boolean,
  hosts: string[] | undefined,
  fixedFilters = false,
): Promise<{ key: string; rows: SessionMeta[]; unreachable: string[] }> {
  const since = f.window;
  const selectedAgent = f.agent ? parseAgentFilter(f.agent) : {};
  const parsedAgent = fixedFilters ? selectedAgent : {};
  const localAgentVersion = parsedAgent.agent && parsedAgent.agent in AGENTS
    ? resolveVersionAliasLoose(parsedAgent.agent as AgentId, parsedAgent.version)
    : parsedAgent.version;
  let unreachable: string[] = [];
  // Local pool: wide (every directory) — device/agent/project are applied in
  // memory so a hotkey toggle is instant and doesn't re-hit the disk. Skipped
  // when an explicit host scope excludes this machine.
  let rows: SessionMeta[] = shouldIncludeLocal(hosts, self)
    ? await discoverSessions({
        all: true,
        agent: parsedAgent.agent,
        version: localAgentVersion,
        includeUnmanaged: f.unmanaged,
        cwd: process.cwd(),
        since,
        until: f.until,
        project: f.project,
        origin: f.routine ? 'routine' : undefined,
        skill: f.skill,
        plugin: f.plugin,
        excludeTeamOrigin: !shouldShowTeamSessions(f),
        // A team filter reaches back past the usual browse window, so the pool it
        // draws from has to as well — otherwise the newest 500 rows decide which
        // teams exist.
        limit: f.team ? WHOLE_TEAM_POOL_LIMIT : f.limit,
        sortBy: f.sort,
      })
    : [];

  // A synced mirror knows which VERSION produced a session, but it cannot know
  // which version is currently installed as latest/oldest on the origin device.
  // For an alias selector, keep only this device's rows here and accept peer
  // rows only from the live query below, where that peer resolves its own
  // inventory. If the peer is unavailable, an empty/partial result is honest;
  // widening to cached sessions from every version is not.
  if (selectedAgent.version === 'latest' || selectedAgent.version === 'oldest') {
    rows = rows.filter((row) => (row.machine ?? self) === self);
  }

  // Fleet: fold in peers' own indexes over SSH (no sync), same as the flag path.
  // Skipped under --local. An explicit --host/--device scopes exactly which peers
  // are dialed (undefined = sweep every online device). Best-effort — a fan-out
  // failure leaves the local list intact.
  const remoteHosts = remoteHostsToDial(hosts, self);
  // An explicit scope naming only this machine leaves nothing remote to dial.
  // gatherRemoteList reads `[]` as "no hosts given" and falls through to the
  // whole-fleet sweep, so `--device <self>` would dial every online box — the
  // exact opposite of the flag's scope-not-add contract. Skip the fan-out here,
  // the same way gatherActiveSessions does for --active.
  const dialPeers = !local && (!hosts?.length || (remoteHosts && remoteHosts.length > 0));
  if (dialPeers) {
    try {
      // The peer's cap has to match the local one, or a team filter widens only
      // this machine's half of the pool and a peer's older rows stay invisible —
      // the same bug one hop out. A numeric --limit is forwarded rather than
      // --in-team itself, which a peer on an older build would reject as an
      // unknown option and fail the whole fan-out.
      const forwarded = remotePoolArgs(f, fixedFilters);
      const remoteResult = await gatherRemoteList(forwarded, remoteHosts, {
        timeoutMs: BROWSER_PEER_TIMEOUT_MS,
      });
      unreachable = remoteResult.unreachable;
      if (remoteResult.sessions.length > 0) rows = mergeLocalFirst([...rows, ...remoteResult.sessions], self);
    } catch {
      // enrichment, never a hard dependency
    }
  }

  // Team rows are anonymous without their meta.json (team name, handle, the
  // orchestrator that spawned them). Only pay for that read when team rows are
  // actually in the pool — with `c` off they were excluded at the query.
  if (f.teams) rows = enrichTeamOrigins(rows);

  return { key: poolCacheKey(f), rows, unreachable };
}

/** Build the static peer query. Keeping it pure pins the per-device alias
 * contract: latest/oldest travel unresolved and are resolved by each peer. */
export function remotePoolArgs(f: BrowserFilter, fixedFilters: boolean): string[] {
  const forwarded = ['sessions', '--all', '--json', '--limit', String(f.team ? WHOLE_TEAM_POOL_LIMIT : f.limit)];
  if (f.window) forwarded.push('--since', f.window);
  if (f.until) forwarded.push('--until', f.until);
  if (f.project) forwarded.push('--project', f.project);
  if (f.routine) {
    forwarded.push('--routine');
    if (typeof f.routine === 'string') forwarded.push(f.routine);
  }
  if (f.skill) forwarded.push('--skill', f.skill);
  if (f.plugin) forwarded.push('--plugin', f.plugin);
  if (f.unmanaged) forwarded.push('--unmanaged');
  if (f.sort !== 'timestamp') forwarded.push('--sort', f.sort === 'cost' ? 'cost' : 'duration');
  if (f.agent && (fixedFilters || f.agent.includes('@'))) forwarded.push('--agent', f.agent);
  if (f.teams) forwarded.push('--teams');
  return forwarded;
}

/**
 * A live session's stable row key: its session id when the agent reported one,
 * else a per-machine handle so an id-less live session (a just-booted harness, a
 * cloud task) still gets exactly one row instead of being dropped. Cloud rows key
 * on the task id because they have no pid — keying them all on the machine alone
 * would collapse two cloud tasks into one row, the same silent-drop this whole
 * change exists to remove.
 */
export function liveRowKey(a: ActiveSession, self: string): string {
  if (a.sessionId) return a.sessionId;
  const handle = a.cloudTaskId ?? (a.pid != null ? String(a.pid) : 'unknown');
  return `${LIVE_ROW_PREFIX}${a.machine ?? self}:${handle}`;
}

/** Index live sessions by {@link liveRowKey} — the join key between the live scan
 *  and the transcript pool. Id-carrying rows key on the session id, so a live row
 *  and its transcript row collapse to one. */
export function indexLiveRows(rows: ActiveSession[], self: string): Map<string, ActiveSession> {
  const byKey = new Map<string, ActiveSession>();
  for (const a of rows) byKey.set(liveRowKey(a, self), a);
  return byKey;
}

/**
 * Project a live session onto the picker's row shape, for a session the transcript
 * pool doesn't carry — a peer's session, a transcript outside the current window,
 * or an agent that has not written one yet. `filePath` is the live transcript path
 * when the scan resolved one and empty otherwise, which is what
 * {@link handlePickedSession} keys "there is nothing to open yet" off.
 */
export function liveSessionToMeta(a: ActiveSession, self: string): SessionMeta {
  const machine = a.machine ?? self;
  const started = a.startedAtMs ?? a.lastActivityMs;
  const topic = a.topic ?? a.preview;
  return {
    id: liveRowKey(a, self),
    // No session id to short — name the row by what it IS (a cloud task, a pid),
    // so the id column still identifies the process you'd go looking for.
    shortId: a.sessionId
      ? a.sessionId.slice(0, 8)
      : a.cloudTaskId
        ? a.cloudTaskId.slice(0, 8)
        : `p:${a.pid ?? '?'}`,
    agent: isSessionTrackedAgent(a.kind) ? a.kind : 'claude',
    timestamp: new Date(started ?? Date.now()).toISOString(),
    lastActivity: a.lastActivityMs ? new Date(a.lastActivityMs).toISOString() : undefined,
    project: a.cwd ? path.basename(a.cwd) : undefined,
    cwd: a.cwd,
    filePath: a.sessionFile ?? '',
    // A live topic is raw transcript text: a newline in it would break the row
    // into two and misalign every column after it. Indexed rows are already
    // cleaned at scan time, so this puts projected rows on the same footing.
    topic: topic ? cleanPreview(topic) : undefined,
    label: a.label ? cleanPreview(a.label) : undefined,
    machine,
    // Reading/resuming a peer's session hops back over SSH — same contract the
    // cross-machine listing sets, so handlePickedSession routes it correctly.
    _remote: machine !== self,
    prUrl: a.pr?.url,
    prNumber: a.pr?.number,
    ticketId: a.ticket?.id,
    worktreeSlug: a.worktree?.slug,
    origin: a.origin,
    routineName: a.routineName,
  };
}

/**
 * Fold the live scan INTO the transcript pool. The running filter used to be a
 * pure intersection (`pool ∩ live`), which meant a session had to already be in
 * the pool to be shown as running — so every session on another machine, and
 * every local one outside the pool's window, was invisible in the browser while
 * `--active --json` listed it. Live sessions the pool lacks are appended as their
 * own rows, then the whole set is grouped local-machine-first.
 */
export function mergeLiveIntoPool(
  rows: SessionMeta[],
  live: Map<string, ActiveSession>,
  self: string,
  includeUnindexed = true,
): SessionMeta[] {
  // A latest/oldest selector is resolved by the peer's transcript query. A live
  // row absent from that result has no proof it belongs to the resolved version,
  // so callers using an alias fail closed instead of widening the selector.
  if (!includeUnindexed) return rows;
  const known = new Set(rows.map((r) => r.id));
  const extra: SessionMeta[] = [];
  for (const [key, a] of live) {
    if (!known.has(key)) extra.push(liveSessionToMeta(a, self));
  }
  return extra.length === 0 ? rows : mergeLocalFirst([...rows, ...extra], self);
}

/**
 * Whether to render the host-program column. It belongs to the running view
 * only, so this gates on the FILTER — not on the live index being populated.
 * `liveCache` outlives a toggle of the `r` hotkey, so testing `live` alone would
 * keep the column after running is turned back off, widening a plain transcript
 * listing that has no live rows to explain it.
 */
export function shouldShowHostColumn(
  f: BrowserFilter,
  live: Map<string, ActiveSession> | null,
  rows: SessionMeta[],
): boolean {
  if (!f.running || !live) return false;
  return rows.some((r) => liveHostLabel(live.get(r.id)) !== '');
}

/** Apply the cheap in-memory filters (agent / device / project / running / bookmarks). */
export function applyFilters(
  rows: SessionMeta[],
  live: Map<string, ActiveSession>,
  f: BrowserFilter,
  self: string,
  bookmarks: Set<string>,
): SessionMeta[] {
  let out = rows;
  // A projected live row is keyed by pid/task when it has no session id, and a
  // A bookmark is always keyed by a real session id — so an id-less row can
  // never be bookmarked and correctly drops out here.
  if (f.bookmarks) out = out.filter((r) => bookmarks.has(r.id));
  if (f.routine) {
    out = out.filter((r) => r.origin === 'routine' || !!r.routineName);
    if (typeof f.routine === 'string') {
      const routineNames = distinct(out.map((r) => r.routineName));
      const selected = resolveRoutineName(f.routine, routineNames);
      out = selected ? out.filter((r) => r.routineName === selected) : [];
    }
  }
  if (f.agent) {
    const { agent, version: rawVersion } = parseAgentFilter(f.agent);
    const localVersion = agent && agent in AGENTS
      ? resolveVersionAliasLoose(agent as AgentId, rawVersion)
      : rawVersion;
    const peerResolvedAlias = rawVersion === 'latest' || rawVersion === 'oldest';
    out = out.filter((r) => {
      if (r.agent !== agent) return false;
      // Only a LIVE peer result may claim it resolved latest/oldest against that
      // device's installed inventory. A synced mirror is historical data, not a
      // version-inventory oracle.
      if (peerResolvedAlias && (r.machine ?? self) !== self) return r._remote === true;
      if (!localVersion) return true;
      return r.version === localVersion;
    });
  }
  if (f.device) out = out.filter((r) => (r.machine ?? self) === f.device);
  if (f.team) out = out.filter((r) => matchesTeam(r, f.team!));
  if (f.project) {
    const q = f.project.toLowerCase();
    out = out.filter((r) => (r.project ?? '').toLowerCase().includes(q) || (r.cwd ?? '').toLowerCase().includes(q));
  }
  if (f.projectScope === 'repo') {
    const cwd = process.cwd();
    out = out.filter((r) => !!r.cwd && (r.cwd === cwd || r.cwd.startsWith(cwd + '/')));
  }
  // The live registry retains dead rows so explicit --closed/--crashed filters
  // can recover them. Bare --active means currently active; a lifecycle filter
  // intentionally replaces that default predicate with its exact status union.
  if (f.running && f.statuses.length === 0) {
    out = out.filter((r) => {
      const active = live.get(r.id);
      return !!active && isRunningLiveSession(active);
    });
  }
  if (f.statuses.length > 0) {
    out = out.filter((r) => {
      const active = live.get(r.id);
      return !!active && f.statuses.some((status) => matchesLiveStatus(active, status));
    });
  }
  return out;
}

/** One-shot form of the browser's canonical candidate pipeline. Focus uses this
 * instead of maintaining a second discovery/filter implementation. */
export async function collectSessionCandidates(
  initial: Partial<BrowserFilter>,
  opts: { local?: boolean; hosts?: string[]; includeLive?: boolean } = {},
): Promise<{ sessions: SessionMeta[]; liveById: Map<string, ActiveSession>; self: string; unreachable: string[] }> {
  const self = machineId();
  const filter = buildInitialFilter(initial);
  if (filter.statuses.length > 0) filter.running = true;
  const hosts = opts.hosts && opts.hosts.length > 0 ? opts.hosts : undefined;
  const pool = await fetchRawPool(filter, self, opts.local ?? false, hosts, true);
  let liveById = new Map<string, ActiveSession>();
  if (filter.running || opts.includeLive) {
    const { sessions } = await gatherActiveSessions({ local: opts.local ?? false, hosts });
    liveById = indexLiveRows(sessions, self);
  }
  const includeUnindexedLive = !filter.agent?.match(/@(latest|oldest)$/);
  const rows = filter.running || opts.includeLive
    ? mergeLiveIntoPool(pool.rows, liveById, self, includeUnindexedLive)
    : pool.rows;
  const sessions = applyFilters(rows, liveById, filter, self, listBookmarks());
  return { sessions, liveById, self, unreachable: pool.unreachable };
}

/** Derive the SSH-launch origin tag for a picker row from the live index. Set
 * only when the live session's provenance is ssh transport; `device` is the
 * resolved origin device (absent → the row shows a bare `ssh`). Rows without a
 * live entry (the running filter off) get no tag — provenance is live-only. */
function sshOriginTagFor(live: Map<string, ActiveSession> | null, id: string): SshOriginTag | undefined {
  const p = live?.get(id)?.provenance;
  if (p?.transport !== 'ssh') return undefined;
  return p.origin?.device ? { device: p.origin.device } : {};
}

function headerFor(f: BrowserFilter): string {
  const bits = [
    `device:${f.device ?? 'all'}`,
    `agent:${f.agent ?? 'all'}`,
    `team:${f.team ?? 'all'}`,
    f.projectScope === 'repo' ? 'this repo' : 'all dirs',
    `window:${f.window ?? 'all'}`,
  ];
  if (f.running) bits.push('running');
  if (f.teams) bits.push('teams');
  if (f.routine) bits.push(`routine:${typeof f.routine === 'string' ? f.routine : 'all'}`);
  if (f.bookmarks) bits.push('bookmarks');
  return bits.join(' · ');
}

function helpFor(_f: BrowserFilter, mode: 'nav' | 'search'): string {
  if (mode === 'search') {
    return 'type to filter · ↑↓ navigate · esc exit search · ⏎ resume';
  }
  return 's search · r running · b bookmarks · * bookmark · f focus · c teams · t team · a agent · d device · p project · w window · tab preview · y copy-cmd · ⏎ resume · esc quit';
}

/**
 * Launch the interactive session browser. `initial` seeds the filter (e.g.
 * `{ running: true }` for `--active`). Resolves after the user resumes a session
 * or cancels — the picked row is dispatched through the shared resume/focus path.
 */
export async function runSessionBrowser(
  initial: Partial<BrowserFilter> = {},
  opts: { local?: boolean; hosts?: string[] } = {},
): Promise<void> {
  const self = machineId();
  const local = opts.local ?? false;
  const hosts = opts.hosts && opts.hosts.length > 0 ? opts.hosts : undefined;

  // Updated after each load so the A/D cycles range over what's actually present.
  let agentsInPool: string[] = [];
  let devicesInPool: string[] = [];
  let teamsInPool: string[] = [];
  let cols: PickerColumns = {};
  // Cache the transcript fetch, keyed by poolCacheKey (everything that changes
  // what is FETCHED); agent/device/project/running are applied in memory so their
  // hotkeys don't re-fan-out the fleet.
  let rawCache: { key: string; rows: SessionMeta[]; unreachable: string[] } | null = null;
  // Peers that didn't answer the last fan-out. The fan-out's own note goes to
  // stderr, which the full-screen picker repaints over — so it is surfaced in
  // the header instead, where "that box is asleep" stays distinguishable from
  // "that box has nothing matching".
  let unreachable: string[] = [];
  // The live index is slow (a full ps/tmux scan) and only the running filter
  // needs it — fetch it once, lazily, the first time running is toggled on.
  let liveCache: Map<string, ActiveSession> | null = null;
  const liveFor = (id: string): ActiveSession | undefined => liveCache?.get(id);
  // Re-read every load (it's an mtime-memoized parse of one small file), so the
  // `*` key's reload picks up the bookmark it just wrote — and so does one
  // bookmarked by another session on this machine.
  let bookmarks = new Set<string>();
  // Generation guard: two quick keypresses can start overlapping loads whose
  // SSH fan-outs settle out of order. dynamicPicker's own gen ref guards which
  // rows become `items`, but the shared closure state below (cols / cycle pools /
  // caches) is a side channel it can't see — so a stale load must never commit
  // it. We compute into locals and only write the shared state as the latest load.
  let loadGen = 0;

  const initialFilter = buildInitialFilter(initial);

  const load = async (f: BrowserFilter): Promise<SessionMeta[]> => {
    const myGen = ++loadGen;
    // f.team decides the fetch limit, so it belongs in the key — otherwise arriving
    // via `t` reuses a 500-row pool while --in-team fetched 5000, and the cycle can
    // only offer the teams that happened to be in whichever pool was built first.
    const key = poolCacheKey(f);
    let pool = rawCache && rawCache.key === key ? rawCache : null;
    if (!pool) {
      const fetched = await fetchRawPool(f, self, local, hosts);
      if (myGen !== loadGen) return []; // superseded — don't touch shared state
      pool = fetched;
    }
    // Only pay for the live scan when the running filter needs it. Same fleet
    // sweep the static `--active` view uses, so the two never disagree about
    // what is running.
    let live = liveCache;
    if (f.running && !live) {
      try {
        const { sessions } = await gatherActiveSessions({ local, hosts });
        live = indexLiveRows(sessions, self);
      } catch {
        live = new Map();
      }
      if (myGen !== loadGen) return [];
    }
    // Latest load — commit shared state atomically (no await past this point, so
    // no newer load can interleave between these writes).
    rawCache = pool;
    unreachable = pool.unreachable;
    if (live) liveCache = live;
    // Live sessions the transcript pool lacks become rows of their own, so the
    // running view lists every active session, not just the ones already indexed.
    const includeUnindexedLive = !f.agent?.match(/@(latest|oldest)$/);
    const rows = f.running && live
      ? mergeLiveIntoPool(pool.rows, live, self, includeUnindexedLive)
      : pool.rows;
    agentsInPool = distinct(rows.map((r) => r.agent));
    devicesInPool = distinct(rows.map((r) => r.machine ?? self));
    // Both ends of the lineage seed the cycle: teams a row spawned, and teams a
    // row belongs to. Teammate rows only carry `teamOrigin` when `c` is on, so
    // with teams hidden this ranges over spawned teams alone — which is exactly
    // the set whose rows are visible.
    // Through safeTeamText: the cycle's values become `f.team`, which headerFor
    // interpolates into the header and browserFilterToArgv copies into a command,
    // and on a peer's row these strings are that machine's to choose.
    teamsInPool = distinct([
      ...rows.map((r) => safeTeamText(r.spawnedTeam)),
      ...rows.map((r) => safeTeamText(r.teamOrigin?.team)),
    ]);
    bookmarks = listBookmarks();
    const filtered = applyFilters(rows, live ?? new Map(), f, self, bookmarks);
    cols = pickerColumnsFor(filtered);
    cols.showHost = shouldShowHostColumn(f, live, filtered);
    // Status rides the same gate as the host column: both come from the live
    // scan, so both belong to the running view and neither should widen a plain
    // transcript listing that has no live rows to fill them.
    cols.showStatus = !!f.running && !!live;
    return filtered;
  };

  const picked = await dynamicPicker<SessionMeta, BrowserFilter, 'focus'>({
    message: 'Sessions',
    initialFilter,
    load,
    keyFor: (s) => s.id,
    labelFor: (s, q) =>
      formatPickerLabel(
        s,
        q,
        cols,
        sshOriginTagFor(liveCache, s.id),
        liveHostLabel(liveCache?.get(s.id)),
        bookmarks.has(s.id),
        liveCache?.get(s.id),
      ),
    matches: sessionMatchesQuery,
    // Lead the preview with the live status banner — the one place a `crashed` /
    // `orphaned` session gets a sentence instead of a glyph. `buildPreview` is
    // memoized per session, so the volatile live half is prepended here rather
    // than baked into the cached body.
    buildPreview: (s) => {
      const headline = formatLiveStatusHeadline(liveCache?.get(s.id), bookmarks.has(s.id));
      const body = buildPreview(s);
      return headline ? `${headline}\n${body}` : body;
    },
    // A remote row's digest arrives over SSH after the pane painted — this is
    // what lets its completion swap the metadata card for the full preview.
    registerPreviewRepaint: setRemotePreviewRepaint,
    headerFor: (f) =>
      unreachable.length > 0
        ? `${headerFor(f)} · ${chalk.yellow(`${unreachable.join(', ')}: unreachable`)}`
        : headerFor(f),
    helpFor,
    enterHint: 'resume',
    emptyMessage: 'No sessions match this filter.',
    loadingMessage: local ? 'Loading…' : 'Loading (reaching other machines)…',
    submitKeys: { f: 'focus' },
    keyBindings: {
      r: (f) => ({ ...f, running: !f.running }),
      b: (f) => ({ ...f, bookmarks: !f.bookmarks }),
      c: (f) => ({ ...f, teams: !f.teams }),
      a: (f) => ({ ...f, agent: cycle(f.agent, agentsInPool) }),
      d: (f) => ({ ...f, device: cycle(f.device, devicesInPool) }),
      t: (f) => ({ ...f, team: cycle(f.team, teamsInPool) }),
      // Under an explicit --device scope every row is a peer's, and no peer cwd
      // is under our process.cwd() — so narrowing to "this repo" could only ever
      // empty the list. Returning the same reference makes the key a no-op.
      p: (f) => (hosts ? f : { ...f, projectScope: f.projectScope === 'repo' ? 'all' : 'repo' }),
      w: (f) => ({ ...f, window: cycleWindow(f.window) }),
    },
    onKey: (name, f, active, query) => {
      if (name === '*') {
        // Only a row with a real session id can be bookmarked: a projected live row
        // with no id is keyed by pid, which is gone the moment the process is.
        if (!active || active.id.startsWith(LIVE_ROW_PREFIX)) return 'nothing to bookmark on this row';
        const on = toggleBookmark(active.id);
        // Reload so the row's bookmark glyph is repainted — labels are memoized per row.
        return { flash: on ? `★ bookmarked ${active.shortId}` : `☆ unbookmarked ${active.shortId}`, reload: true };
      }
      // Both cases: `hotkeyToken` hands `onKey` the literal character, and this
      // key worked with caps lock on before it existed.
      if (name === 'y' || name === 'Y') {
        // Thread the live search query so the copied command reproduces the
        // exact view — the human→agent bridge must include the search term.
        const cmd = 'ag ' + browserFilterToArgv(f, query).join(' ');
        const ok = copyToClipboard(cmd);
        return ok ? `copied: ${cmd}` : cmd;
      }
      return undefined;
    },
    // A late digest fetch must not poke a closed prompt.
  }).finally(() => setRemotePreviewRepaint(undefined));

  if (!picked) return;
  if (picked.action === 'focus') {
    // `focus.ts` consumes this browser for its selector path, so import only
    // after selection to keep the shared picker/focus dependency acyclic.
    const { focusSelectedSession } = await import('./focus.js');
    await focusSelectedSession(picked.item, liveFor(picked.item.id), self);
    return;
  }
  await handlePickedSession({ session: picked.item, action: 'resume' });
}
