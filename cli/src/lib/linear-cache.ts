// Linear cache uses atomic filename-encoded per-key files; stale data survives request failure, and recorded rate-limit expiry is always future.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getCacheDir } from './state.js';

export const LINEAR_CACHE_TTL_MS = 10 * 60_000;

export function resolveLinearApiKey(): string | null {
  const fromEnv = process.env.LINEAR_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('security', ['find-generic-password', '-s', 'linear-api-key', '-w'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const key = out.trim();
      if (key) return key;
    } catch {
    }
  }
  return null;
}

const CACHE_SUBDIR = 'linear-projects';
const RATE_LIMIT_FILE = 'rate-limit.json';

interface CacheEntry<T> {
  at: number;
  value: T;
}

function cacheDir(): string {
  return process.env.AGENTS_LINEAR_CACHE_PATH ?? path.join(getCacheDir(), CACHE_SUBDIR);
}

function entryPath(projectId: string): string {
  return path.join(cacheDir(), `${projectId.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`);
}

function readJson<T>(file: string, valid: (raw: unknown) => raw is T): T | undefined {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return valid(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

function writeJson(file: string, value: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
  }
}

function isEntry(raw: unknown): raw is CacheEntry<unknown> {
  return (
    !!raw &&
    typeof raw === 'object' &&
    typeof (raw as CacheEntry<unknown>).at === 'number' &&
    'value' in (raw as object)
  );
}

interface CacheHit<T> {
  value: T;
  ageMs: number;
  stale: boolean;
}

export function readCached<T>(projectId: string, nowMs: number): CacheHit<T> | undefined {
  const entry = readJson(entryPath(projectId), isEntry);
  if (!entry) return undefined;
  const ageMs = nowMs - entry.at;
  return { value: entry.value as T, ageMs, stale: ageMs > LINEAR_CACHE_TTL_MS };
}

export function writeCached<T>(projectId: string, value: T, nowMs: number): void {
  writeJson(entryPath(projectId), { at: nowMs, value } satisfies CacheEntry<T>);
}

export function invalidateCached(projectId: string): void {
  try {
    fs.rmSync(entryPath(projectId), { force: true });
  } catch {
  }
}

function isRateLimitFile(raw: unknown): raw is { until: number } {
  return !!raw && typeof raw === 'object' && typeof (raw as { until: unknown }).until === 'number';
}

export function isRateLimited(nowMs: number): boolean {
  const f = readJson(path.join(cacheDir(), RATE_LIMIT_FILE), isRateLimitFile);
  return !!f && f.until > nowMs;
}

export function parseRateLimitReset(header: string | null, nowMs: number): number | undefined {
  if (!header) return undefined;
  const n = Number(header);
  if (!Number.isFinite(n) || n <= nowMs) return undefined;
  return n;
}

export function noteRateLimited(resetAtMs: number | undefined, nowMs: number): void {
  const until = resetAtMs && resetAtMs > nowMs ? resetAtMs : nowMs + LINEAR_CACHE_TTL_MS;
  writeJson(path.join(cacheDir(), RATE_LIMIT_FILE), { until });
}
