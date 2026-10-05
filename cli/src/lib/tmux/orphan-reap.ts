
import { execFile } from 'child_process';
import * as fsp from 'fs/promises';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const PS_TIMEOUT_MS = 10_000;

const TMUX_QUERY_TIMEOUT_MS = 10_000;

const REAP_GRACE_MS = 2_000;

export const TMUX_SESSION_ENV = 'AGENT_TMUX_SESSION_NAME';

export interface AgentProcess {
  pid: number;
  ppid: number;
  args: string;
  tmuxSession?: string;
}

export interface PaneOwner {
  agentAlive: boolean;
  attached: boolean;
}

type OrphanReason = 'tmux-agent-exited' | 'detached-helper';

interface OrphanCandidate {
  pid: number;
  args: string;
  reason: OrphanReason;
  tmuxSession?: string;
}

interface OrphanReapResult {
  killed: number;
  details: string[];
  candidates: OrphanCandidate[];
  warnings: string[];
}

interface DetachedHelperRule {
  agent: string;
  spawnerPid(args: string): number | undefined;
}

function argv0Basename(args: string): string {
  // Helper rules anchor argv0; a quoted daemon-like substring in live work is not executable identity.
  const m = /^\s*(\S+)/.exec(args);
  const token = m ? m[1] : '';
  const base = token.split(/[\\/]/).pop() ?? '';
  return base.toLowerCase();
}

const CLAUDE_BG_DAEMON: DetachedHelperRule = {
  agent: 'claude',
  spawnerPid(args: string): number | undefined {
    const exe = argv0Basename(args);
    if (exe !== 'claude' && exe !== 'claude.exe') return undefined;
    if (!/\bdaemon\s+run\b/.test(args)) return undefined;
    const m = /--spawned-by\s+.*?"pid"\s*:\s*(\d+)/.exec(args);
    if (!m) return undefined;
    const pid = parseInt(m[1], 10);
    return Number.isFinite(pid) && pid > 1 ? pid : undefined;
  },
};

export const DETACHED_HELPER_RULES: DetachedHelperRule[] = [CLAUDE_BG_DAEMON];

export function isProtectedAgentsService(args: string): boolean {
  // Fleet control, credential broker, and menu processes are never agent-orphan candidates.
  return /\b__daemon-run\b/.test(args)
    || /\bsecrets\s+_agent-run\b/.test(args)
    || /\bAGI Menu\b/.test(args)
    || /\bAgents CLI\.app\b/.test(args);
}

function livePid(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function selectOrphanProcesses(
  procs: AgentProcess[],
  owners: Map<string, PaneOwner>,
  opts: {
    protectedPids: Set<number>;
    isAlive?: (pid: number) => boolean;
    ownersReliable?: boolean;
    livePanePids?: Set<number>;
  },
): OrphanCandidate[] {
  const isAlive = opts.isAlive ?? livePid;
  const ownersReliable = opts.ownersReliable ?? true;
  const eligible = (p: AgentProcess): boolean =>
    p.pid > 1 && !opts.protectedPids.has(p.pid) && !isProtectedAgentsService(p.args);
  const livePaneSubtree = opts.livePanePids && opts.livePanePids.size > 0
    ? new Set(descendantsOf(procs, [...opts.livePanePids]))
    : undefined;
  const ownedByLivePane = (p: AgentProcess): boolean => {
    // Exclude every descendant of every live pane, independent of stale ownership markers.
    if (livePaneSubtree?.has(p.pid)) return true;
    if (!p.tmuxSession) return false;
    const owner = owners.get(p.tmuxSession);
    return !!owner && (owner.agentAlive || owner.attached);
  };

  const out: OrphanCandidate[] = [];
  const seen = new Set<number>();
  const push = (p: AgentProcess, reason: OrphanReason): void => {
    if (seen.has(p.pid)) return;
    seen.add(p.pid);
    out.push({ pid: p.pid, args: p.args, reason, tmuxSession: p.tmuxSession });
  };

  if (ownersReliable) {
    // Tier 1 requires a present owner that is both detached and dead; missing ownership proves nothing.
    for (const p of procs) {
      if (!p.tmuxSession || !eligible(p)) continue;
      const owner = owners.get(p.tmuxSession);
      if (!owner) continue;
      if (owner.attached || owner.agentAlive) continue;
      push(p, 'tmux-agent-exited');
    }
  }

  const seeds: AgentProcess[] = [];
  for (const p of procs) {
    if (!eligible(p) || ownedByLivePane(p)) continue;
    for (const rule of DETACHED_HELPER_RULES) {
      // Detached helpers qualify only when their declared spawner is confirmed dead.
      const spawner = rule.spawnerPid(p.args);
      if (spawner === undefined || isAlive(spawner)) continue;
      seeds.push(p);
      break;
    }
  }
  if (seeds.length > 0) {
    const byPid = new Map(procs.map(p => [p.pid, p]));
    for (const seed of descendantsOf(procs, seeds.map(s => s.pid))) {
      const p = byPid.get(seed);
      if (p && eligible(p)) push(p, 'detached-helper');
    }
  }

  return out;
}

export function descendantsOf(procs: AgentProcess[], seeds: number[]): number[] {
  const children = new Map<number, number[]>();
  for (const p of procs) {
    const list = children.get(p.ppid);
    if (list) list.push(p.pid);
    else children.set(p.ppid, [p.pid]);
  }
  const out: number[] = [];
  const seen = new Set<number>();
  const stack = [...seeds];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    for (const child of children.get(pid) ?? []) stack.push(child);
  }
  return out;
}

export function parseProcessRows(stdout: string): AgentProcess[] {
  const rows: AgentProcess[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const ppid = parseInt(m[2], 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    rows.push({ pid, ppid, args: m[3].trim() });
  }
  return rows;
}

export function parseTmuxSessionMarker(blob: string): string | undefined {
  const m = new RegExp(`(?:^|[\\s\\0])${TMUX_SESSION_ENV}=([A-Za-z0-9_-]{1,64})`).exec(blob);
  return m ? m[1] : undefined;
}

export function parsePaneOwners(stdout: string, isAlive: (pid: number) => boolean = livePid): Map<string, PaneOwner> {
  const owners = new Map<string, PaneOwner>();
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split('\t');
    if (parts.length < 3) continue;
    const name = parts[0];
    if (!name) continue;
    const panePid = parseInt(parts[1], 10);
    const attached = parts[2].trim() !== '0';
    const prev = owners.get(name);
    const agentAlive = Number.isFinite(panePid) && isAlive(panePid);
    owners.set(name, {
      agentAlive: (prev?.agentAlive ?? false) || agentAlive,
      attached: (prev?.attached ?? false) || attached,
    });
  }
  return owners;
}

export function parsePanePids(stdout: string): Set<number> {
  const pids = new Set<number>();
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split('\t');
    if (parts.length < 2) continue;
    const pid = parseInt(parts[1], 10);
    if (Number.isFinite(pid)) pids.add(pid);
  }
  return pids;
}

export async function readAgentProcesses(opts: { pids?: number[] } = {}): Promise<AgentProcess[]> {
  if (process.platform === 'win32') return [];
  const scope = opts.pids && opts.pids.length > 0 ? ['-p', opts.pids.join(',')] : ['-A'];
  const hasProc = await fsp.access('/proc/self/environ').then(() => true, () => false);
  const args = hasProc ? [...scope, '-o', 'pid=,ppid=,args='] : [...scope, '-E', '-o', 'pid=,ppid=,args='];
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('ps', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: PS_TIMEOUT_MS }));
  } catch {
    return [];
  }
  const rows = parseProcessRows(stdout);
  if (!hasProc) {
    for (const row of rows) row.tmuxSession = parseTmuxSessionMarker(row.args);
    return rows;
  }
  for (const row of rows) {
    let blob: string;
    try {
      blob = await fsp.readFile(`/proc/${row.pid}/environ`, 'utf8');
    } catch {
      continue;
    }
    row.tmuxSession = parseTmuxSessionMarker(blob);
  }
  return rows;
}

interface PaneOwnersRead {
  ok: boolean;
  owners: Map<string, PaneOwner>;
  panePids: Set<number>;
}

export async function readPaneOwners(socket: string): Promise<PaneOwnersRead> {
  if (!(await fsp.access(socket).then(() => true, () => false))) return { ok: true, owners: new Map(), panePids: new Set() };
  const { runTmux } = await import('./binary.js');
  try {
    const res = await runTmux({
      socket,
      args: ['list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}\t#{session_attached}'],
      throwOnError: false,
      timeoutMs: TMUX_QUERY_TIMEOUT_MS,
    });
    if (res.code !== 0) return { ok: true, owners: new Map(), panePids: new Set() };
    return { ok: true, owners: parsePaneOwners(res.stdout), panePids: parsePanePids(res.stdout) };
  } catch {
    return { ok: false, owners: new Map(), panePids: new Set() };
  }
}

async function readAllPaneOwners(
  socket: string,
): Promise<{ owners: Map<string, PaneOwner>; panePids: Set<number>; reliable: boolean }> {
  const { getDefaultSocketPath } = await import('./paths.js');
  const merged = new Map<string, PaneOwner>();
  const panePids = new Set<number>();
  let reliable = true;
  for (const sock of new Set([socket, getDefaultSocketPath()].filter(Boolean))) {
    const read = await readPaneOwners(sock);
    reliable = reliable && read.ok;
    for (const pid of read.panePids) panePids.add(pid);
    for (const [name, owner] of read.owners) {
      const prev = merged.get(name);
      merged.set(name, {
        agentAlive: (prev?.agentAlive ?? false) || owner.agentAlive,
        attached: (prev?.attached ?? false) || owner.attached,
      });
    }
  }
  return { owners: merged, panePids, reliable };
}

function selfProtectedPids(procs: AgentProcess[]): Set<number> {
  // Protect the reaper and its full process ancestry from its own destructive selection.
  const byPid = new Map(procs.map(p => [p.pid, p]));
  const out = new Set<number>([process.pid]);
  let cursor = process.ppid;
  for (let i = 0; i <= procs.length && cursor > 1; i += 1) {
    out.add(cursor);
    cursor = byPid.get(cursor)?.ppid ?? 0;
  }
  return out;
}

async function terminate(candidates: OrphanCandidate[], graceMs: number): Promise<number> {
  let signalled = 0;
  for (const c of candidates) {
    try {
      process.kill(c.pid, 'SIGTERM');
      signalled += 1;
    } catch {  }
  }
  if (signalled === 0) return 0;
  await new Promise(resolve => setTimeout(resolve, graceMs));
  for (const c of candidates) {
    if (!livePid(c.pid)) continue;
    try { process.kill(c.pid, 'SIGKILL'); } catch {  }
  }
  return signalled;
}

function describe(c: OrphanCandidate): string {
  const where = c.tmuxSession ? ` [${c.tmuxSession}]` : '';
  return `pid ${c.pid}${where} (${c.reason}): ${c.args.slice(0, 120)}`;
}

export async function reapOrphanAgentProcesses(
  opts: { socket: string; dryRun?: boolean; graceMs?: number; pids?: number[] } = { socket: '' },
): Promise<OrphanReapResult> {
  const result: OrphanReapResult = { killed: 0, details: [], candidates: [], warnings: [] };
  if (process.platform === 'win32') return result;

  const { owners, panePids, reliable } = await readAllPaneOwners(opts.socket);
  if (!reliable) {
    // Query failure disables the ownership tier; an empty map is not proof that sessions vanished.
    result.warnings.push('tier 1 (pane-marker) sweep skipped this tick: a tmux session query failed to answer');
  }
  const procs = await readAgentProcesses({ pids: opts.pids });
  if (procs.length === 0) return result;

  const candidates = selectOrphanProcesses(procs, owners, {
    protectedPids: selfProtectedPids(procs),
    ownersReliable: reliable,
    livePanePids: panePids,
  });
  result.candidates = candidates;
  if (candidates.length === 0) return result;

  result.details = candidates.map(describe);
  if (opts.dryRun) return result;
  result.killed = await terminate(candidates, opts.graceMs ?? REAP_GRACE_MS);
  return result;
}

export async function reapProcessesForTmuxSession(
  name: string,
  socket?: string,
  opts: { dryRun?: boolean; graceMs?: number; pids?: number[] } = {},
): Promise<OrphanReapResult> {
  const result: OrphanReapResult = { killed: 0, details: [], candidates: [], warnings: [] };
  if (process.platform === 'win32') return result;

  const { getDefaultSocketPath } = await import('./paths.js');
  const defaultSocket = getDefaultSocketPath();
  if (socket && socket !== defaultSocket) {
    const elsewhere = await readPaneOwners(defaultSocket);
    const owner = elsewhere.owners.get(name);
    if (owner && (owner.agentAlive || owner.attached)) {
      result.warnings.push(`skipped: "${name}" is a live session on the agents socket, not the one being torn down`);
      return result;
    }
  }

  const procs = await readAgentProcesses({ pids: opts.pids });
  if (procs.length === 0) return result;

  const protectedPids = selfProtectedPids(procs);
  const byPid = new Map(procs.map(p => [p.pid, p]));
  const owned = procs.filter(p => p.tmuxSession === name);
  const candidates: OrphanCandidate[] = [];
  for (const pid of descendantsOf(procs, owned.map(p => p.pid))) {
    const p = byPid.get(pid);
    if (!p || p.pid <= 1 || protectedPids.has(p.pid) || isProtectedAgentsService(p.args)) continue;
    candidates.push({ pid: p.pid, args: p.args, reason: 'tmux-agent-exited', tmuxSession: name });
  }
  result.candidates = candidates;
  if (candidates.length === 0) return result;

  result.details = candidates.map(describe);
  if (opts.dryRun) return result;
  result.killed = await terminate(candidates, opts.graceMs ?? REAP_GRACE_MS);
  return result;
}
