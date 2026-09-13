/**
 * Singleflight + short-TTL disk cache for the `agents doctor --json` OVERVIEW
 * payload (the bare, no-target form the menu-bar helper and other pollers read).
 *
 * Why this exists (RUSH-2153): the bare `doctor --json` overview is expensive —
 * it probes every host CLI, spawns every installed agent CLI for its sign-in,
 * and diffs every agent×version against its source. On an idle box that is a few
 * seconds; on a loaded one it is minutes. The menu-bar helper polls it on a 60s
 * timer with a per-*process* in-flight guard, so nothing coalesces ACROSS
 * processes: a helper relaunch (or any second poller) each launches its own
 * live compute, and a helper killed mid-run orphans its `doctor --json` child,
 * which keeps spinning. In steady state this stacked to dozens of concurrent
 * `doctor --json` processes pinning ~14 cores and driving load to ~300.
 *
 * The fix mirrors the {@link readStatsCache}/`writeStatsCache` mirror-file
 * convention: reads are cache-first, and when a live compute IS needed exactly
 * ONE runs at a time. The singleflight is the shared `proper-lockfile` lock (via
 * `ensureLockTarget` + `lockfile.lock`) — the SAME battle-tested lock the rest of
 * the CLI uses (fs-atomic.ts) — which owns two things a hand-rolled lock got
 * wrong: (1) it auto-refreshes the lock's mtime on a timer while held, so a live
 * computer whose compute runs for minutes is never mistaken for a crashed one
 * and stolen; (2) `release()` only ever releases the lock THIS caller acquired,
 * so a slow computer can't delete a successor's lock. Waiters block on the lock
 * up to a bounded budget, then serve the last snapshot rather than pile on.
 *
 * The cache write is tmp+rename so a concurrent reader never sees a partial file.
 * All IO is best-effort: a failure degrades to a live compute, never a throw.
 */
import * as fs from 'fs';
import * as path from 'path';
import lockfile from 'proper-lockfile';

import { getCacheDir } from '../state.js';
import { ensureLockTarget } from '../fs-atomic.js';

const CACHE_FILE = '.doctor-overview.json';
const LOCK_TARGET_FILE = '.doctor-overview.lock-target';

/** Serve a cached snapshot without recomputing while it is younger than this. */
export const DOCTOR_OVERVIEW_FRESH_MS = 90_000;
/**
 * A held lock older than this is treated as a crashed computer and broken. The
 * lock's mtime is auto-refreshed by proper-lockfile every `stale/2` while a live
 * computer holds it (the event loop turns during the compute's `await`ed
 * subprocess spawns), so this only ever breaks a genuinely dead holder.
 */
const LOCK_STALE_MS = 60_000;
/**
 * How long a waiter blocks on the lock before giving up and serving the last
 * snapshot. Sized to comfortably exceed a slow (multi-second-to-minutes) compute
 * so a waiter normally gets the winner's fresh write; capped so a truly wedged
 * holder never hangs the CLI (it serves stale instead).
 */
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

/**
 * Drop the cached overview after a doctor repair attempt changes (or fails to
 * change) live health. Best-effort and deliberately narrow: it never touches
 * the singleflight lock, so an in-progress overview compute remains owned by
 * its holder and no repair can create a retry loop.
 */
export function invalidateDoctorOverviewCache(deps: DoctorOverviewCacheDeps = {}): void {
  const dir = deps.dir ?? getCacheDir();
  try {
    fs.unlinkSync(cachePath(dir));
  } catch {
    // Missing/unlinkable cache is already equivalent to invalidated.
  }
}

/**
 * Result of {@link enterDoctorOverviewGate}.
 *  - `cached` non-null → the caller MUST print this string and return; no compute.
 *  - `cached` null     → the caller holds the singleflight lock: compute the
 *    overview, call {@link writeDoctorOverviewCache}, and invoke `release()` on
 *    the way out. Call `release()` in a `finally` so a compute that throws still
 *    frees the lock promptly (idempotent).
 */
interface OverviewGate {
  cached: string | null;
  release?: () => void;
}

/**
 * Enter the doctor-overview singleflight gate. Returns a cached string to print,
 * or a lock token telling the caller to compute (and then write + release).
 *
 * Contract:
 *  - Fresh snapshot present (and not `forceRefresh`) → `{ cached }`, no lock.
 *  - Otherwise exactly one caller holds the lock and gets `{ cached: null,
 *    release }`; everyone else blocks on the lock, then (on acquiring it)
 *    double-checks and serves the winner's fresh write — or, if the winner runs
 *    past the wait budget, serves the last snapshot — rather than recomputing.
 *  - Never throws: any IO/lock failure degrades to a compute token or a served
 *    snapshot.
 */
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
    // AWAIT, don't fire-and-forget: returning while the lockfile is still on
    // disk makes the next caller retry against a lock that is logically free —
    // the same pile-up this gate exists to prevent, just narrowed to the window
    // between return and unlink. We are already in an async function, so the
    // wait costs one unlink.
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
