import * as fs from 'fs';
import * as path from 'path';
import lockfile from 'proper-lockfile';

import { getCacheDir } from '../state.js';
import { ensureLockTarget } from '../fs-atomic.js';

const CACHE_FILE = '.doctor-overview.json';
const LOCK_TARGET_FILE = '.doctor-overview.lock-target';

export const DOCTOR_OVERVIEW_FRESH_MS = 90_000;
const LOCK_STALE_MS = 60_000;
const LOCK_RETRIES = { retries: 240, factor: 1, minTimeout: 500, maxTimeout: 500 } as const;

interface CacheFile {
  version: 1;
  fetchedAt: number;
  payload: unknown;
}

interface DoctorOverviewCacheDeps {
  dir?: string;
  now?: () => number;
}

function cachePath(dir: string): string {
  return path.join(dir, CACHE_FILE);
}

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
  }
  return null;
}

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
  }
}

export function invalidateDoctorOverviewCache(deps: DoctorOverviewCacheDeps = {}): void {
  const dir = deps.dir ?? getCacheDir();
  try {
    fs.unlinkSync(cachePath(dir));
  } catch {
  }
}

interface OverviewGate {
  cached: string | null;
  release?: () => void;
}

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

  const fast = serveFresh();
  if (fast !== null) return { cached: fast };


  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {
    return { cached: null, release: () => {} };
  }

  const lockTarget = path.join(dir, LOCK_TARGET_FILE);
  ensureLockTarget(lockTarget);

  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(lockTarget, {
      stale: LOCK_STALE_MS,
      retries: LOCK_RETRIES,
      onCompromised: () => {},
    });
  } catch {
    const c = readDoctorOverviewCache({ dir });
    if (c) return { cached: JSON.stringify(c.payload, null, 2) };
    return { cached: null, release: () => {} };
  }

  const afterWait = serveFresh();
  if (afterWait !== null) {
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
