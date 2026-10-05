import * as path from 'path';
import chalk from 'chalk';
import { sessionDisplayAgent, linkUrl, linearIssueUrl } from '@phnx-labs/sessions-cli/reader';
import { toComparablePath, homeDir } from '../lib/platform/index.js';
import {
  getActiveSessions,
  describeActiveDiscoveryHealth,
  sessionProcessIsLocal,
  backfillActiveRowsFromIndex,
  isRunningLiveSession,
  serializeActiveSessionsForJson,
  type ActiveSession,
} from '../lib/session/active.js';
import { enumerateGhosttyTabs, assignGhosttyTabs, type GhosttySurface } from '../lib/session/ghostty-tabs.js';
import { mapPanesToTargets, listClients } from '../lib/tmux/session.js';
import { resolveViewingIn, viewingInLabel } from '../lib/session/viewing-in.js';
import { machineId, normalizeHost } from '../lib/session/sync/config.js';
import { gatherRemoteActive } from '../lib/session/remote-active.js';
import { loadFleetActiveSessions, loadLocalActiveSessions } from '../lib/session/session-cache.js';
import { stringWidth, truncateToWidth, padToWidth, terminalWidth } from '../lib/session/width.js';
import { formatCompactAge } from '../lib/session/relative-time.js';
import { colorAgent } from '../lib/agents.js';
import { fuzzyMatch, FUZZY_PRESETS } from '../lib/fuzzy.js';
import { listBookmarks } from '../lib/session/bookmarks.js';
import { formatTodoCompact, githubRepoUrlFromCwd } from './sessions-picker.js';
import { isInteractiveTerminal } from './utils.js';

export interface LiveStatusFlags {
  working?: boolean;
  idle?: boolean;
  waiting?: boolean;
  orphan?: boolean;
  orphaned?: boolean;
  crashed?: boolean;
  closed?: boolean;
  abandoned?: boolean;
  queued?: boolean;
  unknown?: boolean;
}

function shortCwd(cwd?: string): string {
  if (!cwd) return '-';
  const home = homeDir();
  return toComparablePath(cwd).startsWith(toComparablePath(home))
    ? '~' + cwd.slice(home.length)
    : cwd;
}

export function statusColor(status: ActiveSession['status']): (s: string) => string {
  switch (status) {
    case 'running': return chalk.green;
    case 'idle': return chalk.gray;
    case 'queued': return chalk.blue;
    case 'input_required': return chalk.yellow;
    case 'closed': return chalk.dim;
    case 'abandoned': return chalk.red;
    case 'crashed': return chalk.redBright;
    case 'orphaned': return chalk.yellow;
    case 'unknown': return chalk.magenta;
  }
}

export function cleanPreview(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/<\/?(?:local-command-stdout|command-name|command-message|command-args|task-notification|system-reminder)>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildSessionDescription(s: ActiveSession): string {
  const todo = formatTodoCompact(s.todos);
  if (s.context === 'cloud') {
    const base = s.preview || `${s.cloudProvider ?? ''}${s.cloudTaskId ? ` · ${s.cloudTaskId.slice(0, 12)}` : ''}`;
    return cleanPreview([todo, base].filter(Boolean).join(' · '));
  }
  if (s.context === 'teams') {
    const parts = [s.teamName];
    if (s.label && s.label !== s.teamName) parts.push(s.label);
    const orch = s.orchestratorLabel || (s.orchestratorSessionId ? s.orchestratorSessionId.slice(0, 8) : '');
    if (orch) parts.push(`by ${orch}`);
    if (todo) parts.push(todo);
    const target = s.preview || s.assignedTask || s.topic;
    if (target) parts.push(target);
    return cleanPreview(parts.filter(Boolean).join(' · '));
  }

  // ladder-exempt: compact live preview base, not the row's headline.
  const base = s.preview || s.label || s.topic || '';
  return cleanPreview([todo, base].filter(Boolean).join(' · '));
}

export function formatActiveRowDescription(s: ActiveSession): string {
  const parts: string[] = [];
  const pushText = (t?: string) => {
    const c = t ? cleanPreview(t) : '';
    if (c) parts.push(c);
  };
  if (s.context === 'teams' && s.teamName) pushText(s.teamName);
  if (s.label) pushText(s.label);
  const project = s.cwd ? path.basename(s.cwd) : '';
  if (project && project !== s.label && project !== s.teamName) {
    const label = cleanPreview(project);
    const repoUrl = githubRepoUrlFromCwd(s.cwd);
    parts.push(repoUrl ? linkUrl(repoUrl, label) : label);
  }
  const todo = formatTodoCompact(s.todos);
  if (todo) parts.push(todo);

  if (s.preview) {
    pushText(s.preview);
  } else if (!s.label && s.topic) {
    pushText(s.topic);
  }
  return parts.filter(Boolean).join(' · ');
}

function activityLabel(s: ActiveSession): string {
  if (s.status === 'closed' || s.status === 'abandoned') return s.status;
  if (s.status === 'crashed') return 'crashed';
  if (s.status === 'orphaned') return 'orphan';
  if (s.activity === 'waiting_input') return 'waiting';
  if (s.activity === 'working') return 'working';
  if (s.activity === 'idle') return 'idle';
  return s.status === 'input_required' ? 'waiting' : s.status;
}

export function indexActiveBySessionId(active: ActiveSession[]): Map<string, ActiveSession> {
  const byId = new Map<string, ActiveSession>();
  for (const a of active) {
    if (a.sessionId) byId.set(a.sessionId, a);
  }
  return byId;
}


export function liveGlyphAndPreview(a: ActiveSession | undefined): { glyph: string; preview: string } {
  if (!a) return { glyph: '', preview: '' };
  if (a.status === 'abandoned') return { glyph: statusColor(a.status)('⊘'), preview: buildSessionDescription(a) };
  if (a.status === 'closed') return { glyph: statusColor(a.status)('×'), preview: buildSessionDescription(a) };
  if (a.status === 'crashed') return { glyph: statusColor(a.status)('✗'), preview: buildSessionDescription(a) };
  if (a.status === 'orphaned') return { glyph: statusColor(a.status)('◍'), preview: buildSessionDescription(a) };

  const waiting = a.status === 'input_required' || a.activity === 'waiting_input';
  const running = a.status === 'running' || a.activity === 'working';
  const unknown = a.status === 'unknown';
  const shape =
    waiting ? '◐'
      : running ? '●'
        : unknown ? '◌'
          : '○';
  return { glyph: statusColor(a.status)(shape), preview: buildSessionDescription(a) };
}

export function liveStatusWord(a: ActiveSession | undefined): string {
  if (!a) return '';
  if (a.status === 'closed' || a.status === 'abandoned') return a.status;
  if (a.status === 'crashed') return 'crashed';
  if (a.status === 'orphaned') return 'orphan';
  if (a.status === 'input_required' || a.activity === 'waiting_input') return 'waiting';
  if (a.status === 'running' || a.activity === 'working') return 'working';
  if (a.status === 'idle' || a.activity === 'idle') return 'idle';
  if (a.status === 'queued') return 'queued';
  return '';
}

export function isAwaitingUser(s: ActiveSession): boolean {
  if (s.status === 'crashed' || s.status === 'closed') return false;

  if (s.status === 'abandoned' && s.pidAlive !== true) return false;
  return s.status === 'input_required' || s.activity === 'waiting_input';
}


export function signalBadges(s: Pick<ActiveSession, 'awaitingReason' | 'pr' | 'worktree' | 'ticket'>): string {
  const parts: string[] = [];
  if (s.awaitingReason === 'plan_review') parts.push(chalk.yellow('plan'));
  else if (s.awaitingReason === 'question') parts.push(chalk.yellow('ask'));
  else if (s.awaitingReason === 'permission') parts.push(chalk.yellow('perm'));
  if (s.ticket) {
    const url = linearIssueUrl(s.ticket.id);
    parts.push(chalk.cyan(url ? linkUrl(url, s.ticket.id) : s.ticket.id));
  }
  if (s.pr) {
    const label = `PR#${s.pr.number ?? '?'}`;
    parts.push(chalk.blue(s.pr.url ? linkUrl(s.pr.url, label) : label));
  }
  if (s.worktree) parts.push(chalk.magenta(`wt:${s.worktree.slug}`));
  return parts.join(' ');
}

function locatorBadge(s: ActiveSession): string {
  const p = s.provenance;
  const parts: string[] = [];
  if (p?.transport === 'ssh') parts.push(chalk.red(p.origin ? `ssh←${p.origin.device}` : 'ssh'));
  if (p?.mux?.kind === 'tmux' && (s.tmuxTarget || p.mux.pane)) {
    parts.push(chalk.green(s.tmuxTarget ?? p.mux.pane!));
    const label = viewingInLabel(s);
    if (label) parts.push(chalk.gray(label === 'detached' ? label : `viewing in ${label}`));
  } else if (p?.mux?.kind === 'screen') {
    parts.push(chalk.green('screen'));
  }
  if (s.ghosttyTab != null) parts.push(chalk.green(`tab ${s.ghosttyTab}`));
  if (s.context === 'cloud') {
    const bits = [s.cloudProvider, s.cloudTaskId ? s.cloudTaskId.slice(0, 12) : undefined].filter(Boolean);
    if (bits.length) parts.push(chalk.dim(bits.join(' · ')));
  } else if (typeof s.pid === 'number' && s.pid > 0) {
    parts.push(chalk.dim(`${s.machine ? `${s.machine}:` : ''}pid ${s.pid}`));
  }
  return parts.join(' ');
}

function activeTimeCell(s: ActiveSession): string {
  const parts: string[] = [];
  if (s.startedAtMs) parts.push(`created ${formatCompactAge(new Date(s.startedAtMs).toISOString())}`);
  if (s.lastActivityMs) parts.push(`idle ${formatCompactAge(new Date(s.lastActivityMs).toISOString())}`);
  return parts.join(' · ');
}

const ROW_ID_W = 9;
const ROW_AGENT_W = 8;
const ROW_VERSION_W = 8;
const ROW_STATUS_W = 9;
const ROW_OWNER_W = 9;

function fitCell(content: string, room: number): string {
  if (room <= 0) return '';
  return stringWidth(content) <= room ? content : truncateToWidth(content, room);
}

export function renderActiveRowLines(s: ActiveSession, indent: string, termW: number): string[] {
  const idCol = chalk.dim(padToWidth((s.sessionId?.slice(0, 8)) ?? '-', ROW_ID_W));
  const shownKind = sessionDisplayAgent({ agent: s.kind, harness: s.harness });
  const kindCol = colorAgent(shownKind)(padToWidth(truncateToWidth(shownKind, ROW_AGENT_W), ROW_AGENT_W + 1));
  const versionCol = chalk.gray(padToWidth(truncateToWidth(s.version ?? '', ROW_VERSION_W), ROW_VERSION_W + 1));
  const statusCol = statusColor(s.status)(padToWidth(truncateToWidth(activityLabel(s), ROW_STATUS_W - 1), ROW_STATUS_W));
  const ownerCol = chalk.cyan(padToWidth(truncateToWidth(ownerLabel(s), ROW_OWNER_W - 1), ROW_OWNER_W));
  const fixedCols = idCol + kindCol + versionCol + statusCol + ownerCol;
  const fixedW = stringWidth(indent) + ROW_ID_W + (ROW_AGENT_W + 1) + (ROW_VERSION_W + 1) + ROW_STATUS_W + ROW_OWNER_W;
  const remaining = Math.max(0, termW - fixedW - 1);

  const fork = s.pidCount && s.pidCount > 1 ? chalk.dim(`×${s.pidCount} `) : '';
  const badgesCell = fitCell(fork + signalBadges(s), remaining);
  const badgesW = stringWidth(badgesCell);
  const timeRoom = Math.max(0, remaining - (badgesW ? badgesW + 2 : 0));
  const timeCell = chalk.gray(truncateToWidth(activeTimeCell(s), timeRoom));
  let right = timeCell;
  if (badgesCell) right += (stringWidth(timeCell) ? '  ' : '') + badgesCell;
  let line1 = indent + fixedCols + right;
  if (stringWidth(line1) > termW) line1 = truncateToWidth(line1, termW);
  const lines = [line1];

  const contIndent = indent + ' '.repeat(ROW_ID_W);
  const desc = formatActiveRowDescription(s);
  const loc = locatorBadge(s);
  if (desc || loc) {
    const room2 = Math.max(0, termW - stringWidth(contIndent) - 2);
    const locCell = fitCell(loc, room2);
    const locW = stringWidth(locCell);
    const descRoom = Math.max(0, room2 - (locW ? locW + 2 : 0));
    const descCell = chalk.white(fitCell(desc || '-', descRoom));
    let line2 = contIndent + chalk.dim('└ ') + descCell;
    if (locCell) line2 += '  ' + locCell;
    if (stringWidth(line2) > termW) line2 = truncateToWidth(line2, termW);
    lines.push(line2);
  }

  const important = s.importantMessage;
  if (important && (important.kind === 'question' || important.kind === 'needs_you')) {
    const glyph = important.kind === 'question' ? '? ' : '! ';
    const room3 = Math.max(0, termW - stringWidth(contIndent) - 2 - glyph.length);
    const msgCell = fitCell(cleanPreview(important.text), room3);
    if (msgCell) {
      let line3 = contIndent + chalk.dim(glyph + msgCell);
      if (stringWidth(line3) > termW) line3 = truncateToWidth(line3, termW);
      lines.push(line3);
    }
  }
  return lines;
}

function printActiveRow(s: ActiveSession, indent: string): void {
  for (const line of renderActiveRowLines(s, indent, terminalWidth())) console.log(line);
}

export function ownerLabel(s: ActiveSession): string {
  const owner = s.owner;
  if (!owner || owner.startsWith('UNRESOLVED@')) return '-';
  const at = owner.indexOf('@');
  return at > 0 ? owner.slice(0, at) : owner;
}

function shortWindowLabel(windowId: string): string {
  const m = windowId.match(/-(\d+)$/);
  return m ? `ext-pid ${m[1]}` : `win ${windowId.slice(0, 8)}`;
}

interface ActiveSessionsLayout {
  workspaces: Array<{
    key: string;
    total: number;
    windows: Array<{ windowId: string; sessions: ActiveSession[] }>;
    flat: ActiveSession[];
  }>;
}

export function groupActiveSessions(sessions: ActiveSession[]): ActiveSessionsLayout {
  const byWorkspace = new Map<string, ActiveSession[]>();
  for (const s of sessions) {
    const key = s.cwd ?? (s.context === 'cloud' ? '__cloud__' : '__unknown__');
    const list = byWorkspace.get(key) || [];
    list.push(s);
    byWorkspace.set(key, list);
  }
  const sortedKeys = Array.from(byWorkspace.keys()).sort((a, b) => {
    const aCount = byWorkspace.get(a)!.length;
    const bCount = byWorkspace.get(b)!.length;
    if (aCount !== bCount) return bCount - aCount;
    return a.localeCompare(b);
  });
  const workspaces = sortedKeys.map((key) => {
    const group = byWorkspace.get(key)!;
    const windowedSessions: ActiveSession[] = [];
    const flat: ActiveSession[] = [];
    for (const s of group) {
      if (s.context === 'terminal' && s.windowId) windowedSessions.push(s);
      else flat.push(s);
    }
    const byWindow = new Map<string, ActiveSession[]>();
    for (const s of windowedSessions) {
      const list = byWindow.get(s.windowId!) || [];
      list.push(s);
      byWindow.set(s.windowId!, list);
    }
    const windowKeys = Array.from(byWindow.keys()).sort((a, b) => {
      const aStart = Math.min(...byWindow.get(a)!.map(s => s.startedAtMs ?? Infinity));
      const bStart = Math.min(...byWindow.get(b)!.map(s => s.startedAtMs ?? Infinity));
      return aStart - bStart;
    });
    return {
      key,
      total: group.length,
      windows: windowKeys.map((wid) => ({ windowId: wid, sessions: byWindow.get(wid)! })),
      flat,
    };
  });
  return { workspaces };
}

interface MachineGroup {
  machine: string;
  isLocal: boolean;
  total: number;
  layout: ActiveSessionsLayout;
}

interface MachineGroupedLayout {
  machines: MachineGroup[];
}

const CLOUD_MACHINE_KEY = 'cloud';

function machineKeyFor(s: ActiveSession, localMachine: string): string {
  if (s.context === 'cloud') return CLOUD_MACHINE_KEY;
  if (s.machine) return s.machine;
  if (s.provenance?.host) return normalizeHost(s.provenance.host);
  return localMachine;
}

export function groupSessionsByMachine(sessions: ActiveSession[], localMachine: string): MachineGroupedLayout {
  const byMachine = new Map<string, ActiveSession[]>();
  for (const s of sessions) {
    const key = machineKeyFor(s, localMachine);
    (byMachine.get(key) ?? byMachine.set(key, []).get(key)!).push(s);
  }
  const keys = Array.from(byMachine.keys()).sort((a, b) => {
    if (a === localMachine) return -1;
    if (b === localMachine) return 1;
    if (a === CLOUD_MACHINE_KEY) return 1;
    if (b === CLOUD_MACHINE_KEY) return -1;
    const ac = byMachine.get(a)!.length, bc = byMachine.get(b)!.length;
    if (ac !== bc) return bc - ac;
    return a.localeCompare(b);
  });
  const machines = keys.map((machine) => ({
    machine,
    isLocal: machine === localMachine,
    total: byMachine.get(machine)!.length,
    layout: groupActiveSessions(byMachine.get(machine)!),
  }));
  return { machines };
}

export function dedupeByMachineSession(sessions: ActiveSession[]): ActiveSession[] {
  const seen = new Map<string, number>();
  const out: ActiveSession[] = [];
  for (const s of sessions) {
    if (!s.sessionId) { out.push(s); continue; }
    const key = `${s.machine ?? ''}:${s.sessionId}`;
    const at = seen.get(key);
    if (at === undefined) {
      seen.set(key, out.length);
      out.push(s);
      continue;
    }
    if (out[at].offloadedFrom && !s.offloadedFrom) out[at] = s;
  }
  return out;
}

export function filterActiveSessionsByHostScope(
  sessions: ActiveSession[],
  hosts: string[] | undefined,
  self: string,
): ActiveSession[] {
  if (!hosts || hosts.length === 0) return sessions;
  const wanted = new Set(hosts.map(hostToken));
  return sessions.filter((s) => wanted.has(s.machine ?? self));
}

function groupTally(sessions: ActiveSession[]): string {
  const running = sessions.filter(s => s.status === 'running').length;
  const idle = sessions.filter(s => s.status === 'idle').length;
  const waiting = sessions.filter(s => s.status === 'input_required').length;
  const queued = sessions.filter(s => s.status === 'queued').length;
  const closed = sessions.filter(s => s.status === 'closed').length;
  const abandoned = sessions.filter(s => s.status === 'abandoned').length;
  const orphaned = sessions.filter(s => s.status === 'orphaned').length;
  const crashed = sessions.filter(s => s.status === 'crashed').length;
  const unknown = sessions.filter(s => s.status === 'unknown').length;
  const parts: string[] = [];
  if (running) parts.push(`${running} running`);
  if (idle) parts.push(`${idle} idle`);
  if (waiting) parts.push(`${waiting} waiting`);
  if (queued) parts.push(`${queued} queued`);
  if (closed) parts.push(`${closed} closed`);
  if (abandoned) parts.push(`${abandoned} abandoned`);
  if (orphaned) parts.push(`${orphaned} orphaned`);
  if (crashed) parts.push(`${crashed} crashed`);
  if (unknown) parts.push(`${unknown} unknown`);
  return parts.join(' · ');
}

function renderWorkspaceLayout(layout: ActiveSessionsLayout, base: string, machineKey?: string): void {
  let first = true;
  for (const ws of layout.workspaces) {
    if (!first) console.log();
    first = false;

    const redundantCloud = ws.key === '__cloud__' && machineKey === CLOUD_MACHINE_KEY;
    const rowBase = redundantCloud ? base : base + '  ';
    if (!redundantCloud) {
      const header = ws.key === '__cloud__'
        ? chalk.magenta.bold('cloud')
        : ws.key === '__unknown__'
          ? chalk.gray.bold('unknown')
          : chalk.cyan.bold(shortCwd(ws.key));
      const wsSessions = [...ws.windows.flatMap(w => w.sessions), ...ws.flat];
      const tally = groupTally(wsSessions);
      console.log(`${base}${header} ${chalk.gray(`(${ws.total})`)}${tally ? chalk.gray(`  ${tally}`) : ''}`);
    }

    for (const win of ws.windows) {
      const host = win.sessions.find((s) => s.host)?.host ?? 'terminal';
      const winHeader = `${chalk.gray(host)} ${chalk.gray('·')} ${chalk.gray(shortWindowLabel(win.windowId))} ${chalk.gray(`(${win.sessions.length})`)}`;
      console.log(rowBase + winHeader);
      for (const s of win.sessions) printActiveRow(s, rowBase + '  ');
    }

    for (const s of ws.flat) printActiveRow(s, rowBase);
  }
}

function printMachineHeader(mg: MachineGroup): void {
  const isCloud = mg.machine === CLOUD_MACHINE_KEY;
  const marker = mg.isLocal ? chalk.cyan('▸ ') : isCloud ? chalk.magenta('▸ ') : chalk.gray('▸ ');
  const name = mg.isLocal ? chalk.bold.cyan(mg.machine) : isCloud ? chalk.bold.magenta(mg.machine) : chalk.bold(mg.machine);
  const here = mg.isLocal ? chalk.cyan('  ← this machine') : '';
  console.log(`${marker}${name} ${chalk.gray(`(${mg.total})`)}${here}`);
}

async function enrichLocalLocators(local: ActiveSession[]): Promise<void> {
  try {
    const ghostty = local.filter(s => s.host === 'ghostty' && s.provenance?.transport !== 'ssh');
    if (ghostty.length > 0) {
      const surfaces = await enumerateGhosttyTabs();
      for (const [sess, tab] of assignGhosttyTabs(ghostty, surfaces)) sess.ghosttyTab = tab;
    }
  } catch {  }

  await enrichTmuxLocators(local, await enumerateGhosttyTabsQuietly());
}

async function enumerateGhosttyTabsQuietly(): Promise<GhosttySurface[]> {
  try {
    return await enumerateGhosttyTabs();
  } catch {
    return [];
  }
}

async function enrichTmuxLocators(local: ActiveSession[], surfaces: GhosttySurface[] = []): Promise<void> {
  try {
    const tmux = local.filter(s => s.provenance?.mux?.kind === 'tmux' && s.provenance.mux.pane);
    if (tmux.length > 0) {
      const sockets = new Set(tmux.map(s => s.provenance!.mux!.socket));
      for (const socket of sockets) {
        const paneMap = await mapPanesToTargets(socket);
        if (paneMap.size === 0) continue;
        const clients = await listClients(socket);
        for (const s of tmux) {
          if (s.provenance!.mux!.socket !== socket) continue;
          const target = paneMap.get(s.provenance!.mux!.pane!);
          if (target) s.tmuxTarget = target;
          s.viewingIn = await resolveViewingIn(s, clients, { paneToTarget: paneMap, ghosttySurfaces: surfaces });
        }
      }
    }
  } catch {  }
}

function hostToken(h: string): string {
  return normalizeHost(h.split('@').pop() || h);
}

export function shouldIncludeLocal(hosts: string[] | undefined, self: string): boolean {
  if (!hosts || hosts.length === 0) return true;
  return hosts.some(h => hostToken(h) === self);
}

export function remoteHostsToDial(hosts: string[] | undefined, self: string): string[] | undefined {
  if (!hosts || hosts.length === 0) return undefined;
  return hosts.filter(h => hostToken(h) !== self);
}

export async function gatherActiveSessions(
  opts: { local?: boolean; hosts?: string[]; forceRefresh?: boolean } = {},
): Promise<{
  sessions: ActiveSession[];
  remoteDeviceCount: number;
  remoteSkipped?: string[];
  remoteDiscoveryFailed?: boolean;
}> {
  const forceRefresh = opts.forceRefresh === true
    || process.env.AGENTS_SESSIONS_FORCE_REFRESH === '1';
  const scoped = (opts.hosts?.length ?? 0) > 0;

  if (opts.local && !scoped) {
    const loaded = await loadLocalActiveSessions({ forceRefresh });

    const self = machineId();
    for (const s of loaded.sessions) if (!s.machine) s.machine = self;
    return { sessions: loaded.sessions, remoteDeviceCount: 0 };
  }

  if (!opts.local && !scoped) {
    const loaded = await loadFleetActiveSessions({
      forceRefresh,
      gather: () => gatherActiveSessionsLive({ local: false }),
    });
    return {
      sessions: loaded.sessions,
      remoteDeviceCount: loaded.remoteDeviceCount,
      remoteSkipped: loaded.remoteSkipped,
      remoteDiscoveryFailed: loaded.remoteDiscoveryFailed,
    };
  }

  return gatherActiveSessionsLive(opts);
}

async function gatherActiveSessionsLive(
  opts: { local?: boolean; hosts?: string[] } = {},
): Promise<{
  sessions: ActiveSession[];
  remoteDeviceCount: number;
  remoteSkipped: string[];
  remoteDiscoveryFailed: boolean;
}> {
  const self = machineId();
  const local = shouldIncludeLocal(opts.hosts, self)
    ? await getActiveSessions({ localOnly: opts.local })
    : [];
  for (const s of local) if (!s.machine) s.machine = self;

  let remoteDeviceCount = 0;
  let remoteSkipped: string[] = [];
  let remoteDiscoveryFailed = false;
  let merged = local;
  if (!opts.local) {
    const remoteHosts = remoteHostsToDial(opts.hosts, self);
    if (!opts.hosts?.length || (remoteHosts && remoteHosts.length > 0)) {
      const remote = await gatherRemoteActive(remoteHosts);
      remoteDeviceCount = remote.deviceCount;
      remoteSkipped = remote.skipped;
      remoteDiscoveryFailed = remote.discoveryFailed;
      merged = dedupeByMachineSession([...local, ...remote.sessions]);
    }
  }
  return {
    sessions: filterActiveSessionsByHostScope(merged, opts.hosts, self),
    remoteDeviceCount,
    remoteSkipped,
    remoteDiscoveryFailed,
  };
}

async function describeEmptyActiveDiscovery(
  opts: { local?: boolean; hosts?: string[] },
  remoteSkipped: string[] | undefined,
  remoteDiscoveryFailed: boolean | undefined,
): Promise<string> {
  const parts: string[] = [];
  if (!opts.hosts?.length || opts.local) {
    const health = await describeActiveDiscoveryHealth();
    if (health.degradedSources.length > 0) {
      parts.push(`local discovery is degraded (${health.degradedSources.join(', ')} unreachable) — sessions may be hidden, run \`agents doctor\` to diagnose`);
    }
  }
  if (remoteDiscoveryFailed) {
    parts.push('the device list could not be loaded — no peer was reachable to sweep');
  } else if (remoteSkipped && remoteSkipped.length > 0) {
    parts.push(`${remoteSkipped.length} peer(s) went unheard (${remoteSkipped.join(', ')}) — sessions there may be hidden`);
  }
  if (parts.length === 0) return 'No active agent sessions.';
  return `No active agent sessions found, but discovery was degraded: ${parts.join('; ')}.`;
}

export async function renderActiveSessions(
  asJson: boolean,
  waitingOnly = false,
  opts: {
    local?: boolean;
    hosts?: string[];
    bookmarksOnly?: boolean;
    statuses?: LiveStatusFilter[];
    routine?: boolean | string;
  } = {},
): Promise<void> {
  const self = machineId();
  const gathered = await gatherActiveSessions(opts);
  const { remoteDeviceCount, remoteSkipped, remoteDiscoveryFailed } = gathered;
  backfillActiveRowsFromIndex(gathered.sessions);
  const merged = opts.bookmarksOnly
    ? gathered.sessions.filter((s) => !!s.sessionId && listBookmarks().has(s.sessionId))
    : gathered.sessions;
  const routineFiltered = filterActiveSessionsByRoutine(merged, opts.routine);

  const statusFiltered = opts.statuses?.length
    ? routineFiltered.filter((session) => opts.statuses!.some((status) => matchesLiveStatus(session, status)))
    : routineFiltered.filter(isRunningLiveSession);
  const sessions = statusFiltered;

  if (asJson) {
    await enrichTmuxLocators(sessions.filter(s => sessionProcessIsLocal(s, self)));
    process.stdout.write(JSON.stringify(serializeActiveSessionsForJson(sessions), null, 2) + '\n');
    if (waitingOnly && sessions.some(isAwaitingUser)) process.exitCode = 1;
    return;
  }

  if (sessions.length === 0) {
    if (waitingOnly) {
      console.log(chalk.gray('No sessions waiting on input.'));
      return;
    }
    console.log(chalk.gray(await describeEmptyActiveDiscovery(opts, remoteSkipped, remoteDiscoveryFailed)));
    if (!opts.local && !opts.hosts?.length && remoteDeviceCount === 0) printCrossMachineTip();
    return;
  }

  await enrichLocalLocators(sessions.filter(s => sessionProcessIsLocal(s, self)));

  const grouped = groupSessionsByMachine(sessions, self);
  let firstMachine = true;
  for (const mg of grouped.machines) {
    if (!firstMachine) console.log();
    firstMachine = false;
    printMachineHeader(mg);
    renderWorkspaceLayout(mg.layout, '  ', mg.machine);
  }

  const parts = groupTally(sessions).split(' · ').filter(Boolean);
  const realMachines = grouped.machines.filter((m) => m.machine !== CLOUD_MACHINE_KEY).length;
  const hasCloud = grouped.machines.some((m) => m.machine === CLOUD_MACHINE_KEY);
  const machineWord = realMachines === 1 ? 'machine' : 'machines';
  const cloudNote = hasCloud ? ' + cloud' : '';
  console.log(chalk.gray(`\n${sessions.length} active (${parts.join(', ')}) across ${realMachines} ${machineWord}${cloudNote}.`));

  if (!opts.local && !opts.hosts?.length && remoteDeviceCount === 0) printCrossMachineTip();

  if (waitingOnly && sessions.some(isAwaitingUser)) process.exitCode = 1;
}

export function filterActiveSessionsByRoutine(
  sessions: ActiveSession[],
  routine: boolean | string | undefined,
): ActiveSession[] {
  if (!routine) return sessions;
  const routineSessions = sessions.filter((session) =>
    session.origin === 'routine' || !!session.routineName,
  );
  if (typeof routine !== 'string') return routineSessions;
  const names = [...new Set(
    routineSessions.map((session) => session.routineName).filter((name): name is string => !!name),
  )];
  const selected = resolveRoutineName(routine, names);
  return selected
    ? routineSessions.filter((session) => session.routineName === selected)
    : [];
}

export type LiveStatusFilter =
  | 'working'
  | 'idle'
  | 'waiting'
  | 'orphaned'
  | 'crashed'
  | 'closed'
  | 'abandoned'
  | 'queued'
  | 'unknown';

export function matchesLiveStatus(session: ActiveSession, status: LiveStatusFilter): boolean {
  if (status === 'working') return session.activity === 'working' || (!session.activity && session.status === 'running');
  if (status === 'waiting') return isAwaitingUser(session);
  return session.status === status;
}

export function requestedLiveStatuses(options: LiveStatusFlags): LiveStatusFilter[] {
  const statuses: LiveStatusFilter[] = [];
  if (options.working) statuses.push('working');
  if (options.idle) statuses.push('idle');
  if (options.waiting) statuses.push('waiting');
  if (options.orphan || options.orphaned) statuses.push('orphaned');
  if (options.crashed) statuses.push('crashed');
  if (options.closed) statuses.push('closed');
  if (options.abandoned) statuses.push('abandoned');
  if (options.queued) statuses.push('queued');
  if (options.unknown) statuses.push('unknown');
  return [...new Set(statuses)];
}

function printCrossMachineTip(): void {
  console.log(chalk.gray(
    "\nTip: include sessions from your other machines — register them with 'ag devices sync', then rerun. Use --local to skip.",
  ));
}
export function resolveRoutineName(query: string, names: readonly string[]): string | null {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return null;
  const exact = names.find((name) => name.toLowerCase() === normalized);
  if (exact) return exact;
  const containing = names.filter((name) => name.toLowerCase().includes(normalized));
  if (containing.length === 1) return containing[0];
  return fuzzyMatch(query, names, FUZZY_PRESETS.dynamic);
}


export interface LiveRosterOptions extends LiveStatusFlags {
  json?: boolean;
  interactive?: boolean;
  local?: boolean;
  host?: string[];
  teams?: boolean;
  agent?: string;
  since?: string;
  until?: string;
  all?: boolean;
  bookmarks?: boolean;
  routine?: boolean | string;
  project?: string;
  sort?: string;
}

export async function runLiveRoster(options: LiveRosterOptions): Promise<void> {
  const liveStatuses = requestedLiveStatuses(options);
  const hosts = options.host;
  const interactive = options.interactive !== false && !options.json && isInteractiveTerminal();
  if (
    interactive &&
    liveStatuses.length === 0 &&
    !options.until &&
    !options.project &&
    !options.sort &&
    (hosts?.length ?? 0) <= 1 &&
    process.env.AGENTS_SESSIONS_LOCAL !== '1'
  ) {
    const { runSessionBrowser, activeBrowserSeed } = await import('./sessions-browser.js');
    await runSessionBrowser(
      activeBrowserSeed({
        teams: options.teams,
        agent: options.agent,
        host: hosts,
        since: options.since,
        all: options.all,
        bookmarks: options.bookmarks,
        routine: options.routine,
      }),
      { local: options.local === true, hosts },
    );
    return;
  }
  const forceLocal = options.local === true || process.env.AGENTS_SESSIONS_LOCAL === '1';
  await renderActiveSessions(options.json === true, options.waiting === true, {
    local: forceLocal,
    hosts,
    bookmarksOnly: options.bookmarks === true,
    statuses: liveStatuses,
    routine: options.routine,
  });
}
