/**
 * Daemon-owned usage refresher — one poller per account, on a headed box.
 *
 * The routing hot path (`agents run` → collectRunCandidates) reads usage
 * CACHE-ONLY (`getUsageInfoForIdentity`, RUSH-2061) and never blocks
 * on a provider fetch. A headed box (`isHeadedDeviceRole`) polls only the
 * accounts it holds native logins for; a setup-token-only box never polls.
 * A stray `.credentials.json` for an account another headed box already
 * publishes defers to that poller. Auth-health draws from the same
 * per-account call budget so the two stay under the ~100/hr ceiling.
 *
 * Design:
 *
 *  - **Per-host writer.** Each host lists its own credential-backed accounts
 *    and calls providers directly; there is no cross-host broadcast.
 *  - **Fixed 5-minute cadence** (`REFRESH_INTERVAL_MS`). Enough to keep
 *    balanced/`agents view` off multi-hour stale data without thrashing
 *    provider APIs when the user runs agents frequently. The delay helpers
 *    still accept a burn projection for tests/future tuning, but the default
 *    floor and ceiling are both 5 minutes.
 *  - **Hard hourly cap** (`HOURLY_CALL_CAP`) so a stuck "due" loop cannot
 *    hammer an endpoint past ~12 calls/account/hour.
 *  - **429 backoff.** An account (or provider-wide scope) under
 *    `usageRateLimitedUntil` is skipped — no live fetch or re-armed penalty.
 *  - **File-only credentials on the daemon path.** Refresh never opens the
 *    ACL-bound macOS keychain item (Touch ID storm). It uses the no-ACL
 *    access-token cache / setup-token / `.credentials.json` only
 *    (`fileOnly: true` on `getUsageInfo`).
 *  - **Concurrency-safe cache writes.** Usage + headroom files are updated
 *    under `withFileLock` + atomic rename so a concurrent `agents view`
 *    background refresh cannot tear or drop another account's row.
 *
 * Scenarios (what this path must survive):
 *
 *  1. **Daemon tick overlaps a slow tick** — overlap guard in daemon.ts;
 *     second tick is a no-op.
 *  2. **`agents view` writes cache while daemon refreshes** — file lock
 *     serializes read-modify-write; no lost updates.
 *  3. **macOS keychain ACL / Touch ID** — fileOnly refresh never calls
 *     `security find-generic-password` on Claude's ACL item.
 *  4. **Account 429** — that account is skipped until Retry-After while its
 *     siblings continue; a provider-wide penalty still skips all accounts.
 *  5. **Expired access token (no refresh)** — usage path never rotates
 *     single-use refresh tokens; counts as `failed`, reschedules 5m later.
 *  6. **No file credential on this host** — account skipped / failed; no
 *     keychain fallback from the daemon refresher.
 *  7. **Grok/Codex (network:false)** — not listed by `buildLocalUsageAccounts`;
 *     their "cache" is local logs, not this HTTP refresher.
 */
import * as fs from 'fs';
import * as path from 'path';

import { getCacheDir, getUserAgentsDir } from './state.js';
import { atomicWriteFileSync, ensureLockTarget, withFileLock } from './fs-atomic.js';
import {
  deriveUsageHeadroom,
  buildCanonicalUsageContext,
  agentUsesNetworkUsage,
  USAGE_SOURCE_AGENT_IDS,
  claudeHomeHasNativeOauthFile,
  type UsageHeadroom,
  type UsageSnapshot,
  type UsageInfo,
  type UsageIdentityInput,
} from './accounting/usage.js';
import { getAccountInfo, credentialPresence } from './agents.js';
import { listInstalledVersions, getVersionHomePath } from './installations/versions.js';
import type { AgentId } from './types.js';
import { isHeadedDeviceRole, selfConfiguredDeviceRole, type ConfiguredDeviceRole } from './device-config.js';
import { machineId, normalizeHost } from './session/sync/config.js';
import { readFleetSharedDeviceStates } from './fleet-shared-state.js';

/**
 * Default schedule between successful (or attempted) live usage fetches for one
 * account. Floor and ceiling of the delay helper are pinned to this so the
 * daemon does not poll faster than 5 minutes even under high burn, and does not
 * let an idle account rot longer than 5 minutes between attempts.
 */
export const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
/** @deprecated alias — use {@link REFRESH_INTERVAL_MS}. Kept for test imports. */
export const REFRESH_MIN_MS = REFRESH_INTERVAL_MS;
/** @deprecated alias — use {@link REFRESH_INTERVAL_MS}. Kept for test imports. */
export const REFRESH_MAX_MS = REFRESH_INTERVAL_MS;
/** Burn-rate divisor retained for the pure delay helper / tests; with min=max
 * the divisor does not change the scheduled interval. */
export const REFRESH_BURN_DIVISOR = 4;
/** At most this many live fetches per account per rolling hour (5m cadence ⇒ 12). */
export const HOURLY_CALL_CAP = 12;
/** How often the daemon wakes to *consider* a refresh pass (due accounts only). */
export const USAGE_REFRESH_TICK_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/**
 * Minimum wall-clock spacing between two live usage fetches to ONE network
 * provider, across all of its accounts. This is the pacing primitive: refreshes
 * are issued round-robin (stalest account first) no faster than one per spacing,
 * so aggregate endpoint load is a smooth, fixed rate — never the synchronized
 * burst-then-stall a plain rolling-hour cap produces when every account falls
 * due on the same tick. Set to two daemon ticks so the floor-based pacing lands
 * on exact tick boundaries (no drift): one refresh every other tick ⇒ 30/hr.
 */
export const PROVIDER_MIN_REFRESH_SPACING_MS = 2 * USAGE_REFRESH_TICK_MS;
/**
 * Aggregate live fetches this daemon may spend on ONE network provider's usage
 * endpoint per rolling hour, across ALL of that provider's local accounts —
 * derived from {@link PROVIDER_MIN_REFRESH_SPACING_MS} so the two are always
 * consistent (HOUR / 120s = 30).
 *
 * The per-account {@link HOURLY_CALL_CAP} alone scales linearly with account
 * count — 8 Claude accounts × 12/hr = ~96 usage calls/hr from one box — and
 * Anthropic's `/api/oauth/usage` rate-limits around ~100/hr (see the
 * `usage-backoff.ts` header). That tripped the endpoint into per-account 429s
 * with Retry-After penalties up to an hour: measured live on `zion`, 7 of 8
 * Claude accounts sat parked, never refreshed inside their 5h window, so
 * `agents view` showed `S: unavailable` and balanced routing read stale/absent
 * usage. It got WORSE with every account added.
 *
 * 30/hr is a fixed rate that does NOT grow with account count, and leaves ample
 * headroom under the ~100/hr ceiling for the auth probe (same endpoint, ~3/hr
 * per account, RUSH-2998) and foreground `agents view` bursts. Because refreshes
 * are paced round-robin (stalest first), each account's worst-case proactive
 * cadence is bounded at N × spacing (8 accounts ⇒ 16 min; 16 ⇒ 32 min) — kept
 * deliberately under the {@link USAGE_STALE_REFUSAL_MAX_AGE_MS} routing window so
 * a budget-paced account never reads as "genuinely stale". A slightly
 * older-but-present reading beats a 45-minute 429 park. Network providers only;
 * grok/codex read local logs and have no rate-limited endpoint.
 */
export const PROVIDER_HOURLY_BUDGET = HOUR_MS / PROVIDER_MIN_REFRESH_SPACING_MS;
/**
 * Most refreshes a single tick may catch up after the daemon has been idle/down
 * (elapsed ≫ spacing). Without this clamp a long gap would grant many tokens at
 * once and re-synchronize every account into the very burst the spacing exists
 * to prevent. A small catch-up keeps the load smooth even after a restart.
 */
export const PROVIDER_CATCHUP_MAX = 2;
/**
 * A usage row this recently captured (by the free statusline ingest of a live
 * `agents run`, or any writer) is already fresh — do not spend an API call to
 * re-refresh it. Actively-used accounts stay current at zero endpoint cost, so
 * the proactive budget is reserved for genuinely idle accounts.
 */
export const STATUSLINE_FRESH_MS = REFRESH_INTERVAL_MS;
/** Consecutive failed live reads before one broken account is quarantined. */
export const FAILURE_QUARANTINE_THRESHOLD = 3;
/** A chronic offender waits this long while healthy siblings keep their cadence. */
export const FAILURE_QUARANTINE_MS = 30 * 60 * 1000;
const SKIP_JITTER_MIN_MS = 2_000;
const SKIP_JITTER_RANGE_MS = 3_001;

/**
 * One account's refresh state + published headroom. `sessionUsedPercent` /
 * `capturedAt` are the prior sample the NEXT tick projects the burn rate from;
 * `minutesToLimit` / `status` are what the routing hot path reads.
 */
export interface HeadroomEntry {
  status: UsageHeadroom['status'];
  minutesToLimit: number | null;
  /** The session window's usedPercent in the last snapshot (the prev sample). */
  sessionUsedPercent: number | null;
  /** Epoch ms the last snapshot was captured. */
  capturedAt: number | null;
  /** Epoch ms this account is next due for a live refresh. */
  nextRefreshAt: number;
  /** Epoch ms of recent live fetches, for the rolling-hour cap. */
  callTimestamps: number[];
  /** Epoch ms this entry was written. */
  computedAt: number;
  /** Consecutive live-fetch misses; absent on entries written before this field. */
  consecutiveFailures?: number;
}

interface HeadroomCacheFile {
  version: 1;
  entries: Record<string, HeadroomEntry>;
}

/** Test seam for the headroom cache path (see usage.ts `setClaudeUsageCachePathForTest`). */
let headroomCachePathOverride: string | null = null;
export function setHeadroomCachePathForTest(cachePath: string | null): string | null {
  const prev = headroomCachePathOverride;
  headroomCachePathOverride = cachePath;
  return prev;
}
function headroomCachePath(): string {
  return headroomCachePathOverride ?? path.join(getCacheDir(), '.usage-headroom.json');
}

/** Read the whole headroom cache (best-effort; missing/corrupt → empty map). */
export function readHeadroomCache(): Record<string, HeadroomEntry> {
  try {
    const parsed = JSON.parse(fs.readFileSync(headroomCachePath(), 'utf-8')) as HeadroomCacheFile;
    if (parsed && parsed.entries && typeof parsed.entries === 'object') return parsed.entries;
  } catch {
    // missing or corrupt — treat as empty
  }
  return {};
}

/** Read one account's headroom entry, or null. */
export function readHeadroomEntry(usageKey: string): HeadroomEntry | null {
  return readHeadroomCache()[usageKey] ?? null;
}

/** Merge entries into the cache (best-effort; preserves other accounts' rows). */
export function writeHeadroomEntries(entries: Record<string, HeadroomEntry>): void {
  try {
    const cachePath = headroomCachePath();
    ensureLockTarget(cachePath, JSON.stringify({ version: 1, entries: {} }, null, 2));
    withFileLock(cachePath, () => {
      // Re-read under the lock so a concurrent tick/view cannot drop rows.
      const merged: HeadroomCacheFile = {
        version: 1,
        entries: { ...readHeadroomCache(), ...entries },
      };
      atomicWriteFileSync(cachePath, JSON.stringify(merged, null, 2));
    });
  } catch {
    // best-effort; a failed write just means the router sees no projection
  }
}

/**
 * Interval until the next refresh attempt, clamped to [minMs, maxMs].
 * Defaults pin both ends to {@link REFRESH_INTERVAL_MS} (5 minutes) so the
 * live daemon path is a fixed schedule. Tests may pass a wider range to
 * exercise burn-aware scheduling without changing production cadence.
 */
export function computeNextRefreshDelayMs(
  minutesToLimit: number | null,
  opts: { minMs?: number; maxMs?: number; divisor?: number } = {},
): number {
  const minMs = opts.minMs ?? REFRESH_INTERVAL_MS;
  const maxMs = opts.maxMs ?? REFRESH_INTERVAL_MS;
  const divisor = opts.divisor ?? REFRESH_BURN_DIVISOR;
  if (minutesToLimit === null || !Number.isFinite(minutesToLimit)) return maxMs;
  const targetMs = (minutesToLimit / divisor) * 60_000;
  return Math.max(minMs, Math.min(maxMs, targetMs));
}

/** Recent call timestamps trimmed to the trailing hour. */
export function pruneCallTimestamps(timestamps: number[], now: number, windowMs = HOUR_MS): number[] {
  const floor = now - windowMs;
  return timestamps.filter((ts) => ts > floor);
}

/**
 * Whether an account may be live-refreshed right now: it is due (past its
 * scheduled `nextRefreshAt`) AND under the rolling-hour call cap. Pure so the
 * cadence + cap arithmetic is unit-tested without a daemon or a network call.
 */
export function shouldRefreshAccount(
  entry: HeadroomEntry | null | undefined,
  now: number,
  opts: { hourlyCap?: number; windowMs?: number } = {},
): boolean {
  const cap = opts.hourlyCap ?? HOURLY_CALL_CAP;
  const windowMs = opts.windowMs ?? HOUR_MS;
  const due = !entry || now >= entry.nextRefreshAt;
  if (!due) return false;
  const recent = pruneCallTimestamps(entry?.callTimestamps ?? [], now, windowMs);
  return recent.length < cap;
}

/**
 * Build the next headroom entry after a live refresh: project headroom from the
 * new snapshot against the prior sample, schedule the next refresh from the
 * projection, and record this call for the hourly cap.
 */
export function nextHeadroomEntry(
  prev: HeadroomEntry | null | undefined,
  snapshot: UsageSnapshot | null,
  now: number,
): HeadroomEntry {
  const headroom = deriveUsageHeadroom(
    snapshot,
    prev && prev.capturedAt !== null && prev.sessionUsedPercent !== null
      ? { capturedAt: prev.capturedAt, usedPercent: prev.sessionUsedPercent }
      : null,
  );
  const session = snapshot?.windows.find((window) => window.key === 'session') ?? null;
  const callTimestamps = pruneCallTimestamps([...(prev?.callTimestamps ?? []), now], now);
  return {
    status: headroom.status,
    minutesToLimit: headroom.minutesToLimit,
    sessionUsedPercent: session?.usedPercent ?? null,
    capturedAt: snapshot?.capturedAt?.getTime() ?? null,
    nextRefreshAt: now + computeNextRefreshDelayMs(headroom.minutesToLimit),
    callTimestamps,
    computedAt: now,
    consecutiveFailures: snapshot ? 0 : (prev?.consecutiveFailures ?? 0) + 1,
  };
}

/** Stable per-account delay in [2s, 5s], used to spread skipped accounts. */
function skipJitterMs(usageKey: string): number {
  let hash = 0;
  for (const char of usageKey) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return SKIP_JITTER_MIN_MS + (hash % SKIP_JITTER_RANGE_MS);
}

function skippedHeadroomEntry(
  prev: HeadroomEntry | null,
  usageKey: string,
  now: number,
  index: number,
): HeadroomEntry {
  return {
    status: prev?.status ?? null,
    minutesToLimit: prev?.minutesToLimit ?? null,
    sessionUsedPercent: prev?.sessionUsedPercent ?? null,
    capturedAt: prev?.capturedAt ?? null,
    nextRefreshAt: now + (index + 1) * skipJitterMs(usageKey),
    callTimestamps: pruneCallTimestamps(prev?.callTimestamps ?? [], now),
    computedAt: now,
    consecutiveFailures: prev?.consecutiveFailures ?? 0,
  };
}

/**
 * Reschedule an account we skipped because a free statusline ingest already
 * captured it inside {@link STATUSLINE_FRESH_MS}. The statusline row IS a real,
 * live sample, so RE-DERIVE headroom (status / minutesToLimit) from it against
 * the prior sample — otherwise `status`/`minutesToLimit` would freeze at their
 * last API-refresh value forever for exactly the actively-used accounts that
 * stay statusline-fresh, and `capacityWeight` reads `minutesToLimit`. No call
 * timestamp is recorded (this cost zero API budget); the next proactive attempt
 * is pushed to one interval past the free capture.
 */
function freshHeadroomEntry(
  prev: HeadroomEntry | null,
  snapshot: UsageSnapshot,
  now: number,
  capturedAtMs: number,
): HeadroomEntry {
  const headroom = deriveUsageHeadroom(
    snapshot,
    prev && prev.capturedAt !== null && prev.sessionUsedPercent !== null
      ? { capturedAt: prev.capturedAt, usedPercent: prev.sessionUsedPercent }
      : null,
  );
  const session = snapshot.windows.find((window) => window.key === 'session') ?? null;
  return {
    status: headroom.status,
    minutesToLimit: headroom.minutesToLimit,
    sessionUsedPercent: session?.usedPercent ?? prev?.sessionUsedPercent ?? null,
    capturedAt: snapshot.capturedAt?.getTime() ?? prev?.capturedAt ?? null,
    nextRefreshAt: capturedAtMs + REFRESH_INTERVAL_MS,
    // Not an API call — do NOT record a timestamp (would wrongly spend budget).
    callTimestamps: pruneCallTimestamps(prev?.callTimestamps ?? [], now),
    computedAt: now,
    consecutiveFailures: 0,
  };
}

/**
 * Most-recent live-fetch time per network provider (the max call timestamp
 * across its accounts, 0 when none), which the smooth per-provider pacing spaces
 * the next refresh from. Non-network providers are omitted — they have no
 * rate-limited endpoint to pace.
 */
export function providerLastCall(
  accounts: LocalUsageAccount[],
  cache: Record<string, HeadroomEntry>,
): Map<AgentId, number> {
  const last = new Map<AgentId, number>();
  for (const account of accounts) {
    if (!agentUsesNetworkUsage(account.agentId)) continue;
    if (!last.has(account.agentId)) last.set(account.agentId, 0);
    for (const ts of cache[account.usageKey]?.callTimestamps ?? []) {
      if (ts > (last.get(account.agentId) ?? 0)) last.set(account.agentId, ts);
    }
  }
  return last;
}

/**
 * How many live fetches the smooth pacing permits a provider THIS tick: one per
 * elapsed {@link PROVIDER_MIN_REFRESH_SPACING_MS} since its last fetch, clamped
 * to {@link PROVIDER_CATCHUP_MAX} so a long idle gap (or a cold provider with no
 * prior fetch) cannot re-burst the whole due set at once. At the daemon's 60 s
 * tick this yields at most one fetch every other tick in steady state (⇒ the
 * hourly budget), while a small fleet whose total demand fits under budget is
 * never throttled — the {@link PROVIDER_HOURLY_BUDGET} rolling cap is the only
 * gate that binds it.
 */
export function providerSpacingTokens(lastCallMs: number, now: number): number {
  // A cold provider (never fetched) is treated as maximally idle: grant the
  // catch-up ceiling so a couple of accounts warm immediately without bursting.
  const elapsed = lastCallMs <= 0 ? Infinity : now - lastCallMs;
  if (elapsed < PROVIDER_MIN_REFRESH_SPACING_MS) return 0;
  return Math.min(PROVIDER_CATCHUP_MAX, Math.floor(elapsed / PROVIDER_MIN_REFRESH_SPACING_MS));
}

function failedHeadroomEntry(prev: HeadroomEntry | null, now: number): HeadroomEntry {
  const next = nextHeadroomEntry(prev, null, now);
  if ((next.consecutiveFailures ?? 0) >= FAILURE_QUARANTINE_THRESHOLD) {
    next.nextRefreshAt = now + FAILURE_QUARANTINE_MS;
  }
  return next;
}

/** One account considered for the headed poller. */
export interface UsagePollCandidate {
  usageKey: string;
  agentId: AgentId;
  home: string;
  holdsNativeLogin: boolean;
}

/**
 * Whether this box is the poller for `candidate`. A worker / unmarked box
 * never polls. A headed box polls only native logins it holds, and defers
 * when another headed device already claims the account in the shared store.
 */
/** Daemon auth-health may hit `/oauth/usage` only on a headed box, unless forceLive. */
export function mayIssueUsageEndpointProbe(opts: {
  role: ConfiguredDeviceRole | undefined;
  forceLive?: boolean;
}): boolean {
  if (opts.forceLive === true) return true;
  return isHeadedDeviceRole(opts.role);
}

export function shouldPollUsageAccount(
  candidate: Pick<UsagePollCandidate, 'usageKey' | 'holdsNativeLogin'>,
  opts: {
    role: ConfiguredDeviceRole | undefined;
    selfDevice: string;
    claimedBy?: Record<string, string>;
  },
): boolean {
  if (!isHeadedDeviceRole(opts.role)) return false;
  if (!candidate.holdsNativeLogin) return false;
  const owner = opts.claimedBy?.[candidate.usageKey];
  if (owner && normalizeHost(owner) !== normalizeHost(opts.selfDevice)) return false;
  return true;
}

/** Native rotating login on this home — Claude's `.credentials.json` blob, else a credential file. */
export function homeHoldsNativeLogin(agentId: AgentId, home: string): boolean {
  if (agentId === 'claude') return claudeHomeHasNativeOauthFile(home);
  return credentialPresence(agentId, home).perVersion;
}

/** usageKey → poller device from headed peers' published snapshots. */
export function pollerClaimsFromSharedStore(
  selfDevice: string,
  userAgentsDir = getUserAgentsDir(),
): Record<string, string> {
  const claims: Record<string, string> = {};
  const read = readFleetSharedDeviceStates(userAgentsDir);
  for (const state of read.states) {
    if (normalizeHost(state.device) === normalizeHost(selfDevice) || !state.usage) continue;
    for (const [key, row] of Object.entries(state.usage.rows)) {
      const poller = row.pollerDevice ?? state.device;
      if (!poller || claims[key]) continue;
      claims[key] = poller;
    }
  }
  return claims;
}

/**
 * Spend one live usage-endpoint call from the shared per-account / per-provider
 * budget. Auth-health and the usage poller both go through here so they cannot
 * together exceed {@link PROVIDER_HOURLY_BUDGET} (~30/hr, well under ~100/hr).
 * Returns false when the call must not fire.
 */
export function trySpendUsageApiCall(usageKey: string, agentId: AgentId, now: number): boolean {
  if (!agentUsesNetworkUsage(agentId)) return true;
  const cache = readHeadroomCache();
  const entry = cache[usageKey];
  const recent = pruneCallTimestamps(entry?.callTimestamps ?? [], now);
  if (recent.length >= HOURLY_CALL_CAP) return false;
  let providerSpent = recent.length;
  for (const [key, other] of Object.entries(cache)) {
    if (key === usageKey) continue;
    if (!key.startsWith(`${agentId}:`)) continue;
    providerSpent += pruneCallTimestamps(other.callTimestamps ?? [], now).length;
  }
  if (providerSpent >= PROVIDER_HOURLY_BUDGET) return false;
  writeHeadroomEntries({
    [usageKey]: {
      status: entry?.status ?? null,
      minutesToLimit: entry?.minutesToLimit ?? null,
      sessionUsedPercent: entry?.sessionUsedPercent ?? null,
      capturedAt: entry?.capturedAt ?? null,
      nextRefreshAt: entry?.nextRefreshAt ?? now,
      callTimestamps: [...recent, now],
      computedAt: now,
      consecutiveFailures: entry?.consecutiveFailures ?? 0,
    },
  });
  return true;
}

/** An account whose credentials live on the publisher host. */
export interface LocalUsageAccount {
  usageKey: string;
  agentId: AgentId;
  /**
   * Live-fetch this account's usage; the daemon passes the real network fetch.
   * `signal` (the daemon tick's deadline AbortSignal) bounds the provider fetch
   * so a hung refresh is aborted at deadlineMs, not just its own 5s timeout.
   */
  fetch: (signal?: AbortSignal) => Promise<UsageInfo>;
}

/**
 * Order a pass STALEST-FIRST so a scarce per-provider budget
 * ({@link PROVIDER_HOURLY_BUDGET}) is always spent on the accounts most in need
 * of a fresh reading, and no account is starved indefinitely.
 *
 *  - **Cold accounts** (never refreshed → no cache entry) are maximally stale
 *    and lead the pass. They rotate by `tick` so, when the budget can't cover
 *    them all in one tick, a different cold account leads each tick.
 *  - **Cached accounts** follow, oldest `capturedAt` first (a null capture time
 *    counts as maximally stale). As accounts refresh their `capturedAt` advances,
 *    so the next pass naturally rotates to whoever is now most out of date.
 */
export function orderUsageAccounts(
  accounts: LocalUsageAccount[],
  cache: Record<string, HeadroomEntry>,
  tick: number,
): LocalUsageAccount[] {
  const rotate = (group: LocalUsageAccount[]): LocalUsageAccount[] => {
    if (group.length < 2) return group;
    const start = tick % group.length;
    return [...group.slice(start), ...group.slice(0, start)];
  };
  const cold = accounts.filter((account) => cache[account.usageKey] == null);
  const cached = accounts.filter((account) => cache[account.usageKey] != null);
  const staleness = (account: LocalUsageAccount): number => cache[account.usageKey]?.capturedAt ?? 0;
  const byStalest = [...cached].sort((a, b) => staleness(a) - staleness(b));
  return [...rotate(cold), ...byStalest];
}

/**
 * Aggregate live calls a network provider has already spent in the trailing hour,
 * summed across the accounts in this pass. Seeds the per-provider budget counter
 * so {@link PROVIDER_HOURLY_BUDGET} bounds the rolling-hour total, not just this
 * one tick. Non-network providers (grok/codex, local logs) are excluded — they
 * have no rate-limited endpoint to budget.
 */
export function providerRecentCalls(
  accounts: LocalUsageAccount[],
  cache: Record<string, HeadroomEntry>,
  now: number,
): Map<AgentId, number> {
  const counts = new Map<AgentId, number>();
  for (const account of accounts) {
    if (!agentUsesNetworkUsage(account.agentId)) continue;
    const recent = pruneCallTimestamps(cache[account.usageKey]?.callTimestamps ?? [], now);
    counts.set(account.agentId, (counts.get(account.agentId) ?? 0) + recent.length);
  }
  return counts;
}

export interface BuildLocalUsageAccountsOpts {
  role?: ConfiguredDeviceRole;
  device?: string;
  userAgentsDir?: string;
  holdsNativeLogin?: (agentId: AgentId, home: string) => boolean;
  claimedBy?: Record<string, string>;
}

/**
 * Enumerate the usage accounts THIS headed box should poll — native logins it
 * holds, minus accounts another headed poller already claims. A worker or
 * setup-token-only box returns [].
 */
export async function buildLocalUsageAccounts(
  opts: BuildLocalUsageAccountsOpts = {},
): Promise<LocalUsageAccount[]> {
  const role = opts.role ?? selfConfiguredDeviceRole();
  if (!isHeadedDeviceRole(role)) return [];
  const selfDevice = opts.device ?? machineId();
  const claimedBy = opts.claimedBy ?? pollerClaimsFromSharedStore(selfDevice, opts.userAgentsDir);
  const nativeAt = opts.holdsNativeLogin ?? homeHoldsNativeLogin;

  const accounts: LocalUsageAccount[] = [];
  for (const agentId of USAGE_SOURCE_AGENT_IDS) {
    const versions = listInstalledVersions(agentId);
    if (versions.length === 0) continue;

    const inputs: UsageIdentityInput[] = await Promise.all(
      versions.map(async (version) => {
        const home = getVersionHomePath(agentId, version);
        return { agentId, info: await getAccountInfo(agentId, home), home, cliVersion: version };
      }),
    );

    const { canonicalByUsageKey, usageFetchInputs } = buildCanonicalUsageContext(inputs);
    for (const [usageKey, fetchInput] of usageFetchInputs) {
      const canonical = canonicalByUsageKey.get(usageKey);
      if (!canonical?.signedIn) continue; // only refresh accounts actually usable here
      const home = fetchInput.home ?? getVersionHomePath(agentId, fetchInput.cliVersion ?? '');
      if (!shouldPollUsageAccount(
        { usageKey, holdsNativeLogin: nativeAt(agentId, home) },
        { role, selfDevice, claimedBy },
      )) continue;
      accounts.push({
        usageKey,
        agentId,
        // Native file login: skip setup-token (403s on /oauth/usage) and the
        // ACL keychain (Touch ID). Linux headed boxes store the rotating blob
        // in `.credentials.json`; a missing file is a no-op fetch.
        fetch: async (signal?: AbortSignal) => {
          const { getUsageInfoForIdentity } = await import('./accounting/usage.js');
          return getUsageInfoForIdentity({
            agentId,
            home: fetchInput.home,
            cliVersion: fetchInput.cliVersion,
            info: canonical,
          }, { forceRefresh: true, fileOnly: true, nativeFileLogin: true, signal });
        },
      });
    }
  }
  return accounts;
}

/** Injectable side effects, so `runUsageRefresh` is drivable without the daemon. */
export interface UsageRefreshDeps {
  now?: number;
  /** Local-credential accounts to consider (one per unique usage key). */
  listAccounts: () => Promise<LocalUsageAccount[]>;
  /** Persist a fresh snapshot to the usage cache (writeClaudeUsageCache). */
  writeUsageCache: (usageKey: string, snapshot: UsageSnapshot) => void;
  /**
   * Epoch ms this provider — or, when `usageKey` is given, this specific
   * account — is backed off until; null when free (usageRateLimitedUntil).
   * Per-account scope (RUSH-3036): one throttled account must not park its
   * siblings, which previously starved every account after the first 429 in
   * this loop's fixed iteration order.
   */
  backoffUntil: (agentId: AgentId, usageKey?: string) => number | null;
  /**
   * The account's current usage row from the shared cache (the row the routing
   * hot path reads), or null when absent. Lets the refresher see the FREE
   * statusline ingest of a live `agents run` and, when that row is recent, skip a
   * redundant API refresh while still re-deriving headroom from it — instead of
   * spending scarce provider budget re-fetching an already-current account.
   */
  readCachedSnapshot?: (usageKey: string) => UsageSnapshot | null;
  /** Daemon tick deadline signal, forwarded to each account's provider fetch (PHNX-3608). */
  signal?: AbortSignal;
  /** Stamp D8 provenance on a successful poll write. */
  pollerDevice?: string;
  /** Fire after at least one snapshot was written (push-on-change). */
  onSnapshotsChanged?: (usageKeys: string[]) => Promise<void> | void;
}

export interface UsageRefreshResult {
  refreshed: number;
  skippedNotDue: number;
  skippedBackoff: number;
  skippedCap: number;
  /** Skipped because the provider's rolling-hour budget was already spent. */
  skippedBudget: number;
  /** Skipped because a free statusline ingest already captured it recently. */
  skippedFresh: number;
  failed: number;
}

/**
 * One refresher tick: for each local account that is due, under its hourly cap,
 * and not backed off, live-fetch its usage, update the cache, and
 * reschedule from the new burn projection. Never throws — a single account's
 * failed fetch leaves its cache untouched and counts as `failed`.
 */
export async function runUsageRefresh(deps: UsageRefreshDeps): Promise<UsageRefreshResult> {
  const now = deps.now ?? Date.now();
  const result: UsageRefreshResult = {
    refreshed: 0,
    skippedNotDue: 0,
    skippedBackoff: 0,
    skippedCap: 0,
    skippedBudget: 0,
    skippedFresh: 0,
    failed: 0,
  };

  const cache = readHeadroomCache();
  const accounts = orderUsageAccounts(
    await deps.listAccounts(),
    cache,
    Math.floor(now / USAGE_REFRESH_TICK_MS),
  );
  // Per-provider pacing. Two gates keep aggregate endpoint load smooth and bounded:
  //  - a rolling-hour ceiling (PROVIDER_HOURLY_BUDGET) — the hard cap, seeded
  //    with calls already spent in the trailing hour;
  //  - a min-spacing token count (PROVIDER_MIN_REFRESH_SPACING_MS) — the smoother,
  //    which issues refreshes round-robin at a fixed rate instead of the
  //    synchronized burst-then-stall a plain rolling cap produces when every
  //    account falls due on the same tick.
  // Both are per-provider and network-only; accounts are ordered stalest-first, so
  // the scarce budget always serves the account most in need and none is starved.
  const budgetSpent = providerRecentCalls(accounts, cache, now);
  const lastCall = providerLastCall(accounts, cache);
  const spacingTokens = new Map<AgentId, number>();
  for (const [agent, last] of lastCall) spacingTokens.set(agent, providerSpacingTokens(last, now));
  const spacingUsed = new Map<AgentId, number>();
  const updates: Record<string, HeadroomEntry> = {};
  const refreshedKeys: string[] = [];

  for (const [index, account] of accounts.entries()) {
    const entry = cache[account.usageKey] ?? null;
    const network = agentUsesNetworkUsage(account.agentId);

    // A penalized account/provider is off-limits — poking it re-arms the
    // penalty (the whole reason usage-backoff exists).
    if ((deps.backoffUntil(account.agentId, account.usageKey) ?? 0) > now) {
      updates[account.usageKey] = skippedHeadroomEntry(entry, account.usageKey, now, index);
      result.skippedBackoff += 1;
      continue;
    }
    if (!shouldRefreshAccount(entry, now)) {
      if (entry && now < entry.nextRefreshAt) result.skippedNotDue += 1;
      else result.skippedCap += 1;
      continue;
    }

    // A live `agents run` already refreshed this account's usage row for free via
    // the statusline ingest — re-derive headroom from that row and skip the API
    // call. Network providers only: a local-log provider's cache is always its
    // own last write, so this must not suppress its refresh (grok/codex).
    if (network) {
      const cached = deps.readCachedSnapshot?.(account.usageKey) ?? null;
      const capturedAtMs = cached?.capturedAt?.getTime() ?? null;
      if (cached && capturedAtMs !== null && now - capturedAtMs < STATUSLINE_FRESH_MS) {
        updates[account.usageKey] = freshHeadroomEntry(entry, cached, now, capturedAtMs);
        result.skippedFresh += 1;
        continue;
      }
    }

    // Global per-provider budget: cap aggregate endpoint traffic so it does not
    // scale linearly with account count and trip the ~100/hr rate limit, and pace
    // it smoothly. Non-network providers (local logs) have no endpoint to protect.
    if (network) {
      const overHourly = (budgetSpent.get(account.agentId) ?? 0) >= PROVIDER_HOURLY_BUDGET;
      const overSpacing = (spacingUsed.get(account.agentId) ?? 0) >= (spacingTokens.get(account.agentId) ?? 0);
      if (overHourly || overSpacing) {
        // Leave the entry untouched so this still-due account competes again next
        // tick, when budget/spacing frees — never starved (stalest-first serves it).
        result.skippedBudget += 1;
        continue;
      }
      budgetSpent.set(account.agentId, (budgetSpent.get(account.agentId) ?? 0) + 1);
      spacingUsed.set(account.agentId, (spacingUsed.get(account.agentId) ?? 0) + 1);
    }

    try {
      const usage = await account.fetch(deps.signal);
      if (usage.snapshot) {
        // `source` is provenance, not freshness. A forced collection that just
        // reread a local harness event returns `last_seen`; that is still a
        // successful collection and belongs in the shared read cache.
        const stamped = deps.pollerDevice
          ? { ...usage.snapshot, freshness: { source: 'poll' as const, poller: deps.pollerDevice } }
          : usage.snapshot;
        deps.writeUsageCache(account.usageKey, stamped);
        updates[account.usageKey] = nextHeadroomEntry(entry, stamped, now);
        result.refreshed += 1;
        refreshedKeys.push(account.usageKey);
      } else {
        // No live snapshot (expired token / fetch miss): don't rewrite the usage
        // cache, but still record the call + reschedule so a broken account
        // isn't retried every tick.
        updates[account.usageKey] = failedHeadroomEntry(entry, now);
        result.failed += 1;
      }
    } catch {
      updates[account.usageKey] = failedHeadroomEntry(entry, now);
      result.failed += 1;
    }
  }

  if (Object.keys(updates).length > 0) writeHeadroomEntries(updates);
  if (refreshedKeys.length > 0) await deps.onSnapshotsChanged?.(refreshedKeys);
  return result;
}
