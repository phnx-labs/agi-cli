
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
import { formatPickerLabel, pickerColumnsFor, type SshOriginTag, ticketLabel, mergeLocalFirst, liveHostLabel, LIVE_ROW_PREFIX, handlePickedSession, matchesTeam, formatLiveStatusHeadline, isRunningLiveSession, parseAgentFilter, type PickerColumns } from './sessions.js';
import { gatherActiveSessions, cleanPreview, shouldIncludeLocal, remoteHostsToDial, matchesLiveStatus, resolveRoutineName, type LiveStatusFilter } from './ps-roster.js';

export interface BrowserFilter {
  running: boolean;
  teams: boolean;
  agent?: string;
  device?: string;
  team?: string;
  bookmarks: boolean;
  projectScope: 'repo' | 'all';
  window?: string;
  statuses: LiveStatusFilter[];
  project?: string;
  until?: string;
  routine: boolean | string;
  skill?: string;
  plugin?: string;
  limit: number;
  unmanaged: boolean;
  sort: 'timestamp' | 'cost' | 'duration';
}

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

function poolCacheKey(f: BrowserFilter): string {
  const versionScoped = f.agent?.includes('@') ? f.agent : '';
  return [
    f.window ?? 'all', f.until ?? '', f.teams, f.team ? 'team' : '', versionScoped,
    f.project ?? '', f.routine, f.skill ?? '', f.plugin ?? '', f.limit, f.unmanaged, f.sort,
  ].join('|');
}

const WHOLE_TEAM_POOL_LIMIT = 5000;
const BROWSER_PEER_TIMEOUT_MS = 30_000;

const WINDOW_CYCLE: (string | undefined)[] = [undefined, '1d', '7d', '30d'];

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

export function normalizeDeviceSeed(host: string | undefined): string | undefined {
  if (!host) return undefined;
  return normalizeHost(host.split('@').pop() || host);
}

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
    window: opts.since ?? (opts.all ? undefined : '30d'),
    statuses: [],
  };
}

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
  const scoped = (opts.host?.length ?? 0) > 0;
  const wholeTeam = !!opts.inTeam;
  return {
    teams: !!opts.teams,
    bookmarks: !!opts.bookmarks,
    routine: opts.routine ?? false,
    agent: opts.agent,
    device: opts.host?.length === 1 ? normalizeDeviceSeed(opts.host[0]) : undefined,
    team: opts.inTeam,
    projectScope: opts.all || scoped || wholeTeam ? 'all' : 'repo',
    window: opts.since ?? (opts.all || wholeTeam ? undefined : '30d'),
    statuses: [],
  };
}

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
    }
  }
  return false;
}

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
        limit: f.team ? WHOLE_TEAM_POOL_LIMIT : f.limit,
        sortBy: f.sort,
      })
    : [];

  if (selectedAgent.version === 'latest' || selectedAgent.version === 'oldest') {
    rows = rows.filter((row) => (row.machine ?? self) === self);
  }

  const remoteHosts = remoteHostsToDial(hosts, self);
  const dialPeers = !local && (!hosts?.length || (remoteHosts && remoteHosts.length > 0));
  if (dialPeers) {
    try {
      const forwarded = remotePoolArgs(f, fixedFilters);
      const remoteResult = await gatherRemoteList(forwarded, remoteHosts, {
        timeoutMs: BROWSER_PEER_TIMEOUT_MS,
      });
      unreachable = remoteResult.unreachable;
      if (remoteResult.sessions.length > 0) rows = mergeLocalFirst([...rows, ...remoteResult.sessions], self);
    } catch {
    }
  }

  if (f.teams) rows = enrichTeamOrigins(rows);

  return { key: poolCacheKey(f), rows, unreachable };
}

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

export function liveRowKey(a: ActiveSession, self: string): string {
  if (a.sessionId) return a.sessionId;
  const handle = a.cloudTaskId ?? (a.pid != null ? String(a.pid) : 'unknown');
  return `${LIVE_ROW_PREFIX}${a.machine ?? self}:${handle}`;
}

export function indexLiveRows(rows: ActiveSession[], self: string): Map<string, ActiveSession> {
  const byKey = new Map<string, ActiveSession>();
  for (const a of rows) byKey.set(liveRowKey(a, self), a);
  return byKey;
}

export function liveSessionToMeta(a: ActiveSession, self: string): SessionMeta {
  const machine = a.machine ?? self;
  const started = a.startedAtMs ?? a.lastActivityMs;
  const topic = a.topic ?? a.preview;
  return {
    id: liveRowKey(a, self),
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
    topic: topic ? cleanPreview(topic) : undefined,
    label: a.label ? cleanPreview(a.label) : undefined,
    machine,
    _remote: machine !== self,
    prUrl: a.pr?.url,
    prNumber: a.pr?.number,
    ticketId: a.ticket?.id,
    worktreeSlug: a.worktree?.slug,
    origin: a.origin,
    routineName: a.routineName,
  };
}

export function mergeLiveIntoPool(
  rows: SessionMeta[],
  live: Map<string, ActiveSession>,
  self: string,
  includeUnindexed = true,
): SessionMeta[] {
  if (!includeUnindexed) return rows;
  const known = new Set(rows.map((r) => r.id));
  const extra: SessionMeta[] = [];
  for (const [key, a] of live) {
    if (!known.has(key)) extra.push(liveSessionToMeta(a, self));
  }
  return extra.length === 0 ? rows : mergeLocalFirst([...rows, ...extra], self);
}

export function shouldShowHostColumn(
  f: BrowserFilter,
  live: Map<string, ActiveSession> | null,
  rows: SessionMeta[],
): boolean {
  if (!f.running || !live) return false;
  return rows.some((r) => liveHostLabel(live.get(r.id)) !== '');
}

export function applyFilters(
  rows: SessionMeta[],
  live: Map<string, ActiveSession>,
  f: BrowserFilter,
  self: string,
  bookmarks: Set<string>,
): SessionMeta[] {
  let out = rows;
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

export async function runSessionBrowser(
  initial: Partial<BrowserFilter> = {},
  opts: { local?: boolean; hosts?: string[] } = {},
): Promise<void> {
  const self = machineId();
  const local = opts.local ?? false;
  const hosts = opts.hosts && opts.hosts.length > 0 ? opts.hosts : undefined;

  let agentsInPool: string[] = [];
  let devicesInPool: string[] = [];
  let teamsInPool: string[] = [];
  let cols: PickerColumns = {};
  let rawCache: { key: string; rows: SessionMeta[]; unreachable: string[] } | null = null;
  let unreachable: string[] = [];
  let liveCache: Map<string, ActiveSession> | null = null;
  const liveFor = (id: string): ActiveSession | undefined => liveCache?.get(id);
  let bookmarks = new Set<string>();
  let loadGen = 0;

  const initialFilter = buildInitialFilter(initial);

  const load = async (f: BrowserFilter): Promise<SessionMeta[]> => {
    const myGen = ++loadGen;
    const key = poolCacheKey(f);
    let pool = rawCache && rawCache.key === key ? rawCache : null;
    if (!pool) {
      const fetched = await fetchRawPool(f, self, local, hosts);
      if (myGen !== loadGen) return [];
      pool = fetched;
    }
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
    rawCache = pool;
    unreachable = pool.unreachable;
    if (live) liveCache = live;
    const includeUnindexedLive = !f.agent?.match(/@(latest|oldest)$/);
    const rows = f.running && live
      ? mergeLiveIntoPool(pool.rows, live, self, includeUnindexedLive)
      : pool.rows;
    agentsInPool = distinct(rows.map((r) => r.agent));
    devicesInPool = distinct(rows.map((r) => r.machine ?? self));
    teamsInPool = distinct([
      ...rows.map((r) => safeTeamText(r.spawnedTeam)),
      ...rows.map((r) => safeTeamText(r.teamOrigin?.team)),
    ]);
    bookmarks = listBookmarks();
    const filtered = applyFilters(rows, live ?? new Map(), f, self, bookmarks);
    cols = pickerColumnsFor(filtered);
    cols.showHost = shouldShowHostColumn(f, live, filtered);
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
    buildPreview: (s) => {
      const headline = formatLiveStatusHeadline(liveCache?.get(s.id), bookmarks.has(s.id));
      const body = buildPreview(s);
      return headline ? `${headline}\n${body}` : body;
    },
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
      p: (f) => (hosts ? f : { ...f, projectScope: f.projectScope === 'repo' ? 'all' : 'repo' }),
      w: (f) => ({ ...f, window: cycleWindow(f.window) }),
    },
    onKey: (name, f, active, query) => {
      if (name === '*') {
        if (!active || active.id.startsWith(LIVE_ROW_PREFIX)) return 'nothing to bookmark on this row';
        const on = toggleBookmark(active.id);
        return { flash: on ? `★ bookmarked ${active.shortId}` : `☆ unbookmarked ${active.shortId}`, reload: true };
      }
      if (name === 'y' || name === 'Y') {
        const cmd = 'ag ' + browserFilterToArgv(f, query).join(' ');
        const ok = copyToClipboard(cmd);
        return ok ? `copied: ${cmd}` : cmd;
      }
      return undefined;
    },
  }).finally(() => setRemotePreviewRepaint(undefined));

  if (!picked) return;
  if (picked.action === 'focus') {
    const { focusSelectedSession } = await import('./focus.js');
    await focusSelectedSession(picked.item, liveFor(picked.item.id), self);
    return;
  }
  await handlePickedSession({ session: picked.item, action: 'resume' });
}
