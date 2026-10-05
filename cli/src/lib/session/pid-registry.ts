/** Per-PID session registry, headless equivalent of the extension's `live-terminals.json`: `ag run`
 * records the exact session id per pid so `sessions --active` avoids the newest-jsonl guess.
 * Best-effort; failures degrade to it. */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { hostProcessView, writerProcessView } from './process-view.js';
import { getTerminalsDir } from '../state.js';
import { atomicWriteFileSync, withFileLock } from '../fs-atomic.js';

export interface PidSessionEntry {
  pid: number;
  agent: string;
  /** Custom harness/profile name when launched via `agents run <profile>` (e.g. `deepseek`).
   * `agent` stays the host CLI so process matching works; `sessions --active` shows this
   * (PHNX-2935). */
  harness?: string;
  /** The launch session id. Present for agents launched with a known id (Claude). */
  sessionId?: string;
  cwd?: string;
  /** Resolved actor id (`resolveActor().id`) stamped at spawn: a tailnet login/email, or
   * `UNRESOLVED@<host>`. Surfaced as the session `owner` (RUSH-2018). */
  actor?: string;
  /** The actor's kind: `'human'` for a person-initiated run, `'agent'` for one an agent
   * spawned. Pairs with `actor` like `AGENTS_ACTOR_KIND` on the exec env. */
  initiatedBy?: 'human' | 'agent';
  /** Launch id minted by `ag run` and exported as `AGENT_LAUNCH_ID`. The SessionStart hook records
   * the same id, so records reconcile even under a different pid (see resolveHookSessionId). Gives
   * non-Claude launches an exact session id instead of the newest-jsonl heuristic. */
  launchId?: string;
  /** `AGENT_TERMINAL_ID` when inherited (a Factory VS Code tab); a secondary join key to the
   * hook's `terminal_id`. Undefined outside the extension. */
  terminalId?: string;
  /** `$TMUX_PANE` at launch, kept for diagnostics. Not consulted on read: listing keys purely
   * on pid, so this is not an anti-collision key. */
  tmuxPane?: string;
  startedAtMs: number;
  /** Kernel provenance, captured by the writer; absent on legacy records. */
  processIdentity?: { bootId?: string; pidNamespace?: string; initStartTicks?: string; startTicks?: string; startTime?: string };
}

function linuxStartTicks(pid: number): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm (field 2) may contain spaces or parentheses; starttime is field 22.
    const value = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    return value && /^\d+$/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function pidExists(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return undefined;
  }
}

function darwinStartTime(pid: number): string | undefined {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch { return undefined; }
}

function processStartTimeMs(value: string | undefined): number {
  return typeof value === 'string' ? Date.parse(value.trim().replace(/\s+/g, ' ')) : NaN;
}

/** ps lstart fields can differ in padding or date formatting between invocations. */
export function processStartTimesMatch(recorded: string | undefined, observed: string | undefined): boolean | undefined {
  const recordedMs = processStartTimeMs(recorded);
  const observedMs = processStartTimeMs(observed);
  return Number.isFinite(recordedMs) && Number.isFinite(observedMs) ? recordedMs === observedMs : undefined;
}

/** Read-only identity proof for exact joins. Unknown is never a positive match. */
export function pidSessionEntryMatchesLiveProcess(entry: PidSessionEntry, startTime?: string): boolean | undefined {
  if (!Number.isInteger(entry.pid) || entry.pid < 1) return undefined;
  if (process.platform === 'darwin') {
    const exists = pidExists(entry.pid);
    if (exists !== true) return exists;
    const start = startTime ?? darwinStartTime(entry.pid);
    return processStartTimesMatch(entry.processIdentity?.startTime, start);
  }
  if (process.platform !== 'linux') return undefined;
  const scope = hostProcessView();
  if (!scope || entry.processIdentity?.bootId !== scope.bootId
    || entry.processIdentity?.pidNamespace !== scope.pidNamespace
    || entry.processIdentity?.initStartTicks !== scope.initStartTicks) return undefined;
  const exists = pidExists(entry.pid);
  if (exists !== true) return exists;
  const start = linuxStartTicks(entry.pid);
  const recordedStart = entry.processIdentity?.startTicks;
  if (!start || typeof recordedStart !== 'string' || !/^\d+$/.test(recordedStart)) return undefined;
  return start === recordedStart;
}

/** Pull an explicit `--session-id <uuid>` (or `=<uuid>`) out of a raw agent arg vector, so
 * launchers that already name the session get the same exact pid -> session mapping. */
const SESSION_ID_VALUE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isSessionIdShape(value: string): boolean {
  return SESSION_ID_VALUE_RE.test(value);
}
export function extractSessionIdArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--session-id') {
      const v = args[i + 1];
      if (v && SESSION_ID_VALUE_RE.test(v)) return v;
    } else if (a.startsWith('--session-id=')) {
      const v = a.slice('--session-id='.length);
      if (SESSION_ID_VALUE_RE.test(v)) return v;
    }
  }
  return undefined;
}

/** Read a live process's argv (best-effort): `/proc/<pid>/cmdline` on Linux, `ps -ww -o args=`
 * whitespace-split on Darwin, undefined elsewhere. RUSH-2384: the by-pid registry is often empty
 * mid-run, but the live argv still carries `--session-id`. */
export function readProcessArgv(pid: number): string[] | undefined {
  if (!pid || pid < 1) return undefined;
  if (process.platform === 'linux') {
    try {
      const buf = fs.readFileSync(`/proc/${pid}/cmdline`);
      const parts = buf.toString('utf8').split('\0').filter(Boolean);
      return parts.length > 0 ? parts : undefined;
    } catch {
      return undefined;
    }
  }
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'args='], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (!out) return undefined;
      return out.split(/\s+/);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Exact session id a live process was launched with, from its current argv; undefined if the
 * process is gone, argv is unavailable, or there is no `--session-id`. */
export function sessionIdFromLivePid(pid: number): string | undefined {
  const argv = readProcessArgv(pid);
  if (!argv) return undefined;
  return extractSessionIdArg(argv);
}

function pidRegistryDir(): string {
  return path.join(getTerminalsDir(), 'by-pid');
}

function entryPath(pid: number): string {
  return path.join(pidRegistryDir(), `${pid}.json`);
}

// The deployed SessionStart hook reconstructs by-pid entries from an allowlist.
// Keep launcher ownership separately, bound to the immutable launch coordinates.
function ownershipPath(pid: number): string {
  return path.join(getTerminalsDir(), 'by-pid-ownership', `${pid}.json`);
}

function persistOwnership(entry: PidSessionEntry): void {
  fs.mkdirSync(path.dirname(ownershipPath(entry.pid)), { recursive: true });
  atomicWriteFileSync(ownershipPath(entry.pid), JSON.stringify(entry), 'utf8');
}

function restoreOwnership(entry: PidSessionEntry): PidSessionEntry {
  if (entry.processIdentity) return entry;
  try {
    const owner = JSON.parse(fs.readFileSync(ownershipPath(entry.pid), 'utf8')) as PidSessionEntry;
    if (owner.pid === entry.pid && owner.launchId === entry.launchId && owner.startedAtMs === entry.startedAtMs) {
      return { ...entry, processIdentity: owner.processIdentity };
    }
  } catch { /* legacy launch */ }
  return entry;
}

/** Record a launched agent process. Never throws — the registry is an optimization. */
export function writePidSessionEntry(entry: PidSessionEntry): void {
  if (!Number.isInteger(entry.pid) || entry.pid < 1) return;
  try {
    const scope = process.platform === 'linux' ? writerProcessView() : undefined;
    if (process.platform === 'linux' && !scope) return;
    fs.mkdirSync(pidRegistryDir(), { recursive: true });
    const processIdentity = scope?.bootId && scope.pidNamespace ? { bootId: scope.bootId, pidNamespace: scope.pidNamespace, initStartTicks: scope.initStartTicks, startTicks: linuxStartTicks(entry.pid) }
      : process.platform === 'darwin' ? { startTime: darwinStartTime(entry.pid) } : undefined;
    const file = entryPath(entry.pid);
    withFileLock(file, () => {
      // The host writer owns numeric PID slots. Old-boot and legacy records
      // must not reserve a recycled slot; restricted namespaces never get here.
      const owned = { ...entry, processIdentity };
      persistOwnership(owned);
      atomicWriteFileSync(file, JSON.stringify(owned), 'utf8');
    }, { realpath: false, acquireTimeoutMs: 0 });
  } catch {
    /* degrade to the newest-jsonl heuristic */
  }
}

/** Look up a live pid's recorded session. Returns undefined if absent/corrupt. */
export function readPidSessionEntry(pid: number): PidSessionEntry | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(entryPath(pid), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.pid === pid) {
      return restoreOwnership(parsed as PidSessionEntry);
    }
  } catch {
    /* unparseable */
  }
  return undefined;
}

/** Live consumers require identity proof; raw history is not a PID binding.
 * A shared process snapshot may supply lstart to avoid a per-pid ps probe. */
export function readLivePidSessionEntry(pid: number, startTime?: string): PidSessionEntry | undefined {
  const entry = readPidSessionEntry(pid);
  if (!entry || !hostProcessView()) return undefined;
  if (process.platform === 'win32') return pidExists(pid) === true ? entry : undefined;
  if (!entry.processIdentity && pidExists(pid) === true) {
    // Upgrade a native legacy launch only after the home namespace is proven,
    // and the actual process start excludes a recycled PID. Hook timestamps may
    // be later than process start, but cannot predate this process incarnation.
    const start = startTime ?? darwinStartTime(pid);
    const startMs = processStartTimeMs(start);
    if (Number.isFinite(startMs) && entry.startedAtMs >= startMs - 1000 && entry.startedAtMs <= Date.now()) {
      const scope = hostProcessView()!;
      entry.processIdentity = process.platform === 'linux'
        ? { ...scope, startTicks: linuxStartTicks(pid) }
        : { startTime: start };
      try { persistOwnership(entry); } catch { /* read remains useful */ }
    }
  }
  return pidSessionEntryMatchesLiveProcess(entry, startTime) === true ? entry : undefined;
}

/** Every recorded launch, live or dead pid, indexed by `tmuxPane` so a pane the CLI did not wrap
 * can be attributed to its exact launch; callers filter to live pids. Best-effort: corrupt files
 * are skipped and a missing dir yields `[]`. */
export function listPidSessionEntries(): PidSessionEntry[] {
  let files: string[];
  try {
    files = fs.readdirSync(pidRegistryDir()).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: PidSessionEntry[] = [];
  for (const f of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(pidRegistryDir(), f), 'utf8'));
      if (parsed && typeof parsed === 'object' && typeof parsed.pid === 'number') {
        out.push(restoreOwnership(parsed as PidSessionEntry));
      }
    } catch {
      /* raced with a writer/pruner, or corrupt — skip */
    }
  }
  return out;
}

/** Remove entries whose pid is no longer alive. On Linux, delete only when the writer's boot and
 * PID namespace match ours; ESRCH elsewhere says nothing. Unknown ownership is never treated as
 * dead. Kernel start ticks reject PID reuse; other platforms keep the caller's start-time check. */
export function prunePidSessionRegistry(isAlive?: (pid: number, startedAtMs?: number) => boolean | undefined): void {
  let files: string[];
  try {
    files = fs.readdirSync(pidRegistryDir()).filter(f => f.endsWith('.json'));
  } catch {
    return;
  }
  const scope = process.platform === 'linux' ? hostProcessView() : undefined;
  for (const f of files) {
    const pid = Number(f.slice(0, -'.json'.length));
    if (!Number.isInteger(pid) || pid < 1) continue;
    let raw: string;
    let entry: PidSessionEntry;
    try {
      raw = fs.readFileSync(path.join(pidRegistryDir(), f), 'utf8');
      entry = restoreOwnership(JSON.parse(raw));
      if (entry?.pid !== pid) continue;
    } catch {
      continue;
    }
    if (process.platform === 'linux' && (!scope
      || entry.processIdentity?.bootId !== scope.bootId
      || entry.processIdentity?.pidNamespace !== scope.pidNamespace
      || entry.processIdentity?.initStartTicks !== scope.initStartTicks)) continue;
    const exists = pidExists(pid);
    if (exists === undefined) continue;
    if (exists) {
      if (process.platform === 'linux') {
        const start = linuxStartTicks(pid);
        const recordedStart = entry.processIdentity?.startTicks;
        if (!start || typeof recordedStart !== 'string' || !/^\d+$/.test(recordedStart) || start === recordedStart) continue;
      } else if (!isAlive || isAlive(pid, entry.startedAtMs) !== false) continue;
    }
    try {
      const file = path.join(pidRegistryDir(), f);
      // Share the writer's lock so comparison and deletion cannot remove a
      // successor published after the liveness check.
      withFileLock(file, () => {
        if (fs.readFileSync(file, 'utf8') === raw) fs.unlinkSync(file);
      }, { realpath: false, acquireTimeoutMs: 0 });
    } catch {
      /* raced with another writer/pruner */
    }
  }
}
