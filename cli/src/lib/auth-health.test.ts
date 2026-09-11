import { describe, it, expect } from 'vitest';

import {
  authAccountLabel,
  authCacheKey,
  authCellColor,
  classifyHttpStatus,
  groupFleetAuthInstalls,
  mergeAuthHealthEntries,
  formatCheckedAge,
  probeDetail,
  summarizeHostAuth,
  summarizeVerdicts,
  verdictColor,
  verdictFromProbe,
  verdictGlyph,
  verdictLabel,
  type AuthHealth,
  type AuthVerdict,
  type FleetAuthInstall,
} from './auth-health.js';

describe('classifyHttpStatus', () => {
  it('maps 2xx to live', () => {
    expect(classifyHttpStatus(200)).toBe('live');
    expect(classifyHttpStatus(204)).toBe('live');
  });
  it('maps 401/403 to revoked — the exact case the "signed in" flag misses', () => {
    expect(classifyHttpStatus(401)).toBe('revoked');
    expect(classifyHttpStatus(403)).toBe('revoked');
  });
  it('maps 429 to rate_limited (token good, throttled)', () => {
    expect(classifyHttpStatus(429)).toBe('rate_limited');
  });
  it('maps other statuses to error, not a false negative', () => {
    expect(classifyHttpStatus(500)).toBe('error');
    expect(classifyHttpStatus(404)).toBe('error');
  });
});

describe('verdictFromProbe', () => {
  it('missing credential -> unconfigured', () => {
    expect(verdictFromProbe({ status: null, token: 'missing' })).toBe('unconfigured');
  });
  it('locally expired -> expired (never revoked, since no refresh on read path)', () => {
    expect(verdictFromProbe({ status: null, token: 'expired' })).toBe('expired');
  });
  it('present token + network error -> error, so we keep the last known verdict', () => {
    expect(verdictFromProbe({ status: null, token: 'present', error: 'timeout' })).toBe('error');
  });
  it('present token + 401 -> revoked', () => {
    expect(verdictFromProbe({ status: 401, token: 'present' })).toBe('revoked');
  });
  it('present token + 200 -> live', () => {
    expect(verdictFromProbe({ status: 200, token: 'present' })).toBe('live');
  });
  it('setup-token usage-scope 403 -> unverified, never revoked (RUSH-2392)', () => {
    // Bare 403 is still revoked (unknown denial). The reason field is the
    // only signal that this is the known headless scope gap.
    expect(verdictFromProbe({ status: 403, token: 'present' })).toBe('revoked');
    expect(
      verdictFromProbe({
        status: 403,
        token: 'present',
        reason: 'usage_scope',
        error: 'usage unavailable (headless)',
      }),
    ).toBe('unverified');
  });
});

describe('probeDetail', () => {
  it('surfaces the HTTP status for non-2xx', () => {
    expect(probeDetail({ status: 401, token: 'present' })).toBe('HTTP 401');
  });
  it('surfaces the network error when there was no status', () => {
    expect(probeDetail({ status: null, token: 'present', error: 'ETIMEDOUT' })).toBe('ETIMEDOUT');
  });
  it('is undefined for a clean 200', () => {
    expect(probeDetail({ status: 200, token: 'present' })).toBeUndefined();
  });
  it('names the headless scope gap for usage_scope (RUSH-2392)', () => {
    expect(
      probeDetail({
        status: 403,
        token: 'present',
        reason: 'usage_scope',
        error: 'usage unavailable (headless)',
      }),
    ).toBe('usage unavailable (headless)');
  });
});

describe('verdictGlyph / verdictLabel', () => {
  const verdicts: AuthVerdict[] = ['live', 'revoked', 'expired', 'rate_limited', 'unverified', 'unconfigured', 'error'];
  it('returns a non-empty glyph and label for every verdict', () => {
    for (const v of verdicts) {
      expect(verdictGlyph(v).length).toBeGreaterThan(0);
      expect(verdictLabel(v).length).toBeGreaterThan(0);
    }
  });
  it('live and revoked read differently', () => {
    expect(verdictGlyph('live')).not.toBe(verdictGlyph('revoked'));
    expect(verdictLabel('live')).toBe('live');
    expect(verdictLabel('revoked')).toBe('revoked');
  });
});

describe('authAccountLabel', () => {
  it('prefers email, then accountId, then userId', () => {
    expect(authAccountLabel({ email: 'a@b.com', accountId: 'x', userId: 'y' })).toBe('a@b.com');
    expect(authAccountLabel({ email: null, accountId: 'x', userId: 'y' })).toBe('x');
    expect(authAccountLabel({ email: null, accountId: null, userId: 'y' })).toBe('y');
    expect(authAccountLabel({ email: null, accountId: null, userId: null })).toBeUndefined();
    expect(authAccountLabel(null)).toBeUndefined();
  });
});

describe('authCacheKey', () => {
  it('is one entry per install — host+agent+version (unique per token)', () => {
    expect(authCacheKey('zion', 'claude', '2.1.170')).toBe('zion:claude:2.1.170');
    expect(authCacheKey('yosemite-s0', 'kimi', 'default')).toBe('yosemite-s0:kimi:default');
  });
  it('distinguishes two installs of the same account on one host', () => {
    // gmail live in 2.1.207 but revoked in 2.1.186 — different keys, no collision
    expect(authCacheKey('yosemite-s1', 'claude', '2.1.207'))
      .not.toBe(authCacheKey('yosemite-s1', 'claude', '2.1.186'));
  });
});

describe('summarizeVerdicts', () => {
  it('counts live, present (unverified), bad (revoked), and warn (soft)', () => {
    expect(summarizeVerdicts(['live', 'live', 'live', 'live'])).toEqual({ live: 4, present: 0, bad: 0, warn: 0, total: 4 });
    // only revoked is "bad"; expired is soft -> warn; unverified is benign signed-in -> present
    expect(summarizeVerdicts(['live', 'revoked', 'expired', 'unverified'])).toEqual({ live: 1, present: 1, bad: 1, warn: 1, total: 4 });
    // unverified (codex/grok signed in, no probe) must NOT land in warn — it's `present`
    expect(summarizeVerdicts(['unverified', 'unverified'])).toEqual({ live: 0, present: 2, bad: 0, warn: 0, total: 2 });
    expect(summarizeVerdicts(['rate_limited', 'error'])).toEqual({ live: 0, present: 0, bad: 0, warn: 2, total: 2 });
    expect(summarizeVerdicts([])).toEqual({ live: 0, present: 0, bad: 0, warn: 0, total: 0 });
  });
});

describe('verdictColor', () => {
  it('reserves red for revoked; expired is soft yellow, never red', () => {
    // the exact regression: the ping verbose list painted `expired` red (lumped with revoked)
    expect(verdictColor('revoked')).toBe('red');
    expect(verdictColor('expired')).toBe('yellow');
    expect(verdictColor('rate_limited')).toBe('yellow');
    expect(verdictColor('error')).toBe('yellow');
  });
  it('unverified (signed in, no probe) is neutral gray, not an alarm', () => {
    expect(verdictColor('unverified')).toBe('gray');
    expect(verdictColor('live')).toBe('green');
    expect(verdictColor('unconfigured')).toBe('dim');
  });
});

describe('authCellColor', () => {
  const s = (o: Partial<ReturnType<typeof summarizeVerdicts>>) =>
    ({ live: 0, present: 0, bad: 0, warn: 0, total: 0, ...o });
  it('red only when a token is genuinely revoked', () => {
    expect(authCellColor(s({ bad: 1, total: 1 }))).toBe('red');
    // revoked wins even alongside live accounts
    expect(authCellColor(s({ live: 2, bad: 1, total: 3 }))).toBe('red');
  });
  it('expired-only cell is soft yellow, NOT red (kimi/droid self-refresh)', () => {
    expect(authCellColor(s({ warn: 1, total: 1 }))).toBe('yellow');
  });
  it('all-unverified cell (codex/grok signed in) is neutral gray, NOT yellow', () => {
    // this is the "cry wolf" fix: a fully-logged-in codex fleet must not read as degraded
    expect(authCellColor(s({ present: 1, total: 1 }))).toBe('gray');
  });
  it('all-live cell is green; empty cell is dim', () => {
    expect(authCellColor(s({ live: 3, total: 3 }))).toBe('green');
    expect(authCellColor(s({ total: 0 }))).toBe('dim');
  });
});

describe('mergeAuthHealthEntries', () => {
  it('a fresh error does NOT clobber a prior known verdict (keeps last known)', () => {
    const current = { 'zion:claude:2.1.170': { verdict: 'live' as const, checkedAt: 100 } };
    const incoming = { 'zion:claude:2.1.170': { verdict: 'error' as const, checkedAt: 200, detail: 'timeout' } };
    // the live entry survives the transient error
    expect(mergeAuthHealthEntries(current, incoming)['zion:claude:2.1.170']).toEqual({ verdict: 'live', checkedAt: 100 });
  });
  it('a real verdict (revoked/live) DOES overwrite', () => {
    const current = { k: { verdict: 'live' as const, checkedAt: 100 } };
    expect(mergeAuthHealthEntries(current, { k: { verdict: 'revoked' as const, checkedAt: 200 } }).k.verdict).toBe('revoked');
  });
  it('an error on a brand-new key is still recorded (nothing prior to keep)', () => {
    expect(mergeAuthHealthEntries({}, { k: { verdict: 'error' as const, checkedAt: 200 } }).k.verdict).toBe('error');
  });
});

describe('summarizeHostAuth', () => {
  const h = (verdict: AuthVerdict, checkedAt: number): AuthHealth => ({ verdict, checkedAt });
  const cache: Record<string, AuthHealth> = {
    'zion:claude:1.0.0': h('live', 5000),
    'zion:claude:1.1.0': h('live', 3000),
    'zion:codex:0.1.0': h('unverified', 7000),   // signed in, no probe → present
    'zion:opencode:0.1.0': h('revoked', 4000),   // server rejected → revoked
    'zion:kimi:0.1.0': h('expired', 6000),        // soft/self-healing → degraded
    'zion-2:claude:1.0.0': h('revoked', 1000),   // sibling host, must not bleed into 'zion'
    'yosemite-s1:claude:1.0.0': h('live', 9000),
  };

  it('splits present/degraded/revoked into distinct buckets and tracks oldest', () => {
    const r = summarizeHostAuth(cache, 'zion');
    // 5 zion rows — the 'zion-2' row (a `zion` substring) is excluded.
    expect(r).toEqual({
      live: 2,       // two claude
      present: 1,    // codex unverified — NOT counted as degraded
      degraded: 1,   // kimi expired (soft)
      revoked: 1,    // opencode revoked (the only real re-login)
      total: 5,
      oldestCheckedAt: 3000, // not zion-2's 1000
    });
  });

  it('matches on the host prefix, not a substring (no cross-host bleed)', () => {
    const r = summarizeHostAuth(cache, 'yosemite-s1');
    expect(r).toEqual({ live: 1, present: 0, degraded: 0, revoked: 0, total: 1, oldestCheckedAt: 9000 });
  });

  it('returns an empty summary for a host with no cached rows', () => {
    const r = summarizeHostAuth(cache, 'never-probed');
    expect(r).toEqual({ live: 0, present: 0, degraded: 0, revoked: 0, total: 0, oldestCheckedAt: null });
  });
});

describe('groupFleetAuthInstalls — probe once per account (RUSH-2111)', () => {
  const inst = (agent: string, version: string, account: string | undefined): FleetAuthInstall =>
    ({ agent: agent as FleetAuthInstall['agent'], version, account });

  it('collapses two homes on the SAME account into ONE probe group', () => {
    const groups = groupFleetAuthInstalls([
      inst('claude', '1.0.0', 'alice@example.com'),
      inst('claude', '1.1.0', 'alice@example.com'),
    ]);
    // The whole point: two version homes, one live probe.
    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((m) => m.version)).toEqual(['1.0.0', '1.1.0']);
    // The representative is the first-seen home; every member rides its verdict.
    expect(groups[0].probe.version).toBe('1.0.0');
  });

  it('keeps DIFFERENT accounts on the same agent as separate probes', () => {
    const groups = groupFleetAuthInstalls([
      inst('claude', '1.0.0', 'alice@example.com'),
      inst('claude', '1.1.0', 'bob@example.com'),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.members.length === 1)).toBe(true);
  });

  it('never merges the same account label across different agents', () => {
    const groups = groupFleetAuthInstalls([
      inst('claude', '1.0.0', 'shared@example.com'),
      inst('kimi', '2.0.0', 'shared@example.com'),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('never merges installs with no resolvable account — each is its own group', () => {
    const groups = groupFleetAuthInstalls([
      inst('claude', '1.0.0', undefined),
      inst('claude', '1.1.0', undefined),
    ]);
    // Can't prove they're the same account, so probe each (matches the old
    // per-install behaviour for the un-labelable / unconfigured case).
    expect(groups).toHaveLength(2);
  });

  it('deduplicates within an account while isolating the un-labelable ones', () => {
    const groups = groupFleetAuthInstalls([
      inst('claude', '1.0.0', 'alice@example.com'),
      inst('claude', '1.1.0', 'alice@example.com'),
      inst('claude', '1.2.0', undefined),
      inst('claude', '1.3.0', 'bob@example.com'),
    ]);
    // alice(1 group of 2) + bob(1) + un-labelable(1) = 3 probes for 4 homes.
    expect(groups).toHaveLength(3);
    const alice = groups.find((g) => g.probe.account === 'alice@example.com');
    expect(alice?.members.map((m) => m.version)).toEqual(['1.0.0', '1.1.0']);
  });

  it('returns no groups for no installs', () => {
    expect(groupFleetAuthInstalls([])).toEqual([]);
  });

  it('only merges installs the isMergeable predicate accepts', () => {
    // The real caller passes `LIVE_PROBE_AGENTS.has(agent)`: claude merges (it can
    // 429), cursor does not (a cheap local verdict with no rate limit — merging
    // could silently override one home's signedIn state with another's).
    const isLive = (i: FleetAuthInstall) => i.agent === 'claude';
    const groups = groupFleetAuthInstalls(
      [
        inst('claude', '1.0.0', 'alice@example.com'),
        inst('claude', '1.1.0', 'alice@example.com'),
        inst('cursor', '2.0.0', 'alice@example.com'),
        inst('cursor', '2.1.0', 'alice@example.com'),
      ],
      isLive,
    );
    // claude: 2 homes -> 1 group; cursor: 2 homes -> 2 groups (never merged).
    expect(groups).toHaveLength(3);
    const claude = groups.find((g) => g.probe.agent === 'claude');
    expect(claude?.members).toHaveLength(2);
    expect(groups.filter((g) => g.probe.agent === 'cursor').every((g) => g.members.length === 1)).toBe(true);
  });
});

describe('formatCheckedAge', () => {
  const now = 1_000_000_000_000;
  it('renders seconds/minutes/hours/days', () => {
    expect(formatCheckedAge(now - 5_000, now)).toBe('5s ago');
    expect(formatCheckedAge(now - 3 * 60_000, now)).toBe('3m ago');
    expect(formatCheckedAge(now - 2 * 3_600_000, now)).toBe('2h ago');
    expect(formatCheckedAge(now - 3 * 86_400_000, now)).toBe('3d ago');
  });
  it('never goes negative for a future timestamp', () => {
    expect(formatCheckedAge(now + 5_000, now)).toBe('0s ago');
  });
});

describe('probeAuthHealth derives live from a fresh usage fetch (RUSH-3036)', () => {
  // The auth probe and the usage fetch hit the SAME rate-limited endpoint with
  // the SAME shared setup-token, so a fresh successful usage snapshot already
  // proves the token live. Exercised against the REAL cache file via the test
  // seam; in this environment no credentials exist, so a 'live' verdict can
  // ONLY come from the derivation path — a broken gate falls through to the
  // live probe and returns a non-live verdict.
  it('returns live without a network probe when the account has a fresh snapshot', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { setClaudeUsageCachePathForTest, writeClaudeUsageCache, probeAuthHealth: _unused } = await import('./accounting/usage.js').then(async (usage) => {
      const { probeAuthHealth } = await import('./auth-health.js');
      return { ...usage, probeAuthHealth };
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-derive-'));
    const prev = setClaudeUsageCachePathForTest(path.join(dir, 'usage.json'));
    try {
      const usageKey = 'claude:org=derive-test-1234';
      writeClaudeUsageCache(usageKey, {
        source: 'live',
        sourceLabel: 'live account data',
        capturedAt: new Date(Date.now() - 5 * 60_000), // 5 minutes old — fresh
        windows: [{ key: 'week', label: 'Current week', shortLabel: 'W', usedPercent: 42, resetsAt: null, windowMinutes: 10080 }],
      });
      const { probeAuthHealth } = await import('./auth-health.js');
      const health = await probeAuthHealth('claude', undefined, {
        info: { usageKey, signedIn: true } as never,
      });
      expect(health.verdict).toBe('live');
      expect(health.detail).toContain('usage fetch');
    } finally {
      setClaudeUsageCachePathForTest(prev);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls through to the real probe path when the snapshot is stale', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const usage = await import('./accounting/usage.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-derive-stale-'));
    const prev = usage.setClaudeUsageCachePathForTest(path.join(dir, 'usage.json'));
    try {
      const usageKey = 'claude:org=derive-stale-5678';
      usage.writeClaudeUsageCache(usageKey, {
        source: 'live',
        sourceLabel: 'live account data',
        capturedAt: new Date(Date.now() - 25 * 60_000), // 25 minutes — beyond the window
        windows: [{ key: 'week', label: 'Current week', shortLabel: 'W', usedPercent: 42, resetsAt: null, windowMinutes: 10080 }],
      });
      const { probeAuthHealth } = await import('./auth-health.js');
      const health = await probeAuthHealth('claude', undefined, {
        info: { usageKey, signedIn: true } as never,
      });
      // No credentials in this environment: the live probe path cannot return
      // 'live', proving the stale snapshot was NOT used as evidence.
      expect(health.verdict).not.toBe('live');
    } finally {
      usage.setClaudeUsageCachePathForTest(prev);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('derivation guards (RUSH-3036 review findings)', () => {
  async function withFreshSnapshot<T>(run: (usageKey: string) => Promise<T>): Promise<T> {
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const usage = await import('./accounting/usage.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-derive-guard-'));
    const prev = usage.setClaudeUsageCachePathForTest(path.join(dir, 'usage.json'));
    try {
      const usageKey = 'claude:org=guard-test-9999';
      usage.writeClaudeUsageCache(usageKey, {
        source: 'live',
        sourceLabel: 'live account data',
        capturedAt: new Date(Date.now() - 60_000), // 1 minute old — maximally fresh
        windows: [{ key: 'week', label: 'Current week', shortLabel: 'W', usedPercent: 10, resetsAt: null, windowMinutes: 10080 }],
      });
      return await run(usageKey);
    } finally {
      usage.setClaudeUsageCachePathForTest(prev);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('forceLive skips derivation — devices ping --strict always fires a real probe', async () => {
    await withFreshSnapshot(async (usageKey) => {
      const { probeAuthHealth } = await import('./auth-health.js');
      const health = await probeAuthHealth('claude', undefined, {
        info: { usageKey, signedIn: true } as never,
        forceLive: true,
      });
      // Fresh evidence exists, but forceLive must ignore it. No credentials in
      // this environment, so the real probe path cannot return 'live' — a
      // 'live' here would mean the derivation leaked through the force path.
      expect(health.verdict).not.toBe('live');
    });
  });

  it('a fleet-imported snapshot on an unsigned home is NOT proof this box can authenticate', async () => {
    await withFreshSnapshot(async (usageKey) => {
      const { probeAuthHealth } = await import('./auth-health.js');
      const health = await probeAuthHealth('claude', undefined, {
        info: { usageKey, signedIn: false } as never, // no local credential
      });
      expect(health.verdict).not.toBe('live');
    });
  });
});

describe('enumerateSlotInstalls — the daemon probe covers account slots', () => {
  // Real temp dirs, no mocks: a registered codex account with a slot on disk is a
  // probe target keyed `slot:<id>`; a slot whose dir is gone, and an account whose
  // harness is not being probed, are skipped. Before this the probe walked
  // `listInstalledVersions` only, so a slot's verdict was never re-derived.
  it('yields one probe target per registered slot that exists on disk', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { enumerateSlotInstalls, slotAuthVersionKey } = await import('./auth-health.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-probe-'));
    try {
      const present = 'e003a157-64fd-4899-92cc-ac7ca547586e';
      const gone = '1f87cf2a-41c4-445d-90a0-d021e9ad2ae1';
      const otherHarness = 'a9935675-1c79-407e-9f3c-3750efb99ae3';
      const presentDir = path.join(root, 'accounts', 'codex', present);
      fs.mkdirSync(path.join(presentDir, '.codex'), { recursive: true });
      const meta = {
        accounts: {
          native: {
            [present]: { id: present, name: 'getrush', agent: 'codex' as const, identityKey: 'codex:account=x', identityLabel: 'muqsit@getrush.ai' },
            [gone]: { id: gone, name: 'icloud', agent: 'codex' as const, identityKey: 'codex:account=y', identityLabel: 'muqsitnawaz@icloud.com' },
            [otherHarness]: { id: otherHarness, name: 'work', agent: 'claude' as const, identityKey: 'claude:account=z', identityLabel: 'muqsit@getrush.ai' },
          },
        },
        deviceAccounts: {
          slots: {
            [present]: { accountId: present, slotDir: presentDir, authMode: 'native' as const, verdict: 'unconfigured' as const },
            [gone]: { accountId: gone, slotDir: path.join(root, 'accounts', 'codex', gone), authMode: 'native' as const, verdict: 'live' as const },
            [otherHarness]: { accountId: otherHarness, slotDir: presentDir, authMode: 'native' as const, verdict: 'live' as const },
          },
        },
      };
      const out = enumerateSlotInstalls(meta as never, ['codex']);
      expect(out).toEqual([
        { agent: 'codex', version: slotAuthVersionKey(present), home: presentDir, account: undefined, accountId: present },
      ]);
      // The other harness's slot is a target only when that harness is probed.
      expect(enumerateSlotInstalls(meta as never, ['claude']).map((s) => s.accountId)).toEqual([otherHarness]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
