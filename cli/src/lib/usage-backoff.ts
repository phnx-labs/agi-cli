/**
 * Respect a usage endpoint's `Retry-After` instead of hammering through it.
 *
 * The failure this exists to stop, measured on `yosemite-s1` (2026-08-03): every
 * Claude account there returned `429 rate_limit_error` with `retry-after: 2678`
 * — about 45 minutes — while the credentials themselves read healthy
 * (`probeClaudeStatus` → `status=429 token=present`). The daemon warms
 * auth-health every 3 minutes (`daemon.ts`, `setInterval(..., 3 * 60_000)`) and
 * `probeLocalFleetAuth` fans out over every installed version home in one
 * `Promise.all`, so five Claude homes meant five concurrent requests to one
 * endpoint every three minutes — ~100/hour from a single machine. Nothing read
 * `Retry-After`, so each tick fired deep inside the penalty window and re-armed
 * the throttle. Measured 75 minutes apart, the box never got out: `retry-after`
 * 2678s at 08:42Z, still 429 at 09:57Z on a freshly-issued 1208s penalty. Its
 * usage cache froze — exactly the permanently-stale state the routing freshness
 * rule (`rotate.ts`, `USAGE_DECISION_MAX_AGE_MS`) was written to defend against.
 *
 * So a 429 is recorded here with its deadline, and every usage read and health
 * probe for that provider short-circuits until the deadline passes — no request,
 * no renewed penalty. State is on disk rather than in memory because the
 * offenders are separate processes: the long-lived daemon, and every one-shot
 * `agents view` / `agents run` invocation.
 *
 * ## The deadline lives in the FILENAME, and that is the whole design
 *
 * The obvious shape — one JSON document holding `{agent: deadline}` — is
 * read-modify-write, and without a lock two processes recording the same
 * provider can both read the old value and let the SHORTER deadline write last,
 * silently undoing the longer penalty. That is not a theoretical race here: the
 * triggering condition is a batch of concurrent same-provider 429s, which is
 * precisely what the daemon issues, and it can recur on every batch. Reading
 * back and retrying does not fix it either — that only detects a clobber which
 * already landed, and a stale writer can still write after the check.
 *
 * So no shared document. Each penalty is its own file named `<agent>.<deadline>`
 * with empty contents, and a read takes the MAXIMUM deadline across that
 * provider's files. Two concurrent writers create two different files and
 * neither can erase the other, so a shorter deadline cannot displace a longer
 * one — monotonicity is structural rather than argued, and there is no lock to
 * go stale on a path every usage read touches. Elapsed files are swept on read.
 *
 * Scoped per ACCOUNT when the caller knows one, per provider otherwise
 * (RUSH-3036). The first cut was deliberately provider-wide — the 2026-08-03
 * incident 429'd every account on the box at once, so per-provider looked
 * sufficient. It was not: the quotas proved per-account, and a provider-wide
 * park let the first throttled account in a refresh pass starve every account
 * after it in the loop's fixed iteration order — the same four accounts read
 * 'usage unavailable' across passes while their siblings refreshed. An
 * account-scoped penalty parks only that account; a penalty recorded with no
 * account identity stays provider-wide and still parks everything.
 */
import * as fs from 'fs';
import * as path from 'path';

import { getCacheDir } from './state.js';
import type { AgentId } from './types.js';

const MAX_BACKOFF_MS = 60 * 60 * 1000;

let backoffDirOverride: string | null = null;
export function setUsageBackoffDirForTest(dir: string | null): string | null {
  const prev = backoffDirOverride;
  backoffDirOverride = dir;
  return prev;
}

function backoffDir(): string {
  return backoffDirOverride ?? path.join(getCacheDir(), 'usage-backoff');
}

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

/**
 * File-name scope for a penalty. Provider-wide penalties are `<agent>`;
 * account-scoped ones are `<agent>@<slug>` (RUSH-3036), where the slug is the
 * account's usage key with path separators neutralized (usage keys carry `:`,
 * `=`, `.` and `@` freely — all filename-safe on the platforms we run on).
 * `@` cannot collide with the provider scope because provider files are always
 * `<agent>.<digits>` and agent ids never contain `@`.
 */
function backoffScope(agent: AgentId, account?: string | null): string {
  if (!account) return agent;
  return `${agent}@${account.replace(/[/\\]/g, '_')}`;
}

/**
 * Every recorded deadline for `scope`. A file belongs to the scope only when
 * everything after `<scope>.` is pure digits — account slugs contain dots
 * (emails inside usage keys), so a bare prefix match would let scope
 * `claude@a` swallow `claude@a.b`'s files.
 */
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
    fs.writeFileSync(path.join(backoffDir(), `${backoffScope(agent, opts?.account)}.${deadline}`), '');
  } catch {
  }
}

export function usageRateLimitedUntil(
  agent: AgentId,
  now: number = Date.now(),
  account?: string | null,
): number | null {
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
        }
      }
    }
  }
  return latest;
}

export function formatBackoffRemaining(untilMs: number, now: number = Date.now()): string {
  const mins = Math.ceil((untilMs - now) / 60_000);
  if (mins <= 1) return 'under a minute';
  if (mins < 60) return `${mins} minutes`;
  const hours = Math.round(mins / 60);
  return hours === 1 ? 'about an hour' : `about ${hours} hours`;
}
