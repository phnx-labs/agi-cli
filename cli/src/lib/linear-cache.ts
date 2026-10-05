/** Disk TTL cache for Linear answers behind `agents projects`; requests (2500/hr) are the binding
 * budget. One file per key, atomic rename (a shared JSON lost 8 of 80 entries under concurrent
 * writers). On failure a stale entry is served, marked stale, rather than the line vanishing. */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getCacheDir } from './state.js';

/** Matches `SKILL_INDEX_TTL_MS` (`lib/registry.ts`) — the repo's TTL convention. */
export const LINEAR_CACHE_TTL_MS = 10 * 60_000;

/** Resolves the Linear API key from `LINEAR_API_KEY`, then the macOS keychain item
 * `linear-api-key`; null if neither. Shared by every Linear-touching surface. */
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
      // not in keychain — fall through
    }
  }
  return null;
}

const CACHE_SUBDIR = 'linear-projects';
/** Sits beside the per-project files; its own file, so it cannot be clobbered by them. */
const RATE_LIMIT_FILE = 'rate-limit.json';

/** One cached answer. */
interface CacheEntry<T> {
  /** Epoch ms the value was fetched. */
  at: number;
  value: T;
}

/** Cache directory; `AGENTS_LINEAR_CACHE_PATH` overrides it because getCacheDir() resolves HOME
 * once at load, so tests swapping HOME would otherwise read and write the real cache. */
function cacheDir(): string {
  return process.env.AGENTS_LINEAR_CACHE_PATH ?? path.join(getCacheDir(), CACHE_SUBDIR);
}

/** One file per project id. The id becomes a filename from external input, so unsafe characters are
 * encoded: a `/` or `..` must never escape the cache directory. */
function entryPath(projectId: string): string {
  return path.join(cacheDir(), `${projectId.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`);
}

/** Parse a cache file, treating absent/corrupt/wrong-shaped as simply absent. */
function readJson<T>(file: string, valid: (raw: unknown) => raw is T): T | undefined {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return valid(raw) ? raw : undefined;
  } catch {
    return undefined; // absent or corrupt — an empty cache is always a valid answer
  }
}

/** Writes whole-or-not-at-all: temp file in the same directory, then atomic `rename`, so readers
 * never see a half-written document. */
function writeJson(file: string, value: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    /* best-effort: an unwritable cache degrades to no cache, never to an error */
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

/** What a lookup found, and how much to trust it. */
interface CacheHit<T> {
  value: T;
  /** Age in ms. Past the TTL the value is still returned, flagged stale. */
  ageMs: number;
  stale: boolean;
}

/** Look up a project's cached answer. Returns stale entries too — the caller decides. */
export function readCached<T>(projectId: string, nowMs: number): CacheHit<T> | undefined {
  const entry = readJson(entryPath(projectId), isEntry);
  if (!entry) return undefined;
  const ageMs = nowMs - entry.at;
  return { value: entry.value as T, ageMs, stale: ageMs > LINEAR_CACHE_TTL_MS };
}

/** Store a freshly fetched answer. */
export function writeCached<T>(projectId: string, value: T, nowMs: number): void {
  writeJson(entryPath(projectId), { at: nowMs, value } satisfies CacheEntry<T>);
}

/** Drop one project's entry — used when `projects link` re-points a definition. */
export function invalidateCached(projectId: string): void {
  try {
    fs.rmSync(entryPath(projectId), { force: true });
  } catch {
    /* already gone is the desired state */
  }
}

function isRateLimitFile(raw: unknown): raw is { until: number } {
  return !!raw && typeof raw === 'object' && typeof (raw as { until: unknown }).until === 'number';
}

/** True when a prior 429 said the budget is exhausted and has not yet reset. */
export function isRateLimited(nowMs: number): boolean {
  const f = readJson(path.join(cacheDir(), RATE_LIMIT_FILE), isRateLimitFile);
  return !!f && f.until > nowMs;
}

/** Parses a 429's `x-ratelimit-requests-reset` (epoch ms) into an instant; absent, non-numeric, or
 * past values return undefined and the caller backs off one TTL. */
export function parseRateLimitReset(header: string | null, nowMs: number): number | undefined {
  if (!header) return undefined;
  const n = Number(header);
  if (!Number.isFinite(n) || n <= nowMs) return undefined;
  return n;
}

/** Records a 429 so later runs don't spend a request relearning it; `resetAtMs` comes from
 * parseRateLimitReset, else back off one TTL. */
export function noteRateLimited(resetAtMs: number | undefined, nowMs: number): void {
  // Invariant: `until` is always in the future. An elapsed reset would read as not rate limited
  // and send the next run straight into the same 429.
  const until = resetAtMs && resetAtMs > nowMs ? resetAtMs : nowMs + LINEAR_CACHE_TTL_MS;
  writeJson(path.join(cacheDir(), RATE_LIMIT_FILE), { until });
}
