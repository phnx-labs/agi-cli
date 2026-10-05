/** Shared cross-process budget for Linear's 2500 requests/hr per key (PHNX-2310); ~13 agents share
 * one key, so a request reserves a slot first or the caller serves stale cache. Each slot is an
 * empty file (no shared JSON race); budget sits below 2500, key is hashed, scope is per machine. */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { getCacheDir } from './state.js';

/** One hour, the window Linear's request quota is measured over. */
export const LINEAR_RATE_WINDOW_MS = 60 * 60 * 1000;

/** Shared proactive budget per key per rolling hour. Deliberately under Linear's hard 2500/hr to
 * leave room for a human and absorb the concurrent check-then-create overshoot (at most N-1 for N
 * racing agents). */
export const LINEAR_HOURLY_REQUEST_BUDGET = 2400;

/** Test seam mirroring `setUsageBackoffDirForTest`: the cache dir resolves HOME at import, so tests
 * swapping HOME would touch the real cache. Returns the previous value for restore. */
let rateLimitDirOverride: string | null = null;
export function setLinearRateLimitDirForTest(dir: string | null): string | null {
  const prev = rateLimitDirOverride;
  rateLimitDirOverride = dir;
  return prev;
}

function rateLimitRoot(): string {
  return rateLimitDirOverride ?? path.join(getCacheDir(), 'linear-rate-limit');
}

/** Per-key directory. The key is hashed so the raw credential never touches disk; a short hex
 * prefix is enough. */
function keyDir(apiKey: string): string {
  const hash = crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
  return path.join(rateLimitRoot(), hash);
}

/** Parse `<createdMs>.<pid>.<seq>` back to its creation instant, or null if it is not one of ours. */
function createdMsOf(name: string): number | null {
  const first = name.indexOf('.');
  if (first <= 0) return null;
  const head = name.slice(0, first);
  if (!/^\d+$/.test(head)) return null;
  const n = Number(head);
  return Number.isFinite(n) ? n : null;
}

/** Counts this key's requests in the rolling window, sweeping elapsed stamp files as it goes.
 * Otherwise a pure read. */
export function linearRequestsInWindow(apiKey: string, nowMs: number = Date.now()): number {
  const dir = keyDir(apiKey);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0; // no directory yet — nothing spent
  }
  const cutoff = nowMs - LINEAR_RATE_WINDOW_MS;
  let live = 0;
  for (const name of names) {
    const created = createdMsOf(name);
    if (created === null) continue;
    if (created <= cutoff) {
      try {
        fs.rmSync(path.join(dir, name), { force: true });
      } catch {
        /* another process may have swept it already */
      }
    } else {
      live++;
    }
  }
  return live;
}

let reserveSeq = 0;

/** Tries to reserve one request against the shared hourly budget: true and records it when there is
 * room, false when exhausted (caller serves cache). The file NAME is the whole record, so
 * concurrent reservers can't clobber each other. */
export function reserveLinearRequest(apiKey: string, nowMs: number = Date.now()): boolean {
  if (linearRequestsInWindow(apiKey, nowMs) >= LINEAR_HOURLY_REQUEST_BUDGET) return false;
  const dir = keyDir(apiKey);
  try {
    fs.mkdirSync(dir, { recursive: true });
    // `<createdMs>.<pid>.<seq>`: pid separates processes, the in-process counter
    // separates two reservations in the same millisecond, so the name is unique
    // without a lock or a random token. Empty contents — the name is the record.
    fs.writeFileSync(path.join(dir, `${nowMs}.${process.pid}.${reserveSeq++}`), '');
    return true;
  } catch {
    // An unwritable cache dir costs the cross-process budget, not correctness: let the request
    // through rather than block on it; the reactive 429 backoff in linear-cache.ts is the
    // backstop.
    return true;
  }
}
