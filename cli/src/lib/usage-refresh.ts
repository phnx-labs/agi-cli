/** Daemon-owned usage refresher, one poller per account on a headed box; routing reads the cache
 * only (RUSH-2061). Fixed 5-minute cadence, `HOURLY_CALL_CAP`, skip 429-backed-off accounts,
 * file-only credentials (no Touch ID storm), cache writes under `withFileLock`. */
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
import { USAGE_SYNC_INTERVAL_MS } from './accounting/usage-sync.js';

/** Default schedule between live usage fetches for one account; the delay helper's floor and ceiling
 * are both this, so polling is exactly every 5 minutes. */
export const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
/** Burn-rate divisor retained for the pure delay helper / tests; with min=max
 * the divisor does not change the scheduled interval. */
export const REFRESH_BURN_DIVISOR = 4;
/** At most this many live fetches per account per rolling hour (5m cadence ⇒ 12). */
export const HOURLY_CALL_CAP = 12;
/** How often the daemon wakes to *consider* a refresh pass (due accounts only). */
export const USAGE_REFRESH_TICK_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** Minimum spacing between live fetches to one network provider across accounts: round-robin,
 * stalest first, a smooth rate instead of a burst. Two daemon ticks, so 30/hr. */
export const PROVIDER_MIN_REFRESH_SPACING_MS = 2 * USAGE_REFRESH_TICK_MS;
/** Aggregate live fetches per rolling hour per network provider, derived from the spacing (30).
 * Per-account caps alone scaled with accounts (~96/hr from 8) and tripped Anthropic's ~100/hr
 * limit. 30/hr leaves room for the auth probe (RUSH-2998) and stays under the stale window. */
export const PROVIDER_HOURLY_BUDGET = HOUR_MS / PROVIDER_MIN_REFRESH_SPACING_MS;
/** Most refreshes one tick may catch up after the daemon was idle or down, so a long gap cannot
 * re-synchronize every account into a burst. */
export const PROVIDER_CATCHUP_MAX = 2;
/** A row captured this recently (e.g. by the free statusline ingest of a live run) is fresh: skip
 * the API call and keep the budget for idle accounts. */
/** Consecutive failed live reads before one broken account is quarantined. */
export const FAILURE_QUARANTINE_THRESHOLD = 3;
/** A chronic offender waits this long while healthy siblings keep their cadence. */
export const FAILURE_QUARANTINE_MS = 30 * 60 * 1000;
const SKIP_JITTER_MIN_MS = 2_000;
const SKIP_JITTER_RANGE_MS = 3_001;

/** One account's refresh state and headroom: `sessionUsedPercent`/`capturedAt` are the prior sample
 * for burn projection; `minutesToLimit`/`status` are what routing reads. */
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
function readHeadroomCache(): Record<string, HeadroomEntry> {
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

/** Interval to the next refresh attempt, clamped to [minMs, maxMs]; defaults pin both to
 * `REFRESH_INTERVAL_MS`. Tests may widen the range. */
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

/** Whether an account may be live-refreshed now: past `nextRefreshAt` and under the hourly cap.
 * Pure, so testable without a daemon. */
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

/** Build the next headroom entry after a live refresh: project headroom, schedule the next refresh,
 * record the call for the hourly cap. */
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

/** Reschedule an account skipped because a free statusline ingest captured it: re-derive
 * status/minutesToLimit from that sample (else they freeze and `capacityWeight` goes stale). No
 * call is recorded. */
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

/** Most-recent live-fetch time per network provider (0 when none), from which pacing spaces the next
 * refresh. Non-network providers have no rate-limited endpoint and are omitted. */
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

/** Fetches pacing permits a provider this tick: one per elapsed spacing since its last fetch,
 * clamped to `PROVIDER_CATCHUP_MAX` so an idle gap cannot re-burst. `PROVIDER_HOURLY_BUDGET` is
 * the only cap on a small fleet. */
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
/** Daemon auth-health may hit `/oauth/usage` only on a headed box, unless forceLive. */
export function mayIssueUsageEndpointProbe(opts: {
  role: ConfiguredDeviceRole | undefined;
  forceLive?: boolean;
}): boolean {
  if (opts.forceLive === true) return true;
  return isHeadedDeviceRole(opts.role);
}

/** Sticky one-poller election: lex-least among this box (if it has a native login) and peers
 * publishing a `freshnessSource=poll` row, so two headed boxes converge instead of deferring to
 * each other. */
export function electUsagePoller(opts: {
  selfDevice: string;
  selfHoldsNativeLogin: boolean;
  peerPollers?: string[];
}): string | null {
  const names = new Set<string>();
  if (opts.selfHoldsNativeLogin) names.add(normalizeHost(opts.selfDevice));
  for (const peer of opts.peerPollers ?? []) names.add(normalizeHost(peer));
  if (names.size === 0) return null;
  return [...names].sort()[0];
}

export function shouldPollUsageAccount(
  candidate: Pick<UsagePollCandidate, 'usageKey' | 'holdsNativeLogin'>,
  opts: {
    role: ConfiguredDeviceRole | undefined;
    selfDevice: string;
    peerPollers?: string[];
    /** @deprecated use peerPollers; kept so older tests that pass claimedBy still compile */
    claimedBy?: Record<string, string>;
  },
): boolean {
  if (!isHeadedDeviceRole(opts.role)) return false;
  if (!candidate.holdsNativeLogin) return false;
  const peerPollers = opts.peerPollers
    ?? (opts.claimedBy?.[candidate.usageKey] ? [opts.claimedBy[candidate.usageKey]] : []);
  const elected = electUsagePoller({
    selfDevice: opts.selfDevice,
    selfHoldsNativeLogin: true,
    peerPollers,
  });
  return elected === normalizeHost(opts.selfDevice);
}

/** Native rotating login on this home — Claude's `.credentials.json` blob, else a credential file. */
export function homeHoldsNativeLogin(agentId: AgentId, home: string): boolean {
  if (agentId === 'claude') return claudeHomeHasNativeOauthFile(home);
  return credentialPresence(agentId, home).perVersion;
}

/** usageKey → devices that published a `poll` row (statusline/sync do not claim). */
export function pollerClaimsFromSharedStore(
  selfDevice: string,
  userAgentsDir = getUserAgentsDir(),
): Record<string, string[]> {
  const claims: Record<string, string[]> = {};
  const read = readFleetSharedDeviceStates(userAgentsDir);
  const self = normalizeHost(selfDevice);
  for (const state of read.states) {
    if (!state.usage) continue;
    for (const [key, row] of Object.entries(state.usage.rows)) {
      if (row.freshnessSource !== 'poll') continue;
      const capturedMs = row.capturedAt ? Date.parse(row.capturedAt) : NaN;
      if (!Number.isFinite(capturedMs) || Date.now() - capturedMs > USAGE_SYNC_INTERVAL_MS) continue;
      const poller = normalizeHost(row.pollerDevice ?? state.device);
      if (!poller || poller === self) continue;
      const list = claims[key] ?? [];
      if (!list.includes(poller)) list.push(poller);
      claims[key] = list;
    }
  }
  return claims;
}

/** Spend one live call from the shared per-account/per-provider budget; auth-health and the poller
 * both use it so together they stay under `PROVIDER_HOURLY_BUDGET` (~30/hr). False means do not
 * fire. */
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
interface LocalUsageAccount {
  usageKey: string;
  agentId: AgentId;
  /** Live-fetch this account's usage; `signal` (the tick's deadline AbortSignal) aborts a hung
   * refresh at deadlineMs, not just its own 5s timeout. */
  fetch: (signal?: AbortSignal) => Promise<UsageInfo>;
}

/** Order a pass stalest-first so the scarce per-provider budget serves the neediest and none
 * starves: cold accounts lead (rotating by `tick`), then cached ones by oldest `capturedAt`. */
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

/** Live calls a network provider already spent in the trailing hour, summed over this pass, so
 * `PROVIDER_HOURLY_BUDGET` bounds the rolling hour. Local-log providers (grok/codex) are excluded. */
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
  claimedBy?: Record<string, string[]>;
}

/** Usage accounts this headed box should poll: its native logins minus those another headed poller
 * claims. A worker or setup-token-only box returns []. */
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
        { role, selfDevice, peerPollers: claimedBy[usageKey] },
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
interface UsageRefreshDeps {
  now?: number;
  /** Local-credential accounts to consider (one per unique usage key). */
  listAccounts: () => Promise<LocalUsageAccount[]>;
  /** Persist a fresh snapshot to the usage cache (writeClaudeUsageCache). */
  writeUsageCache: (usageKey: string, snapshot: UsageSnapshot) => void;
  /** Epoch ms this provider (or, with `usageKey`, this account) is backed off until; null if free.
   * Per-account (RUSH-3036) so one throttled account cannot park its siblings. */
  backoffUntil: (agentId: AgentId, usageKey?: string) => number | null;
  /** The account's usage row from the shared cache (what routing reads), or null; lets the refresher
   * skip a redundant refresh when a free statusline ingest is recent. */
  readCachedSnapshot?: (usageKey: string) => UsageSnapshot | null;
  /** Daemon tick deadline signal, forwarded to each account's provider fetch (PHNX-3608). */
  signal?: AbortSignal;
  /** Stamp D8 provenance on a successful poll write. */
  pollerDevice?: string;
  /** Fire after at least one snapshot was written (push-on-change). */
  onSnapshotsChanged?: (usageKeys: string[]) => Promise<void> | void;
}

interface UsageRefreshResult {
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

/** One refresher tick: live-fetch each due, under-cap, not-backed-off account, update the cache,
 * reschedule. Never throws; a failed fetch leaves the cache untouched and counts as `failed`. */
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
  // Per-provider pacing: a rolling-hour ceiling (PROVIDER_HOURLY_BUDGET, seeded with calls already
  // spent) plus min-spacing tokens that issue refreshes round-robin instead of a burst.
  // Network-only; stalest first.
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

    // A live `agents run` already refreshed this row via the statusline ingest: re-derive headroom
    // and skip the API call. Network providers only; a local-log provider's cache is its own write
    // (grok/codex).
    if (network) {
      const cached = deps.readCachedSnapshot?.(account.usageKey) ?? null;
      const capturedAtMs = cached?.capturedAt?.getTime() ?? null;
      if (cached && capturedAtMs !== null && now - capturedAtMs < REFRESH_INTERVAL_MS) {
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
