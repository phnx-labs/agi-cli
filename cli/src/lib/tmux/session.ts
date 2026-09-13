/**
 * tmux session lifecycle.
 *
 * Public surface used by both `agents tmux` commands and external consumers
 * (swarmify, `agents teams` with a future multiplexer mode). Every state
 * change goes through here so the CLI surface stays a thin parser.
 *
 * Liveness model: tmux itself owns liveness. The `<name>.json` meta files are
 * pure provenance — `listSessions()` always reconciles them against
 * `tmux list-sessions` and prunes stale entries on the fly.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runTmux, TmuxCommandError } from './binary.js';
import { ensureTmuxDir, getDefaultSocketPath, getSessionMetaPath } from './paths.js';

/** Tmux session names must not contain `.` or `:` — those are reserved for window/pane addressing. */
const VALID_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Ten times tmux's 2,000-line default, while keeping per-pane memory bounded:
 * history storage scales with pane width, so a 200-column pane retains at most
 * four million grid cells rather than an unbounded agent transcript.
 */
export const AGENTS_TMUX_HISTORY_LIMIT = 20_000;

/**
 * Bump when the generated startup config changes, so an ALREADY-RUNNING server
 * picks the new settings up. tmux reads `-f` only when it actually starts a
 * server: a second `new-session -f other.conf` against a live server exits 0
 * and silently applies nothing (verified against tmux 3.4). Since agents-cli
 * uses one long-lived shared socket, the normal state at upgrade is a running
 * server — so without this reconcile every existing machine would get none of
 * these defaults, silently. Same shape as AGENT_HOOK_SCHEMA below.
 */
export const AGENTS_TMUX_CONFIG_SCHEMA = 1;
/** Server-scoped user-option recording which AGENTS_TMUX_CONFIG_SCHEMA is applied. */
const CONFIG_SCHEMA_OPTION = '@ag_tmux_config_schema';

/**
 * Session-scoped user options naming WHICH agent session a wrapper session runs,
 * so a status bar (or any tmux format) can show it without shelling out:
 * `#{@ag_session_id}` / `#{@ag_agent}`.
 *
 * The session NAME cannot serve this purpose. runInTmux builds it from
 * `(options.sessionId ?? randomUUID()).slice(0, 8)` (exec.ts), so a run with no
 * pre-assigned id still gets 8 hex characters — indistinguishable from a real
 * short session id but resolving to nothing. Only claude currently takes a
 * forced `--session-id`, so on a box running both, `ag-claude-<real>` and
 * `ag-codex-<fabricated>` look identical. These options are stamped ONLY from
 * `labels.sessionId`, which is set only when the id is genuine — absent rather
 * than wrong, so a consumer can fall back instead of displaying a fake handle.
 */
const SESSION_ID_OPTION = '@ag_session_id';
const AGENT_NAME_OPTION = '@ag_agent';

let startupConfigSequence = 0;

function tmuxConfigArgument(value: string): string {
  return `"${value.replace(/([\\"$])/g, '\\$1')}"`;
}

/** Source one user config without tmux's quiet flag, preserving path bytes. */
export function userConfigSourceLine(value: string): string {
  return `source-file ${tmuxConfigArgument(value)}`;
}

/**
 * tmux loads `-f` instead of its normal user config, so put agents-cli's
 * defaults first and explicitly source the first user config tmux would have
 * selected afterward. Configuration files execute in order; this makes these
 * settings defaults while preserving every option or binding the user sets.
 */
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
  // tmux's own start_cfg() sources EVERY entry of TMUX_CONF that exists, not
  // just the first — a user with both ~/.tmux.conf and ~/.config/tmux/tmux.conf
  // gets both. Sourcing only the first would silently drop the second and break
  // the "never override a user-set value" contract this file exists to keep.
  const userConfigs = candidates.filter((candidate) => fs.existsSync(candidate));
  const startupConfig = path.join(
    ensureTmuxDir(),
    `startup-${process.pid}-${startupConfigSequence++}.conf`,
  );
  const lines = [
    // Stamp the schema HERE as well as in reconcileServerConfig. Without it a
    // cold start leaves the option unset, the post-new-session check sees a
    // stale stamp, and the reconcile re-sources the user's config a second time
    // on launch #1 — firing any run-shell side effect (TPM) twice.
    `set-option -g ${CONFIG_SCHEMA_OPTION} ${AGENTS_TMUX_CONFIG_SCHEMA}`,
    'set-option -g mouse on',
    'set-option -s set-clipboard on',
    `set-option -g history-limit ${AGENTS_TMUX_HISTORY_LIMIT}`,
    'bind-key -T copy-mode MouseDragEnd1Pane send-keys -X copy-selection-no-clear',
    'bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-selection-no-clear',
  ];
  for (const userConfig of userConfigs) {
    // Do not suppress parse/read failures: a broken user config must fail the
    // launch visibly instead of producing a silently half-configured server.
    lines.push(userConfigSourceLine(userConfig));
  }
  fs.writeFileSync(startupConfig, `${lines.join('\n')}\n`, { mode: 0o600 });
  return startupConfig;
}

/** Provenance written alongside each live tmux session. */
export interface SessionMeta {
  name: string;
  socket: string;
  createdAt: number;
  /** Initial command launched in the first pane (informational — tmux owns the actual process). */
  cmd?: string;
  /** Working directory the session was created in. */
  cwd?: string;
  /** Who created this session — useful for `agents sessions --active` attribution. */
  source: 'cli' | 'extension' | 'teams' | 'external';
  /** Free-form labels callers can stamp (e.g. `{ agent: 'claude', vscodePid: 1234 }`). */
  labels?: Record<string, string>;
  /**
   * The first pane's id (`%N`) captured at creation. The exact send-keys /
   * attach handle for the agent that runs in this session — recorded so
   * `agents sessions --active` and the spawn-wrap path (src/lib/exec.ts) don't
   * have to re-query it. Absent for pre-existing/`attach-existing` sessions.
   */
  pane?: string;
}

export interface CreateSessionOptions {
  name: string;
  cmd?: string;
  /**
   * Redacted copy of `cmd` to persist in SessionMeta.cmd instead of the real
   * command. When set, `cmd` is still executed but only `metaCmd` is written to
   * disk — used to keep resolved secret values out of the informational cmd
   * field (see exec.ts buildTmuxAgentCommand, RUSH-1758). Defaults to `cmd`.
   */
  metaCmd?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  socket?: string;
  source?: SessionMeta['source'];
  labels?: Record<string, string>;
  /** When the named session already exists, kill it before creating. */
  replace?: boolean;
  /** When the named session already exists, return it instead of failing. */
  attachExisting?: boolean;
  /** Initial window dimensions for the detached session. tmux clamps to client size on attach. */
  width?: number;
  height?: number;
}

export interface ListedSession {
  name: string;
  socket: string;
  /** Unix epoch seconds reported by tmux (`session_created`). */
  createdAtTmux: number;
  windows: number;
  attached: boolean;
  meta?: SessionMeta;
}

/** Build the atomic server-configuration + session-creation command. */
export function buildCreateSessionArgs(opts: CreateSessionOptions, startupConfig: string): string[] {
  const args = [
    '-f', startupConfig,
    'set-option', '-g', 'remain-on-exit', 'on', ';',
    'new-session', '-d', '-s', opts.name, '-P', '-F', '#{pane_id}',
  ];
  if (opts.width)  args.push('-x', String(opts.width));
  if (opts.height) args.push('-y', String(opts.height));
  if (opts.cwd)    args.push('-c', opts.cwd);
  // Separator + child command. tmux passes the rest verbatim to exec, so no
  // shell escaping is required — array args end-to-end.
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

/** Reject invalid session names early — tmux's error for `.`/`:` is cryptic. */
export function assertValidSessionName(name: string): void {
  if (!VALID_NAME.test(name)) {
    throw new TmuxSessionError(
      `Invalid session name: "${name}". Use 1-64 characters from [A-Za-z0-9_-]. tmux disallows '.' and ':'.`,
    );
  }
}

/** Slugify an arbitrary string into a valid session name. Useful for swarmify auto-generated names. */
export function slugifyName(input: string): string {
  const s = input.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return s || `s-${Date.now()}`;
}

/** True when a session by this name currently exists on the given socket. */
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

/** Which AGENTS_TMUX_CONFIG_SCHEMA a live server has applied; undefined when none. */
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

/**
 * Apply the generated startup config to an already-running server and stamp it.
 * Failure is surfaced, not swallowed: a server left without these settings is
 * the silent no-op this exists to prevent.
 */
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

/**
 * Create a new detached session. Throws when the name is already taken unless
 * `replace` or `attachExisting` is set.
 */
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
      // Reuse of a live session is precisely the already-running-server case,
      // so it needs the same reconcile the create path gets — otherwise
      // `agents tmux new --attach-existing` silently keeps a pre-fix server
      // with none of these settings.
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

  // Configure the agents-cli tmux server BEFORE the child command can finish — a fast-exiting
  // cmd (e.g. `echo BRIEF && true`) would otherwise collapse the only session,
  // exit the server, and the follow-up `set-option` would race with "no
  // server running". Server-wide (`-g`) is applied in the same tmux
  // invocation as new-session so they share one server lifetime.
  // `-P -F '#{pane_id}'` prints the new session's first pane id on stdout so we
  // can record the exact `%N` handle without a follow-up `list-panes`.
  const startupConfig = writeStartupConfig(opts.env);
  const args = buildCreateSessionArgs(opts, startupConfig);
  let res: Awaited<ReturnType<typeof runTmux>>;
  try {
    res = await runTmux({ socket, args, env: opts.env });
  } finally {
    fs.rmSync(startupConfig, { force: true });
  }
  // Only the new-session command in the `;`-chained invocation emits output.
  const pane = /^%\d+$/.test(res.stdout.trim()) ? res.stdout.trim() : undefined;

  // If the server was ALREADY running, its `-f` was ignored, so the config above
  // never applied. Re-source it — the generated file ends by sourcing the user's
  // own tmux.conf, so re-applying preserves the same precedence a cold start
  // gives. Gated on a generation stamp so a user config with side effects (tpm's
  // run-shell, for one) is not re-executed on every single launch.
  if (existed || (await appliedConfigSchema(socket)) !== AGENTS_TMUX_CONFIG_SCHEMA) {
    await reconcileServerConfig(socket, opts.env);
  }

  // Keep the agent pane around after its process exits (so runInTmux can read
  // the exit status and capture the final error), but do NOT keep that behavior
  // for user-created splits. Apply remain-on-exit to the agent pane only, then
  // revert the global default so future splits close automatically when their
  // command finishes. The global-on above protects a fast-exiting agent during
  // the brief window before the pane option is stamped.
  if (pane) {
    await runTmux({ socket, args: ['set-option', '-pt', pane, 'remain-on-exit', 'on', ';', 'set-option', '-g', 'remain-on-exit', 'off'], throwOnError: false }).catch(() => {});
  }

  // Stamp the agent identity onto the session so tmux formats can read it.
  // Best-effort: a failure here must not fail a launch that otherwise worked,
  // and an unset option simply renders empty in a format.
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
    // Persist the redacted copy when provided so resolved secret values in the
    // launch command never land on disk (RUSH-1758).
    cmd: opts.metaCmd ?? opts.cmd,
    cwd: opts.cwd,
    source: opts.source ?? 'cli',
    labels: opts.labels,
    pane,
  };
  writeSessionMeta(meta);
  return meta;
}

/**
 * Kill one named session. Idempotent — killing a non-existent session is a no-op.
 *
 * Destroying the tmux session only SIGHUPs each pane's FOREGROUND process group,
 * so a helper the agent put in its own process group (an MCP server, a harness
 * background daemon) survives and reparents to init. `reapOrphans` therefore
 * defaults ON: the session's leftover helpers are terminated with it rather than
 * waiting for the daemon's next sweep (RUSH-2521). {@link reapDeadTmuxPanes}
 * passes `false` because it sweeps every session's leftovers in one pass instead
 * of re-snapshotting the process table per session.
 */
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
      // Already dead by the time the kill landed — treat as success.
    } else {
      throw err;
    }
  }
  if (opts.reapOrphans !== false) {
    const { reapProcessesForTmuxSession } = await import('./orphan-reap.js');
    await reapProcessesForTmuxSession(name, sock).catch(() => ({ killed: 0, details: [], candidates: [], warnings: [] }));
  }
  removeSessionMeta(name);
  return true;
}

/**
 * After an attach client returns: destroy the session if every pane is dead
 * (the agent exited); leave it if any pane is still alive (Ctrl-b d).
 *
 * `runInTmux` already does this via `resolveAfterAttach`. The attach verbs
 * (`agents tmux attach`, `sessions focus`/`resume --attach-only`, `jumpTo`)
 * used to `process.exit` the tmux client status and leave a `remain-on-exit`
 * husk — the session "came back" in `tmux ls` after the user exited the agent.
 */
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

/**
 * Kill every session on the shared server AND the server itself, then prune
 * meta files. Wipes the socket so the next `new` starts from a clean slate.
 */
export async function killAll(socket?: string): Promise<number> {
  const sock = socket ?? getDefaultSocketPath();
  let count = 0;
  try {
    const sessions = await listSessions({ socket: sock });
    count = sessions.length;
    await runTmux({ socket: sock, args: ['kill-server'], throwOnError: false });
  } catch {
    // Server already gone — that's a successful kill-all.
  }
  // Clear meta files for every session we knew about.
  const dir = ensureTmuxDir();
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.json')) {
      try { fs.unlinkSync(`${dir}/${f}`); } catch { /* race-tolerant */ }
    }
  }
  // Stale socket can survive kill-server on some platforms — sweep it.
  try { fs.unlinkSync(sock); } catch { /* may not exist */ }
  return count;
}

/** Result returned by {@link reapDeadTmuxPanes}. */
interface ReapDeadPanesResult {
  /** Number of tmux sessions killed. */
  reaped: number;
  /** Names of reaped sessions. */
  sessions: string[];
  /** Human-readable lines describing each reap, for log output. */
  details: string[];
  /** Orphaned helper processes terminated (MCP servers, harness background daemons). */
  processes: number;
  /** One human-readable line per terminated helper process. */
  processDetails: string[];
  /** Non-fatal observations worth logging — e.g. a tier-1 sweep skipped this tick because a tmux query failed. */
  warnings: string[];
}

/**
 * Kill every tmux session whose panes are ALL dead (`pane_dead=1`), and
 * terminate the helper processes whose owning agent has exited.
 *
 * Dead panes accumulate because `remain-on-exit on` is intentionally set
 * per-pane so the harness can inspect exit status. Without a periodic sweep
 * they pile up indefinitely — e.g. 48 of 127 sessions dead on yosemite-s0
 * (RUSH-2501).
 *
 * Killing the pane is not enough on its own: it SIGHUPs only the pane's
 * FOREGROUND process group, so an MCP server or harness background daemon that
 * moved itself out of that group survives the session that spawned it and keeps
 * its memory forever (RUSH-2521). The process sweep runs FIRST, while the dead
 * sessions still exist, so every leftover is attributed to a named session
 * rather than to a session tmux has already forgotten.
 *
 * Safety invariant: a session with ANY live pane (`pane_dead=0`) is never
 * touched, and neither are the processes belonging to a session whose agent is
 * still running or that has a client attached.
 *
 * `dryRun` reports both halves without killing anything.
 */
export async function reapDeadTmuxPanes(
  socket?: string,
  opts: { dryRun?: boolean; pids?: number[] } = {},
): Promise<ReapDeadPanesResult> {
  const sock = socket ?? getDefaultSocketPath();
  const result: ReapDeadPanesResult = { reaped: 0, sessions: [], details: [], processes: 0, processDetails: [], warnings: [] };

  // The process sweep may run with no server, but an absent session is not
  // evidence that a still-live marked process is orphaned. Tier 1 only acts on
  // a present pane owner confirmed dead; tier 2 independently verifies its
  // declared spawner pid (RUSH-2603).
  // `opts.pids` is a test-only process-table scope (see `readAgentProcesses`)
  // — production callers never set it.
  const { reapOrphanAgentProcesses } = await import('./orphan-reap.js');
  const orphans = await reapOrphanAgentProcesses({ socket: sock, dryRun: opts.dryRun, pids: opts.pids });
  result.warnings = orphans.warnings;
  result.processes = opts.dryRun ? orphans.candidates.length : orphans.killed;
  result.processDetails = orphans.details;

  // Async existence check — this runs on the daemon's tmux-reap tick, so a sync
  // `existsSync` would block the shared event loop (PHNX-3695).
  if (!(await fsp.access(sock).then(() => true, () => false))) return result;

  const res = await runTmux({
    socket: sock,
    args: ['list-panes', '-a', '-F', '#{pane_id}\t#{session_name}\t#{pane_dead}'],
    throwOnError: false,
  });
  // Nonzero exit means no server or no sessions — nothing to reap.
  if (res.code !== 0) return result;

  // Group dead-flags by session name.
  const sessionFlags = new Map<string, boolean[]>();
  for (const raw of res.stdout.split('\n')) {
    const parts = raw.trim().split('\t');
    const name = parts[1];
    if (!name) continue;
    const dead = parts[2]?.trim() === '1';
    if (!sessionFlags.has(name)) sessionFlags.set(name, []);
    sessionFlags.get(name)!.push(dead);
  }

  // Kill only sessions where every pane is dead.
  for (const [name, flags] of sessionFlags) {
    if (flags.length === 0 || !flags.every(d => d)) continue;
    try {
      // The one process-table sweep above already collected this session's
      // leftovers; a per-session reap here would re-snapshot `ps` N times.
      if (!opts.dryRun) await killSession(name, sock, { reapOrphans: false });
      result.reaped++;
      result.sessions.push(name);
      result.details.push(`${name} (${flags.length} dead pane${flags.length === 1 ? '' : 's'})`);
    } catch {
      // Best-effort: session may already be gone by the time we hit it.
    }
  }
  return result;
}

/**
 * Map every pane id (`%N`) on a socket to its `session:window.pane` attach
 * target, in one batched `tmux list-panes -a` call. `%116 -> main:2.0` is a
 * valid `tmux attach -t main:2` / `tmux select-window -t main:2` target — a
 * human jump target, unlike the bare `%pane` send-keys id. Because it walks
 * every pane (not just one-per-session), it also surfaces multiple agents that
 * share a session across windows. Best-effort: returns an empty map on any
 * failure (tmux gone, foreign socket) so callers fall back to the raw pane id.
 */
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

/** One tmux client attached to the shared server. */
export interface TmuxClient {
  /** Controlling TTY of the terminal running `tmux attach` (e.g. '/dev/ttys004'). */
  tty: string;
  /** PID of the `tmux attach` client process — the leaf whose ancestry names the host app. */
  pid: number;
  /** The `session:window.pane` the client is currently displaying. */
  target: string;
}

/**
 * List every client attached to the shared server, with the terminal PID and
 * the session/window/pane it's viewing. This is how "viewing in <app> tab N"
 * resolves: a client's `pid` walks the process ancestry to name the host app,
 * and its `target` says which session it's attached to. Best-effort — returns
 * an empty list on any failure (no server, foreign socket) so the renderer
 * degrades to "detached".
 */
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

/** A dead pane's exit status, read from tmux while the pane lingers under remain-on-exit. */
interface PaneExit {
  /** False when the pane/socket no longer exists or tmux could not query it. */
  found: boolean;
  /** True once the process that ran in the pane has exited (pane is dead). */
  dead: boolean;
  /** Exit status of the dead pane's process, when tmux reports it. */
  status?: number;
}

/**
 * Read whether a pane's process has exited and, if so, its exit status. Used by
 * the spawn-wrap path to recover the wrapped agent's exit code after the attach
 * client returns. `found: false` distinguishes a missing pane from a living one;
 * focus must recover the former instead of attaching a retained/stale target.
 */
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

/**
 * Bind a per-session hook. Used by the spawn-wrap path to install a `pane-died`
 * hook that detaches the attach client the instant the wrapped agent exits (the
 * global `remain-on-exit on` otherwise leaves the client staring at a dead pane).
 * Best-effort — returns false when tmux rejects the hook so callers do not
 * stamp a schema marker and daemon reconciliation can retry later.
 */
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

/**
 * Schema version of the `pane-died` hook installed on managed `agents run`
 * sessions. Bump whenever the hook's SHAPE changes so the daemon reconcile
 * (reconcileSessionHooks) knows to re-stamp live sessions a prior binary left on
 * an older shape.
 *   v1 — the original unconditional `detach-client`: ANY pane death (including a
 *        user exiting a split they opened) tore down the whole client.
 *   v2 — `#{hook_pane}`-guarded: only the AGENT pane dying detaches; a user
 *        split's death runs `kill-pane`, closing just that split.
 *   v3 — the else-branch pins its target via
 *        `run-shell "tmux -S <socket> kill-pane -t #{hook_pane}"`. Untargeted
 *        kill-pane resolves "current pane" inside the hook context, which goes
 *        nondeterministic on a loaded detached server (CI flake #965: the dead
 *        split survived as a husk); run-shell format-expands its command at
 *        fire time, so the event pane is always the target.
 *   v4 — `run-shell -C "kill-pane -t #{hook_pane}"` executes the targeted command
 *        in the tmux server instead of launching a second tmux client against
 *        the same socket from inside the hook. That self-client could race the
 *        server under load and leave the dead split behind.
 *   v5 — `run-shell -b -C "kill-pane -t #{hook_pane}"` runs the targeted kill-pane
 *        in the background inside the server command queue. The synchronous
 *        variant could stall the hook on a loaded CI runner, letting the dead
 *        split survive until the test's wait timeout expired (flake in CI shard
 *        3: pane-guarded pane-died hook / user split exit).
 *   v6 — the agent-pane branch is now `session_attached`-aware: with a client
 *        attached it `detach-client`s (the interactive path, so runInTmux's
 *        attach returns and reads the exit status, EXEC-23b unchanged); with NO
 *        client it `kill-session`s outright. A `remain-on-exit` pane with no
 *        attach client to reap it otherwise lingers as a dead husk until the
 *        daemon's periodic `reapDeadTmuxPanes` sweep — so a run whose terminal
 *        was closed, or a `/exit` after the user detached, left an idle-looking
 *        dead session on the socket. Killing it the instant the agent exits is
 *        the "one close tears down every layer" contract (#5a).
 */
export const AGENT_HOOK_SCHEMA = 6;
/** Per-session tmux user-option that records which AGENT_HOOK_SCHEMA a session's hook is at. */
const HOOK_SCHEMA_OPTION = '@ag_hook_schema';

/**
 * Bound on every tmux call made by the hook-repair path (daemon startup,
 * upgrade migration, and single-session repair-before-attach). A wedged tmux
 * server would otherwise hang the caller indefinitely — exactly the class of
 * bug RUSH-2507 fixed for `listTmuxAgentSessions`'s `list-panes` call, applied
 * here to `reconcileSessionHooks`/`repairSessionHookIfStale`'s calls so a
 * wedged shared socket can no longer wedge daemon startup (RUSH-2435 review).
 */
const TMUX_HOOK_REPAIR_TIMEOUT_MS = 5_000;

/**
 * The guarded `pane-died` hook. When the AGENT pane dies, tear the whole session
 * down — but HOW depends on whether a client is attached:
 *   - attached (`#{session_attached}`): `detach-client` so the blocking attach in
 *     runInTmux returns and `resolveAfterAttach` reads the exit status off the
 *     still-`remain-on-exit` dead pane, then kills the session (EXEC-23b, unchanged);
 *   - no client: `kill-session` outright. Without this the dead pane sits under
 *     `remain-on-exit` as an idle-looking husk until the daemon's periodic
 *     `reapDeadTmuxPanes` sweep — the "second exit" / orphaned-idle session bug
 *     when a wrapped agent exits with nobody attached (a closed terminal, or a
 *     `/exit` after the user detached). `detach-client` on an unattached session
 *     is a no-op, so the old hook left the husk; `kill-session` ends it at once.
 * A user split's death still runs the else-branch, closing just that split via
 * `run-shell -b -C` with an explicit `-t #{hook_pane}` target: tmux format-expands
 * the command at fire time and executes it inside the server command queue in the
 * background, so the event pane is always the one killed without launching a second
 * tmux client against the same socket and without stalling the hook on a loaded
 * runner. Single source of truth: both the spawn-wrap (exec.ts) and the daemon
 * reconcile build the hook here, so the two can never drift.
 */
export function agentPaneDiedHook(sessionName: string, agentPane: string): string {
  const agentPaneAction = `if -F '#{session_attached}' 'detach-client -s =${sessionName}' 'kill-session -t =${sessionName}'`;
  return `if -F '#{==:#{hook_pane},${agentPane}}' "${agentPaneAction}" 'run-shell -b -C "kill-pane -t #{hook_pane}"'`;
}

/** Stamp a session's hook-schema marker to the current version. */
export async function markSessionHookSchema(name: string, socket?: string, timeoutMs?: number): Promise<void> {
  const sock = socket ?? getDefaultSocketPath();
  await runTmux({ socket: sock, args: ['set-option', '-t', name, HOOK_SCHEMA_OPTION, String(AGENT_HOOK_SCHEMA)], throwOnError: false, timeoutMs }).catch(() => {});
}

/** Read a session's hook-schema marker; undefined when unset (pre-marker sessions). */
async function readHookSchema(name: string, socket: string, timeoutMs?: number): Promise<string | undefined> {
  const res = await runTmux({ socket, args: ['show-options', '-v', '-t', name, HOOK_SCHEMA_OPTION], throwOnError: false, timeoutMs }).catch(() => null);
  if (!res || res.code !== 0) return undefined;
  const v = res.stdout.trim();
  return v === '' ? undefined : v;
}

/**
 * Lowest pane id (`%N`) in a session — the first pane created, i.e. the agent
 * pane, since user splits are always created later and get higher ids. Fallback
 * for sessions whose SessionMeta (which records the agent pane) predates meta
 * persistence. Undefined when the session has no panes (already torn down).
 */
async function lowestPaneId(name: string, socket: string, timeoutMs?: number): Promise<string | undefined> {
  const res = await runTmux({ socket, args: ['list-panes', '-t', name, '-F', '#{pane_id}'], throwOnError: false, timeoutMs }).catch(() => null);
  if (!res || res.code !== 0) return undefined;
  const ids = res.stdout.split('\n').map(l => l.trim()).filter(id => /^%\d+$/.test(id));
  if (!ids.length) return undefined;
  return ids.reduce((lo, id) => (parseInt(id.slice(1), 10) < parseInt(lo.slice(1), 10) ? id : lo));
}

/**
 * The outcome of {@link prepareSessionForResume}. `attach` carries the pane it
 * positively resolved so the caller can read that pane's exit status back after
 * its attach client returns — without that, a resume-attach has no handle to ask
 * tmux what happened and can only assume success (EXEC-23b).
 */
type ResumePreparation =
  | { decision: 'attach'; pane: string }
  | { decision: 'create' };

/**
 * Decide whether a native resume may attach an existing managed tmux session.
 * Only a positively resolved, living agent pane is reusable. Metadata-less
 * legacy sessions and stale metadata resolve their real first pane through
 * tmux before the decision; a dead or unreadable session is reaped so the
 * caller can create a fresh wrapper for the resumed harness.
 */
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
    // Self-heal a legacy/stale hook right before handing the session back to
    // an attach client — the steady-state repair point between the daemon's
    // startup and upgrade one-shots (RUSH-2435).
    await ensureSessionHookRepaired(name, sock);
    return { decision: 'attach', pane };
  }

  await killSession(name, sock);
  return { decision: 'create' };
}

/**
 * Repair ONE session's `pane-died` hook if it predates AGENT_HOOK_SCHEMA.
 * Idempotent and NON-DESTRUCTIVE — only `set-hook`s, never kills a pane or
 * detaches a client. Shared by {@link reconcileSessionHooks} (full sweep) and
 * {@link ensureSessionHookRepaired} (single session, called before attach) so
 * the two can never drift on what counts as "repaired" (RUSH-2435).
 */
async function repairSessionHookIfStale(name: string, sock: string, meta: SessionMeta | undefined, timeoutMs: number = TMUX_HOOK_REPAIR_TIMEOUT_MS): Promise<boolean> {
  if (await readHookSchema(name, sock, timeoutMs) === String(AGENT_HOOK_SCHEMA)) return false;
  const agentPane = meta?.pane ?? await lowestPaneId(name, sock, timeoutMs);
  if (!agentPane) return false;
  const installed = await setSessionHook(name, 'pane-died', agentPaneDiedHook(name, agentPane), sock, timeoutMs);
  if (!installed) return false;
  await markSessionHookSchema(name, sock, timeoutMs);
  return true;
}

/**
 * Retrofit the current guarded `pane-died` hook onto every managed `agents run`
 * session whose hook predates AGENT_HOOK_SCHEMA. Idempotent and NON-DESTRUCTIVE:
 * it only `set-hook`s (never kills a pane or detaches a client), so a long-lived
 * shared server started by a pre-fix binary — whose still-running sessions carry
 * the old unconditional hook that kicked the user out of the whole view when they
 * exited a split — self-heals in place, without waiting for those agents to exit
 * or for the server to be recycled.
 *
 * NOT a daemon poll — the 5-minute `tmux-reconcile` routine that used to call this
 * was deleted (RUSH-2495). It survives as the version-skew ONE-SHOT: the daemon
 * calls it once at startup (`runDaemon` in `../daemon.js`) and once from the
 * upgrade-time migration (`runMigration` in `../migrate.js`), so a session a
 * pre-fix binary left with a stale hook still self-heals without a live poller.
 * `ensureSessionHookRepaired` covers the steady-state gap between those two
 * points by repairing a single session right before it's attached to. The
 * per-session `@ag_hook_schema` marker makes both paths a cheap no-op once a
 * session is current. Only run-wrapped sessions (`ag-` prefix) are touched — an
 * externally-created session on the socket keeps whatever hook it set.
 */
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
    if (!s.name.startsWith('ag-')) continue; // only run-wrapped sessions
    if (await repairSessionHookIfStale(s.name, sock, s.meta)) reconciled++;
  }
  return { scanned: sessions.length, reconciled };
}

/**
 * Repair a single managed session's `pane-died` hook right before it is
 * attached to, so a legacy session left by a pre-fix binary self-heals on the
 * next touch instead of waiting for the next daemon-startup/upgrade one-shot
 * (RUSH-2435). Only `ag-`-prefixed (run-wrapped) sessions are touched; a no-op
 * for anything else. Best-effort — never throws, so a repair failure can never
 * block the attach it is protecting.
 */
export async function ensureSessionHookRepaired(name: string, socket?: string): Promise<void> {
  if (!name.startsWith('ag-')) return;
  const sock = socket ?? getDefaultSocketPath();
  if (!fs.existsSync(sock)) return;
  try {
    await repairSessionHookIfStale(name, sock, readSessionMeta(name) ?? undefined);
  } catch {
    // best-effort — an attach must never fail because a repair attempt did
  }
}

/**
 * List live sessions on the socket. Reconciles meta JSONs against tmux's view:
 *  - tmux session with no meta → returned without `meta` (external session)
 *  - meta file with no tmux session → meta deleted (stale)
 */
export async function listSessions(opts: { socket?: string; timeoutMs?: number } = {}): Promise<ListedSession[]> {
  const socket = opts.socket ?? getDefaultSocketPath();
  if (!fs.existsSync(socket)) {
    // No server has ever run — clean orphan metas defensively.
    pruneAllMetas();
    return [];
  }

  // Pipe-separated format so we don't need to parse tmux's variable-width default output.
  const fmt = '#{session_name}|#{session_created}|#{session_windows}|#{session_attached}';
  const res = await runTmux({
    socket,
    args: ['list-sessions', '-F', fmt],
    throwOnError: false,
    timeoutMs: opts.timeoutMs,
  });

  // tmux returns nonzero with "no server running" or "no sessions" — both mean empty.
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

  // Drop metas with no matching live session.
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

/**
 * Split the active pane of a session. Returns the new pane's tmux pane id
 * (e.g. `%3`) so callers can target it later via `send`/`capture`.
 */
export async function splitPane(opts: SplitOptions): Promise<string> {
  assertValidSessionName(opts.name);
  const socket = opts.socket ?? getDefaultSocketPath();
  if (opts.cwd && !fs.existsSync(opts.cwd)) {
    throw new TmuxSessionError(`cwd does not exist: ${opts.cwd}`);
  }

  // tmux split-window directions: -h splits the pane left/right (sibling on the
  // right); -v splits top/bottom. swarmify treats H as "below" and V as "side"
  // — keep tmux semantics (h=left/right, v=top/bottom) and document it.
  // Pane-target ops use the bare name (no =) — the '=' exact-match modifier is
  // a session-only feature; pane targets reject it with "can't find pane".
  // Slug validation already guarantees the name is unambiguous.
  const args = ['split-window', `-${opts.direction}`, '-t', opts.name, '-P', '-F', '#{pane_id}'];
  if (opts.cwd) args.push('-c', opts.cwd);
  if (opts.cmd) args.push('--', 'sh', '-c', opts.cmd);

  const res = await runTmux({ socket, args });
  return res.stdout.trim();
}

export interface SendOptions {
  name: string;
  /** Pane id (e.g. `%2`) or pane index (`0`, `1`) — appended after the session name when targeting a specific pane. */
  pane?: string;
  /** The literal characters to type into the pane. */
  keys: string;
  /** When true, do NOT append Enter at the end. */
  noEnter?: boolean;
  /**
   * When true, treat `keys` as a single literal string (-l flag). When false
   * (default), tmux interprets named keys like `C-c`, `Enter`, `Escape`.
   */
  raw?: boolean;
  socket?: string;
}

/** Send keystrokes to a session's active pane (or a specific pane via :pane). */
export async function sendKeys(opts: SendOptions): Promise<void> {
  assertValidSessionName(opts.name);
  const socket = opts.socket ?? getDefaultSocketPath();
  // Bare name (no =) for pane targets — see note in splitPane.
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
  /** Number of lines from history to include (default: visible screen only). */
  lines?: number;
  /** Keep ANSI escape sequences (default strips them). */
  ansi?: boolean;
  socket?: string;
}

/** Capture pane contents as a string. The cleaned form is what humans see. */
export async function capturePane(opts: CaptureOptions): Promise<string> {
  assertValidSessionName(opts.name);
  const socket = opts.socket ?? getDefaultSocketPath();
  // Bare name (no =) for pane targets — see note in splitPane.
  const target = opts.pane ? `${opts.name}.${opts.pane}` : opts.name;
  const args = ['capture-pane', '-p', '-t', target];
  if (opts.ansi) args.push('-e');
  if (opts.lines && opts.lines > 0) {
    // -S -N means "start N lines back from current view"; we use -S -<lines> -E -.
    args.push('-S', `-${opts.lines}`);
  }
  const res = await runTmux({ socket, args });
  return res.stdout;
}

/** Read a session's provenance JSON, if present. */
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
  try { fs.unlinkSync(getSessionMetaPath(name)); } catch { /* may not exist */ }
}

function pruneOrphanMetas(liveNames: Set<string>): void {
  const dir = ensureTmuxDir();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const name = f.slice(0, -5);
    if (!liveNames.has(name)) {
      try { fs.unlinkSync(`${dir}/${f}`); } catch { /* race-tolerant */ }
    }
  }
}

function pruneAllMetas(): void {
  const dir = ensureTmuxDir();
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.json')) {
      try { fs.unlinkSync(`${dir}/${f}`); } catch { /* race-tolerant */ }
    }
  }
}
