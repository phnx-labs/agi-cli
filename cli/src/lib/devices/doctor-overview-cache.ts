/** Singleflight + short-TTL disk cache for the `agents doctor --json` overview polled by the
 * menu-bar helper (RUSH-2153). It is expensive, and relaunches stacked dozens of processes (load
 * ~300). One live compute at a time via a lockfile; waiters serve the last snapshot. */
import * as fs from 'fs';
import * as path from 'path';
import lockfile from 'proper-lockfile';

import { getCacheDir } from '../state.js';
import { ensureLockTarget } from '../fs-atomic.js';

const CACHE_FILE = '.doctor-overview.json';
const LOCK_TARGET_FILE = '.doctor-overview.lock-target';

/** Serve a cached snapshot without recomputing while it is younger than this. */
export const DOCTOR_OVERVIEW_FRESH_MS = 90_000;
/** A held lock older than this is a crashed computer and is broken. proper-lockfile refreshes mtime
 * every `stale/2` while a live computer holds it, so only a dead holder is broken. */
const LOCK_STALE_MS = 60_000;
/** How long a waiter blocks on the lock before serving the last snapshot. Sized above a slow
 * compute so a waiter usually gets the winner's write; capped so a wedged holder never hangs the
 * CLI. */
const LOCK_RETRIES = { retries: 240, factor: 1, minTimeout: 500, maxTimeout: 500 } as const;

interface CacheFile {
  version: 1;
  fetchedAt: number;
  payload: unknown;
}

/** Injectable IO + clock so tests exercise the real fs at a temp dir, no mocks. */
interface DoctorOverviewCacheDeps {
  /** Cache directory (default: the real `~/.agents/.cache`). */
  dir?: string;
  /** Clock (default: {@link Date.now}). */
  now?: () => number;
}

function cachePath(dir: string): string {
  return path.join(dir, CACHE_FILE);
}

/** Read the last snapshot (best-effort; missing/corrupt/wrong-version → null). */
export function readDoctorOverviewCache(
  deps: DoctorOverviewCacheDeps = {},
): { fetchedAt: number; payload: unknown } | null {
  const dir = deps.dir ?? getCacheDir();
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(dir), 'utf-8')) as CacheFile;
    if (parsed && parsed.version === 1 && typeof parsed.fetchedAt === 'number') {
      return { fetchedAt: parsed.fetchedAt, payload: parsed.payload };
    }
  } catch {
    // missing or corrupt — treat as no snapshot
  }
  return null;
}

/** Persist a fresh overview payload (best-effort; tmp+rename so reads are atomic). */
export function writeDoctorOverviewCache(payload: unknown, deps: DoctorOverviewCacheDeps = {}): void {
  const dir = deps.dir ?? getCacheDir();
  const now = deps.now ?? Date.now;
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const body: CacheFile = { version: 1, fetchedAt: now(), payload };
    const tmp = `${cachePath(dir)}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
    fs.renameSync(tmp, cachePath(dir));
  } catch {
    // best-effort; a failed write just means the next read falls back to live
  }
}

/** Drop the cached overview after a doctor repair changes (or fails to change) health. Best-effort
 * and narrow: it never touches the singleflight lock, so an in-progress compute stays owned by its
 * holder and no repair can create a retry loop. */
export function invalidateDoctorOverviewCache(deps: DoctorOverviewCacheDeps = {}): void {
  const dir = deps.dir ?? getCacheDir();
  try {
    fs.unlinkSync(cachePath(dir));
  } catch {
    // Missing/unlinkable cache is already equivalent to invalidated.
  }
}

/** Result of {@link enterDoctorOverviewGate}: non-null `cached` means print it and return; null
 * `cached` means the caller holds the lock, computes, calls {@link writeDoctorOverviewCache}, and
 * calls `release()` in a `finally` (idempotent) so a throwing compute still frees the lock. */
interface OverviewGate {
  cached: string | null;
  release?: () => void;
}

/** Enter the doctor-overview singleflight: returns a cached string to print, or a lock token to
 * compute, write, and release. A fresh snapshot (without `forceRefresh`) returns `{ cached }`;
 * otherwise one caller holds the lock. Never throws; failure degrades to a compute token. */
export async function enterDoctorOverviewGate(
  opts: { forceRefresh?: boolean; freshMs?: number } = {},
  deps: DoctorOverviewCacheDeps = {},
): Promise<OverviewGate> {
  const dir = deps.dir ?? getCacheDir();
  const now = deps.now ?? Date.now;
  const freshMs = opts.freshMs ?? DOCTOR_OVERVIEW_FRESH_MS;

  const serveFresh = (): string | null => {
    if (opts.forceRefresh) return null;
    const c = readDoctorOverviewCache({ dir });
    if (c && now() - c.fetchedAt < freshMs) return JSON.stringify(c.payload, null, 2);
    return null;
  };

  // 1. Fast path: a fresh snapshot serves without any compute or lock.
  const fast = serveFresh();
  if (fast !== null) return { cached: fast };

  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Can't even make the cache dir — fall back to an unguarded compute.
    return { cached: null, release: () => {} };
  }

  const lockTarget = path.join(dir, LOCK_TARGET_FILE);
  ensureLockTarget(lockTarget);

  // 2. Singleflight via proper-lockfile: one caller holds the lock and computes;
  //    the rest block here until it releases.
  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(lockTarget, {
      stale: LOCK_STALE_MS,
      retries: LOCK_RETRIES,
      // A peer broke our lock (only possible if we somehow went stale). Don't
      // crash on the async callback; we re-check the cache and serve/recompute.
      onCompromised: () => {},
    });
  } catch {
    // 3. Winner held the lock past our wait budget. Serve the last snapshot
    //    (even if stale) rather than pile on; only if there is genuinely none do
    //    we compute unguarded (rare cold-start under sustained load).
    const c = readDoctorOverviewCache({ dir });
    if (c) return { cached: JSON.stringify(c.payload, null, 2) };
    return { cached: null, release: () => {} };
  }

  // 4. Acquired. The winner may have written a fresh snapshot while we waited —
  //    serve it and release, instead of recomputing.
  const afterWait = serveFresh();
  if (afterWait !== null) {
    // Await, don't fire-and-forget: returning while the lockfile is on disk makes the next caller
    // retry against a logically free lock, the pile-up this gate prevents. It costs one unlink.
    await release().catch(() => {});
    return { cached: afterWait };
  }

  const rel = release;
  let released = false;
  return {
    cached: null,
    release: () => {
      if (released) return;
      released = true;
      void rel();
    },
  };
}
