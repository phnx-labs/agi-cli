/** Background sync for tracked git repos. The system repo is local read-only, so fast-forward is
 * safe; the user repo and enabled extras may have local commits, so only `git fetch` plus a status
 * marker `agents doctor` surfaces. spawnDetachedSync never blocks; parent recency gate: RUSH-2324. */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { getFetchCacheDir } from './state.js';
import { backgroundSpawnOptions } from './platform/process.js';

/** Shared 5-minute recency window for per-repo locks (worker) and the parent spawn check
 * (RUSH-2324). The worker skips a repo with a younger lock; the parent skips the spawn after a
 * recent cycle or fresh locks. */
export const SYNC_LOCK_TTL_MS = 5 * 60 * 1000;

/** Where lock files and per-repo status markers live. */
function fetchStateDir(): string {
  return getFetchCacheDir();
}

/** Per-repo lock file path. mtime acts as a recency check. */
export function lockFilePath(alias: string, fetchDir?: string): string {
  return path.join(fetchDir ?? fetchStateDir(), `${alias}.lock`);
}

/** Per-repo status marker path (for user/extras only). */
export function statusFilePath(alias: string, fetchDir?: string): string {
  return path.join(fetchDir ?? fetchStateDir(), `${alias}.status.json`);
}

/** Stamp written at the end of every detached-worker cycle (including no-target and
 * all-locks-skipped), so the parent stats one file instead of forking a child on every ordinary
 * CLI invocation. */
export function lastSyncStampPath(fetchDir?: string): string {
  return path.join(fetchDir ?? fetchStateDir(), '.last-sync');
}

export interface FetchStatusMarker {
  alias: string;
  dir: string;
  ahead: number;
  behind: number;
  branch: string;
  fetchedAt: number;
}

function isMtimeFresh(filePath: string, now: number, ttlMs: number): boolean {
  try {
    return now - fs.statSync(filePath).mtimeMs < ttlMs;
  } catch {
    return false;
  }
}

/** Whether the parent should skip forking the detached worker: true when `.last-sync` is within
 * SYNC_LOCK_TTL_MS, or the fetch dir has `*.lock` files that are all still fresh. False (spawn)
 * when the stamp is missing or stale with no fresh locks. Cheap; never reads git. */
export function shouldSkipDetachedSync(
  fetchDir?: string,
  now: number = Date.now(),
  ttlMs: number = SYNC_LOCK_TTL_MS,
): boolean {
  const dir = fetchDir ?? fetchStateDir();
  if (isMtimeFresh(lastSyncStampPath(dir), now, ttlMs)) return true;

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  const locks = entries.filter((name) => name.endsWith('.lock'));
  if (locks.length === 0) return false;
  return locks.every((name) => isMtimeFresh(path.join(dir, name), now, ttlMs));
}

/** Record that a detached-worker cycle finished (success, empty targets, or all repos
 * lock-skipped). Best-effort; a failed write just means the next invocation re-spawns the worker. */
export function markDetachedSyncComplete(fetchDir?: string): void {
  const dir = fetchDir ?? fetchStateDir();
  const stamp = lastSyncStampPath(dir);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(stamp, String(Date.now()));
  } catch {
    /* best-effort */
  }
}

/** Spawn the detached worker. No-op when AGENTS_NO_AUTOPULL=1 is set. */
export function spawnDetachedSync(fetchDir?: string): void {
  if (process.env.AGENTS_NO_AUTOPULL === '1') return;

  // RUSH-2324: the ~7ms spawn is mostly wasted when a cycle ran in the last five minutes, so check
  // the last-sync stamp and lock mtimes in the parent and skip the fork when everything is fresh.
  if (shouldSkipDetachedSync(fetchDir)) return;

  // Resolve the worker path relative to the compiled location of this module.
  // After `tsc`, both files land in the same directory under dist/lib/.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const workerPath = path.join(here, 'auto-pull-worker.js');
  if (!fs.existsSync(workerPath)) return;

  try {
    // Scrub AGENTS_BRAND so background sync reconciles the full resource set into shared agent
    // homes. Otherwise a branded foreground call (e.g. `jack`) would leak its reduced profile into
    // the detached sync and strip skills/plugins for plain `agents` (last-writer-wins).
    const { AGENTS_BRAND: _brand, ...unbrandedEnv } = process.env;
    const child = spawn(process.execPath, [workerPath], {
      ...backgroundSpawnOptions(),
      stdio: 'ignore',
      env: unbrandedEnv,
    });
    child.unref();
  } catch {
    /* best-effort: never break the foreground command */
  }
}

/** Read all status markers and return those where the local repo is behind upstream. Markers
 * persist until the next background fetch overwrites them. Synchronous and cheap; used by `agents
 * doctor` to surface warnings in one place instead of stderr on every command. */
export function readRepoBehindMarkers(fetchDir?: string): FetchStatusMarker[] {
  const dir = fetchDir ?? fetchStateDir();
  if (!fs.existsSync(dir)) return [];

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const result: FetchStatusMarker[] = [];
  for (const name of entries) {
    if (!name.endsWith('.status.json')) continue;
    const file = path.join(dir, name);
    let marker: FetchStatusMarker | null = null;
    try {
      marker = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      continue;
    }
    if (!marker || marker.behind <= 0) continue;
    result.push(marker);
  }
  return result;
}
