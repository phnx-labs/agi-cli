
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runTmux, TmuxCommandError } from './binary.js';
import { ensureTmuxDir, getDefaultSocketPath, getSessionMetaPath } from './paths.js';

const VALID_NAME = /^[A-Za-z0-9_-]{1,64}$/;

// Bound long-running agent panes without truncating ordinary interactive scrollback.
export const AGENTS_TMUX_HISTORY_LIMIT = 20_000;

// Any generated-config change requires a schema bump so existing shared servers re-source it.
export const AGENTS_TMUX_CONFIG_SCHEMA = 1;
const CONFIG_SCHEMA_OPTION = '@ag_tmux_config_schema';

const SESSION_ID_OPTION = '@ag_session_id';
const AGENT_NAME_OPTION = '@ag_agent';

let startupConfigSequence = 0;

function tmuxConfigArgument(value: string): string {
  return `"${value.replace(/([\\"$])/g, '\\$1')}"`;
}

export function userConfigSourceLine(value: string): string {
  return `source-file ${tmuxConfigArgument(value)}`;
}

function writeStartupConfig(env: NodeJS.ProcessEnv | undefined): string {
  const effectiveEnv = env ?? process.env;
  const home = effectiveEnv.HOME ?? os.homedir();
  const candidates = [
    path.join(home, '.tmux.conf'),
    ...(effectiveEnv.XDG_CONFIG_HOME
      ? [path.join(effectiveEnv.XDG_CONFIG_HOME, 'tmux', 'tmux.conf')]
      : []),
    path.join(home, '.config', 'tmux', 'tmux.conf'),
  ];
  const userConfigs = candidates.filter((candidate) => fs.existsSync(candidate));
  const startupConfig = path.join(
    ensureTmuxDir(),
    `startup-${process.pid}-${startupConfigSequence++}.conf`,
  );
  const lines = [
    // Cold start stamps the schema before the post-create reconciliation check.
    `set-option -g ${CONFIG_SCHEMA_OPTION} ${AGENTS_TMUX_CONFIG_SCHEMA}`,
    'set-option -g mouse on',
    'set-option -s set-clipboard on',
    `set-option -g history-limit ${AGENTS_TMUX_HISTORY_LIMIT}`,
    'bind-key -T copy-mode MouseDragEnd1Pane send-keys -X copy-selection-no-clear',
    'bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-selection-no-clear',
  ];
  // Source every existing user config after defaults; tmux parse failures remain loud.
  for (const userConfig of userConfigs) {
    lines.push(userConfigSourceLine(userConfig));
  }
  fs.writeFileSync(startupConfig, `${lines.join('\n')}\n`, { mode: 0o600 });
  return startupConfig;
}

export interface SessionMeta {
  name: string;
  socket: string;
  createdAt: number;
  cmd?: string;
  cwd?: string;
  source: 'cli' | 'extension' | 'teams' | 'external';
  labels?: Record<string, string>;
  pane?: string;
}

export interface CreateSessionOptions {
  name: string;
  cmd?: string;
  metaCmd?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  socket?: string;
  source?: SessionMeta['source'];
  labels?: Record<string, string>;
  replace?: boolean;
  attachExisting?: boolean;
  width?: number;
  height?: number;
}

export interface ListedSession {
  name: string;
  socket: string;
  createdAtTmux: number;
  windows: number;
  attached: boolean;
  meta?: SessionMeta;
}

export function buildCreateSessionArgs(opts: CreateSessionOptions, startupConfig: string): string[] {
  const args = [
    '-f', startupConfig,
    'set-option', '-g', 'remain-on-exit', 'on', ';',
    'new-session', '-d', '-s', opts.name, '-P', '-F', '#{pane_id}',
  ];
  if (opts.width)  args.push('-x', String(opts.width));
  if (opts.height) args.push('-y', String(opts.height));
  if (opts.cwd)    args.push('-c', opts.cwd);
  if (opts.cmd) {
    args.push('--', 'sh', '-c', opts.cmd);
  }
  return args;
}

export class TmuxSessionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'TmuxSessionError';
  }
}

export function assertValidSessionName(name: string): void {
  if (!VALID_NAME.test(name)) {
    throw new TmuxSessionError(
      `Invalid session name: "${name}". Use 1-64 characters from [A-Za-z0-9_-]. tmux disallows '.' and ':'.`,
    );
  }
}

export function slugifyName(input: string): string {
  const s = input.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return s || `s-${Date.now()}`;
}

export async function hasSession(name: string, socket?: string): Promise<boolean> {
  assertValidSessionName(name);
  const sock = socket ?? getDefaultSocketPath();
  const res = await runTmux({
    socket: sock,
    args: ['has-session', '-t', `=${name}`],
    throwOnError: false,
  });
  return res.code === 0;
}

async function appliedConfigSchema(socket: string): Promise<number | undefined> {
  const res = await runTmux({
    socket,
    args: ['show-options', '-gv', CONFIG_SCHEMA_OPTION],
    throwOnError: false,
  }).catch(() => null);
  if (!res || res.code !== 0) return undefined;
  const n = Number(res.stdout.trim());
  return Number.isFinite(n) ? n : undefined;
}

async function reconcileServerConfig(socket: string, env: NodeJS.ProcessEnv | undefined): Promise<void> {
  const conf = writeStartupConfig(env);
  try {
    const res = await runTmux({ socket, args: ['source-file', conf], throwOnError: false, env });
    if (res.code !== 0) {
      throw new TmuxSessionError(
        `could not apply agents-cli tmux settings to the running server (${res.stderr.trim() || `exit ${res.code}`})`,
      );
    }
    await runTmux({
      socket,
      args: ['set-option', '-g', CONFIG_SCHEMA_OPTION, String(AGENTS_TMUX_CONFIG_SCHEMA)],
      throwOnError: false,
      env,
    }).catch(() => {});
  } finally {
    fs.rmSync(conf, { force: true });
  }
}

export async function createSession(opts: CreateSessionOptions): Promise<SessionMeta> {
  assertValidSessionName(opts.name);
  ensureTmuxDir();

  const socket = opts.socket ?? getDefaultSocketPath();
  if (opts.cwd && !fs.existsSync(opts.cwd)) {
    throw new TmuxSessionError(`cwd does not exist: ${opts.cwd}`);
  }

  const existed = await hasSession(opts.name, socket);
  if (existed) {
    if (opts.attachExisting) {
      if ((await appliedConfigSchema(socket)) !== AGENTS_TMUX_CONFIG_SCHEMA) {
        await reconcileServerConfig(socket, opts.env);
      }
      const meta = readSessionMeta(opts.name);
      return meta ?? {
        name: opts.name,
        socket,
        createdAt: Date.now(),
        source: opts.source ?? 'cli',
      };
    }
    if (!opts.replace) {
      throw new TmuxSessionError(
        `Session "${opts.name}" already exists. Use --replace to overwrite or --attach-existing to reuse it.`,
      );
    }
    await killSession(opts.name, socket);
  }

  const startupConfig = writeStartupConfig(opts.env);
  const args = buildCreateSessionArgs(opts, startupConfig);
  let res: Awaited<ReturnType<typeof runTmux>>;
  try {
    res = await runTmux({ socket, args, env: opts.env });
  } finally {
    fs.rmSync(startupConfig, { force: true });
  }
  const pane = /^%\d+$/.test(res.stdout.trim()) ? res.stdout.trim() : undefined;

  if (existed || (await appliedConfigSchema(socket)) !== AGENTS_TMUX_CONFIG_SCHEMA) {
    await reconcileServerConfig(socket, opts.env);
  }

  if (pane) {
    // Only the agent pane remains visible after exit; user-created splits must not linger as husks.
    await runTmux({ socket, args: ['set-option', '-pt', pane, 'remain-on-exit', 'on', ';', 'set-option', '-g', 'remain-on-exit', 'off'], throwOnError: false }).catch(() => {});
  }

  const identityArgs: string[] = [];
  if (opts.labels?.sessionId) {
    identityArgs.push('set-option', '-t', opts.name, SESSION_ID_OPTION, opts.labels.sessionId);
  }
  if (opts.labels?.agent) {
    if (identityArgs.length) identityArgs.push(';');
    identityArgs.push('set-option', '-t', opts.name, AGENT_NAME_OPTION, opts.labels.agent);
  }
  if (identityArgs.length) {
    await runTmux({ socket, args: identityArgs, throwOnError: false }).catch(() => {});
  }

  const meta: SessionMeta = {
    name: opts.name,
    socket,
    createdAt: Date.now(),
    // metaCmd is redacted; resolved secret-bearing argv must never reach persisted metadata.
    cmd: opts.metaCmd ?? opts.cmd,
    cwd: opts.cwd,
    source: opts.source ?? 'cli',
    labels: opts.labels,
    pane,
  };
  writeSessionMeta(meta);
  return meta;
}

export async function killSession(
  name: string,
  socket?: string,
  opts: { reapOrphans?: boolean } = {},
): Promise<boolean> {
  assertValidSessionName(name);
  const sock = socket ?? getDefaultSocketPath();
  const existed = await hasSession(name, sock);
  if (!existed) {
    removeSessionMeta(name);
    return false;
  }
  try {
    await runTmux({ socket: sock, args: ['kill-session', '-t', `=${name}`] });
  } catch (err) {
    if (err instanceof TmuxCommandError && err.code !== 0) {
    } else {
      throw err;
    }
  }
  if (opts.reapOrphans !== false) {
    // tmux teardown also owns detached helpers whose terminal parent has disappeared.
    const { reapProcessesForTmuxSession } = await import('./orphan-reap.js');
    await reapProcessesForTmuxSession(name, sock).catch(() => ({ killed: 0, details: [], candidates: [], warnings: [] }));
  }
  removeSessionMeta(name);
  return true;
}

export async function teardownIfAgentExited(name: string, socket?: string): Promise<'killed' | 'kept' | 'absent'> {
  assertValidSessionName(name);
  const sock = socket ?? getDefaultSocketPath();
  if (!(await hasSession(name, sock))) return 'absent';
  const res = await runTmux({
    socket: sock,
    args: ['list-panes', '-t', `=${name}`, '-F', '#{pane_dead}'],
    throwOnError: false,
  }).catch(() => null);
  if (!res || res.code !== 0) {
    await killSession(name, sock).catch(() => {});
    return 'killed';
  }
  const flags = res.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (flags.some((d) => d === '0')) return 'kept';
  await killSession(name, sock).catch(() => {});
  return 'killed';
}

export async function killAll(socket?: string): Promise<number> {
  const sock = socket ?? getDefaultSocketPath();
  let count = 0;
  try {
    const sessions = await listSessions({ socket: sock });
    count = sessions.length;
    await runTmux({ socket: sock, args: ['kill-server'], throwOnError: false });
  } catch {
  }
  const dir = ensureTmuxDir();
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.json')) {
      try { fs.unlinkSync(`${dir}/${f}`); } catch {  }
    }
  }
  try { fs.unlinkSync(sock); } catch {  }
  return count;
}

interface ReapDeadPanesResult {
  reaped: number;
  sessions: string[];
  details: string[];
  processes: number;
  processDetails: string[];
  warnings: string[];
}

export async function reapDeadTmuxPanes(
  socket?: string,
  opts: { dryRun?: boolean; pids?: number[] } = {},
): Promise<ReapDeadPanesResult> {
  const sock = socket ?? getDefaultSocketPath();
  const result: ReapDeadPanesResult = { reaped: 0, sessions: [], details: [], processes: 0, processDetails: [], warnings: [] };

  // Attribute processes before deleting ownership; sessions with any live pane stay intact.
  const { reapOrphanAgentProcesses } = await import('./orphan-reap.js');
  const orphans = await reapOrphanAgentProcesses({ socket: sock, dryRun: opts.dryRun, pids: opts.pids });
  result.warnings = orphans.warnings;
  result.processes = opts.dryRun ? orphans.candidates.length : orphans.killed;
  result.processDetails = orphans.details;

  if (!(await fsp.access(sock).then(() => true, () => false))) return result;

  const res = await runTmux({
    socket: sock,
    args: ['list-panes', '-a', '-F', '#{pane_id}\t#{session_name}\t#{pane_dead}'],
    throwOnError: false,
  });
  if (res.code !== 0) return result;

  const sessionFlags = new Map<string, boolean[]>();
  for (const raw of res.stdout.split('\n')) {
    const parts = raw.trim().split('\t');
    const name = parts[1];
    if (!name) continue;
    const dead = parts[2]?.trim() === '1';
    if (!sessionFlags.has(name)) sessionFlags.set(name, []);
    sessionFlags.get(name)!.push(dead);
  }

  for (const [name, flags] of sessionFlags) {
    if (flags.length === 0 || !flags.every(d => d)) continue;
    try {
      if (!opts.dryRun) await killSession(name, sock, { reapOrphans: false });
      result.reaped++;
      result.sessions.push(name);
      result.details.push(`${name} (${flags.length} dead pane${flags.length === 1 ? '' : 's'})`);
    } catch {
    }
  }
  return result;
}

export async function mapPanesToTargets(socket?: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let res;
  try {
    res = await runTmux({
      socket,
      args: ['list-panes', '-a', '-F', '#{pane_id} #{session_name}:#{window_index}.#{pane_index}'],
      throwOnError: false,
    });
  } catch {
    return out;
  }
  if (res.code !== 0) return out;
  for (const line of res.stdout.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp > 0) out.set(line.slice(0, sp), line.slice(sp + 1).trim());
  }
  return out;
}

export interface TmuxClient {
  tty: string;
  pid: number;
  target: string;
}

export async function listClients(socket?: string): Promise<TmuxClient[]> {
  let res;
  try {
    res = await runTmux({
      socket,
      args: ['list-clients', '-F', '#{client_tty} #{client_pid} #{session_name}:#{window_index}.#{pane_index}'],
      throwOnError: false,
    });
  } catch {
    return [];
  }
  if (res.code !== 0) return [];
  const out: TmuxClient[] = [];
  for (const line of res.stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const sp1 = t.indexOf(' ');
    if (sp1 < 0) continue;
    const sp2 = t.indexOf(' ', sp1 + 1);
    if (sp2 < 0) continue;
    const tty = t.slice(0, sp1);
    const pid = parseInt(t.slice(sp1 + 1, sp2), 10);
    const target = t.slice(sp2 + 1).trim();
    if (!Number.isFinite(pid) || !target) continue;
    out.push({ tty, pid, target });
  }
  return out;
}

interface PaneExit {
  found: boolean;
  dead: boolean;
  status?: number;
}

export async function paneExitStatus(pane: string, socket?: string): Promise<PaneExit> {
  let res;
  try {
    res = await runTmux({
      socket,
      args: ['display-message', '-pt', pane, '-p', '#{pane_dead} #{pane_dead_status}'],
      throwOnError: false,
    });
  } catch {
    return { found: false, dead: false };
  }
  if (res.code !== 0) return { found: false, dead: false };
  const [deadRaw, statusRaw] = res.stdout.trim().split(/\s+/);
  const status = statusRaw !== undefined && statusRaw !== '' ? parseInt(statusRaw, 10) : undefined;
  return { found: true, dead: deadRaw === '1', status: Number.isFinite(status) ? status : undefined };
}

export async function setSessionHook(name: string, hook: string, command: string, socket?: string, timeoutMs?: number): Promise<boolean> {
  assertValidSessionName(name);
  const sock = socket ?? getDefaultSocketPath();
  const result = await runTmux({
    socket: sock,
    args: ['set-hook', '-t', name, hook, command],
    throwOnError: false,
    timeoutMs,
  }).catch(() => null);
  return result?.code === 0;
}

export const AGENT_HOOK_SCHEMA = 6;
const HOOK_SCHEMA_OPTION = '@ag_hook_schema';

const TMUX_HOOK_REPAIR_TIMEOUT_MS = 5_000;

export function agentPaneDiedHook(sessionName: string, agentPane: string): string {
  // Agent death detaches attached clients or kills unattended work; a user split kills only itself.
  const agentPaneAction = `if -F '#{session_attached}' 'detach-client -s =${sessionName}' 'kill-session -t =${sessionName}'`;
  return `if -F '#{==:#{hook_pane},${agentPane}}' "${agentPaneAction}" 'run-shell -b -C "kill-pane -t #{hook_pane}"'`;
}

export async function markSessionHookSchema(name: string, socket?: string, timeoutMs?: number): Promise<void> {
  const sock = socket ?? getDefaultSocketPath();
  await runTmux({ socket: sock, args: ['set-option', '-t', name, HOOK_SCHEMA_OPTION, String(AGENT_HOOK_SCHEMA)], throwOnError: false, timeoutMs }).catch(() => {});
}

async function readHookSchema(name: string, socket: string, timeoutMs?: number): Promise<string | undefined> {
  const res = await runTmux({ socket, args: ['show-options', '-v', '-t', name, HOOK_SCHEMA_OPTION], throwOnError: false, timeoutMs }).catch(() => null);
  if (!res || res.code !== 0) return undefined;
  const v = res.stdout.trim();
  return v === '' ? undefined : v;
}

async function lowestPaneId(name: string, socket: string, timeoutMs?: number): Promise<string | undefined> {
  const res = await runTmux({ socket, args: ['list-panes', '-t', name, '-F', '#{pane_id}'], throwOnError: false, timeoutMs }).catch(() => null);
  if (!res || res.code !== 0) return undefined;
  const ids = res.stdout.split('\n').map(l => l.trim()).filter(id => /^%\d+$/.test(id));
  if (!ids.length) return undefined;
  return ids.reduce((lo, id) => (parseInt(id.slice(1), 10) < parseInt(lo.slice(1), 10) ? id : lo));
}

type ResumePreparation =
  | { decision: 'attach'; pane: string }
  | { decision: 'create' };

export async function prepareSessionForResume(
  name: string,
  socket?: string,
): Promise<ResumePreparation> {
  const sock = socket ?? getDefaultSocketPath();
  if (!(await hasSession(name, sock))) return { decision: 'create' };

  const recordedPane = readSessionMeta(name)?.pane;
  const recordedState = recordedPane ? await paneExitStatus(recordedPane, sock) : undefined;
  const pane = recordedPane && recordedState?.found
    ? recordedPane
    : await lowestPaneId(name, sock);
  const state = pane ? await paneExitStatus(pane, sock) : undefined;
  if (pane && state?.found && !state.dead) {
    await ensureSessionHookRepaired(name, sock);
    return { decision: 'attach', pane };
  }

  await killSession(name, sock);
  return { decision: 'create' };
}

async function repairSessionHookIfStale(name: string, sock: string, meta: SessionMeta | undefined, timeoutMs: number = TMUX_HOOK_REPAIR_TIMEOUT_MS): Promise<boolean> {
  // Schema gates upgrades; repair is bounded and best-effort because it runs against live sessions.
  if (await readHookSchema(name, sock, timeoutMs) === String(AGENT_HOOK_SCHEMA)) return false;
  const agentPane = meta?.pane ?? await lowestPaneId(name, sock, timeoutMs);
  if (!agentPane) return false;
  const installed = await setSessionHook(name, 'pane-died', agentPaneDiedHook(name, agentPane), sock, timeoutMs);
  if (!installed) return false;
  await markSessionHookSchema(name, sock, timeoutMs);
  return true;
}

export async function reconcileSessionHooks(socket?: string): Promise<{ scanned: number; reconciled: number }> {
  const sock = socket ?? getDefaultSocketPath();
  if (!fs.existsSync(sock)) return { scanned: 0, reconciled: 0 };
  let sessions: ListedSession[];
  try {
    sessions = await listSessions({ socket: sock, timeoutMs: TMUX_HOOK_REPAIR_TIMEOUT_MS });
  } catch {
    return { scanned: 0, reconciled: 0 };
  }
  let reconciled = 0;
  for (const s of sessions) {
    // Only agents-cli-owned sessions participate; never mutate arbitrary user tmux sessions.
    if (!s.name.startsWith('ag-')) continue;
    if (await repairSessionHookIfStale(s.name, sock, s.meta)) reconciled++;
  }
  return { scanned: sessions.length, reconciled };
}

export async function ensureSessionHookRepaired(name: string, socket?: string): Promise<void> {
  if (!name.startsWith('ag-')) return;
  const sock = socket ?? getDefaultSocketPath();
  if (!fs.existsSync(sock)) return;
  try {
    await repairSessionHookIfStale(name, sock, readSessionMeta(name) ?? undefined);
  } catch {
  }
}

export async function listSessions(opts: { socket?: string; timeoutMs?: number } = {}): Promise<ListedSession[]> {
  const socket = opts.socket ?? getDefaultSocketPath();
  if (!fs.existsSync(socket)) {
    pruneAllMetas();
    return [];
  }

  const fmt = '#{session_name}|#{session_created}|#{session_windows}|#{session_attached}';
  const res = await runTmux({
    socket,
    args: ['list-sessions', '-F', fmt],
    throwOnError: false,
    timeoutMs: opts.timeoutMs,
  });

  if (res.code !== 0) {
    if (/no server running|no sessions|error connecting/i.test(res.stderr)) {
      pruneAllMetas();
      return [];
    }
    throw new TmuxCommandError(`tmux list-sessions failed: ${res.stderr}`, res.stderr, res.stdout, res.code);
  }

  const lines = res.stdout.split('\n').map(l => l.trim()).filter(Boolean);
  const out: ListedSession[] = [];
  const liveNames = new Set<string>();
  for (const line of lines) {
    const [name, createdRaw, windowsRaw, attachedRaw] = line.split('|');
    if (!name) continue;
    liveNames.add(name);
    out.push({
      name,
      socket,
      createdAtTmux: parseInt(createdRaw, 10) || 0,
      windows: parseInt(windowsRaw, 10) || 1,
      attached: attachedRaw === '1',
      meta: readSessionMeta(name) ?? undefined,
    });
  }

  pruneOrphanMetas(liveNames);
  return out;
}

export interface SplitOptions {
  name: string;
  direction: 'h' | 'v';
  cmd?: string;
  cwd?: string;
  socket?: string;
}

export async function splitPane(opts: SplitOptions): Promise<string> {
  assertValidSessionName(opts.name);
  const socket = opts.socket ?? getDefaultSocketPath();
  if (opts.cwd && !fs.existsSync(opts.cwd)) {
    throw new TmuxSessionError(`cwd does not exist: ${opts.cwd}`);
  }

  const args = ['split-window', `-${opts.direction}`, '-t', opts.name, '-P', '-F', '#{pane_id}'];
  if (opts.cwd) args.push('-c', opts.cwd);
  if (opts.cmd) args.push('--', 'sh', '-c', opts.cmd);

  const res = await runTmux({ socket, args });
  return res.stdout.trim();
}

export interface SendOptions {
  name: string;
  pane?: string;
  keys: string;
  noEnter?: boolean;
  raw?: boolean;
  socket?: string;
}

export async function sendKeys(opts: SendOptions): Promise<void> {
  assertValidSessionName(opts.name);
  const socket = opts.socket ?? getDefaultSocketPath();
  const target = opts.pane ? `${opts.name}.${opts.pane}` : opts.name;
  const args = ['send-keys', '-t', target];
  if (opts.raw) args.push('-l');
  args.push(opts.keys);
  if (!opts.noEnter) args.push('Enter');
  await runTmux({ socket, args });
}

export interface CaptureOptions {
  name: string;
  pane?: string;
  lines?: number;
  ansi?: boolean;
  socket?: string;
}

export async function capturePane(opts: CaptureOptions): Promise<string> {
  assertValidSessionName(opts.name);
  const socket = opts.socket ?? getDefaultSocketPath();
  const target = opts.pane ? `${opts.name}.${opts.pane}` : opts.name;
  const args = ['capture-pane', '-p', '-t', target];
  if (opts.ansi) args.push('-e');
  if (opts.lines && opts.lines > 0) {
    args.push('-S', `-${opts.lines}`);
  }
  const res = await runTmux({ socket, args });
  return res.stdout;
}

export function readSessionMeta(name: string): SessionMeta | null {
  try {
    const raw = fs.readFileSync(getSessionMetaPath(name), 'utf8');
    return JSON.parse(raw) as SessionMeta;
  } catch {
    return null;
  }
}

function writeSessionMeta(meta: SessionMeta): void {
  ensureTmuxDir();
  fs.writeFileSync(getSessionMetaPath(meta.name), JSON.stringify(meta, null, 2), { mode: 0o600 });
}

function removeSessionMeta(name: string): void {
  try { fs.unlinkSync(getSessionMetaPath(name)); } catch {  }
}

function pruneOrphanMetas(liveNames: Set<string>): void {
  const dir = ensureTmuxDir();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const name = f.slice(0, -5);
    if (!liveNames.has(name)) {
      try { fs.unlinkSync(`${dir}/${f}`); } catch {  }
    }
  }
}

function pruneAllMetas(): void {
  const dir = ensureTmuxDir();
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.json')) {
      try { fs.unlinkSync(`${dir}/${f}`); } catch {  }
    }
  }
}
