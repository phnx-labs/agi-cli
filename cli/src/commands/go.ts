import chalk from 'chalk';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getActiveSessions, findSessionFileForKind, listTerminalsActive, sessionProcessIsLocal, sessionProcessHost, type ActiveSession } from '../lib/session/active.js';
import { isSessionIdShape } from '../lib/session/pid-registry.js';
import { gatherRemoteActive } from '../lib/session/remote-active.js';
import { discoverSessions } from '../lib/session/discover.js';
import { deriveShortId } from '../lib/session/short-id.js';
import type { SessionMeta, SessionAgentId } from '@phnx-labs/sessions-cli/reader';
import { mergeLocalFirst, pickSessionInteractive, filterSessionsByQuery, formatPickerLabel, pickerColumnsFor, isUniqueEnoughSelector } from './sessions.js';
import { dedupeByMachineSession, matchesLiveStatus, type LiveStatusFilter } from './ps-roster.js';
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
import { editorVariantForHost, focusTabSpecs } from '../lib/terminal/backends/vscodium-agent.js';
import { runLocal } from '../lib/terminal/transport.js';

const execFileAsync = promisify(execFile);

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

export function localLiveSelectorMatches(sessions: ActiveSession[], selector: string): ActiveSession[] {
  const q = selector.toLowerCase();
  return sessions.filter((s) => (s.sessionId ?? '').toLowerCase().startsWith(q));
}

export function shouldSkipRemoteSweep(localMatches: ActiveSession[], selector: string): boolean {
  if (localMatches.length >= 2) return true;
  if (localMatches.length === 1) return isUniqueEnoughSelector(selector);
  return false;
}

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
    } catch {  }
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

export async function pickLiveTargets(
  activeById: Map<string, ActiveSession>,
  self: string,
  message: string,
): Promise<ActiveSession[]> {
  const pool = await buildLivePool(activeById, self);
  if (pool.length === 0) return [];
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

export async function buildLivePool(activeById: Map<string, ActiveSession>, self: string): Promise<SessionMeta[]> {
  let metas: SessionMeta[] = [];
  try {
    metas = await discoverSessions({ all: true, since: '30d', limit: 1000 });
  } catch {  }
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


export interface Where { label: string; action: string; }

function shortId(s: ActiveSession): string {
  return (s.sessionId ?? '').slice(0, 8) || '-';
}

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

export function describeWhere(s: ActiveSession, self: string): Where {
  const remote = sessionProcessHost(s, self);
  const mux = s.provenance?.mux;
  if (mux?.kind === 'tmux' && mux.pane) {
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

export type UnreachableFallback = (s: ActiveSession, remote: string | undefined, fallbackId?: string) => void | Promise<void>;

export type AttachRailLiveness =
  | { state: 'alive' }
  | { state: 'dead'; exitStatus?: number }
  | { state: 'missing' };

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

function isFocusableEditorTab(t: ActiveSession): boolean {
  return !!(editorVariantForHost(t.host) && t.terminalId && t.workspaceDir && t.pidAlive);
}

export function matchEditorTab(s: ActiveSession, self: string, tabs: ActiveSession[]): ActiveSession | undefined {
  const originTab = s.originTerminal?.device === self ? s.originTerminal.terminalId : undefined;
  return tabs.find((t) => isFocusableEditorTab(t) &&
    ((s.sessionId && t.sessionId === s.sessionId) || (originTab && t.terminalId === originTab)));
}

export function editorTabsForSelector(selector: string, tabs: ActiveSession[]): ActiveSession[] {
  return tabs.filter((t) => isFocusableEditorTab(t) && t.sessionId?.startsWith(selector));
}

export async function focusEditorTab(tab: ActiveSession): Promise<void> {
  const variant = editorVariantForHost(tab.host)!;
  for (const spec of focusTabSpecs(variant, tab.workspaceDir!, tab.terminalId!)) {
    const result = await runLocal(spec, 10_000);
    if (!result.ok) throw new Error(`Could not focus ${variant.label} tab ${tab.terminalId}: ${result.error}`);
  }
  console.log(chalk.gray(`Focused ${shortId(tab)} → ${tab.label || tab.topic || tab.terminalId} (${path.basename(tab.workspaceDir!)}).`));
}

export async function focusLocalEditorTab(selector: string): Promise<boolean> {
  const matches = editorTabsForSelector(selector, await listTerminalsActive());
  if (matches.length !== 1) return false;
  await focusEditorTab(matches[0]);
  return true;
}

export async function jumpTo(s: ActiveSession, self: string, fallback: UnreachableFallback = refuseFallback, fallbackId?: string): Promise<void> {
  const tab = matchEditorTab(s, self, await listTerminalsActive());
  if (tab) {
    await focusEditorTab(tab);
    return;
  }
  const remote = sessionProcessHost(s, self);
  const mux = s.provenance?.mux;

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
    await fallback(s, remote, fallbackId);
    return;
  }

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
    if (session) await ensureSessionHookRepaired(session, socket);
    const code = await attachTmux({ socket, args: ['attach-session', '-t', tgt] });
    if (session) await teardownIfAgentExited(session, socket);
    process.exit(code);
  }

  if (s.host === 'ghostty') {
    let tab: number | undefined;
    try {
      const surfaces = await enumerateGhosttyTabs();
      tab = assignGhosttyTabs([s], surfaces).get(s);
    } catch {  }
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

  await fallback(s, undefined, fallbackId);
}

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
