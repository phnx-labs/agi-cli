/**
 * The shared live-session reach engine that `sessions focus` / `resume --attach-only`
 * import ("attach or refuse", never fork/resume):
 *   - `gatherLiveTargets` / `pickLiveTarget` / `buildLivePool` — live-session discovery + picker
 *   - `jumpTo` — the side-effecting jump: attach the already-running terminal
 *       local tmux    -> attach (switch-client when already inside tmux)
 *       local Ghostty -> focus its tab (Cmd+<n> via System Events; tab # from ghostty-tabs)
 *       remote tmux   -> ssh -tt + tmux attach (pane->session resolved on the remote)
 *       otherwise     -> hand off to the `UnreachableFallback` (attach-only refuses; focus resumes)
 *   - `refuseFallback` — the attach-only fallback (remote -> login shell; local -> refuse)
 */
import chalk from 'chalk';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getActiveSessions, findSessionFileForKind, sessionProcessIsLocal, sessionProcessHost, type ActiveSession } from '../lib/session/active.js';
import { isSessionIdShape } from '../lib/session/pid-registry.js';
import { gatherRemoteActive } from '../lib/session/remote-active.js';
import { discoverSessions } from '../lib/session/discover.js';
import { deriveShortId } from '../lib/session/short-id.js';
import type { SessionMeta, SessionAgentId } from '@phnx-labs/sessions-cli/reader';
import {
  dedupeByMachineSession,
  mergeLocalFirst,
  pickSessionInteractive,
  matchesLiveStatus,
  filterSessionsByQuery,
  formatPickerLabel,
  pickerColumnsFor,
  isUniqueEnoughSelector,
  type LiveStatusFilter,
} from './sessions.js';
import { buildPreview } from './sessions-picker.js';
import { multiItemPicker } from '../lib/picker.js';
import { isPromptCancelled } from './utils.js';
import { machineId } from '../lib/session/sync/config.js';
import { attachTmux, runTmux } from '../lib/tmux/binary.js';
import { ensureSessionHookRepaired, paneExitStatus, teardownIfAgentExited } from '../lib/tmux/session.js';
import { getDefaultSocketPath } from '../lib/tmux/paths.js';
import { sshExec, sshStream, assertValidSshTarget, shellQuote, SSH_CONN_FAILURE_CODE } from '../lib/ssh-exec.js';
import { connectionEndedNotice } from '../lib/hosts/reconnect.js';
import { enumerateGhosttyTabs, assignGhosttyTabs } from '../lib/session/ghostty-tabs.js';
import { addressabilityRecoveryHint } from '../lib/terminal/resolve.js';

const execFileAsync = promisify(execFile);

/**
 * Scope a live-session pool by device and live status. Pure so the `focus`
 * device/status filters are unit-testable without touching the sweep. `hosts`
 * keeps only sessions whose `machine` is in the set (local rows carry `self`,
 * remote rows carry their peer tag); `statuses` reuses `--active`'s exact
 * `matchesLiveStatus` derivation rather than a parallel status table.
 */
export function filterLivePool(
  sessions: ActiveSession[],
  opts: { hosts?: string[]; statuses?: LiveStatusFilter[] } = {},
): ActiveSession[] {
  let out = sessions;
  if (opts.hosts?.length) {
    const set = new Set(opts.hosts);
    out = out.filter((s) => !!s.machine && set.has(s.machine));
  }
  if (opts.statuses?.length) {
    out = out.filter((s) => opts.statuses!.some((status) => matchesLiveStatus(s, status)));
  }
  return out;
}

/**
 * Live rows whose session id starts with `selector` (case-insensitive prefix).
 * Same match `resolveOne` uses, so skip-fleet and resolve stay aligned.
 */
export function localLiveSelectorMatches(sessions: ActiveSession[], selector: string): ActiveSession[] {
  const q = selector.toLowerCase();
  return sessions.filter((s) => (s.sessionId ?? '').toLowerCase().startsWith(q));
}

/**
 * Skip `gatherRemoteActive` when local already answered the selector:
 * two local matches fail closed without waiting for a sleeping peer that
 * might collide; a single local hit skips only when the selector is a full
 * UUID or unique-enough 8-hex (`isUniqueEnoughSelector`). A shorter unique
 * local prefix still races the fleet so a remote collision can fail closed.
 * Zero matches still race the fleet.
 */
export function shouldSkipRemoteSweep(localMatches: ActiveSession[], selector: string): boolean {
  if (localMatches.length >= 2) return true;
  if (localMatches.length === 1) return isUniqueEnoughSelector(selector);
  return false;
}

/**
 * First-hit abort predicate for a live-id fleet race. A full UUID is globally
 * unique so the first exact hit is the only hit. A unique-enough live prefix
 * (8+ chars, the tmux `ag-<agent>-<8hex>` short id) aborts remaining SSH once
 * a reachable peer answers — unanswered boxes must not delay (PHNX-3298).
 * Shorter prefixes stay all-settle.
 */
export function isDefinitiveLiveMatch(session: ActiveSession, selector: string): boolean {
  const id = (session.sessionId ?? '').toLowerCase();
  const q = selector.trim().toLowerCase();
  if (!id || !q) return false;
  if (isSessionIdShape(q)) return id === q;
  return q.length >= 8 && id.startsWith(q);
}

function liveSelectorEarlyExit(
  selector: string | undefined,
): { isDefinitive: (item: ActiveSession, machine: string) => boolean } | undefined {
  if (!selector || !isUniqueEnoughSelector(selector)) return undefined;
  return { isDefinitive: (item) => isDefinitiveLiveMatch(item, selector) };
}

/**
 * Live jump targets (local + remote), keyed by session id. Cloud is excluded by
 * default (it has no local pid to attach), but `detach` opts in with
 * `includeCloud` so it can resolve a cloud id and refuse it with a clear message
 * instead of a bare "no live session".
 *
 * `hosts` scopes the sweep to named devices — the fan-out only dials them, and the
 * pool is then filtered to `s.machine ∈ hosts` so a stray local row can't leak in.
 * `statuses` narrows to the live-state words `--active` uses (orphan/crashed/…).
 * `selector` (detach/stop) skips fleet SSH when local already has a unique live
 * id or a local collision; omit it for browse (`focus` with no id) so the picker
 * still all-settles.
 */
export async function gatherLiveTargets(
  local: boolean,
  opts: { includeCloud?: boolean; hosts?: string[]; statuses?: LiveStatusFilter[]; selector?: string } = {},
): Promise<{ self: string; activeById: Map<string, ActiveSession> }> {
  const self = machineId();
  const localActive = await getActiveSessions();
  for (const s of localActive) if (!s.machine) s.machine = self;
  let active = localActive;
  const skipRemote = local || (opts.selector
    ? shouldSkipRemoteSweep(
        opts.hosts?.length
          ? filterLivePool(localLiveSelectorMatches(localActive, opts.selector), { hosts: opts.hosts })
          : localLiveSelectorMatches(localActive, opts.selector),
        opts.selector,
      )
    : false);
  if (!skipRemote) {
    try {
      const remote = await gatherRemoteActive(opts.hosts, {
        earlyExit: liveSelectorEarlyExit(opts.selector),
      });
      active = dedupeByMachineSession([...localActive, ...remote.sessions]);
    } catch { /* remote sweep is best-effort */ }
  }
  active = filterLivePool(active, { hosts: opts.hosts, statuses: opts.statuses });
  const activeById = new Map<string, ActiveSession>();
  for (const s of active) {
    if (!s.sessionId) continue;
    if (s.context === 'cloud' && !opts.includeCloud) continue;
    activeById.set(s.sessionId, s);
  }
  return { self, activeById };
}

/** Interactive pick over the live sessions' rich SessionMeta; returns the chosen live session. */
export async function pickLiveTarget(
  activeById: Map<string, ActiveSession>,
  self: string,
  message: string,
  enterHint: string,
): Promise<ActiveSession | null> {
  const pool = await buildLivePool(activeById, self);
  if (pool.length === 0) return null;
  const picked = await pickSessionInteractive(pool, message, undefined, 0, enterHint);
  if (!picked) return null;
  return activeById.get(picked.session.id) ?? null;
}

/**
 * Multi-select over the live sessions' rich SessionMeta (same rows as
 * `pickLiveTarget`, but a checkbox picker) — the plural sibling that lets `focus`
 * open several sessions at once. Mirrors `sessions resume`'s `multiItemPicker`
 * wiring; returns the chosen live sessions in pick order, or `[]` on cancel.
 */
export async function pickLiveTargets(
  activeById: Map<string, ActiveSession>,
  self: string,
  message: string,
): Promise<ActiveSession[]> {
  const pool = await buildLivePool(activeById, self);
  if (pool.length === 0) return [];
  // gutter: 6 = the multi-select cursor + checkbox ('> [x] ') multiItemPicker prepends.
  const cols = { ...pickerColumnsFor(pool), gutter: 6 };
  let chosen: SessionMeta[] | null;
  try {
    chosen = await multiItemPicker<SessionMeta>({
      message,
      items: pool,
      filter: (q: string) => (q.trim() ? filterSessionsByQuery(pool, q) : pool),
      labelFor: (s, q) => formatPickerLabel(s, q, cols),
      keyFor: (s) => s.id,
      buildPreview,
      pageSize: 15,
      emptyMessage: 'No live sessions match.',
      enterHint: 'focus',
    });
  } catch (err) {
    if (isPromptCancelled(err)) return [];
    throw err;
  }
  if (!chosen) return [];
  return chosen.map((m) => activeById.get(m.id)).filter((s): s is ActiveSession => !!s);
}

/**
 * Map each live session to its rich SessionMeta (worktree/PR/changes/tools/tests
 * via the shared picker), reusing `discoverSessions`. Remote or unindexed live
 * sessions get a minimal synthesized meta so they still appear and jump.
 */
export async function buildLivePool(activeById: Map<string, ActiveSession>, self: string): Promise<SessionMeta[]> {
  let metas: SessionMeta[] = [];
  try {
    metas = await discoverSessions({ all: true, since: '30d', limit: 1000 });
  } catch { /* fall back to synthesized metas */ }
  const byId = new Map<string, SessionMeta>();
  for (const m of metas) byId.set(m.id, m);
  const pool: SessionMeta[] = [];
  for (const [sid, s] of activeById) {
    pool.push(byId.get(sid) ?? synthMeta(s, self));
  }
  return mergeLocalFirst(pool, self);
}

function synthMeta(s: ActiveSession, self: string): SessionMeta {
  const remote = !sessionProcessIsLocal(s, self);
  // For a local session, locate the real transcript so the picker's buildPreview
  // parses it directly (rich Prompt/Changes/Tools/Last response) rather than
  // rendering from the indexed digest. For Claude that resolves off disk; every
  // other harness resolves the id THROUGH the session index (RUSH-2691), so a
  // local non-Claude session the index has not reached yet yields '' here and
  // gets the same clean "not indexed here" note as a remote one — which is the
  // honest answer, since the pre-RUSH-2691 alternative was a co-located
  // stranger's transcript. Remote transcripts live on the peer, so leave
  // filePath empty there too.
  const filePath = remote ? '' : (findSessionFileForKind(s.kind, s.cwd, s.sessionId) ?? '');
  return {
    id: s.sessionId!,
    shortId: deriveShortId(s.sessionId!),
    agent: s.kind as SessionAgentId,
    timestamp: new Date(s.startedAtMs ?? Date.now()).toISOString(),
    filePath,
    cwd: s.cwd,
    project: s.cwd ? path.basename(s.cwd) : undefined,
    topic: s.topic,
    machine: s.machine,
    _remote: remote,
  };
}

// ---------- the jump ----------

export interface Where { label: string; action: string; }

function shortId(s: ActiveSession): string {
  return (s.sessionId ?? '').slice(0, 8) || '-';
}

/** What `jumpTo` writes after a remote tmux attach's SSH stream returns. Pure so
 *  the ControlMaster close path is unit-tested without SSH (RUSH-3227). */
export function remoteAttachEndedNotice(
  sessionId: string | undefined,
  host: string,
  code: number,
): string | undefined {
  if (!sessionId) return undefined;
  return connectionEndedNotice(
    { kind: 'session', id: sessionId },
    host,
    { dropped: code === SSH_CONN_FAILURE_CODE },
  );
}

/**
 * Pure, testable mirror of `jumpTo`'s path selection (jumpTo itself has side
 * effects — process.exit / ssh / osascript). Keep the branch ORDER in sync with
 * `jumpTo` below: remote-tmux, then local-tmux, then ghostty, then refuse.
 */
export function describeWhere(s: ActiveSession, self: string): Where {
  const remote = sessionProcessHost(s, self);
  const mux = s.provenance?.mux;
  if (mux?.kind === 'tmux' && mux.pane) {
    // When the renderer has resolved the current viewer, fold it into the label
    // so `focus` reports "tmux %3 (viewing in codium tab 2)" / "(detached)".
    const view = s.viewingIn
      ? ` (viewing in ${s.viewingIn.app}${s.viewingIn.tab != null ? ` tab ${s.viewingIn.tab}` : ''})`
      : '';
    return remote
      ? { label: `tmux ${mux.pane} on ${remote}`, action: `ssh + attach on ${remote}` }
      : { label: `tmux ${mux.pane}${view}`, action: 'attach its tmux' };
  }
  if (!remote && s.host === 'ghostty') return { label: 'Ghostty', action: 'focus its Ghostty tab' };
  if (remote) return { label: `${s.host ?? 'shell'} on ${remote}`, action: `open a shell on ${remote}` };
  return { label: s.host ?? 'unknown terminal', action: 'resume it (no live attach rail)' };
}

/**
 * What to do when a session can't be *attached* (no tmux/Ghostty rail). `go`
 * refuses; `focus` opens a new tab and resumes. `remote` is the peer name when
 * the session lives on another machine, else undefined. `fallbackId` is the
 * indexed session id when the live row has not registered one yet (PHNX-3356).
 */
export type UnreachableFallback = (s: ActiveSession, remote: string | undefined, fallbackId?: string) => void | Promise<void>;

export type AttachRailLiveness =
  | { state: 'alive' }
  | { state: 'dead'; exitStatus?: number }
  | { state: 'missing' };

/** Probe the tmux process, not just retained provenance. This is deliberately
 * called immediately before an attach so remain-on-exit panes cannot masquerade
 * as living agent sessions. */
export async function probeAttachRail(s: ActiveSession, self: string): Promise<AttachRailLiveness> {
  const mux = s.provenance?.mux;
  if (mux?.kind !== 'tmux' || !mux.pane) return { state: 'missing' };
  const remote = sessionProcessHost(s, self);
  if (!remote) {
    const pane = await paneExitStatus(mux.pane, mux.socket ?? getDefaultSocketPath());
    if (!pane.found) return { state: 'missing' };
    return pane.dead ? { state: 'dead', exitStatus: pane.status } : { state: 'alive' };
  }

  assertValidSshTarget(remote);
  const sock = mux.socket ? `-S ${shellQuote(mux.socket)} ` : '';
  const pane = shellQuote(mux.pane);
  const command =
    `v=$(tmux ${sock}display-message -pt ${pane} -p '#{pane_dead} #{pane_dead_status}' 2>/dev/null) || { echo missing; exit 0; }; ` +
    `printf '%s\\n' "$v"`;
  const result = sshExec(remote, command, { timeoutMs: 15_000, multiplex: true });
  if (result.code !== 0) return { state: 'missing' };
  const value = result.stdout.trim();
  if (value === 'missing' || !value) return { state: 'missing' };
  const [dead, rawStatus] = value.split(/\s+/);
  const exitStatus = Number.parseInt(rawStatus ?? '', 10);
  return dead === '1'
    ? { state: 'dead', exitStatus: Number.isFinite(exitStatus) ? exitStatus : undefined }
    : { state: 'alive' };
}

/** Strict attach-only fallback: no pane means no attach. Never open a shell or
 * start recovery, because both would violate the caller's no-fork intent. */
export async function refuseFallback(s: ActiveSession, remote: string | undefined, fallbackId?: string): Promise<void> {
  if (remote) {
    console.log(chalk.yellow(`Can't attach ${shortId(s)} on ${remote} — it has no living tmux pane.`));
    process.exitCode = 1;
    return;
  }
  console.log(
    chalk.yellow(`Can't jump to ${shortId(s)} — it's in ${s.host ?? 'an unknown terminal'} with no attach rail (not tmux/Ghostty).`) +
      chalk.gray(`\n${addressabilityRecoveryHint(s, fallbackId)}`),
  );
  process.exitCode = 1;
}

export async function jumpTo(s: ActiveSession, self: string, fallback: UnreachableFallback = refuseFallback, fallbackId?: string): Promise<void> {
  const remote = sessionProcessHost(s, self);
  const mux = s.provenance?.mux;

  // Path C: remote tmux — ssh in and attach, resolving the pane's session on the remote.
  if (remote) {
    if (mux?.kind === 'tmux' && mux.pane) {
      const liveness = await probeAttachRail(s, self);
      if (liveness.state !== 'alive') {
        await fallback(s, remote, fallbackId);
        return;
      }
      assertValidSshTarget(remote);
      const sock = mux.socket ? `-S ${shellQuote(mux.socket)} ` : '';
      const p = shellQuote(mux.pane);
      const remoteCmd =
        `w=$(tmux ${sock}display-message -pt ${p} '#{session_name}:#{window_index}' 2>/dev/null); ` +
        `sess=$(tmux ${sock}display-message -pt ${p} '#{session_name}' 2>/dev/null); ` +
        `[ -n "$w" ] && tmux ${sock}select-window -t "$w" 2>/dev/null; ` +
        `exec tmux ${sock}attach-session -t "\${sess:-${p}}"`;
      const attachId = s.sessionId || shortId(s);
      console.log(chalk.gray(`Attaching ${attachId} on ${remote} over SSH — Ctrl-b d to detach.`));
      const code = sshStream(remote, remoteCmd, { tty: true });
      const notice = remoteAttachEndedNotice(s.sessionId, remote, code);
      if (notice) process.stderr.write(notice);
      process.exit(code);
    }
    // Remote, not in tmux → hand off to the fallback (go: shell; focus: resume in a tab).
    await fallback(s, remote, fallbackId);
    return;
  }

  // Path B: local tmux — attach (or switch-client if we're already inside tmux).
  if (mux?.kind === 'tmux' && mux.pane) {
    const liveness = await probeAttachRail(s, self);
    if (liveness.state !== 'alive') {
      await fallback(s, undefined, fallbackId);
      return;
    }
    const socket = mux.socket ?? getDefaultSocketPath();
    const { session, window } = await resolveLocalPane(socket, mux.pane);
    if (session && window != null) {
      await runTmux({ socket, args: ['select-window', '-t', `${session}:${window}`], throwOnError: false }).catch(() => {});
    }
    const tgt = session ?? mux.pane;
    if (process.env.TMUX) {
      await runTmux({ socket, args: ['switch-client', '-t', tgt], throwOnError: false }).catch(() => {});
      console.log(chalk.gray(`Switched this tmux client to ${shortId(s)} (${tgt}).`));
      return;
    }
    console.log(chalk.gray(`Attaching ${shortId(s)} (tmux ${tgt}) — Ctrl-b d to detach.`));
    // Repair a legacy/stale pane-died hook before the attach client takes over
    // — the 5-min daemon reconcile that used to cover this was deleted;
    // attach-time repair is what closes the gap now (RUSH-2435).
    if (session) await ensureSessionHookRepaired(session, socket);
    const code = await attachTmux({ socket, args: ['attach-session', '-t', tgt] });
    if (session) await teardownIfAgentExited(session, socket);
    process.exit(code);
  }

  // Path A: local Ghostty — focus its tab (Cmd+N via System Events).
  if (s.host === 'ghostty') {
    let tab: number | undefined;
    try {
      const surfaces = await enumerateGhosttyTabs();
      tab = assignGhosttyTabs([s], surfaces).get(s);
    } catch { /* best-effort */ }
    if (tab != null && tab <= 9) {
      const script =
        `tell application "Ghostty" to activate\n` +
        `delay 0.15\n` +
        `tell application "System Events" to keystroke "${tab}" using command down`;
      await execFileAsync('osascript', ['-e', script]).catch(() => {});
      console.log(chalk.gray(`Focused ${shortId(s)} → Ghostty tab ${tab}.`));
      return;
    }
    await execFileAsync('osascript', ['-e', 'tell application "Ghostty" to activate']).catch(() => {});
    console.log(
      chalk.yellow(`Raised Ghostty for ${shortId(s)}`) +
        chalk.gray(tab != null ? ` — switch to tab ${tab} (Cmd+${tab}).` : " — couldn't pinpoint its tab (same-repo forks are ambiguous); switch tabs manually."),
    );
    return;
  }

  // Path D: no attach rail (headless / plain terminal) → hand off to the fallback.
  await fallback(s, undefined, fallbackId);
}

/** Resolve a local tmux pane id to its session name + window index. */
async function resolveLocalPane(socket: string, pane: string): Promise<{ session?: string; window?: number }> {
  try {
    const res = await runTmux({ socket, args: ['display-message', '-pt', pane, '-p', '#{session_name}\t#{window_index}'], throwOnError: false });
    if (res.code !== 0) return {};
    const [session, win] = res.stdout.trim().split('\t');
    const window = Number.parseInt(win, 10);
    return { session: session || undefined, window: Number.isFinite(window) ? window : undefined };
  } catch {
    return {};
  }
}
