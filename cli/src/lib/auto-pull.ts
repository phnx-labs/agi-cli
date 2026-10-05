
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { getFetchCacheDir } from './state.js';
import { backgroundSpawnOptions } from './platform/process.js';

export const SYNC_LOCK_TTL_MS = 5 * 60 * 1000;

function fetchStateDir(): string {
  return getFetchCacheDir();
}

export function lockFilePath(alias: string, fetchDir?: string): string {
  return path.join(fetchDir ?? fetchStateDir(), `${alias}.lock`);
}

export function statusFilePath(alias: string, fetchDir?: string): string {
  return path.join(fetchDir ?? fetchStateDir(), `${alias}.status.json`);
}

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

export function markDetachedSyncComplete(fetchDir?: string): void {
  const dir = fetchDir ?? fetchStateDir();
  const stamp = lastSyncStampPath(dir);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(stamp, String(Date.now()));
  } catch {
  }
}

export function spawnDetachedSync(fetchDir?: string): void {
  if (process.env.AGENTS_NO_AUTOPULL === '1') return;

  if (shouldSkipDetachedSync(fetchDir)) return;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const workerPath = path.join(here, 'auto-pull-worker.js');
  if (!fs.existsSync(workerPath)) return;

  try {
    const { AGENTS_BRAND: _brand, ...unbrandedEnv } = process.env;
    const child = spawn(process.execPath, [workerPath], {
      ...backgroundSpawnOptions(),
      stdio: 'ignore',
      env: unbrandedEnv,
    });
    child.unref();
  } catch {
  }
}

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
