import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import * as os from 'os';
import { sleepSync } from '../fs-atomic.js';

/** Forcefully terminates a process AND its descendant tree. Windows: `taskkill /F /T /PID`
 * (TerminateProcess orphans children). POSIX: SIGKILL to the pid (callers owning a process group
 * can pass the negative pid). Best-effort, never throws; an already-exited process is success. */
export function killTree(pid: number): void {
  // Windows taskkill must terminate descendants too; POSIX callers manage process groups separately.
  if (!pid || pid <= 0) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    } catch {  }
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {  }
  }
}

/** Spawn options for long-lived background children. POSIX: detached so the child leads its own
 * group. Windows (#556): must not share the launcher's console; with piped stdio use windowsHide
 * and not detached (DETACHED_PROCESS defeats it); with fd stdio libuv skips it, so keep detached. */
export function backgroundSpawnOptions(
  opts: { cwd?: string; fdStdio?: boolean; platform?: NodeJS.Platform } = {},
): { cwd: string; detached: boolean; windowsHide: boolean } {
  const platform = opts.platform ?? process.platform;
  const cwd = opts.cwd ?? os.homedir();
  if (platform === 'win32') {
    // Detached Windows children lose usable stdio unless real descriptors were supplied.
    return opts.fdStdio
      ? { cwd, detached: true, windowsHide: true }
      : { cwd, detached: false, windowsHide: true };
  }
  return { cwd, detached: true, windowsHide: false };
}

/** Is a process with this PID alive? Uses the cross-platform signal-0 probe and returns false on
 * any error (no such process, or no permission). */
/** Poll interval while waiting for a pid to disappear. */
const EXIT_POLL_MS = 50;

/** True if `pid` is dead or a zombie awaiting reap. `kill(pid, 0)` succeeds for zombies, and
 * waitForExit blocks the event loop so our own child daemon never gets reaped. */
export function hasExited(pid: number): boolean {
  if (!isAlive(pid)) return true;
  if (process.platform === 'win32') return false;
  // kill(0) reports zombies alive; ps state is needed before bounded shutdown waits can finish.
  try {
    const state = execFileSync('ps', ['-o', 'state=', '-p', String(pid)], { encoding: 'utf-8' }).trim();
    return state.startsWith('Z');
  } catch (err: any) {
    // `ps` failing because the pid is unknown means gone. Any other failure is not evidence of
    // death, so fail closed and keep treating the pid as alive.
    if (err?.code === 'ENOENT' && err?.syscall === 'spawnSync ps') return false;
    const out = String(err?.stdout ?? '').trim();
    const errOut = String(err?.stderr ?? '').trim();
    if (err?.status === 1 && out === '' && errOut === '') return true;
    return false;
  }
}

/** Block until `pid` stops serving or `timeoutMs` elapses; true if gone. Synchronous on purpose:
 * short-lived callers (postinstall) exit before an async timer fires. */
export function waitForExit(pid: number, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (hasExited(pid)) return true;
    if (Date.now() >= deadline) return false;
    sleepSync(EXIT_POLL_MS);
  }
}

export function isAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Memoized per pid. Start time cannot change while a process lives, and a recycled pid still
 * compares unequal to the recorded value. */
const startTimeByPid = new Map<number, string | null>();

/** Stable identifier of the process at `pid` as of its start, or null; defeats PID reuse and is
 * only compared for equality against an earlier capture. Linux: /proc/<pid>/stat field 22. macOS:
 * `ps -o lstart=`. Windows: Win32_Process CreationDate. */
export function captureProcessStartTime(pid: number, opts: { fresh?: boolean } = {}): string | null {
  // Persist start identity with a PID so later cleanup cannot kill an unrelated recycled process.
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const cached = startTimeByPid.get(pid);
  if (!opts.fresh && cached !== undefined) return cached;
  const value = readProcessStartTime(pid);
  startTimeByPid.set(pid, value);
  return value;
}

function readProcessStartTime(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToFileTimeUtc()`,
        ],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5000 },
      );
      const trimmed = out.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const lastParen = stat.lastIndexOf(')');
      if (lastParen < 0) return null;
      const fields = stat.slice(lastParen + 2).split(' ');
      return fields[19] || null;
    }
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
