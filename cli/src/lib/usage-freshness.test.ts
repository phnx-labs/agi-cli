/**
 * W3 usage freshness: real home-layout / real shared-store path, no mocks.
 *
 *  1. Two headed boxes publish; a worker consumeUsageSnapshotsFromSharedStore
 *     merge lets balanced auto-pick (no picker) on synced rows 10 min old.
 *  2. A worker / setup-token-only box lists zero poll accounts, so
 *     runUsageRefresh issues zero usage API calls.
 *  3. auth-sync and usage-sync kickoffs never land inside the git-lock window.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  consumeUsageSnapshotsFromSharedStore,
  publishUsageSnapshotToSharedStore,
  USAGE_SYNC_INTERVAL_MS,
} from './accounting/usage-sync.js';
import {
  readClaudeUsageCache,
  setClaudeUsageCachePathForTest,
  type CachedUsageSnapshot,
} from './accounting/usage.js';
import {
  isUsageVerified,
  pickBalancedCandidate,
  USAGE_DECISION_MAX_AGE_MS,
  USAGE_SYNC_TRUST_MS,
  type RotateCandidate,
} from './accounting/rotate.js';
import {
  buildLocalUsageAccounts,
  mayIssueUsageEndpointProbe,
  runUsageRefresh,
  setHeadroomCachePathForTest,
  shouldPollUsageAccount,
  trySpendUsageApiCall,
  HOURLY_CALL_CAP,
  PROVIDER_HOURLY_BUDGET,
} from './usage-refresh.js';
import { AUTH_SYNC_KICKOFF_MS, AUTH_SYNC_TICK_MS } from './daemon/auth-sync-service.js';
import { USAGE_SYNC_KICKOFF_MS, USAGE_SYNC_TICK_MS } from './daemon/usage-sync-service.js';
import { FLEET_SHARED_REPO_SYNC_DEADLINE_MS } from './fleet-shared-repo-sync.js';
import { writeClaudeUsageCache } from './accounting/usage.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-usage-fresh-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function row(
  capturedAt: string,
  usedPercent: number,
  extra: Partial<CachedUsageSnapshot> = {},
): CachedUsageSnapshot {
  return {
    capturedAt,
    windows: [{
      key: 'week',
      label: 'Week',
      shortLabel: 'W',
      usedPercent,
      resetsAt: null,
      windowMinutes: 10_080,
    }],
    freshnessSource: 'poll',
    pollerDevice: extra.pollerDevice,
    ...extra,
  };
}

function seed(file: string, rows: Record<string, CachedUsageSnapshot>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rows), 'utf-8');
}

function candidateFromSnap(version: string, snap: ReturnType<typeof readClaudeUsageCache>): RotateCandidate {
  return {
    agent: 'claude',
    version,
    accountKey: `claude:account=${version}`,
    accountLabel: `${version}@example.com`,
    email: `${version}@example.com`,
    usageKey: `claude:org=${version}`,
    usageStatus: 'available',
    usageSnapshot: snap,
    usageError: null,
    usageMinutesToLimit: null,
    plan: 'Max',
    signedIn: true,
    authVerdict: null,
    lastActive: null,
  };
}

describe('W3.4 two headed boxes merge through the shared store; worker balanced auto-picks', () => {
  it('consumes synced rows 10 min old and pickBalancedCandidate does not refuse', async () => {
    const root = tempDir();
    const workerCache = path.join(root, 'worker-cache.json');
    const now = Date.parse('2026-09-06T12:00:00.000Z');
    const tenMinAgo = new Date(now - 10 * 60_000).toISOString();

    const zionCache = path.join(root, 'zion.json');
    const desktopCache = path.join(root, 'desktop.json');
    seed(zionCache, {
      'claude:org=alpha': row(tenMinAgo, 20, { pollerDevice: 'zion' }),
    });
    seed(desktopCache, {
      'claude:org=beta': row(tenMinAgo, 35, { pollerDevice: 'desktop' }),
    });
    expect(await publishUsageSnapshotToSharedStore({
      userAgentsDir: root, cachePath: zionCache, role: 'personal', device: 'zion',
    })).toMatchObject({ published: true, changed: true });
    expect(await publishUsageSnapshotToSharedStore({
      userAgentsDir: root, cachePath: desktopCache, role: 'desktop', device: 'desktop',
    })).toMatchObject({ published: true, changed: true });

    const consumed = consumeUsageSnapshotsFromSharedStore({
      userAgentsDir: root,
      cachePath: workerCache,
      role: 'worker',
      device: 'worker-a',
      roles: { zion: 'personal', desktop: 'desktop', 'worker-a': 'worker' },
    });
    expect(consumed.merged).toBe(2);
    expect(consumed.sources).toEqual(['desktop', 'zion']);

    const alpha = readClaudeUsageCache('claude:org=alpha', workerCache, new Date(now));
    const beta = readClaudeUsageCache('claude:org=beta', workerCache, new Date(now));
    expect(alpha?.freshness).toEqual({ source: 'sync', poller: 'zion' });
    expect(beta?.freshness).toEqual({ source: 'sync', poller: 'desktop' });

    // 10 min is past the local 5-min bar but inside the sync cadence.
    expect(now - (alpha?.capturedAt?.getTime() ?? 0)).toBeGreaterThan(USAGE_DECISION_MAX_AGE_MS);
    expect(now - (alpha?.capturedAt?.getTime() ?? 0)).toBeLessThan(USAGE_SYNC_TRUST_MS);

    const a = candidateFromSnap('2.1.1', alpha);
    a.usageKey = 'claude:org=alpha';
    const b = candidateFromSnap('2.1.2', beta);
    b.usageKey = 'claude:org=beta';
    expect(isUsageVerified(a, now)).toBe(true);
    expect(isUsageVerified(b, now)).toBe(true);

    const rotation = pickBalancedCandidate([a, b], now);
    expect(rotation).not.toBeNull();
    expect(rotation!.noVerifiedUsage).toBeFalsy();
    expect(rotation!.usageUnverified).toBe(false);
    expect(['2.1.1', '2.1.2']).toContain(rotation!.picked.version);
  });
});

describe('W3.1 / W3.4 worker with only setup tokens makes zero usage API calls', () => {
  it('buildLocalUsageAccounts returns [] on a worker, so runUsageRefresh fetches nothing', async () => {
    const listed = await buildLocalUsageAccounts({ role: 'worker', device: 'worker-a' });
    expect(listed).toEqual([]);

    let calls = 0;
    const result = await runUsageRefresh({
      listAccounts: async () => listed,
      writeUsageCache: () => { throw new Error('worker must not write usage'); },
      backoffUntil: () => null,
    });
    expect(calls).toBe(0);
    expect(result.refreshed).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('shouldPollUsageAccount: setup-token-only and peer-claimed accounts never poll', () => {
    expect(shouldPollUsageAccount(
      { usageKey: 'claude:org=a', holdsNativeLogin: true },
      { role: 'worker', selfDevice: 'worker-a' },
    )).toBe(false);
    expect(shouldPollUsageAccount(
      { usageKey: 'claude:org=a', holdsNativeLogin: false },
      { role: 'personal', selfDevice: 'zion' },
    )).toBe(false);
    expect(shouldPollUsageAccount(
      { usageKey: 'claude:org=a', holdsNativeLogin: true },
      { role: 'personal', selfDevice: 'yosemite-s1', claimedBy: { 'claude:org=a': 'zion' } },
    )).toBe(false);
    expect(shouldPollUsageAccount(
      { usageKey: 'claude:org=a', holdsNativeLogin: true },
      { role: 'personal', selfDevice: 'zion', claimedBy: { 'claude:org=a': 'zion' } },
    )).toBe(true);
  });

  it('mayIssueUsageEndpointProbe is false on a worker unless forceLive', () => {
    expect(mayIssueUsageEndpointProbe({ role: 'worker' })).toBe(false);
    expect(mayIssueUsageEndpointProbe({ role: undefined })).toBe(false);
    expect(mayIssueUsageEndpointProbe({ role: 'personal' })).toBe(true);
    expect(mayIssueUsageEndpointProbe({ role: 'worker', forceLive: true })).toBe(true);
  });
});

describe('W3.1 shared per-account usage/auth budget', () => {
  let cacheDir = '';
  let prevHeadroom: string | null = null;

  afterEach(() => {
    setHeadroomCachePathForTest(prevHeadroom);
    if (cacheDir) fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('trySpendUsageApiCall records calls and refuses past the hourly cap', () => {
    cacheDir = tempDir();
    prevHeadroom = setHeadroomCachePathForTest(path.join(cacheDir, '.usage-headroom.json'));
    const now = 1_800_000_000_000;
    for (let i = 0; i < HOURLY_CALL_CAP; i++) {
      expect(trySpendUsageApiCall('claude:org=a', 'claude', now + i)).toBe(true);
    }
    expect(trySpendUsageApiCall('claude:org=a', 'claude', now + HOURLY_CALL_CAP)).toBe(false);
  });

  it('auth and usage share the provider hourly budget', () => {
    cacheDir = tempDir();
    prevHeadroom = setHeadroomCachePathForTest(path.join(cacheDir, '.usage-headroom.json'));
    const now = 1_800_000_000_000;
    let spent = 0;
    for (let i = 0; i < PROVIDER_HOURLY_BUDGET + 5; i++) {
      const key = `claude:org=acct-${i}`;
      if (trySpendUsageApiCall(key, 'claude', now + i)) spent += 1;
    }
    expect(spent).toBe(PROVIDER_HOURLY_BUDGET);
  });
});

describe('W3.2 auth-sync and usage-sync do not starve each other on the shared lock', () => {
  it('kickoffs sit more than one git-exchange deadline apart, forever', () => {
    expect(USAGE_SYNC_TICK_MS).toBe(USAGE_SYNC_INTERVAL_MS);
    expect(USAGE_SYNC_TRUST_MS).toBe(USAGE_SYNC_INTERVAL_MS);
    expect(AUTH_SYNC_TICK_MS).toBe(USAGE_SYNC_INTERVAL_MS);
    const gap = Math.abs(USAGE_SYNC_KICKOFF_MS - AUTH_SYNC_KICKOFF_MS);
    expect(gap).toBeGreaterThan(FLEET_SHARED_REPO_SYNC_DEADLINE_MS);

    const horizon = 24 * 60 * 60_000;
    for (let t = 0; t <= horizon; t += 60_000) {
      const authFiring = (t - AUTH_SYNC_KICKOFF_MS) % AUTH_SYNC_TICK_MS === 0 && t >= AUTH_SYNC_KICKOFF_MS;
      const usageFiring = (t - USAGE_SYNC_KICKOFF_MS) % USAGE_SYNC_TICK_MS === 0 && t >= USAGE_SYNC_KICKOFF_MS;
      if (authFiring && usageFiring) {
        throw new Error(`auth-sync and usage-sync both fire at t=${t}`);
      }
    }
  });
});

describe('W3.2 poll write stamps poller provenance and push-on-change fires', () => {
  it('runUsageRefresh stamps freshness.source=poll and calls onSnapshotsChanged', async () => {
    const dir = tempDir();
    const prevHeadroom = setHeadroomCachePathForTest(path.join(dir, '.usage-headroom.json'));
    const prevUsage = setClaudeUsageCachePathForTest(path.join(dir, 'claude-usage.json'));
    const now = Date.now();
    let pushed: string[] = [];
    try {
      const result = await runUsageRefresh({
        now,
        listAccounts: async () => [{
          usageKey: 'claude:org=alpha',
          agentId: 'claude',
          fetch: async () => ({
            snapshot: {
              source: 'live',
              sourceLabel: 'live',
              capturedAt: new Date(now),
              windows: [{
                key: 'week', label: 'Week', shortLabel: 'W',
                usedPercent: 12, resetsAt: null, windowMinutes: 10_080,
              }],
            },
            error: null,
          }),
        }],
        writeUsageCache: writeClaudeUsageCache,
        backoffUntil: () => null,
        pollerDevice: 'zion',
        onSnapshotsChanged: async (keys) => { pushed = keys; },
      });
      expect(result.refreshed).toBe(1);
      expect(pushed).toEqual(['claude:org=alpha']);
      const snap = readClaudeUsageCache('claude:org=alpha', undefined, new Date(now));
      expect(snap?.freshness).toEqual({ source: 'poll', poller: 'zion' });
    } finally {
      setHeadroomCachePathForTest(prevHeadroom);
      setClaudeUsageCachePathForTest(prevUsage);
    }
  });
});
