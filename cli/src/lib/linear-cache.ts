/**
 * Disk TTL cache for the Linear answers behind the `agents projects` card.
 *
 * Linear meters two budgets independently, and only one of them binds. Observed
 * on this account's response headers:
 *
 *   x-ratelimit-requests-limit:   2500      remaining: 2
 *   x-ratelimit-complexity-limit: 3000000   remaining: 2999987
 *
 * Requests are scarce; complexity is 99.999% untouched. So the thing to
 * optimize is the NUMBER of calls, not their cost — and the way to spend 2500
 * of them is an agent (or a watch loop) running `projects status` repeatedly.
 * A human typing it is not the exhauster.
 *
 * The CLI is a short-lived process, so an in-memory memo would only help within
 * one invocation, which is the case that never needed help. This caches to disk.
 *
 * **One file per key, written by atomic rename.** A single JSON document holding
 * every entry has to be read, modified, and written back, and that sequence is
 * not atomic across processes — measured on this machine, two concurrent writers
 * of 40 distinct keys each left **8 of 80** surviving. This box routinely runs a
 * dozen agent sessions, so that is the normal case, not a corner. Per-key files
 * remove the shared mutable document entirely: two processes caching different
 * projects never touch the same path, and two caching the SAME project race only
 * to write identical data. `writeFileSync` to a temp path followed by `rename`
 * makes each file appear whole or not at all, so a reader never sees a partial
 * write.
 *
 * The load-bearing behavior is what happens on FAILURE: a stale entry keeps
 * being served, marked stale, instead of the line vanishing. That rule is
 * borrowed from `mergeAuthHealthEntries` — one 8s timeout must not flip a
 * populated chip to empty — and it is the fix for the card silently losing its
 * Linear line mid-session when the request budget ran out.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getCacheDir } from './state.js';

/** Matches `SKILL_INDEX_TTL_MS` (`lib/registry.ts`) — the repo's TTL convention. */
export const LINEAR_CACHE_TTL_MS = 10 * 60_000;

/**
 * Resolve the Linear API key from the `LINEAR_API_KEY` env var, falling back to
 * the macOS keychain generic-password `linear-api-key` (how the rest of the
 * stack stores it). Null if none is resolvable. The shared resolver for every
 * Linear-touching surface (project counts, session discovery).
 */
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

/**
 * Where the snapshot lives. `AGENTS_LINEAR_CACHE_PATH` overrides the directory.
 * `getCacheDir()` resolves `HOME` once at module load, so a test that swaps
 * `process.env.HOME` afterwards would otherwise read and WRITE the developer's
 * real cache.
 */
function cacheDir(): string {
  return process.env.AGENTS_LINEAR_CACHE_PATH ?? path.join(getCacheDir(), CACHE_SUBDIR);
}

/**
 * One file per project id. Linear ids are UUIDs, but this is a filename built
 * from external input, so anything outside the safe set is encoded rather than
 * trusted — a `/` or `..` must never escape the cache directory.
 */
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

/**
 * Write whole-or-not-at-all: a temp file in the same directory (so `rename`
 * stays on one filesystem and is therefore atomic) swapped into place. A reader
 * concurrent with this never observes a half-written document.
 */
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

/**
 * Read a 429's `x-ratelimit-requests-reset` header into an epoch-ms instant.
 * Linear sends epoch milliseconds; anything absent, non-numeric, or already in
 * the past is not usable and the caller backs off a TTL instead. Pure, so the
 * parsing is testable without a live 429.
 */
export function parseRateLimitReset(header: string | null, nowMs: number): number | undefined {
  if (!header) return undefined;
  const n = Number(header);
  if (!Number.isFinite(n) || n <= nowMs) return undefined;
  return n;
}

/**
 * Record a 429 so the next runs don't spend a request learning the same thing.
 * `resetAtMs` comes from {@link parseRateLimitReset}; without it, back off one TTL.
 */
export function noteRateLimited(resetAtMs: number | undefined, nowMs: number): void {
  // The invariant this owns: `until` is always in the future. A reset already
  // elapsed would record a window that is over before it is written, which
  // reads as "not rate limited" and sends the next run straight back into the
  // 429 it just took.
  const until = resetAtMs && resetAtMs > nowMs ? resetAtMs : nowMs + LINEAR_CACHE_TTL_MS;
  writeJson(path.join(cacheDir(), RATE_LIMIT_FILE), { until });
}
