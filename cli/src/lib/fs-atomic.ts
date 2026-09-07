import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import lockfile from 'proper-lockfile';

const LOCK_STALE_MS = 5_000;
// Wall-clock budget to acquire the lock before giving up. A count-bounded retry
// (the old 5 attempts / ~750ms ceiling) could expire while a peer legitimately
// held the lock — under CI/parallel load two `agents` invocations mutating
// agents.yaml would have one throw and silently drop its write. The budget must
// comfortably exceed both a normal critical-section hold and the stale-break
// window (LOCK_STALE_MS): a dead holder's lock turns stale at 5s and is then
// broken on the next attempt, so this only ever waits out a live, in-progress
// holder. Bounded (not unbounded) so a truly wedged holder still surfaces an
// error instead of hanging the CLI forever.
const LOCK_ACQUIRE_TIMEOUT_MS = 30_000;
const LOCK_RETRY_MIN_MS = 50;
const LOCK_RETRY_MAX_MS = 250;

// Reused across all sleepSync calls — avoids allocating a new SAB each time.
const _sleepBuf = new Int32Array(new SharedArrayBuffer(4));

export function sleepSync(ms: number): void {
  Atomics.wait(_sleepBuf, 0, 0, ms);
}

/**
 * Ensures the target file (and its parent directory) exist so proper-lockfile
 * can create a sibling .lock directory. Created with flag 'wx' so concurrent
 * creation races are safe (EEXIST is swallowed).
 */
export function ensureLockTarget(filePath: string, initialContent = '', dirMode?: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, ...(dirMode != null ? { mode: dirMode } : {}) });
  if (fs.existsSync(filePath)) return;
  try {
    fs.writeFileSync(filePath, initialContent, { encoding: 'utf-8', flag: 'wx' });
  } catch (err: any) {
    if (err?.code !== 'EEXIST') throw err;
  }
}

/**
 * Writes content to filePath via a temp file + rename so readers never see a
 * partial write. On POSIX, rename(2) is atomic.
 */
export function atomicWriteFileSync(filePath: string, content: string, options: fs.WriteFileOptions = 'utf-8'): void {
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  fs.writeFileSync(tmpPath, content, options);
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

/**
 * Convenience wrapper around {@link atomicWriteFileSync} for the common case of
 * writing pretty-printed JSON (RUSH-2840). Same tmp-then-rename mechanics, same
 * caller responsibility to ensure the parent directory exists first — this adds
 * only the `JSON.stringify`.
 */
export function atomicWriteJsonSync(filePath: string, data: unknown): void {
  atomicWriteFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * Async counterpart of {@link atomicWriteFileSync} for callers on the daemon's
 * shared event loop (PHNX-3695): a `writeFileSync`/`renameSync` on a tick freezes
 * every service and the browser IPC server until the disk write returns. Same
 * tmp-then-rename atomicity, but every syscall is awaited via `fs/promises`.
 */
export async function atomicWriteFile(filePath: string, content: string, options: fs.WriteFileOptions = 'utf-8'): Promise<void> {
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  await fs.promises.writeFile(tmpPath, content, options);
  try {
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    try { await fs.promises.unlink(tmpPath); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

/**
 * Acquires an exclusive proper-lockfile lock on filePath, runs fn, then
 * releases the lock. Retries with capped linear back-off until either the lock
 * is acquired or LOCK_ACQUIRE_TIMEOUT_MS elapses. Breaks stale locks older than
 * LOCK_STALE_MS, so a crashed holder never blocks past the stale window.
 *
 * `fn` is handed a `heartbeat()` it can call during a long, fully SYNCHRONOUS
 * critical section. proper-lockfile keeps a held lock "alive" by refreshing its
 * lockfile mtime on a `setTimeout` every `stale/2` — but that timer only fires
 * when the event loop gets a turn. A synchronous hold that outruns `stale`
 * (e.g. the scrypt-bound rotation loop in filestore.ts, ~16s on a real store)
 * never yields, so the timer cannot run: the lock ages past `stale` mid-hold and a
 * peer contending for it treats the live holder as crashed, breaks the lock, and
 * interleaves — corrupting the invariant the lock exists to protect, with no crash
 * involved. `heartbeat()` drives the same refresh synchronously (bumps the lockfile
 * mtime), so a long sync holder stays fresh while the short `stale` window still
 * detects a genuinely crashed holder within LOCK_STALE_MS. Callers whose critical
 * section is short (a single read-modify-write) can ignore it.
 */
export interface FileLockOptions {
  staleMs?: number;
  acquireTimeoutMs?: number;
  /** Lock a canonical absolute path before its file exists (e.g. a new installation record). */
  realpath?: boolean;
}

export function withFileLock<T>(filePath: string, fn: (heartbeat: () => void) => T, opts: FileLockOptions = {}): T {
  let release: (() => void) | null = null;
  let lastError: unknown;
  // Set if a peer breaks this lock while we hold it. proper-lockfile reports that
  // from its own refresh TIMER, so the default handler rethrows asynchronously —
  // an uncatchable crash of the whole CLI process, from a callback no caller is
  // on the stack for. Capture it instead and surface it synchronously below.
  let compromised: Error | null = null;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const acquireTimeoutMs = opts.acquireTimeoutMs ?? LOCK_ACQUIRE_TIMEOUT_MS;
  const deadline = Date.now() + acquireTimeoutMs;
  for (let attempt = 0; ; attempt++) {
    try {
      release = lockfile.lockSync(filePath, {
        stale: staleMs,
        realpath: opts.realpath ?? true,
        onCompromised: (err: Error) => { compromised = err; },
      });
      break;
    } catch (err) {
      lastError = err;
      if (Date.now() >= deadline) break;
      const backoff = Math.min(LOCK_RETRY_MIN_MS * (attempt + 1), LOCK_RETRY_MAX_MS);
      sleepSync(Math.min(backoff, Math.max(0, deadline - Date.now())));
    }
  }
  if (!release) {
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(
      `Could not acquire lock for ${filePath} after ${acquireTimeoutMs}ms: ${message}`,
    );
  }
  // proper-lockfile's lock dir is `<filePath>.lock`; touching its mtime is exactly
  // what proper-lockfile's own async updater does, so the staleness check keys off
  // a fresh mtime. Best-effort: a failed touch just leaves the async updater's
  // behaviour unchanged (no worse than before this heartbeat existed).
  const lockDir = `${filePath}.lock`;
  const heartbeat = (): void => {
    try { const now = new Date(); fs.utimesSync(lockDir, now, now); } catch { /* best effort */ }
  };
  try {
    const result = fn(heartbeat);
    // A compromised lock means a peer may have written under us — the caller must
    // not treat the result as if it held exclusivity throughout.
    if (compromised) {
      throw new Error(
        `Lock for ${filePath} was broken by another process while held: ` +
        `${(compromised as Error).message}`,
      );
    }
    return result;
  } finally {
    // Releasing a lock a peer already stole throws ENOTACQUIRED; that is the
    // stolen case, already reported above, so don't mask it with a teardown error.
    try { release(); } catch { /* already gone */ }
  }
}

/**
 * Async counterpart of {@link withFileLock} for callers on the daemon's shared
 * event loop (PHNX-3695). The sync version retries acquisition with
 * {@link sleepSync} (`Atomics.wait`), which HALTS the thread for up to
 * {@link LOCK_ACQUIRE_TIMEOUT_MS} on contention — on a daemon tick that freezes
 * every service and the browser IPC server. This variant awaits proper-lockfile's
 * async `lock()` and yields with a real timer between retries, so the loop keeps
 * turning while a peer holds the lock. Same stale-break, same acquire budget,
 * same compromised-lock surfacing.
 */
export async function withFileLockAsync<T>(filePath: string, fn: (heartbeat: () => void) => Promise<T> | T, opts: FileLockOptions = {}): Promise<T> {
  let release: (() => Promise<void>) | null = null;
  let lastError: unknown;
  let compromised: Error | null = null;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const acquireTimeoutMs = opts.acquireTimeoutMs ?? LOCK_ACQUIRE_TIMEOUT_MS;
  const deadline = Date.now() + acquireTimeoutMs;
  for (let attempt = 0; ; attempt++) {
    try {
      release = await lockfile.lock(filePath, {
        stale: staleMs,
        realpath: opts.realpath ?? true,
        onCompromised: (err: Error) => { compromised = err; },
      });
      break;
    } catch (err) {
      lastError = err;
      if (Date.now() >= deadline) break;
      const backoff = Math.min(LOCK_RETRY_MIN_MS * (attempt + 1), LOCK_RETRY_MAX_MS);
      await new Promise((r) => setTimeout(r, Math.min(backoff, Math.max(0, deadline - Date.now()))));
    }
  }
  if (!release) {
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(
      `Could not acquire lock for ${filePath} after ${acquireTimeoutMs}ms: ${message}`,
    );
  }
  const lockDir = `${filePath}.lock`;
  const heartbeat = (): void => {
    try { const now = new Date(); fs.utimesSync(lockDir, now, now); } catch { /* best effort */ }
  };
  try {
    const result = await fn(heartbeat);
    if (compromised) {
      throw new Error(
        `Lock for ${filePath} was broken by another process while held: ` +
        `${(compromised as Error).message}`,
      );
    }
    return result;
  } finally {
    try { await release(); } catch { /* already gone */ }
  }
}
