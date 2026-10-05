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

export const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
export const REFRESH_BURN_DIVISOR = 4;
export const HOURLY_CALL_CAP = 12;
export const USAGE_REFRESH_TICK_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
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
export const PROVIDER_CATCHUP_MAX = 2;
export const FAILURE_QUARANTINE_THRESHOLD = 3;
export const FAILURE_QUARANTINE_MS = 30 * 60 * 1000;
const SKIP_JITTER_MIN_MS = 2_000;
const SKIP_JITTER_RANGE_MS = 3_001;

export interface HeadroomEntry {
  status: UsageHeadroom['status'];
  minutesToLimit: number | null;
  sessionUsedPercent: number | null;
  capturedAt: number | null;
  nextRefreshAt: number;
  callTimestamps: number[];
  computedAt: number;
  consecutiveFailures?: number;
}

interface HeadroomCacheFile {
  version: 1;
  entries: Record<string, HeadroomEntry>;
}

let headroomCachePathOverride: string | null = null;
export function setHeadroomCachePathForTest(cachePath: string | null): string | null {
  const prev = headroomCachePathOverride;
  headroomCachePathOverride = cachePath;
  return prev;
}
function headroomCachePath(): string {
  return headroomCachePathOverride ?? path.join(getCacheDir(), '.usage-headroom.json');
}

function readHeadroomCache(): Record<string, HeadroomEntry> {
  try {
    const parsed = JSON.parse(fs.readFileSync(headroomCachePath(), 'utf-8')) as HeadroomCacheFile;
    if (parsed && parsed.entries && typeof parsed.entries === 'object') return parsed.entries;
  } catch {
  }
  return {};
}

export function readHeadroomEntry(usageKey: string): HeadroomEntry | null {
  return readHeadroomCache()[usageKey] ?? null;
}

export function writeHeadroomEntries(entries: Record<string, HeadroomEntry>): void {
  try {
    const cachePath = headroomCachePath();
    ensureLockTarget(cachePath, JSON.stringify({ version: 1, entries: {} }, null, 2));
    withFileLock(cachePath, () => {
      // Re-read under the lock so concurrent refreshers cannot drop each other's rows.
      const merged: HeadroomCacheFile = {
        version: 1,
        entries: { ...readHeadroomCache(), ...entries },
      };
      atomicWriteFileSync(cachePath, JSON.stringify(merged, null, 2));
    });
  } catch {
  }
}

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

export function pruneCallTimestamps(timestamps: number[], now: number, windowMs = HOUR_MS): number[] {
  const floor = now - windowMs;
  return timestamps.filter((ts) => ts > floor);
}

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

function freshHeadroomEntry(
  prev: HeadroomEntry | null,
  snapshot: UsageSnapshot,
  now: number,
  capturedAtMs: number,
): HeadroomEntry {
  // A recent statusline row is a free live sample: re-derive headroom without
  // recording an API call, then schedule the next proactive refresh from it.
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
    callTimestamps: pruneCallTimestamps(prev?.callTimestamps ?? [], now),
    computedAt: now,
    consecutiveFailures: 0,
  };
}

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

export function providerSpacingTokens(lastCallMs: number, now: number): number {
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

export interface UsagePollCandidate {
  usageKey: string;
  agentId: AgentId;
  home: string;
  holdsNativeLogin: boolean;
}

export function mayIssueUsageEndpointProbe(opts: {
  role: ConfiguredDeviceRole | undefined;
  forceLive?: boolean;
}): boolean {
  if (opts.forceLive === true) return true;
  return isHeadedDeviceRole(opts.role);
}

export function electUsagePoller(opts: {
  selfDevice: string;
  selfHoldsNativeLogin: boolean;
  peerPollers?: string[];
}): string | null {
  // Only native-login headed devices contend; statusline ingest never claims
  // ownership. Lexical election converges multiple headed devices on one poller.
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

export function homeHoldsNativeLogin(agentId: AgentId, home: string): boolean {
  if (agentId === 'claude') return claudeHomeHasNativeOauthFile(home);
  return credentialPresence(agentId, home).perVersion;
}

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

export function trySpendUsageApiCall(usageKey: string, agentId: AgentId, now: number): boolean {
  // Auth-health and refresh share this per-account and per-provider budget.
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

interface LocalUsageAccount {
  usageKey: string;
  agentId: AgentId;
  fetch: (signal?: AbortSignal) => Promise<UsageInfo>;
}

export function orderUsageAccounts(
  accounts: LocalUsageAccount[],
  cache: Record<string, HeadroomEntry>,
  tick: number,
): LocalUsageAccount[] {
  // Spend scarce provider budget stalest-first; rotate cold accounts per tick.
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
      if (!canonical?.signedIn) continue;
      const home = fetchInput.home ?? getVersionHomePath(agentId, fetchInput.cliVersion ?? '');
      if (!shouldPollUsageAccount(
        { usageKey, holdsNativeLogin: nativeAt(agentId, home) },
        { role, selfDevice, peerPollers: claimedBy[usageKey] },
      )) continue;
      accounts.push({
        usageKey,
        agentId,
        // Native file-only credentials avoid worker setup tokens and Touch ID.
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

interface UsageRefreshDeps {
  now?: number;
  listAccounts: () => Promise<LocalUsageAccount[]>;
  writeUsageCache: (usageKey: string, snapshot: UsageSnapshot) => void;
  backoffUntil: (agentId: AgentId, usageKey?: string) => number | null;
  readCachedSnapshot?: (usageKey: string) => UsageSnapshot | null;
  signal?: AbortSignal;
  pollerDevice?: string;
  onSnapshotsChanged?: (usageKeys: string[]) => Promise<void> | void;
}

interface UsageRefreshResult {
  refreshed: number;
  skippedNotDue: number;
  skippedBackoff: number;
  skippedCap: number;
  skippedBudget: number;
  skippedFresh: number;
  failed: number;
}

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

    // Account-specific penalties cannot park siblings; provider-wide penalties still apply.
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

    if (network) {
      const cached = deps.readCachedSnapshot?.(account.usageKey) ?? null;
      const capturedAtMs = cached?.capturedAt?.getTime() ?? null;
      if (cached && capturedAtMs !== null && now - capturedAtMs < REFRESH_INTERVAL_MS) {
        updates[account.usageKey] = freshHeadroomEntry(entry, cached, now, capturedAtMs);
        result.skippedFresh += 1;
        continue;
      }
    }

    if (network) {
      const overHourly = (budgetSpent.get(account.agentId) ?? 0) >= PROVIDER_HOURLY_BUDGET;
      const overSpacing = (spacingUsed.get(account.agentId) ?? 0) >= (spacingTokens.get(account.agentId) ?? 0);
      if (overHourly || overSpacing) {
        result.skippedBudget += 1;
        continue;
      }
      budgetSpent.set(account.agentId, (budgetSpent.get(account.agentId) ?? 0) + 1);
      spacingUsed.set(account.agentId, (spacingUsed.get(account.agentId) ?? 0) + 1);
    }

    try {
      const usage = await account.fetch(deps.signal);
      if (usage.snapshot) {
        const stamped = deps.pollerDevice
          ? { ...usage.snapshot, freshness: { source: 'poll' as const, poller: deps.pollerDevice } }
          : usage.snapshot;
        deps.writeUsageCache(account.usageKey, stamped);
        updates[account.usageKey] = nextHeadroomEntry(entry, stamped, now);
        result.refreshed += 1;
        refreshedKeys.push(account.usageKey);
      } else {
        // Preserve the last usage snapshot; reschedule and quarantine repeated misses.
        updates[account.usageKey] = failedHeadroomEntry(entry, now);
        result.failed += 1;
      }
    } catch {
      // A failed fetch changes headroom scheduling only, never the usage cache.
      updates[account.usageKey] = failedHeadroomEntry(entry, now);
      result.failed += 1;
    }
  }

  if (Object.keys(updates).length > 0) writeHeadroomEntries(updates);
  if (refreshedKeys.length > 0) await deps.onSnapshotsChanged?.(refreshedKeys);
  return result;
}
