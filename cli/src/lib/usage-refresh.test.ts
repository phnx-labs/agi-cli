import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  REFRESH_INTERVAL_MS,
  REFRESH_BURN_DIVISOR,
  HOURLY_CALL_CAP,
  PROVIDER_HOURLY_BUDGET,
  PROVIDER_MIN_REFRESH_SPACING_MS,
  PROVIDER_CATCHUP_MAX,
  USAGE_REFRESH_TICK_MS,
  FAILURE_QUARANTINE_MS,
  FAILURE_QUARANTINE_THRESHOLD,
  computeNextRefreshDelayMs,
  pruneCallTimestamps,
  shouldRefreshAccount,
  nextHeadroomEntry,
  orderUsageAccounts,
  providerRecentCalls,
  providerLastCall,
  providerSpacingTokens,
  runUsageRefresh,
  readHeadroomEntry,
  writeHeadroomEntries,
  setHeadroomCachePathForTest,
  type HeadroomEntry,
} from './usage-refresh.js';
import { setClaudeUsageCachePathForTest, writeClaudeUsageCache, readClaudeUsageCache, type UsageSnapshot } from './accounting/usage.js';
import {
  isUsageVerified,
  hasStaleUsage,
  USAGE_DECISION_MAX_AGE_MS,
  USAGE_STALE_REFUSAL_MAX_AGE_MS,
  type RotateCandidate,
} from './accounting/rotate.js';

const NOW = 1_800_000_000_000;

/** A minimal cached headroom entry the new budget/ordering tests clone and tweak. */
const baseEntry: HeadroomEntry = {
  status: 'available',
  minutesToLimit: 10,
  sessionUsedPercent: 50,
  capturedAt: NOW - 60_000,
  nextRefreshAt: NOW - 1,
  callTimestamps: [],
  computedAt: NOW - 60_000,
};

const sessionSnap = (usedPercent: number, capturedAtMs: number): UsageSnapshot => ({
  source: 'live',
  sourceLabel: 'live',
  capturedAt: new Date(capturedAtMs),
  windows: [
    { key: 'session', label: '5h', shortLabel: 'S', usedPercent, resetsAt: null, windowMinutes: 300 },
  ],
});

describe('computeNextRefreshDelayMs — fixed 5-minute production cadence', () => {
  it('defaults to the 5-minute interval regardless of burn projection', () => {
    expect(REFRESH_INTERVAL_MS).toBe(5 * 60 * 1000);
    expect(USAGE_REFRESH_TICK_MS).toBe(60_000);
    expect(computeNextRefreshDelayMs(600)).toBe(REFRESH_INTERVAL_MS);
    expect(computeNextRefreshDelayMs(20)).toBe(REFRESH_INTERVAL_MS);
    expect(computeNextRefreshDelayMs(0)).toBe(REFRESH_INTERVAL_MS);
    expect(computeNextRefreshDelayMs(null)).toBe(REFRESH_INTERVAL_MS);
  });

  it('still supports a wider clamp when a test/caller passes min/max', () => {
    // minutesToLimit / K with an explicit wide range: 20/4 = 5min.
    const near = computeNextRefreshDelayMs(20, {
      minMs: 90_000,
      maxMs: 15 * 60_000,
      divisor: REFRESH_BURN_DIVISOR,
    });
    expect(near).toBe((20 / REFRESH_BURN_DIVISOR) * 60_000);
    const far = computeNextRefreshDelayMs(600, { minMs: 90_000, maxMs: 15 * 60_000 });
    expect(far).toBe(15 * 60_000);
  });
});

describe('the rolling-hour call cap bounds provider load', () => {
  it('prunes timestamps outside the trailing hour', () => {
    const ts = [NOW - 2 * 60 * 60_000, NOW - 30 * 60_000, NOW - 1000];
    expect(pruneCallTimestamps(ts, NOW)).toEqual([NOW - 30 * 60_000, NOW - 1000]);
  });

  it('refuses a due account that already hit the hourly cap', () => {
    const atCap: HeadroomEntry = {
      status: 'available', minutesToLimit: 10, sessionUsedPercent: 80, capturedAt: NOW - 60_000,
      nextRefreshAt: NOW - 1, // due
      callTimestamps: Array.from({ length: HOURLY_CALL_CAP }, (_, i) => NOW - i * 60_000),
      computedAt: NOW - 60_000,
    };
    expect(shouldRefreshAccount(atCap, NOW)).toBe(false);
  });

  it('allows a due account under the cap, and refuses one not yet due', () => {
    const underCap: HeadroomEntry = {
      status: 'available', minutesToLimit: 10, sessionUsedPercent: 80, capturedAt: NOW - 60_000,
      nextRefreshAt: NOW - 1, callTimestamps: [NOW - 60_000], computedAt: NOW - 60_000,
    };
    expect(shouldRefreshAccount(underCap, NOW)).toBe(true);
    expect(shouldRefreshAccount({ ...underCap, nextRefreshAt: NOW + 60_000 }, NOW)).toBe(false);
  });

  it('always refreshes an account with no prior entry (cold cache)', () => {
    expect(shouldRefreshAccount(null, NOW)).toBe(true);
  });
});

describe('nextHeadroomEntry — projects, schedules, and records the call', () => {
  it('records burn projection but schedules the fixed 5-minute cadence', () => {
    const prev: HeadroomEntry = {
      status: 'available', minutesToLimit: null, sessionUsedPercent: 50, capturedAt: NOW - 10 * 60_000,
      nextRefreshAt: NOW - 1, callTimestamps: [], computedAt: NOW - 10 * 60_000,
    };
    // 50 -> 70 over 10min = 2%/min; 30% left => 15min to cap (projection still computed).
    const entry = nextHeadroomEntry(prev, sessionSnap(70, NOW), NOW);
    expect(entry.minutesToLimit).toBeCloseTo(15, 5);
    // Production cadence is fixed 5 minutes (floor = ceiling = REFRESH_INTERVAL_MS).
    expect(entry.nextRefreshAt - NOW).toBe(REFRESH_INTERVAL_MS);
    expect(entry.sessionUsedPercent).toBe(70);
    expect(entry.callTimestamps).toContain(NOW);
  });
});

describe('runUsageRefresh — refreshes only due, uncapped, un-backed-off local accounts', () => {
  let cacheDir: string;
  let prevHeadroom: string | null;
  let prevUsage: string | null;

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-refresh-'));
    prevHeadroom = setHeadroomCachePathForTest(path.join(cacheDir, '.usage-headroom.json'));
    prevUsage = setClaudeUsageCachePathForTest(path.join(cacheDir, 'claude-usage.json'));
  });

  afterEach(() => {
    setHeadroomCachePathForTest(prevHeadroom);
    setClaudeUsageCachePathForTest(prevUsage);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('writes the usage cache + headroom for a cold account', async () => {
    const key = 'claude:org=refresh';
    const result = await runUsageRefresh({
      now: NOW,
      listAccounts: async () => [
        { usageKey: key, agentId: 'claude', fetch: async () => ({ snapshot: sessionSnap(70, NOW), error: null }) },
      ],
      writeUsageCache: writeClaudeUsageCache,
      backoffUntil: () => null,
    });

    expect(result.refreshed).toBe(1);
    // The live snapshot landed in the usage cache (the readOnly hot path reads this).
    expect(readClaudeUsageCache(key)?.windows[0]?.usedPercent).toBe(70);
    // And a headroom entry was published + scheduled.
    const entry = readHeadroomEntry(key);
    expect(entry?.sessionUsedPercent).toBe(70);
    expect(entry?.nextRefreshAt).toBeGreaterThan(NOW);
  });

  it('publishes a freshly collected local-event snapshot', async () => {
    const key = 'grok:user=local-event';
    const snapshot = {
      ...sessionSnap(21, NOW),
      source: 'last_seen' as const,
      plan: 'SuperGrok Heavy',
    };
    const result = await runUsageRefresh({
      now: NOW,
      listAccounts: async () => [
        { usageKey: key, agentId: 'grok', fetch: async () => ({ snapshot, error: null }) },
      ],
      writeUsageCache: writeClaudeUsageCache,
      backoffUntil: () => null,
    });

    expect(result.refreshed).toBe(1);
    expect(result.failed).toBe(0);
    expect(readClaudeUsageCache(key)).toEqual(expect.objectContaining({ plan: 'SuperGrok Heavy' }));
    expect(readClaudeUsageCache(key)?.windows[0]?.usedPercent).toBe(21);
  });

  it('seeds a never-cached account before cached accounts and rotates each tick', async () => {
    const cached = 'claude:org=cached';
    const coldA = 'claude:org=cold-a';
    const coldB = 'claude:org=cold-b';
    writeHeadroomEntries({
      [cached]: nextHeadroomEntry(null, sessionSnap(10, NOW - REFRESH_INTERVAL_MS), NOW - REFRESH_INTERVAL_MS),
    });
    const accounts = [cached, coldA, coldB].map((usageKey) => ({
      usageKey,
      agentId: 'claude' as const,
      fetch: async () => ({ snapshot: sessionSnap(20, NOW), error: null }),
    }));

    const firstTick = orderUsageAccounts(accounts, { [cached]: readHeadroomEntry(cached)! }, 0);
    const secondTick = orderUsageAccounts(accounts, { [cached]: readHeadroomEntry(cached)! }, 1);

    expect(firstTick.map((account) => account.usageKey)).toEqual([coldA, coldB, cached]);
    expect(secondTick.map((account) => account.usageKey)).toEqual([coldB, coldA, cached]);
  });

  it('skips a provider under a live 429 backoff without calling fetch', async () => {
    let called = false;
    const result = await runUsageRefresh({
      now: NOW,
      listAccounts: async () => [
        { usageKey: 'claude:org=x', agentId: 'claude', fetch: async () => { called = true; return { snapshot: sessionSnap(10, NOW), error: null }; } },
      ],
      writeUsageCache: writeClaudeUsageCache,
      backoffUntil: () => NOW + 30 * 60_000, // backed off 30 min
    });
    expect(called).toBe(false);
    expect(result.skippedBackoff).toBe(1);
    expect(result.refreshed).toBe(0);
    expect(readHeadroomEntry('claude:org=x')?.nextRefreshAt).toBeGreaterThan(NOW);
  });

  it('reschedules backed-off accounts at distinct jittered due times', async () => {
    const keys = ['claude:org=a', 'claude:org=b', 'claude:org=c'];
    await runUsageRefresh({
      now: NOW,
      listAccounts: async () => keys.map((usageKey) => ({
        usageKey,
        agentId: 'claude' as const,
        fetch: async () => ({ snapshot: sessionSnap(10, NOW), error: null }),
      })),
      writeUsageCache: writeClaudeUsageCache,
      backoffUntil: () => NOW + 30 * 60_000,
    });

    const dueTimes = keys.map((key) => readHeadroomEntry(key)?.nextRefreshAt);
    expect(new Set(dueTimes).size).toBe(keys.length);
    expect(dueTimes.every((due) => due !== undefined && due > NOW)).toBe(true);
    expect(dueTimes.every((due) => due !== undefined && due <= NOW + keys.length * 5_000)).toBe(true);
  });

  it('quarantines a chronic failure while healthy siblings keep refreshing', async () => {
    const chronic = 'claude:org=chronic';
    const healthy = 'claude:org=healthy';
    let chronicCalls = 0;
    let healthyCalls = 0;
    const runAt = async (now: number) => runUsageRefresh({
      now,
      listAccounts: async () => [
        {
          usageKey: chronic,
          agentId: 'claude',
          fetch: async () => {
            chronicCalls += 1;
            return { snapshot: null, error: 'rate limited' };
          },
        },
        {
          usageKey: healthy,
          agentId: 'claude',
          fetch: async () => {
            healthyCalls += 1;
            return { snapshot: sessionSnap(20 + healthyCalls, now), error: null };
          },
        },
      ],
      writeUsageCache: writeClaudeUsageCache,
      backoffUntil: () => null,
    });

    for (let cycle = 0; cycle < FAILURE_QUARANTINE_THRESHOLD; cycle += 1) {
      await runAt(NOW + cycle * REFRESH_INTERVAL_MS);
    }
    const quarantined = readHeadroomEntry(chronic);
    expect(quarantined?.consecutiveFailures).toBe(FAILURE_QUARANTINE_THRESHOLD);
    expect(quarantined?.nextRefreshAt).toBe(
      NOW + (FAILURE_QUARANTINE_THRESHOLD - 1) * REFRESH_INTERVAL_MS + FAILURE_QUARANTINE_MS,
    );

    await runAt(NOW + FAILURE_QUARANTINE_THRESHOLD * REFRESH_INTERVAL_MS);
    expect(chronicCalls).toBe(FAILURE_QUARANTINE_THRESHOLD);
    expect(healthyCalls).toBe(FAILURE_QUARANTINE_THRESHOLD + 1);
    expect(readClaudeUsageCache(healthy)?.windows[0]?.usedPercent).toBe(24);
  });

  it('schedules the next attempt 5 minutes out after a successful refresh', async () => {
    const key = 'claude:org=sched';
    await runUsageRefresh({
      now: NOW,
      listAccounts: async () => [
        { usageKey: key, agentId: 'claude', fetch: async () => ({ snapshot: sessionSnap(40, NOW), error: null }) },
      ],
      writeUsageCache: writeClaudeUsageCache,
      backoffUntil: () => null,
    });
    const entry = readHeadroomEntry(key);
    expect(entry?.nextRefreshAt).toBe(NOW + REFRESH_INTERVAL_MS);
  });

  it('does not lose concurrent cache writes for different accounts (lock merge)', async () => {
    // Two serial writeClaudeUsageCache calls under lock must both land.
    writeClaudeUsageCache('claude:org=a', sessionSnap(10, NOW));
    writeClaudeUsageCache('claude:org=b', sessionSnap(20, NOW));
    expect(readClaudeUsageCache('claude:org=a')?.windows[0]?.usedPercent).toBe(10);
    expect(readClaudeUsageCache('claude:org=b')?.windows[0]?.usedPercent).toBe(20);
  });
});

describe('orderUsageAccounts — stalest account first', () => {
  it('orders cached accounts oldest-capture first, cold accounts lead', () => {
    const accounts = ['fresh', 'stalest', 'mid', 'cold'].map((k) => ({
      usageKey: `claude:org=${k}`,
      agentId: 'claude' as const,
      fetch: async () => ({ snapshot: sessionSnap(10, NOW), error: null }),
    }));
    const cache: Record<string, HeadroomEntry> = {
      'claude:org=fresh': { ...baseEntry, capturedAt: NOW - 60_000 },
      'claude:org=stalest': { ...baseEntry, capturedAt: NOW - 40 * 60_000 },
      'claude:org=mid': { ...baseEntry, capturedAt: NOW - 10 * 60_000 },
      // 'cold' has no entry → maximally stale, leads the pass.
    };
    const ordered = orderUsageAccounts(accounts, cache, 0).map((a) => a.usageKey);
    expect(ordered).toEqual([
      'claude:org=cold',
      'claude:org=stalest',
      'claude:org=mid',
      'claude:org=fresh',
    ]);
  });

  it('treats a null capturedAt as maximally stale among cached accounts', () => {
    const accounts = ['hasCapture', 'nullCapture'].map((k) => ({
      usageKey: `claude:org=${k}`,
      agentId: 'claude' as const,
      fetch: async () => ({ snapshot: sessionSnap(10, NOW), error: null }),
    }));
    const cache: Record<string, HeadroomEntry> = {
      'claude:org=hasCapture': { ...baseEntry, capturedAt: NOW - 5 * 60_000 },
      'claude:org=nullCapture': { ...baseEntry, capturedAt: null },
    };
    const ordered = orderUsageAccounts(accounts, cache, 0).map((a) => a.usageKey);
    expect(ordered).toEqual(['claude:org=nullCapture', 'claude:org=hasCapture']);
  });
});

describe('providerRecentCalls — aggregate rolling-hour spend per network provider', () => {
  it('sums only network providers, only calls inside the trailing hour', () => {
    const accounts = [
      { usageKey: 'claude:org=a', agentId: 'claude' as const, fetch: async () => ({ snapshot: null, error: null }) },
      { usageKey: 'claude:org=b', agentId: 'claude' as const, fetch: async () => ({ snapshot: null, error: null }) },
      // grok is network:false — no rate-limited endpoint, excluded from the budget.
      { usageKey: 'grok:user=g', agentId: 'grok' as const, fetch: async () => ({ snapshot: null, error: null }) },
    ];
    const cache: Record<string, HeadroomEntry> = {
      'claude:org=a': { ...baseEntry, callTimestamps: [NOW - 10 * 60_000, NOW - 90 * 60_000, NOW - 1_000] },
      'claude:org=b': { ...baseEntry, callTimestamps: [NOW - 5 * 60_000] },
      'grok:user=g': { ...baseEntry, callTimestamps: [NOW - 1_000, NOW - 2_000] },
    };
    const counts = providerRecentCalls(accounts, cache, NOW);
    // claude: 2 recent from a (the 90-min-old one is pruned) + 1 from b = 3.
    expect(counts.get('claude')).toBe(3);
    expect(counts.has('grok')).toBe(false);
  });
});

describe('providerSpacingTokens — smooth per-provider pacing', () => {
  it('grants a cold provider the catch-up ceiling (warms a couple of accounts, not a burst)', () => {
    expect(providerSpacingTokens(0, NOW)).toBe(PROVIDER_CATCHUP_MAX);
  });

  it('grants none until a full spacing has elapsed, then one', () => {
    const last = NOW - PROVIDER_MIN_REFRESH_SPACING_MS + 1;
    expect(providerSpacingTokens(last, NOW)).toBe(0);
    expect(providerSpacingTokens(NOW - PROVIDER_MIN_REFRESH_SPACING_MS, NOW)).toBe(1);
  });

  it('clamps catch-up after a long idle gap so it cannot re-burst', () => {
    const longAgo = NOW - 10 * PROVIDER_MIN_REFRESH_SPACING_MS;
    expect(providerSpacingTokens(longAgo, NOW)).toBe(PROVIDER_CATCHUP_MAX);
  });

  it('is consistent with the hourly budget (HOUR / spacing)', () => {
    expect(PROVIDER_HOURLY_BUDGET).toBe(60 * 60 * 1000 / PROVIDER_MIN_REFRESH_SPACING_MS);
    expect(PROVIDER_MIN_REFRESH_SPACING_MS).toBe(2 * USAGE_REFRESH_TICK_MS);
  });
});

describe('providerLastCall — most-recent live fetch per network provider', () => {
  it('takes the max timestamp across a provider, and ignores non-network providers', () => {
    const accounts = [
      { usageKey: 'claude:org=a', agentId: 'claude' as const, fetch: async () => ({ snapshot: null, error: null }) },
      { usageKey: 'claude:org=b', agentId: 'claude' as const, fetch: async () => ({ snapshot: null, error: null }) },
      { usageKey: 'grok:user=g', agentId: 'grok' as const, fetch: async () => ({ snapshot: null, error: null }) },
    ];
    const cache: Record<string, HeadroomEntry> = {
      'claude:org=a': { ...baseEntry, callTimestamps: [NOW - 500, NOW - 5_000] },
      'claude:org=b': { ...baseEntry, callTimestamps: [NOW - 200] },
      'grok:user=g': { ...baseEntry, callTimestamps: [NOW - 1] },
    };
    const last = providerLastCall(accounts, cache);
    expect(last.get('claude')).toBe(NOW - 200);
    expect(last.has('grok')).toBe(false);
  });
});

describe('provider budget — aggregate endpoint pressure does not scale with N', () => {
  let cacheDir: string;
  let prevHeadroom: string | null;
  let prevUsage: string | null;

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-budget-'));
    prevHeadroom = setHeadroomCachePathForTest(path.join(cacheDir, '.usage-headroom.json'));
    prevUsage = setClaudeUsageCachePathForTest(path.join(cacheDir, 'claude-usage.json'));
  });

  afterEach(() => {
    setHeadroomCachePathForTest(prevHeadroom);
    setClaudeUsageCachePathForTest(prevUsage);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  const claudeAccounts = (n: number, fetchImpl?: (key: string, now: number) => void) =>
    Array.from({ length: n }, (_, i) => {
      const usageKey = `claude:org=acct-${i}`;
      return {
        usageKey,
        agentId: 'claude' as const,
        fetch: async () => { fetchImpl?.(usageKey, NOW); return { snapshot: sessionSnap(10, NOW), error: null }; },
      };
    });

  it('paces a cold provider to the catch-up ceiling, not the whole due set at once', async () => {
    const accounts = claudeAccounts(PROVIDER_HOURLY_BUDGET + 12);
    const result = await runUsageRefresh({
      now: NOW,
      listAccounts: async () => accounts,
      writeUsageCache: writeClaudeUsageCache,
      backoffUntil: () => null,
    });
    // Spacing caps a single tick at the catch-up ceiling — never the full due set.
    expect(result.refreshed).toBe(PROVIDER_CATCHUP_MAX);
    expect(result.skippedBudget).toBe(accounts.length - PROVIDER_CATCHUP_MAX);
  });

  it('holds the aggregate at the hourly budget across a full hour of ticks', async () => {
    const accounts = claudeAccounts(PROVIDER_HOURLY_BUDGET + 12);
    let fetches = 0;
    const ticksPerHour = (60 * 60 * 1000) / USAGE_REFRESH_TICK_MS; // 60
    for (let tick = 0; tick < ticksPerHour; tick += 1) {
      const r = await runUsageRefresh({
        now: NOW + tick * USAGE_REFRESH_TICK_MS,
        listAccounts: async () => accounts,
        writeUsageCache: writeClaudeUsageCache,
        backoffUntil: () => null,
      });
      fetches += r.refreshed;
    }
    // Smooth pacing lands exactly on the budget — one fetch every other tick.
    expect(fetches).toBe(PROVIDER_HOURLY_BUDGET);
  });

  it('serves the STALEST account first when spacing frees a token', async () => {
    const fetched: string[] = [];
    const accounts = claudeAccounts(4, (key) => fetched.push(key));
    // Seed staggered capture times: acct-3 stalest, acct-0 freshest. All due.
    // A recent provider call means spacing grants no token this tick...
    const seed: Record<string, HeadroomEntry> = {};
    accounts.forEach((a, i) => {
      seed[a.usageKey] = {
        ...baseEntry,
        capturedAt: NOW - (i + 1) * 60_000,
        nextRefreshAt: NOW - 1,
        // last provider call one full spacing ago ⇒ exactly one token this tick.
        callTimestamps: i === 0 ? [NOW - PROVIDER_MIN_REFRESH_SPACING_MS] : [],
      };
    });
    writeHeadroomEntries(seed);

    const result = await runUsageRefresh({
      now: NOW,
      listAccounts: async () => accounts,
      writeUsageCache: writeClaudeUsageCache,
      backoffUntil: () => null,
    });
    expect(result.refreshed).toBe(1);
    // The one token went to the stalest account (acct-3), not the freshest.
    expect(fetched).toEqual(['claude:org=acct-3']);
  });

  it('never calls a parked (backed-off) account, and it does not consume budget', async () => {
    let parkedCalled = false;
    let liveCalled = false;
    const result = await runUsageRefresh({
      now: NOW,
      listAccounts: async () => [
        { usageKey: 'claude:org=parked', agentId: 'claude', fetch: async () => { parkedCalled = true; return { snapshot: sessionSnap(10, NOW), error: null }; } },
        { usageKey: 'claude:org=live', agentId: 'claude', fetch: async () => { liveCalled = true; return { snapshot: sessionSnap(10, NOW), error: null }; } },
      ],
      writeUsageCache: writeClaudeUsageCache,
      backoffUntil: (_agent, usageKey) => (usageKey === 'claude:org=parked' ? NOW + 30 * 60_000 : null),
    });
    expect(parkedCalled).toBe(false);
    expect(liveCalled).toBe(true);
    expect(result.skippedBackoff).toBe(1);
    expect(result.refreshed).toBe(1);
  });

  it('does not API-refresh an account a statusline ingest just captured, and re-derives its headroom', async () => {
    let fetched = false;
    const key = 'claude:org=statusline-fresh';
    // Prior sample so the burn projection has something to compute minutesToLimit from.
    writeHeadroomEntries({
      [key]: { ...baseEntry, capturedAt: NOW - 10 * 60_000, sessionUsedPercent: 50, nextRefreshAt: NOW - 1, callTimestamps: [] },
    });
    // The statusline wrote a fresh row 1 minute ago: 70% used (up from 50%).
    const fresh = { ...sessionSnap(70, NOW - 60_000) };
    const result = await runUsageRefresh({
      now: NOW,
      listAccounts: async () => [
        { usageKey: key, agentId: 'claude', fetch: async () => { fetched = true; return { snapshot: sessionSnap(99, NOW), error: null }; } },
      ],
      writeUsageCache: writeClaudeUsageCache,
      backoffUntil: () => null,
      readCachedSnapshot: () => fresh,
    });
    expect(fetched).toBe(false);
    expect(result.skippedFresh).toBe(1);
    expect(result.refreshed).toBe(0);
    const entry = readHeadroomEntry(key);
    // Headroom is RE-DERIVED from the fresh statusline row, not frozen at the old sample.
    expect(entry?.sessionUsedPercent).toBe(70);
    expect(entry?.status).not.toBeNull();
    // Prev sample (50% @ NOW-10m) → fresh (70% @ NOW-1m): 20% over 9 min = 2.22%/min,
    // 30% left ⇒ 13.5 min to cap — computed from the REAL fresh capture time, not frozen.
    expect(entry?.minutesToLimit).toBeCloseTo(13.5, 5);
    // No API call recorded (statusline is free) ⇒ no call timestamp consumed budget.
    expect(entry?.callTimestamps).toEqual([]);
    // Rescheduled one interval past the free capture.
    expect(entry?.nextRefreshAt).toBe(NOW - 60_000 + REFRESH_INTERVAL_MS);
  });

  it('DOES API-refresh an account whose cached row aged past the statusline-fresh window', async () => {
    let fetched = false;
    const result = await runUsageRefresh({
      now: NOW,
      listAccounts: async () => [
        { usageKey: 'claude:org=stale-statusline', agentId: 'claude', fetch: async () => { fetched = true; return { snapshot: sessionSnap(10, NOW), error: null }; } },
      ],
      writeUsageCache: writeClaudeUsageCache,
      backoffUntil: () => null,
      readCachedSnapshot: () => sessionSnap(10, NOW - (REFRESH_INTERVAL_MS + 60_000)),
    });
    expect(fetched).toBe(true);
    expect(result.refreshed).toBe(1);
    expect(result.skippedFresh).toBe(0);
  });

  it('does NOT apply the statusline-fresh skip to a network:false provider (grok refreshes)', async () => {
    let fetched = false;
    // grok's cache is always its own last local-log write, so a "recent" capture
    // must NOT suppress its refresh — only network providers get the skip.
    const result = await runUsageRefresh({
      now: NOW,
      listAccounts: async () => [
        { usageKey: 'grok:user=g', agentId: 'grok', fetch: async () => { fetched = true; return { snapshot: sessionSnap(10, NOW), error: null }; } },
      ],
      writeUsageCache: writeClaudeUsageCache,
      backoffUntil: () => null,
      readCachedSnapshot: () => sessionSnap(10, NOW - 1_000), // 1s ago
    });
    expect(fetched).toBe(true);
    expect(result.refreshed).toBe(1);
    expect(result.skippedFresh).toBe(0);
  });
});

describe('BLOCKER reconciliation — a budget-paced fleet never collapses to NO_VERIFIED_USAGE', () => {
  let cacheDir: string;
  let prevHeadroom: string | null;
  let prevUsage: string | null;

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-sim-'));
    prevHeadroom = setHeadroomCachePathForTest(path.join(cacheDir, '.usage-headroom.json'));
    prevUsage = setClaudeUsageCachePathForTest(path.join(cacheDir, 'claude-usage.json'));
  });

  afterEach(() => {
    setHeadroomCachePathForTest(prevHeadroom);
    setClaudeUsageCachePathForTest(prevUsage);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  // Build the router's freshness view of a provider straight from the usage cache
  // the daemon just wrote, then apply the REAL rotate gates. This is the seam the
  // reviewer's blocker lives on: budget-paced cadence vs the routing window.
  const noVerifiedUsage = (keys: string[], now: number): { refuse: boolean; maxAgeMs: number; verified: number } => {
    const pool = keys.map((usageKey) => {
      const snap = readClaudeUsageCache(usageKey);
      return { usageSnapshot: snap } as unknown as RotateCandidate;
    });
    const verified = pool.filter((c) => isUsageVerified(c, now)).length;
    const refuse = verified === 0 && pool.some((c) => hasStaleUsage(c, now));
    const maxAgeMs = Math.max(
      0,
      ...keys.map((k) => {
        const cap = readClaudeUsageCache(k)?.capturedAt?.getTime();
        return cap ? now - cap : 0;
      }),
    );
    return { refuse, maxAgeMs, verified };
  };

  const runFleet = async (n: number, hours: number) => {
    const keys = Array.from({ length: n }, (_, i) => `claude:org=acct-${i}`);
    const accounts = keys.map((usageKey) => ({
      usageKey,
      agentId: 'claude' as const,
      fetch: async () => ({ snapshot: sessionSnap(10, NOW), error: null }),
    }));
    const ticks = (hours * 60 * 60 * 1000) / USAGE_REFRESH_TICK_MS;
    let totalFetches = 0;
    let everRefused = false;
    let worstAgeMs = 0;
    let allWarm = false;
    for (let tick = 0; tick < ticks; tick += 1) {
      const now = NOW + tick * USAGE_REFRESH_TICK_MS;
      const r = await runUsageRefresh({
        now,
        listAccounts: async () => accounts.map((a) => ({
          ...a,
          fetch: async () => ({ snapshot: sessionSnap(10, now), error: null }),
        })),
        writeUsageCache: writeClaudeUsageCache,
        backoffUntil: () => null,
      });
      totalFetches += r.refreshed;
      // Once every account has a snapshot, the fleet is warm; from then on the
      // refusal must NEVER fire.
      if (!allWarm) allWarm = keys.every((k) => readClaudeUsageCache(k) !== null);
      if (allWarm) {
        const v = noVerifiedUsage(keys, now);
        if (v.refuse) everRefused = true;
        worstAgeMs = Math.max(worstAgeMs, v.maxAgeMs);
      }
    }
    return { totalFetches, everRefused, worstAgeMs, ticks };
  };

  it('8-account idle fleet: refusal never fires, every account stays under the routing window, load ~budget/hr', async () => {
    const { totalFetches, everRefused, worstAgeMs, ticks } = await runFleet(8, 3);
    expect(everRefused).toBe(false);
    // No account ever reads as genuinely stale (the refusal bar)...
    expect(worstAgeMs).toBeLessThan(USAGE_STALE_REFUSAL_MAX_AGE_MS);
    // ...and the worst-case cadence tracks round-robin N × spacing (~16 min for 8
    // accounts), not the unbounded 40-min stall a plain rolling cap produced.
    expect(worstAgeMs).toBeLessThan(9 * PROVIDER_MIN_REFRESH_SPACING_MS);
    // Aggregate endpoint load holds at ~budget/hr (NOT 8×12=96/hr).
    const perHour = totalFetches / (ticks / ((60 * 60 * 1000) / USAGE_REFRESH_TICK_MS));
    expect(perHour).toBeLessThanOrEqual(PROVIDER_HOURLY_BUDGET + PROVIDER_CATCHUP_MAX);
  });

  it('16-account idle fleet (realistic max): still no refusal, cadence still under the window', async () => {
    const { everRefused, worstAgeMs } = await runFleet(16, 3);
    expect(everRefused).toBe(false);
    expect(worstAgeMs).toBeLessThan(USAGE_STALE_REFUSAL_MAX_AGE_MS);
  });
});
