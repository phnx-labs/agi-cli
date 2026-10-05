import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import lockfile from 'proper-lockfile';

const LOCK_STALE_MS = 5_000;
// Wall-clock budget to acquire the lock. A count-bounded retry (old 5 attempts, ~750ms) could
// expire while a peer legitimately held it, so a concurrent agents.yaml write was dropped. Must
// exceed LOCK_STALE_MS (5s); bounded so a wedged holder errors instead of hanging the CLI.
const LOCK_ACQUIRE_TIMEOUT_MS = 30_000;
const LOCK_RETRY_MIN_MS = 50;
const LOCK_RETRY_MAX_MS = 250;

// Reused across all sleepSync calls — avoids allocating a new SAB each time.
const _sleepBuf = new Int32Array(new SharedArrayBuffer(4));

export function sleepSync(ms: number): void {
  Atomics.wait(_sleepBuf, 0, 0, ms);
}

/** Ensures the target file and its parent directory exist so proper-lockfile can create a
 * sibling .lock directory. Flag 'wx' makes creation races safe (EEXIST swallowed). */
export function ensureLockTarget(filePath: string, initialContent = '', dirMode?: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, ...(dirMode != null ? { mode: dirMode } : {}) });
  if (fs.existsSync(filePath)) return;
  try {
    fs.writeFileSync(filePath, initialContent, { encoding: 'utf-8', flag: 'wx' });
  } catch (err: any) {
    if (err?.code !== 'EEXIST') throw err;
  }
}

/** Writes content via a temp file plus rename so readers never see a partial write; rename(2) is
 * atomic on POSIX. */
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

/** Wrapper around atomicWriteFileSync for pretty-printed JSON (RUSH-2840): same tmp-then-rename
 * mechanics, and the caller must ensure the parent directory exists. */
export function atomicWriteJsonSync(filePath: string, data: unknown): void {
  atomicWriteFileSync(filePath, JSON.stringify(data, null, 2));
}

/** Async counterpart of atomicWriteFileSync for the daemon's shared event loop (PHNX-3695): sync
 * write/rename on a tick freezes every service and the browser IPC server. Same atomicity,
 * every syscall awaited via `fs/promises`. */
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

/** Takes an exclusive proper-lockfile lock on filePath, runs fn, releases it. Retries until
 * LOCK_ACQUIRE_TIMEOUT_MS; breaks locks stale beyond LOCK_STALE_MS. fn gets heartbeat(): a long
 * synchronous hold (e.g. filestore.ts scrypt rotation) must call it, or a peer breaks the lock. */
export interface FileLockOptions {
  staleMs?: number;
  acquireTimeoutMs?: number;
  /** Lock a canonical absolute path before its file exists (e.g. a new installation record). */
  realpath?: boolean;
}

export function withFileLock<T>(filePath: string, fn: (heartbeat: () => void) => T, opts: FileLockOptions = {}): T {
  let release: (() => void) | null = null;
  let lastError: unknown;
  // Set if a peer breaks this lock while we hold it. proper-lockfile reports that from its refresh
  // timer, whose default handler rethrows asynchronously and crashes the CLI from a callback no
  // caller is on the stack for. Capture it and surface it synchronously.
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
      // proper-lockfile breaks stale locks with rmdir, which fails with ENOTDIR when a crash left a
      // regular file. Remove that file so the next attempt succeeds, using its own path resolution
      // (realpath by default, raw path when off).
      if (err instanceof Error && (err as any).code === 'ENOTDIR') {
        try {
          const base = (opts.realpath ?? true) ? fs.realpathSync(filePath) : filePath;
          const lockPath = `${base}.lock`;
          const st = fs.statSync(lockPath);
          if (st.isFile()) fs.unlinkSync(lockPath);
        } catch { /* best effort */ }
      }
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
  // The lock dir is `<filePath>.lock`; touching its mtime is what proper-lockfile's own async
  // updater does, so staleness sees a fresh mtime. Best-effort: a failed touch leaves the async
  // updater's behavior unchanged.
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

/** Async counterpart of withFileLock for the daemon's shared event loop (PHNX-3695). The sync
 * version retries with sleepSync (Atomics.wait), halting the thread up to
 * LOCK_ACQUIRE_TIMEOUT_MS and freezing every service and the browser IPC server. */
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
      if (err instanceof Error && (err as any).code === 'ENOTDIR') {
        try {
          const base = (opts.realpath ?? true) ? fs.realpathSync(filePath) : filePath;
          const lockPath = `${base}.lock`;
          const st = fs.statSync(lockPath);
          if (st.isFile()) fs.unlinkSync(lockPath);
        } catch { /* best effort */ }
      }
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
