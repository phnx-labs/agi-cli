/** Respect a usage endpoint's `Retry-After`: a 3-minute health fan-out kept re-arming a ~45 min 429
 * penalty (2026-08-03). Deadlines live in FILENAMES (`<agent>.<deadline>`) and reads take the max,
 * so concurrent writers never clobber. Scoped per account when known, else provider (RUSH-3036). */
import * as fs from 'fs';
import * as path from 'path';

import { getCacheDir } from './state.js';
import type { AgentId } from './types.js';

/** Cap a server-supplied delay so a bad header cannot park a provider forever. */
const MAX_BACKOFF_MS = 60 * 60 * 1000;

/** Test seam like `setKeychainBackendForTest`: the cache dir is a module constant, so overriding
 * `HOME` does not redirect it and would park real usage reads for 45 minutes. Returns the previous
 * value. */
let backoffDirOverride: string | null = null;
export function setUsageBackoffDirForTest(dir: string | null): string | null {
  const prev = backoffDirOverride;
  backoffDirOverride = dir;
  return prev;
}

function backoffDir(): string {
  return backoffDirOverride ?? path.join(getCacheDir(), 'usage-backoff');
}

/** Parse a `Retry-After` header (delta-seconds or HTTP date) to ms from `now`, or null when
 * unusable. */
export function parseRetryAfterMs(header: string | null | undefined, now: number = Date.now()): number | null {
  const raw = (header ?? '').trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    const ms = Number(raw) * 1000;
    return ms > 0 ? Math.min(ms, MAX_BACKOFF_MS) : null;
  }

  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  const ms = at - now;
  return ms > 0 ? Math.min(ms, MAX_BACKOFF_MS) : null;
}

/** File-name scope: `<agent>` provider-wide, `<agent>@<slug>` per account (RUSH-3036). `@` cannot
 * collide: provider files are `<agent>.<digits>` and agent ids have no `@`. */
function backoffScope(agent: AgentId, account?: string | null): string {
  if (!account) return agent;
  return `${agent}@${account.replace(/[/\\]/g, '_')}`;
}

/** Every deadline for `scope`; a file matches only if everything after `<scope>.` is digits, since
 * account slugs contain dots (`claude@a` must not swallow `claude@a.b`). */
function deadlinesFor(scope: string): number[] {
  let names: string[];
  try {
    names = fs.readdirSync(backoffDir());
  } catch {
    // No directory yet: nothing is throttled.
    return [];
  }
  const prefix = `${scope}.`;
  const out: number[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const rest = name.slice(prefix.length);
    if (!/^\d+$/.test(rest)) continue;
    const at = Number(rest);
    if (Number.isFinite(at)) out.push(at);
  }
  return out;
}

/** Record a 429 for `agent`; with no parseable `retryAfter` still back off `fallbackMs`, since
 * polling an endpoint that just refused is what caused the loop. */
export function noteUsageRateLimited(
  agent: AgentId,
  retryAfter: string | null | undefined,
  opts?: { now?: number; fallbackMs?: number; account?: string | null },
): void {
  const now = opts?.now ?? Date.now();
  const fallbackMs = opts?.fallbackMs ?? 15 * 60 * 1000;
  const ms = parseRetryAfterMs(retryAfter, now) ?? fallbackMs;
  const deadline = now + Math.min(ms, MAX_BACKOFF_MS);
  try {
    fs.mkdirSync(backoffDir(), { recursive: true });
    // Empty file: the name carries the value, so nothing can be read half-written or merged. With
    // an account the penalty is per-account (RUSH-3036): 429s are per-account quotas and
    // provider-wide parking starved later accounts.
    fs.writeFileSync(path.join(backoffDir(), `${backoffScope(agent, opts?.account)}.${deadline}`), '');
  } catch {
    // Best-effort. An unwritable cache dir costs the cross-process backoff, not
    // the correctness of this read.
  }
}

/** Epoch ms until which `agent`'s usage endpoint is off limits, or null; the furthest future
 * deadline wins. Also sweeps elapsed files. */
export function usageRateLimitedUntil(
  agent: AgentId,
  now: number = Date.now(),
  account?: string | null,
): number | null {
  // A provider-wide penalty parks every account; an account read also honors its own. A bare read
  // ignores account penalties so one account cannot park its siblings (RUSH-3036).
  const scopes = account ? [backoffScope(agent, null), backoffScope(agent, account)] : [backoffScope(agent, null)];
  let latest: number | null = null;
  for (const scope of scopes) {
    for (const at of deadlinesFor(scope)) {
      if (at > now) {
        if (latest === null || at > latest) latest = at;
      } else {
        try {
          fs.rmSync(path.join(backoffDir(), `${scope}.${at}`), { force: true });
        } catch {
          /* another process may have swept it already */
        }
      }
    }
  }
  return latest;
}

/** Human-readable remaining backoff, for the error a skipped read returns. */
export function formatBackoffRemaining(untilMs: number, now: number = Date.now()): string {
  const mins = Math.ceil((untilMs - now) / 60_000);
  if (mins <= 1) return 'under a minute';
  if (mins < 60) return `${mins} minutes`;
  const hours = Math.round(mins / 60);
  return hours === 1 ? 'about an hour' : `about ${hours} hours`;
}
