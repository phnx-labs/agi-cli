import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountInfo } from '../agents.js';
import { ALL_AGENT_IDS } from '../agents.js';
import * as state from '../state.js';
import {
  agentReportsUsage,
  buildCanonicalUsageContext,
  deriveUsageStatusFromSnapshot,
  formatUsageSummary,
  formatUsageStatusBadge,
  getUsageInfo,
  getClaudeKeychainService,
  loadClaudeOauth,
  getUsageInfoForIdentity,
  readClaudeUsageCache,
  isClaudeUsageOrgMatch,
  writeClaudeUsageCache,
  normalizeKimiWindows,
  formatKimiPlan,
  normalizeDroidWindows,
  normalizeCursorUsage,
  normalizeCursorPeriodUsage,
  normalizeCursorUsageSummary,
  antigravityModelShortLabel,
  antigravityTokenNeedsRefresh,
  normalizeAntigravityWindows,
  parseAntigravityOauthPayload,
  pickCompactUsageWindows,
  USAGE_SOURCE_AGENT_IDS,
  USAGE_FETCH_CONCURRENCY,
  type DroidBillingLimitsResponse,
  type KimiUsagesResponse,
  type UsageSnapshot,
  type UsageWindow,
} from '../accounting/usage.js';
import { deleteKeychainTokenSync, setKeychainTokenSync } from '../secrets-client.js';
import { standaloneKeychainIsFileBacked, useFreshSecretsHome } from '../../../tests/secrets-standalone.js';

const fileBacked = await standaloneKeychainIsFileBacked();

function makeAccountInfo(overrides: Partial<AccountInfo> = {}): AccountInfo {
  return {
    accountKey: null,
    usageKey: null,
    accountId: null,
    organizationId: null,
    userId: null,
    email: null,
    plan: null,
    usageStatus: null,
    overageCredits: null,
    lastActive: null,
    signedIn: false,
    ...overrides,
  };
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

describe('usage formatting', () => {
  it('renders compact S:/W: bars and skips the sonnet-only window', () => {
    const snapshot: UsageSnapshot = {
      source: 'live',
      sourceLabel: 'live account data',
      capturedAt: new Date('2026-04-17T12:00:00Z'),
      windows: [
        {
          key: 'session',
          label: 'Current session',
          shortLabel: 'S',
          usedPercent: 40,
          resetsAt: null,
          windowMinutes: 300,
        },
        {
          key: 'week',
          label: 'Current week',
          shortLabel: 'W',
          usedPercent: 80,
          resetsAt: null,
          windowMinutes: 10080,
        },
        {
          key: 'sonnet_week',
          label: 'Current week (Sonnet only)',
          shortLabel: 'So',
          usedPercent: 55,
          resetsAt: null,
          windowMinutes: 10080,
        },
      ],
    };

    const summary = stripAnsi(formatUsageSummary(null, snapshot));

    expect(summary).toContain('S:');
    expect(summary).toContain('W:');
    expect(summary).not.toContain('So:');
  });

  it('appends the exact percentage and a compact reset hint to each bar', () => {
    const snapshot: UsageSnapshot = {
      source: 'live',
      sourceLabel: 'live account data',
      capturedAt: new Date(),
      windows: [
        {
          key: 'session',
          label: 'Current session',
          shortLabel: 'S',
          usedPercent: 34,
          resetsAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
          windowMinutes: 300,
        },
        {
          key: 'week',
          label: 'Current week',
          shortLabel: 'W',
          usedPercent: 58,
          resetsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
          windowMinutes: 10080,
        },
      ],
    };
    const summary = stripAnsi(formatUsageSummary(null, snapshot));
    expect(summary).toContain('S:');
    expect(summary).toContain('34% (2h)');
    expect(summary).toContain('58% (3d)');
  });

  it('shows "usage unavailable" only when the opt is set and there is no snapshot', () => {
    expect(stripAnsi(formatUsageSummary('Max', null, 3, { unavailable: true })))
      .toContain('usage unavailable');
    expect(stripAnsi(formatUsageSummary('Max', null, 3))).not.toContain('usage unavailable');
    const snapshot: UsageSnapshot = {
      source: 'live',
      sourceLabel: 'live account data',
      capturedAt: new Date(),
      windows: [{ key: 'session', label: 'S', shortLabel: 'S', usedPercent: 0, resetsAt: null, windowMinutes: 300 }],
    };
    expect(stripAnsi(formatUsageSummary('Max', snapshot, 3, { unavailable: true })))
      .not.toContain('usage unavailable');
  });

  it('caps overview meters so multi-window agents cannot blow out column width', () => {
    const snapshot: UsageSnapshot = {
      source: 'live',
      sourceLabel: 'live',
      capturedAt: new Date(),
      windows: [
        { key: 'session', label: 'S', shortLabel: 'S', usedPercent: 10, resetsAt: null, windowMinutes: null },
        { key: 'week', label: 'W', shortLabel: 'W', usedPercent: 20, resetsAt: null, windowMinutes: null },
        { key: 'month', label: 'M', shortLabel: 'M', usedPercent: 90, resetsAt: null, windowMinutes: null },
        { key: 'sonnet_week', label: 'So', shortLabel: 'So', usedPercent: 50, resetsAt: null, windowMinutes: null },
      ],
    };
    const picked = pickCompactUsageWindows(snapshot.windows, 2);
    expect(picked.map((w) => w.shortLabel)).toEqual(['S', 'W']);

    const summary = stripAnsi(formatUsageSummary(null, snapshot, 3, { maxWindows: 2 }));
    expect(summary).toContain('S:');
    expect(summary).toContain('W:');
    expect(summary).toContain('+1');
    expect(summary).not.toContain('M:');
    expect(summary).not.toContain('So:');
  });

  it('still fills maxWindows when every window shares key: session (Antigravity)', () => {
    const windows: UsageWindow[] = [
      { key: 'session', label: '2.5F', shortLabel: '2.5F', usedPercent: 10, resetsAt: null, windowMinutes: null },
      { key: 'session', label: '2.5FL', shortLabel: '2.5FL', usedPercent: 20, resetsAt: null, windowMinutes: null },
      { key: 'session', label: '2.5P', shortLabel: '2.5P', usedPercent: 90, resetsAt: null, windowMinutes: null },
      { key: 'session', label: '3.1FL', shortLabel: '3.1FL', usedPercent: 5, resetsAt: null, windowMinutes: null },
    ];
    const picked = pickCompactUsageWindows(windows, 2);
    expect(picked.map((w) => w.shortLabel)).toEqual(['2.5F', '2.5P']);
    const summary = stripAnsi(formatUsageSummary(null, {
      source: 'live', sourceLabel: 'live', capturedAt: new Date(), windows,
    }, 3, { maxWindows: 2 }));
    expect(summary).toContain('+2');
  });

  it('prefers highest utilization when session/week are absent', () => {
    const windows: UsageWindow[] = [
      { key: 'month', label: 'A', shortLabel: 'A', usedPercent: 10, resetsAt: null, windowMinutes: null },
      { key: 'month', label: 'B', shortLabel: 'B', usedPercent: 95, resetsAt: null, windowMinutes: null },
      { key: 'month', label: 'C', shortLabel: 'C', usedPercent: 40, resetsAt: null, windowMinutes: null },
    ];
    const picked = pickCompactUsageWindows(windows, 2);
    expect(picked.map((w) => w.shortLabel)).toEqual(['B', 'C']);
  });

  it('pins bounded fetch concurrency', () => {
    expect(USAGE_FETCH_CONCURRENCY).toBe(3);
  });

  it('pins the complete usage source registry and derives support from it', () => {
    expect(USAGE_SOURCE_AGENT_IDS).toEqual(['claude', 'codex', 'kimi', 'droid', 'grok', 'cursor', 'antigravity', 'muse']);
    for (const agentId of ALL_AGENT_IDS) {
      expect(agentReportsUsage(agentId)).toBe(USAGE_SOURCE_AGENT_IDS.includes(agentId as never));
    }
  });

  it('normalizeCursorUsage builds a monthly request bar for request-capped plans', () => {
    const windows = normalizeCursorUsage({
      'gpt-4': { numRequests: 120, maxRequestUsage: 500 },
      startOfMonth: '2026-07-22T11:35:59.000Z',
    });
    expect(windows).toHaveLength(1);
    expect(windows[0]?.key).toBe('month');
    expect(windows[0]?.shortLabel).toBe('M');
    expect(windows[0]?.usedPercent).toBe(24);
    expect(windows[0]?.resetsAt?.toISOString()).toBe(new Date('2026-08-22T11:35:59.000Z').toISOString());
  });

  it('normalizeCursorUsage clamps a month-end reset instead of overflowing into the next month', () => {
    const [w] = normalizeCursorUsage({
      'gpt-4': { numRequests: 10, maxRequestUsage: 100 },
      startOfMonth: '2026-01-31T12:00:00.000Z',
    });
    expect(w?.resetsAt?.getMonth()).toBe(1);
    expect(w?.resetsAt?.getDate()).toBeGreaterThanOrEqual(28);
  });

  it('normalizeCursorUsage returns no window for usage-based plans (no request cap)', () => {
    expect(
      normalizeCursorUsage({
        'gpt-4': { numRequests: 0, numRequestsTotal: 0, maxRequestUsage: null } as never,
        startOfMonth: '2026-07-22T11:35:59.000Z',
      })
    ).toEqual([]);
    expect(normalizeCursorUsage({ startOfMonth: '2026-07-22T11:35:59.000Z' })).toEqual([]);
    expect(normalizeCursorUsage({})).toEqual([]);
  });

  it('normalizeCursorPeriodUsage maps the primary Auto/API/Total breakdown to three windows', () => {
    const windows = normalizeCursorPeriodUsage({
      billingCycleEnd: '2026-08-22T11:35:59.000Z',
      planUsage: { autoPercentUsed: 13.21, apiPercentUsed: 3.16, totalPercentUsed: 10.19 },
    });
    expect(windows).toHaveLength(3);
    expect(windows[0]).toMatchObject({ key: 'session', shortLabel: 'A', label: 'Auto + Composer', usedPercent: 13.21 });
    expect(windows[1]).toMatchObject({ key: 'week', shortLabel: 'API', label: 'API', usedPercent: 3.16 });
    expect(windows[2]).toMatchObject({ key: 'month', shortLabel: 'T', label: 'Total', usedPercent: 10.19 });
    for (const window of windows) {
      expect(window.resetsAt?.toISOString()).toBe(new Date('2026-08-22T11:35:59.000Z').toISOString());
    }
  });

  it('normalizeCursorPeriodUsage accepts a unix-ms string billingCycleEnd and drops non-finite percents', () => {
    const windows = normalizeCursorPeriodUsage({
      billingCycleEnd: '1771077734000',
      planUsage: { autoPercentUsed: 0, apiPercentUsed: null, totalPercentUsed: 15.48 },
    });
    expect(windows).toHaveLength(2);
    expect(windows.map((w) => w.key)).toEqual(['session', 'month']);
    expect(windows[0]?.resetsAt?.toISOString()).toBe(new Date(1771077734000).toISOString());
  });

  it('normalizeCursorPeriodUsage returns no windows for a missing/empty planUsage', () => {
    expect(normalizeCursorPeriodUsage({ billingCycleEnd: '2026-08-22T11:35:59.000Z' })).toEqual([]);
    expect(normalizeCursorPeriodUsage({})).toEqual([]);
  });

  it('normalizeCursorUsageSummary maps the fallback individualUsage.plan breakdown', () => {
    const windows = normalizeCursorUsageSummary({
      isUnlimited: false,
      billingCycleEnd: '2026-05-02T14:11:55.000Z',
      individualUsage: { plan: { autoPercentUsed: 0, apiPercentUsed: 100, totalPercentUsed: 100 } },
    });
    expect(windows).toHaveLength(3);
    expect(windows[0]).toMatchObject({ key: 'session', shortLabel: 'A', usedPercent: 0 });
    expect(windows[1]).toMatchObject({ key: 'week', shortLabel: 'API', usedPercent: 100 });
    expect(windows[2]).toMatchObject({ key: 'month', shortLabel: 'T', usedPercent: 100 });
    expect(windows[0]?.resetsAt?.toISOString()).toBe(new Date('2026-05-02T14:11:55.000Z').toISOString());
  });

  it('normalizeCursorUsageSummary returns no windows for an unlimited plan with no usable percents', () => {
    expect(
      normalizeCursorUsageSummary({
        isUnlimited: true,
        billingCycleEnd: '2026-05-02T14:11:55.000Z',
        individualUsage: { plan: {} },
      })
    ).toEqual([]);
    expect(normalizeCursorUsageSummary({ isUnlimited: true })).toEqual([]);
    expect(normalizeCursorUsageSummary({})).toEqual([]);
  });

  it('parseAntigravityOauthPayload reads the raw JSON and the go-keyring-base64 wrapper', () => {
    const raw = JSON.stringify({
      token: { access_token: 'ya29.x', refresh_token: 'rt', expiry: '2026-08-01T21:06:25Z' },
      auth_method: 'consumer',
    });
    expect(parseAntigravityOauthPayload(raw)).toEqual({
      access_token: 'ya29.x',
      refresh_token: 'rt',
      expiry: '2026-08-01T21:06:25Z',
    });

    const wrapped = `go-keyring-base64:${Buffer.from(raw, 'utf-8').toString('base64')}`;
    expect(parseAntigravityOauthPayload(wrapped)?.refresh_token).toBe('rt');

    expect(parseAntigravityOauthPayload('not json')).toBeNull();
    expect(parseAntigravityOauthPayload('{}')).toBeNull();
    expect(parseAntigravityOauthPayload(JSON.stringify({ token: {} }))).toBeNull();
  });

  it('antigravityTokenNeedsRefresh gates on the RFC3339 expiry with a leeway', () => {
    const now = Date.parse('2026-08-03T06:00:00Z');
    expect(antigravityTokenNeedsRefresh('2026-08-03T07:00:00Z', now)).toBe(false);
    expect(antigravityTokenNeedsRefresh('2026-08-03T06:00:30Z', now)).toBe(true);
    expect(antigravityTokenNeedsRefresh('2026-08-01T21:06:25Z', now)).toBe(true);
    expect(antigravityTokenNeedsRefresh(null, now)).toBe(false);
    expect(antigravityTokenNeedsRefresh('not-a-date', now)).toBe(false);
  });

  it('antigravityModelShortLabel compacts gemini model ids', () => {
    expect(antigravityModelShortLabel('gemini-2.5-flash-lite')).toBe('2.5FL');
    expect(antigravityModelShortLabel('gemini-2.5-pro')).toBe('2.5P');
    expect(antigravityModelShortLabel('gemini-3.1-flash-lite')).toBe('3.1FL');
    expect(antigravityModelShortLabel('custom-model')).toBe('customM');
  });

  it('normalizeAntigravityWindows builds one bar per model, most-used first', () => {
    const windows = normalizeAntigravityWindows([
      { modelId: 'gemini-2.5-flash', tokenType: 'REQUESTS', remainingFraction: 1, resetTime: '2026-08-04T07:07:52Z' },
      { modelId: 'gemini-3.1-pro', tokenType: 'REQUESTS', remainingFraction: 0.42, resetTime: '2026-08-04T07:07:52Z' },
      { modelId: 'gemini-3.1-pro', tokenType: 'REQUESTS', remainingFraction: 0.5, resetTime: '2026-08-04T07:07:52Z' },
      { modelId: 'gemini-2.5-pro', remainingFraction: 0 },
      { modelId: null, remainingFraction: 0.5 },
      { modelId: 'gemini-2.5-flash-lite' },
    ]);

    expect(windows.map((w) => w.label)).toEqual(['gemini-2.5-pro', 'gemini-3.1-pro', 'gemini-2.5-flash']);
    const pro = windows.find((w) => w.label === 'gemini-3.1-pro');
    expect(pro?.usedPercent).toBeCloseTo(58, 5);
    expect(pro?.shortLabel).toBe('3.1P');
    expect(pro?.key).toBe('session');
    expect(pro?.resetsAt?.toISOString()).toBe('2026-08-04T07:07:52.000Z');
    expect(pro?.windowMinutes).toBeNull();
    expect(windows[0]?.usedPercent).toBe(100);
  });

  it('getUsageInfo(antigravity) reports a specific no-credential error, not silent null (RUSH-3040)', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-agy-usage-'));
    const prev = process.env.AGENTS_NO_KEYCHAIN_PROBE;
    const prevRealHome = process.env.AGENTS_REAL_HOME;
    process.env.AGENTS_NO_KEYCHAIN_PROBE = '1';
    process.env.AGENTS_REAL_HOME = home;
    try {
      const info = await getUsageInfo('antigravity', { home });
      expect(info.snapshot).toBeNull();
      expect(info.error).toContain('No readable Antigravity credential');
    } finally {
      if (prev === undefined) delete process.env.AGENTS_NO_KEYCHAIN_PROBE;
      else process.env.AGENTS_NO_KEYCHAIN_PROBE = prev;
      if (prevRealHome === undefined) delete process.env.AGENTS_REAL_HOME;
      else process.env.AGENTS_REAL_HOME = prevRealHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('parses Grok usage from the local unified.jsonl (real log shape)', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-grok-usage-'));
    try {
      const logDir = path.join(home, '.grok', 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      const periodEnd = new Date(now + 6 * day).toISOString();
      const lines = [
        JSON.stringify({
          ts: new Date(now - 2 * day).toISOString(),
          msg: 'billing: fetched credits config',
          ctx: {
            config: {
              creditUsagePercent: 10,
              currentPeriod: { end: new Date(now - day).toISOString() },
            },
            subscriptionTier: 'X Premium',
          },
        }),
        JSON.stringify({
          ts: new Date(now - 60_000).toISOString(),
          src: 'shell',
          lvl: 'info',
          msg: 'billing: fetched credits config',
          ctx: {
            config: {
              creditUsagePercent: 100.0,
              currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: periodEnd },
              isUnifiedBillingUser: true,
            },
            subscriptionTier: 'X Premium+',
          },
        }),
      ];
      fs.writeFileSync(path.join(logDir, 'unified.jsonl'), `${lines.join('\n')}\n`);

      const { snapshot, error } = await getUsageInfo('grok', { home });
      expect(error).toBeNull();
      expect(snapshot?.plan).toBe('X Premium+');
      const week = snapshot?.windows.find((w) => w.key === 'week');
      expect(week?.shortLabel).toBe('W');
      expect(week?.usedPercent).toBe(100);
      expect(week?.resetsAt?.toISOString()).toBe(new Date(periodEnd).toISOString());
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('drops an expired Grok billing window from the real log shape', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-grok-expired-'));
    try {
      const logDir = path.join(home, '.grok', 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(
        path.join(logDir, 'unified.jsonl'),
        `${JSON.stringify({
          ts: '2026-08-02T04:00:49.628Z',
          msg: 'billing: fetched credits config',
          ctx: {
            config: {
              creditUsagePercent: 100.0,
              currentPeriod: {
                type: 'USAGE_PERIOD_TYPE_WEEKLY',
                end: '2026-08-02T18:27:00.269749+00:00',
              },
            },
            subscriptionTier: 'X Premium+',
          },
        })}\n`
      );

      const { snapshot, error } = await getUsageInfo('grok', { home });
      expect(error).toBeNull();
      expect(snapshot?.plan).toBe('X Premium+');
      expect(snapshot?.windows).toEqual([]);
      expect(deriveUsageStatusFromSnapshot(snapshot)).toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('returns a benign no-recent-usage state when the log is absent (RUSH-3040)', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-grok-nolog-'));
    try {
      const { snapshot, error } = await getUsageInfo('grok', { home });
      expect(snapshot).toBeNull();
      expect(error).toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('formatUsageStatusBadge renders only for throttled states', () => {
    expect(formatUsageStatusBadge(null)).toBe('');
    expect(formatUsageStatusBadge('available')).toBe('');
    expect(stripAnsi(formatUsageStatusBadge('rate_limited'))).toBe('rate-limited');
    expect(stripAnsi(formatUsageStatusBadge('out_of_credits'))).toBe('out of credits');
  });
});

describe('deriveUsageStatusFromSnapshot', () => {
  function win(key: UsageWindow['key'], usedPercent: number): UsageWindow {
    return {
      key,
      label: key,
      shortLabel: key === 'week' ? 'W' : key === 'session' ? 'S' : 'So',
      usedPercent,
      resetsAt: null,
      windowMinutes: null,
    };
  }
  function snap(windows: UsageWindow[]): UsageSnapshot {
    return { source: 'live', sourceLabel: 'live account data', capturedAt: new Date('2026-04-17T12:00:00Z'), windows };
  }

  it('returns null when there is no snapshot or no windows', () => {
    expect(deriveUsageStatusFromSnapshot(null)).toBeNull();
    expect(deriveUsageStatusFromSnapshot(undefined)).toBeNull();
    expect(deriveUsageStatusFromSnapshot(snap([]))).toBeNull();
  });

  it('is available when every blocking window is below 100%', () => {
    expect(deriveUsageStatusFromSnapshot(snap([win('session', 5), win('week', 5)]))).toBe('available');
  });

  it('is rate_limited when any blocking window is maxed', () => {
    expect(deriveUsageStatusFromSnapshot(snap([win('session', 100), win('week', 40)]))).toBe('rate_limited');
    expect(deriveUsageStatusFromSnapshot(snap([win('session', 10), win('week', 100)]))).toBe('rate_limited');
  });

  it('ignores a maxed sonnet_week sub-limit when other windows are fine', () => {
    expect(
      deriveUsageStatusFromSnapshot(snap([win('session', 10), win('week', 20), win('sonnet_week', 100)]))
    ).toBe('available');
  });

  it('does not regress to "out of credits" for a usable account with overage disabled', () => {
    expect(deriveUsageStatusFromSnapshot(snap([win('session', 2), win('week', 5)]))).toBe('available');
  });
});

describe('usage identity deduping', () => {
  it('keeps only the freshest version home per usage identity', () => {
    const older = makeAccountInfo({
      usageKey: 'claude:org=shared',
      accountKey: 'claude:account=one',
      organizationId: 'org-old',
      plan: 'Pro',
      lastActive: new Date('2026-04-17T10:00:00Z'),
    });
    const newer = makeAccountInfo({
      usageKey: 'claude:org=shared',
      accountKey: 'claude:account=two',
      organizationId: 'org-new',
      plan: 'Max',
      lastActive: new Date('2026-04-17T11:00:00Z'),
    });
    const fallback = makeAccountInfo({
      usageKey: null,
      accountKey: 'codex:account=fallback',
      organizationId: 'org-codex',
      lastActive: new Date('2026-04-17T09:00:00Z'),
    });

    const { canonicalByUsageKey, usageFetchInputs } = buildCanonicalUsageContext([
      {
        agentId: 'claude',
        home: '/tmp/old',
        cliVersion: '2.1.80',
        info: older,
      },
      {
        agentId: 'claude',
        home: '/tmp/new',
        cliVersion: '2.1.98',
        info: newer,
      },
      {
        agentId: 'codex',
        home: '/tmp/codex',
        cliVersion: '0.113.0',
        info: fallback,
      },
    ]);

    expect(canonicalByUsageKey.size).toBe(2);
    expect(canonicalByUsageKey.get('claude:org=shared')).toEqual(newer);
    expect(canonicalByUsageKey.get('codex:account=fallback')).toEqual(fallback);
    expect(usageFetchInputs.get('claude:org=shared')).toEqual({
      agentId: 'claude',
      home: '/tmp/new',
      cliVersion: '2.1.98',
      organizationId: 'org-new',
    });
    expect(usageFetchInputs.get('codex:account=fallback')).toEqual({
      agentId: 'codex',
      home: '/tmp/codex',
      cliVersion: '0.113.0',
      organizationId: 'org-codex',
    });
  });
});

describe('Claude usage scoping', () => {
  useFreshSecretsHome();

  it('uses the shared keychain service without a managed home', () => {
    expect(getClaudeKeychainService()).toBe('Claude Code-credentials');
  });

  it('derives distinct keychain services for distinct Claude homes', () => {
    const first = getClaudeKeychainService('/tmp/claude-a');
    const second = getClaudeKeychainService('/tmp/claude-b');

    expect(first).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
    expect(second).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
    expect(first).not.toBe(second);
  });

  it('does not reuse the shared keychain service for managed Claude homes', () => {
    expect(getClaudeKeychainService('/tmp/claude-a')).not.toBe('Claude Code-credentials');
  });

  it.skipIf(!fileBacked)('ignores malformed keychain payloads without an access token', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-usage-oauth-'));
    const service = getClaudeKeychainService(home);
    setKeychainTokenSync(service, JSON.stringify({ claudeAiOauth: { refreshToken: 'refresh-only' } }));

    try {
      await expect(loadClaudeOauth(home)).resolves.toBeNull();
    } finally {
      deleteKeychainTokenSync(service);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32' || !fileBacked)('falls back to <home>/.claude/.credentials.json when the keychain has no item (Linux/CI)', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-usage-oauth-file-'));
    const claudeDir = path.join(home, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'file-token',
          refreshToken: 'file-refresh',
          expiresAt: Date.now() + 60 * 60 * 1000,
        },
      })
    );

    try {
      const oauth = await loadClaudeOauth(home);
      expect(oauth?.accessToken).toBe('file-token');
      expect(oauth?.refreshToken).toBe('file-refresh');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps usage eligible when the live org is missing', () => {
    expect(isClaudeUsageOrgMatch('org-requested', null)).toBe(true);
  });

  it('rejects usage only when both org ids exist and mismatch', () => {
    expect(isClaudeUsageOrgMatch('org-requested', 'org-live')).toBe(false);
    expect(isClaudeUsageOrgMatch('org-requested', 'org-requested')).toBe(true);
  });
});

describe('Claude usage cache', () => {
  it('persists and reloads the last seen live snapshot by usage key', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-usage-cache-'));
    const cachePath = path.join(tempDir, 'claude-usage.json');
    const snapshot: UsageSnapshot = {
      source: 'live',
      sourceLabel: 'live account data',
      capturedAt: new Date('2026-04-17T12:00:00Z'),
      windows: [
        {
          key: 'session',
          label: 'Current session',
          shortLabel: 'S',
          usedPercent: 40,
          resetsAt: new Date('2026-04-17T16:00:00Z'),
          windowMinutes: 300,
        },
        {
          key: 'week',
          label: 'Current week',
          shortLabel: 'W',
          usedPercent: 80,
          resetsAt: new Date('2026-04-23T12:00:00Z'),
          windowMinutes: 10080,
        },
      ],
    };

    try {
      writeClaudeUsageCache('claude:org=shared', snapshot, cachePath);
      const cached = readClaudeUsageCache(
        'claude:org=shared',
        cachePath,
        new Date('2026-04-17T13:00:00Z')
      );

      expect(cached?.source).toBe('last_seen');
      expect(cached?.sourceLabel).toBe('last seen live account data');
      expect(cached?.windows.map((window) => window.shortLabel)).toEqual(['S', 'W']);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns a recent shared snapshot with no network call', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-usage-swr-'));
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error('fetch must not be called on fresh cache');
    }) as typeof globalThis.fetch;
    vi.spyOn(state, 'getCacheDir').mockReturnValue(tmpDir);

    try {
      const snapshot: UsageSnapshot = {
        source: 'live',
        sourceLabel: 'live account data',
        capturedAt: new Date(Date.now() - 30_000),
        windows: [
          { key: 'session', label: 'S', shortLabel: 'S', usedPercent: 10, resetsAt: null, windowMinutes: 300 },
        ],
      };
      writeClaudeUsageCache('claude:org=swr-fresh', snapshot);

      const result = await getUsageInfoForIdentity({
        agentId: 'claude',
        info: makeAccountInfo({ usageKey: 'claude:org=swr-fresh' }),
      });

      expect(result.error).toBeNull();
      expect(result.snapshot?.windows[0]?.usedPercent).toBe(10);
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
      vi.restoreAllMocks();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns a stale shared snapshot with no network call', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-usage-swr-'));
    vi.spyOn(state, 'getCacheDir').mockReturnValue(tmpDir);

    try {
      const snapshot: UsageSnapshot = {
        source: 'live',
        sourceLabel: 'live account data',
        capturedAt: new Date(Date.now() - 5 * 60 * 1000),
        windows: [
          { key: 'session', label: 'S', shortLabel: 'S', usedPercent: 42, resetsAt: null, windowMinutes: 300 },
        ],
      };
      writeClaudeUsageCache('claude:org=swr-stale', snapshot);

      const t0 = Date.now();
      const result = await getUsageInfoForIdentity({
        agentId: 'claude',
        info: makeAccountInfo({ usageKey: 'claude:org=swr-stale' }),
      });
      const elapsedMs = Date.now() - t0;

      expect(elapsedMs).toBeLessThan(100);
      expect(result.error).toBeNull();
      expect(result.snapshot?.windows[0]?.usedPercent).toBe(42);
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('drops expired cached windows instead of resurrecting them as 0%', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-usage-cache-'));
    const cachePath = path.join(tempDir, 'claude-usage.json');
    const snapshot: UsageSnapshot = {
      source: 'live',
      sourceLabel: 'live account data',
      capturedAt: new Date('2026-04-17T12:00:00Z'),
      windows: [
        {
          key: 'session',
          label: 'Current session',
          shortLabel: 'S',
          usedPercent: 40,
          resetsAt: new Date('2026-04-17T13:00:00Z'),
          windowMinutes: 300,
        },
        {
          key: 'week',
          label: 'Current week',
          shortLabel: 'W',
          usedPercent: 80,
          resetsAt: new Date('2026-04-23T12:00:00Z'),
          windowMinutes: 10080,
        },
      ],
    };

    try {
      writeClaudeUsageCache('claude:org=shared', snapshot, cachePath);
      const cached = readClaudeUsageCache(
        'claude:org=shared',
        cachePath,
        new Date('2026-04-17T14:00:00Z')
      );

      expect(cached?.windows.map((window) => window.shortLabel)).toEqual(['W']);
      expect(cached?.windows.find((w) => w.shortLabel === 'W')?.usedPercent).toBe(80);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('normalizeKimiWindows', () => {
  const payload: KimiUsagesResponse = {
    user: { userId: 'd483kfq783mkn8of1gtg', membership: { level: 'LEVEL_INTERMEDIATE' } },
    usage: { limit: '100', used: '1', remaining: '99', resetTime: '2026-07-06T03:47:50.921944Z' },
    limits: [
      {
        window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
        detail: { limit: '100', used: '4', remaining: '96', resetTime: '2026-07-01T13:47:50.921944Z' },
      },
    ],
    subType: 'TYPE_PURCHASE',
  };

  it('maps the 300-minute limit to a session bar and the rolling quota to a week bar', () => {
    const windows = normalizeKimiWindows(payload);
    expect(windows.map((w) => w.shortLabel)).toEqual(['S', 'W']);
    const session = windows.find((w) => w.key === 'session')!;
    const week = windows.find((w) => w.key === 'week')!;
    expect(session.usedPercent).toBe(4);
    expect(week.usedPercent).toBe(1);
    expect(session.windowMinutes).toBe(300);
    expect(session.resetsAt?.toISOString()).toBe('2026-07-01T13:47:50.921Z');
  });

  it('drops a bucket with a zero or missing limit rather than dividing by zero', () => {
    const windows = normalizeKimiWindows({
      usage: { limit: '0', used: '5' },
      limits: [{ detail: { used: '4' } }],
    });
    expect(windows).toEqual([]);
  });

  it('derives the plan label from the membership tier, falling back to subType', () => {
    expect(formatKimiPlan(payload)).toBe('Intermediate');
    expect(formatKimiPlan({ subType: 'TYPE_PURCHASE' })).toBe('Purchase');
    expect(formatKimiPlan({})).toBeNull();
  });
});

describe('normalizeDroidWindows', () => {
  const payload: DroidBillingLimitsResponse = {
    usesTokenRateLimitsBilling: true,
    limits: {
      standard: {
        fiveHour: { usedPercent: 12, windowEnd: '2026-07-15T18:00:00.000Z' },
        weekly: { usedPercent: 34, windowEnd: '2026-07-20T00:00:00.000Z' },
        monthly: { usedPercent: 5, windowEnd: '2026-08-01T00:00:00.000Z' },
      },
    },
  };

  it('maps fiveHour/weekly/monthly to session, week, and month windows', () => {
    const windows = normalizeDroidWindows(payload);
    expect(windows.map((w) => w.shortLabel)).toEqual(['S', 'W', 'M']);
    const session = windows.find((w) => w.key === 'session')!;
    const week = windows.find((w) => w.key === 'week')!;
    const month = windows.find((w) => w.key === 'month')!;
    expect(session.usedPercent).toBe(12);
    expect(week.usedPercent).toBe(34);
    expect(month.usedPercent).toBe(5);
    expect(session.windowMinutes).toBe(300);
    expect(month.windowMinutes).toBe(43200);
    expect(session.resetsAt?.toISOString()).toBe('2026-07-15T18:00:00.000Z');
  });

  it('renders nothing for orgs on the legacy billing model', () => {
    expect(normalizeDroidWindows({ ...payload, usesTokenRateLimitsBilling: false })).toEqual([]);
    expect(normalizeDroidWindows({ ...payload, usesTokenRateLimitsBilling: undefined })).toEqual([]);
  });

  it('renders nothing when limits.standard is missing', () => {
    expect(normalizeDroidWindows({ usesTokenRateLimitsBilling: true })).toEqual([]);
    expect(normalizeDroidWindows({ usesTokenRateLimitsBilling: true, limits: {} })).toEqual([]);
  });

  it('drops a window without a numeric usedPercent and clamps out-of-range values', () => {
    const windows = normalizeDroidWindows({
      usesTokenRateLimitsBilling: true,
      limits: {
        standard: {
          fiveHour: { windowEnd: '2026-07-15T18:00:00.000Z' },
          weekly: { usedPercent: 250 },
        },
      },
    });
    expect(windows.map((w) => w.key)).toEqual(['week']);
    expect(windows[0].usedPercent).toBe(100);
  });

  it('shows the month window in the compact summary — droid meters on it', () => {
    const snapshot: UsageSnapshot = {
      source: 'live',
      sourceLabel: 'live account data',
      capturedAt: new Date('2026-07-15T12:00:00Z'),
      windows: normalizeDroidWindows(payload),
    };
    const summary = stripAnsi(formatUsageSummary(null, snapshot));
    expect(summary).toContain('S:');
    expect(summary).toContain('W:');
    expect(summary).toContain('M:');
    const exhausted = normalizeDroidWindows({
      ...payload,
      limits: { standard: { ...payload.limits!.standard, monthly: { usedPercent: 100 } } },
    });
    expect(deriveUsageStatusFromSnapshot({ ...snapshot, windows: exhausted })).toBe('rate_limited');
  });

  it('keeps the non-blocking sonnet_week window out of the compact summary', () => {
    const snapshot: UsageSnapshot = {
      source: 'live',
      sourceLabel: 'live account data',
      capturedAt: new Date('2026-07-15T12:00:00Z'),
      windows: [
        ...normalizeDroidWindows(payload),
        {
          key: 'sonnet_week',
          label: 'Current week (Sonnet only)',
          shortLabel: 'So',
          usedPercent: 40,
          resetsAt: null,
          windowMinutes: null,
        },
      ],
    };
    const summary = stripAnsi(formatUsageSummary(null, snapshot));
    expect(summary).toContain('M:');
    expect(summary).not.toContain('So:');
  });
});
