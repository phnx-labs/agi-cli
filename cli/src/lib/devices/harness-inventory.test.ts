import { describe, expect, it } from 'vitest';

import type { UsageSnapshot, UsageWindow } from '../accounting/usage.js';
import { USAGE_NOT_COLLECTED_MARKER, usageErrorForDisplay } from '../accounting/usage.js';
import { usageHeadlessScopeError } from '../accounting/usage.js';
import {
  applyUsageHonesty,
  computeReady,
  formatQuota,
  groupByAccount,
  renderAccountsMatrix,
  renderAccountFleetMatrix,
  renderHarnessMatrix,
  summarizeObservedQuota,
  summarizeQuota,
  type HarnessRow,
  type QuotaSummary,
} from './harness-inventory.js';

/** Build a usage window; only `key` + `usedPercent` matter for these tests. */
function win(key: UsageWindow['key'], usedPercent: number): UsageWindow {
  return { key, label: key, shortLabel: key, usedPercent, resetsAt: null, windowMinutes: null };
}

function snapshot(windows: UsageWindow[], source: 'live' | 'last_seen' = 'live'): UsageSnapshot {
  return { source, sourceLabel: source, capturedAt: null, windows };
}

function quota(status: QuotaSummary['status'], usedPercent: number | null, stale = false): QuotaSummary {
  return {
    status,
    verdict: status ?? 'unavailable',
    usedPercent,
    stale,
    capturedAt: null,
    resetsAt: null,
    unavailableReason: status ? null : 'usage unavailable',
  };
}

/** A HarnessRow with sane defaults, overridable per test. */
function row(overrides: Partial<HarnessRow> = {}): HarnessRow {
  const quotaValue: QuotaSummary = overrides.quota ?? quota('available', 10);
  return {
    agent: 'claude',
    version: '1.0.0',
    account: 'a@ex.com',
    signedIn: true,
    quota: quotaValue,
    ready: true,
    verdict: 'live',
    fix: null,
    snapshot: null,
    usageError: null,
    ...overrides,
  };
}

describe('summarizeQuota', () => {

  it('an out_of_credits marker blocks readiness even with no live windows (RUSH-3018)', () => {
    // The normal state hours/days after a run: cached windows have expired, so
    // only the persisted refusal marker remains. It must NOT read as available.
    const snap: UsageSnapshot = {
      source: 'live', sourceLabel: 'live', capturedAt: null, windows: [],
      unavailable: { reason: 'out_of_credits' },
    };
    // accountStatus 'available' is the coarse hardcoded value for a signed-in Claude.
    const q = summarizeQuota(snap, null, 'available');
    expect(q.status).toBe('out_of_credits');
    expect(computeReady(true, q)).toEqual({ ready: false, reason: 'out of credits' });
  });

  it('an unexpired session_limit marker with no windows blocks; an expired one does not', () => {
    const future: UsageSnapshot = {
      source: 'live', sourceLabel: 'live', capturedAt: null, windows: [],
      unavailable: { reason: 'session_limit', resetsAt: new Date(Date.now() + 3600_000) },
    };
    expect(summarizeQuota(future, null, 'available').status).toBe('rate_limited');
    const past: UsageSnapshot = {
      source: 'live', sourceLabel: 'live', capturedAt: null, windows: [],
      unavailable: { reason: 'session_limit', resetsAt: new Date(Date.now() - 1000) },
    };
    // expired marker → falls through to the coarse available status
    expect(summarizeQuota(past, null, 'available').status).toBe('available');
  });
  it('returns null status and no percent when there is no snapshot', () => {
    expect(summarizeQuota(null)).toEqual(quota(null, null));
    expect(summarizeQuota(snapshot([]))).toEqual(quota(null, null));
  });

  it('takes the highest utilization across blocking windows', () => {
    const q = summarizeQuota(snapshot([win('session', 12), win('week', 47)]));
    expect(q.usedPercent).toBe(47);
    expect(q.status).toBe('available');
  });

  it('rounds the percent', () => {
    expect(summarizeQuota(snapshot([win('session', 12.6)])).usedPercent).toBe(13);
  });

  it('excludes the sonnet_week sub-limit from the account-wide utilization', () => {
    // A maxed model sub-limit must not read as a throttled account.
    const q = summarizeQuota(snapshot([win('session', 20), win('sonnet_week', 100)]));
    expect(q.usedPercent).toBe(20);
    expect(q.status).toBe('available');
  });

  it('reports rate_limited when a blocking window is at 100%', () => {
    expect(summarizeQuota(snapshot([win('week', 100)])).status).toBe('rate_limited');
  });

  it('marks a cached (last_seen) snapshot stale', () => {
    expect(summarizeQuota(snapshot([win('session', 5)], 'last_seen')).stale).toBe(true);
  });

  it('never shows 100% for an account that is not actually capped', () => {
    // 99.6 rounds to 100, but the account is still `available` (a true 100 window
    // would flip status to rate_limited) — so the display caps at 99 to avoid a
    // "100%" cell next to a "ready" verdict.
    const q = summarizeQuota(snapshot([win('session', 99.6)]));
    expect(q.status).toBe('available');
    expect(q.usedPercent).toBe(99);
  });

  it('exposes verdict, capture time, earliest reset, and no unavailable reason', () => {
    const capturedAt = new Date('2026-08-10T10:00:00.000Z');
    const later = new Date('2026-08-11T10:00:00.000Z');
    const earlier = new Date('2026-08-10T12:00:00.000Z');
    const snap = snapshot([
      { ...win('session', 20), resetsAt: later },
      { ...win('week', 40), resetsAt: earlier },
    ]);
    snap.capturedAt = capturedAt;
    expect(summarizeQuota(snap)).toMatchObject({
      verdict: 'available',
      capturedAt: capturedAt.toISOString(),
      resetsAt: earlier.toISOString(),
      unavailableReason: null,
    });
  });

  it('preserves account-level out_of_credits without a usage snapshot', () => {
    expect(summarizeQuota(null, null, 'out_of_credits')).toEqual({
      ...quota('out_of_credits', null),
      unavailableReason: null,
    });
  });

  it('returns an explicit provider error when quota is unavailable', () => {
    expect(summarizeQuota(null, 'provider timed out')).toMatchObject({
      verdict: 'unavailable',
      unavailableReason: 'provider timed out',
    });
  });

  it('never surfaces the internal not-collected sentinel — the caller normalizes it (PHNX-3348)', () => {
    // collectLocalHarnessInventory feeds `usageErrorForDisplay(usage?.error)` into
    // summarizeQuota, so a never-cached account (error === 'stale', without
    // --refresh) can never reach `agents devices harnesses/accounts --json`'s
    // `quota.unavailableReason` as the raw sentinel — the same leak class PHNX-3348
    // fixed for `agents view --json`.
    const q = summarizeQuota(null, usageErrorForDisplay(USAGE_NOT_COLLECTED_MARKER));
    expect(q.unavailableReason).not.toBe(USAGE_NOT_COLLECTED_MARKER);
    expect(q.unavailableReason).not.toBe('stale');
    expect(q.unavailableReason).toContain('not collected');
  });
});

describe('summarizeObservedQuota', () => {
  it('renders a worker scope refusal as unverified usage, never no credits', () => {
    const observed = summarizeObservedQuota(
      null,
      usageHeadlessScopeError(),
      'out_of_credits',
    );
    expect(observed.unverified).toBe(true);
    expect(observed.quota.status).toBeNull();
    expect(observed.quota.verdict).toBe('unavailable');
    expect(formatQuota(observed.quota)).toBe('—');
  });

  it('does not hide an expired or revoked auth failure behind a usage-scope 403', () => {
    const observed = summarizeObservedQuota(null, usageHeadlessScopeError(), 'out_of_credits');
    expect(applyUsageHonesty('expired', observed.quota).verdict).toBe('expired');
    expect(applyUsageHonesty('revoked', observed.quota).verdict).toBe('revoked');
    expect(applyUsageHonesty('live', observed.quota).verdict).toBe('unverified');
  });
});

describe('computeReady', () => {
  it('is not ready and reasons "signed out" when signed out', () => {
    expect(computeReady(false, quota(null, null))).toEqual({
      ready: false,
      reason: 'signed out',
    });
  });

  it('is not ready and reasons "rate-limited" when throttled', () => {
    expect(computeReady(true, quota('rate_limited', 100))).toEqual({
      ready: false,
      reason: 'rate-limited',
    });
  });

  it('is not ready when the account is out of credits', () => {
    expect(computeReady(true, quota('out_of_credits', null))).toEqual({
      ready: false,
      reason: 'out of credits',
    });
  });

  it('is ready when signed in and not throttled — even with no quota data', () => {
    expect(computeReady(true, quota(null, null))).toEqual({ ready: true });
    expect(computeReady(true, quota('available', 30))).toEqual({ ready: true });
  });
});

describe('formatQuota', () => {
  it('renders limited / percent / dash, marking cached with *', () => {
    expect(formatQuota(quota('rate_limited', 100))).toBe('limited');
    expect(formatQuota(quota('available', 42))).toBe('42%');
    expect(formatQuota(quota('available', 42, true))).toBe('42%*');
    expect(formatQuota(quota(null, null))).toBe('—');
  });
});

describe('groupByAccount', () => {
  it('collapses installs that share one account into a single row', () => {
    const rows = [
      row({ agent: 'claude', version: '1.0.0', account: 'me@ex.com' }),
      row({ agent: 'claude', version: '1.1.0', account: 'me@ex.com' }),
      row({ agent: 'codex', version: '0.1.0', account: 'work@ex.com' }),
    ];
    const groups = groupByAccount(rows);
    expect(groups).toHaveLength(2);
    const me = groups.find((g) => g.account === 'me@ex.com')!;
    expect(me.installs).toBe(2);
    expect(me.agents).toEqual(['claude']);
    expect(me.signedIn).toBe(true);
  });

  it('buckets signed-out installs under a null account', () => {
    const groups = groupByAccount([
      row({ account: null, signedIn: false, ready: false, reason: 'signed out' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].account).toBeNull();
    expect(groups[0].signedIn).toBe(false);
    expect(groups[0].ready).toBe(false);
  });

  it('does not merge a real account labelled "signed-out" into the signed-out bucket', () => {
    const groups = groupByAccount([
      row({ agent: 'claude', version: '1', account: 'signed-out', signedIn: true, ready: true }),
      row({ agent: 'codex', version: '2', account: null, signedIn: false, ready: false, reason: 'signed out' }),
    ]);
    // The NUL-prefixed sentinel keeps the two apart: a real label 'signed-out'
    // (signed in) never collides with the null signed-out bucket.
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.account === 'signed-out')?.signedIn).toBe(true);
    expect(groups.find((g) => g.account === null)?.signedIn).toBe(false);
  });

  it('surfaces a throttled member so a rate-limit is never hidden by an available sibling', () => {
    const groups = groupByAccount([
      row({ agent: 'droid', version: '1', account: 'x@ex.com', quota: quota('available', 5) }),
      row({ agent: 'droid', version: '2', account: 'x@ex.com', quota: quota('rate_limited', 100), ready: false, reason: 'rate-limited' }),
    ]);
    expect(groups[0].quota.status).toBe('rate_limited');
    expect(groups[0].ready).toBe(false);
    expect(groups[0].reason).toBe('rate-limited');
  });

  it('collects distinct agent ids sorted', () => {
    const groups = groupByAccount([
      row({ agent: 'codex', account: 'shared@ex.com' }),
      row({ agent: 'claude', account: 'shared@ex.com' }),
      row({ agent: 'claude', version: '2', account: 'shared@ex.com' }),
    ]);
    expect(groups[0].agents).toEqual(['claude', 'codex']);
    expect(groups[0].installs).toBe(3);
  });
});

describe('renderHarnessMatrix', () => {
  it('groups rows under each device and shows account / signed / quota / ready', () => {
    const out = renderHarnessMatrix([
      { host: 'zion', rows: [row({ agent: 'claude', version: '1.2.3', account: 'me@ex.com', quota: quota('available', 12) })] },
    ]).join('\n');
    expect(out).toContain('Fleet harnesses');
    expect(out).toContain('zion');
    expect(out).toContain('claude@1.2.3');
    expect(out).toContain('me@ex.com');
    expect(out).toContain('12%');
    expect(out).toContain('ready');
  });

  it('shows a signed-out install with its reason, not "ready"', () => {
    const out = renderHarnessMatrix([
      { host: 'box', rows: [row({ signedIn: false, account: null, ready: false, reason: 'signed out', quota: quota(null, null) })] },
    ]).join('\n');
    expect(out).toContain('signed out');
  });

  it('notes an offline / skipped host instead of rows', () => {
    const out = renderHarnessMatrix([
      { host: 'sleepy', rows: [], skipped: 'offline' },
      { host: 'broken', rows: [], error: 'timed out' },
      { host: 'bare', rows: [] },
    ]).join('\n');
    expect(out).toContain('offline');
    expect(out).toContain('timed out');
    expect(out).toContain('no harnesses installed');
  });
});

describe('renderAccountsMatrix', () => {
  it('renders one row per account with its harnesses', () => {
    const out = renderAccountsMatrix([
      {
        host: 'mac-mini',
        rows: [
          row({ agent: 'claude', version: '1', account: 'me@ex.com' }),
          row({ agent: 'claude', version: '2', account: 'me@ex.com' }),
          row({ agent: 'codex', version: '1', account: 'work@ex.com' }),
        ],
      },
    ]).join('\n');
    expect(out).toContain('Fleet accounts');
    expect(out).toContain('mac-mini');
    expect(out).toContain('me@ex.com');
    expect(out).toContain('work@ex.com');
    // collapsed: one 'me@ex.com' row, not two
    expect(out.match(/me@ex\.com/g)?.length).toBe(1);
  });
});

describe('renderAccountFleetMatrix', () => {
  it('names devices whose daemon-state carries no account verdicts', () => {
    const out = renderAccountFleetMatrix(
      [{
        harness: 'claude',
        name: 'work',
        identityLabel: 'w@example.com',
        devices: [{ device: 'zion', verdict: 'live' }],
      }],
      { uncoveredDevices: ['mac-mini', 'worker-1'] },
    ).join('\n');
    expect(out).toContain('zion');
    expect(out).toContain('LIVE');
    expect(out).not.toMatch(/^\s*mac-mini\s*$/m);
    expect(out).toContain('mac-mini, worker-1: daemon-state carries no account verdicts (older release)');
  });

  it('renders accounts as rows and daemon-observed devices as columns', () => {
    const out = renderAccountFleetMatrix([
      {
        harness: 'claude',
        name: 'work',
        identityLabel: 'w@example.com',
        devices: [
          { device: 'laptop', verdict: 'live' },
          { device: 'worker-1', verdict: 'expired' },
        ],
      },
    ]).join('\n');
    expect(out).toContain('ACCOUNT');
    expect(out).toContain('laptop');
    expect(out).toContain('worker-1');
    expect(out).toContain('claude#work w@example.com');
    expect(out).toContain('LIVE');
    expect(out).toContain('EXPIRED');
  });
});
