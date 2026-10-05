import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import lockfile from 'proper-lockfile';

const LOCK_STALE_MS = 5_000;
const LOCK_ACQUIRE_TIMEOUT_MS = 30_000;
const LOCK_RETRY_MIN_MS = 50;
const LOCK_RETRY_MAX_MS = 250;

const _sleepBuf = new Int32Array(new SharedArrayBuffer(4));

export function sleepSync(ms: number): void {
  Atomics.wait(_sleepBuf, 0, 0, ms);
}

export function ensureLockTarget(filePath: string, initialContent = '', dirMode?: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, ...(dirMode != null ? { mode: dirMode } : {}) });
  if (fs.existsSync(filePath)) return;
  try {
    fs.writeFileSync(filePath, initialContent, { encoding: 'utf-8', flag: 'wx' });
  } catch (err: any) {
    if (err?.code !== 'EEXIST') throw err;
  }
}

export function atomicWriteFileSync(filePath: string, content: string, options: fs.WriteFileOptions = 'utf-8'): void {
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  fs.writeFileSync(tmpPath, content, options);
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {  }
    throw err;
  }
}

export function atomicWriteJsonSync(filePath: string, data: unknown): void {
  atomicWriteFileSync(filePath, JSON.stringify(data, null, 2));
}

export async function atomicWriteFile(filePath: string, content: string, options: fs.WriteFileOptions = 'utf-8'): Promise<void> {
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  await fs.promises.writeFile(tmpPath, content, options);
  try {
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    try { await fs.promises.unlink(tmpPath); } catch {  }
    throw err;
  }
}

export interface FileLockOptions {
  staleMs?: number;
  acquireTimeoutMs?: number;
  realpath?: boolean;
}

export function withFileLock<T>(filePath: string, fn: (heartbeat: () => void) => T, opts: FileLockOptions = {}): T {
  let release: (() => void) | null = null;
  let lastError: unknown;
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
      if (err instanceof Error && (err as any).code === 'ENOTDIR') {
        try {
          const base = (opts.realpath ?? true) ? fs.realpathSync(filePath) : filePath;
          const lockPath = `${base}.lock`;
          const st = fs.statSync(lockPath);
          if (st.isFile()) fs.unlinkSync(lockPath);
        } catch {  }
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
  const lockDir = `${filePath}.lock`;

  const heartbeat = (): void => {
    try { const now = new Date(); fs.utimesSync(lockDir, now, now); } catch {  }
  };
  try {
    const result = fn(heartbeat);
    if (compromised) {
      throw new Error(
        `Lock for ${filePath} was broken by another process while held: ` +
        `${(compromised as Error).message}`,
      );
    }
    return result;
  } finally {
    try { release(); } catch {  }
  }
}

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
        } catch {  }
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
    try { const now = new Date(); fs.utimesSync(lockDir, now, now); } catch {  }
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
    try { await release(); } catch {  }
  }
}
