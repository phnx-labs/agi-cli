import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  claudeAccessTokenNeedsRefresh,
  claudeUsageAccessTokenNoRefresh,
  loadClaudeOauth,
  getClaudeKeychainService,
  getUsageInfo,
  getUsageInfoForIdentity,
  writeClaudeUsageCache,
  readClaudeUsageCache,
  pruneExpiredClaudeUsageCacheEntry,
  noteClaudeSessionLimit,
  noteClaudeOutOfCredits,
  clearClaudeAccountRefusal,
  parseClaudeSessionLimitReset,
  noteClaudeModelRefusal,
  clearClaudeModelRefusal,
  getClaudeModelRefusal,
  parseClaudeModelRefusal,
  mergeClaudeUsageCacheWindows,
  deriveUsageStatusFromSnapshot,
  setClaudeUsageCachePathForTest,
  deriveUsageHeadroom,
  formatUsageSummary,
  renderBar,
  classifyUsageErrorKind,
  classifyUsageFetchFailure,
  getUsageBenignState,
  usageNoCredentialError,
  usageNoClaudeUsageCredentialError,
  usageExpiredCredentialError,
  usageExpiredKimiCredentialError,
  usageRejectedError,
  usageThrottledError,
  usageUnreachableError,
  usageHeadlessScopeError,
  isUsageHeadlessScopeError,
  isClaudeUsageScopeDenied,
  USAGE_HEADLESS_SCOPE_MARKER,
  USAGE_NO_USAGE_CREDENTIAL_MARKER,
  USAGE_NOT_COLLECTED_MARKER,
  usageErrorForDisplay,
  probeClaudeStatus,
  probeKimiStatus,
  type UsageSnapshot,
  type UsageErrorKind,
} from './usage.js';
import type { AccountInfo } from '../agents.js';
import { noteUsageRateLimited, setUsageBackoffDirForTest, usageRateLimitedUntil } from '../usage-backoff.js';
import { keychainRef, secretsKeychainItem, setKeychainTokenSync, writeBundleWithItemsSync } from '../secrets-client.js';
import { standaloneKeychainIsFileBacked, useFreshSecretsHome } from '../../../tests/secrets-standalone.js';

// The Claude keychain service item and the reserved `auth` bundle live behind the
// real standalone `secrets` CLI (PHNX-3989). The Claude item is a keychain item,
// so on a headed macOS box these blocks would reach the operator's login keychain.
const fileBacked = await standaloneKeychainIsFileBacked();

describe('renderBar', () => {
  it('renders low and intermediate percentages proportionally', () => {
    expect(renderBar(2, 5)).toBe('▏░░░░');
    expect(renderBar(46, 5)).toBe('██▎░░');
    expect(renderBar(81, 5)).toBe('████░');
  });
});

const LEEWAY_MS = 5 * 60 * 1000;
const NOW = 1_800_000_000_000; // fixed epoch ms so the tests are deterministic

describe('claudeAccessTokenNeedsRefresh', () => {
  it('treats a missing expiry as still-fresh (never force a refresh)', () => {
    // A token with no known expiry must not trigger a refresh — that is what
    // kept the health probe from rotating tokens with an unknown lifetime.
    expect(claudeAccessTokenNeedsRefresh(null, NOW)).toBe(false);
    expect(claudeAccessTokenNeedsRefresh(undefined, NOW)).toBe(false);
  });

  it('is false while the token is comfortably in the future', () => {
    expect(claudeAccessTokenNeedsRefresh(NOW + LEEWAY_MS + 60_000, NOW)).toBe(false);
  });

  it('is true once the token is within the refresh leeway of expiry', () => {
    // The stampede fix depends on this comparison direction: a near-expiry
    // token reports `expired` from the probe (non-fatal) instead of refreshing.
    expect(claudeAccessTokenNeedsRefresh(NOW + LEEWAY_MS - 1, NOW)).toBe(true);
  });

  it('is true exactly at the leeway boundary (>=, not >)', () => {
    expect(claudeAccessTokenNeedsRefresh(NOW + LEEWAY_MS, NOW)).toBe(true);
  });

  it('is true for an already-expired token', () => {
    expect(claudeAccessTokenNeedsRefresh(NOW - 60_000, NOW)).toBe(true);
  });
});

describe('claudeUsageAccessTokenNoRefresh', () => {
  // Uses the real Date.now() internally (via claudeAccessTokenNeedsRefresh), so
  // express expiries relative to now.
  const now = Date.now();

  it('returns the token when it is comfortably fresh', () => {
    expect(claudeUsageAccessTokenNoRefresh({ accessToken: 'tok-abc', expiresAt: now + 60 * 60 * 1000 })).toBe('tok-abc');
  });

  it('returns the token when the expiry is unknown (never forces a refresh)', () => {
    expect(claudeUsageAccessTokenNoRefresh({ accessToken: 'tok-abc', expiresAt: null })).toBe('tok-abc');
  });

  it('returns null (NOT a rotating refresh) for a near-expiry token', () => {
    // The regression this guards: a usage read must never rotate Claude's
    // single-use refresh token. A token within the 5-min leeway yields "no usage
    // now" (null) instead of refreshing and logging every other fleet box out.
    expect(claudeUsageAccessTokenNoRefresh({ accessToken: 'tok-abc', expiresAt: now + 60_000 })).toBeNull();
  });

  it('returns null for an already-expired token (still never refreshes)', () => {
    expect(claudeUsageAccessTokenNoRefresh({ accessToken: 'tok-abc', expiresAt: now - 60_000 })).toBeNull();
  });

  it('returns null for a missing/empty access token', () => {
    expect(claudeUsageAccessTokenNoRefresh({ accessToken: '', expiresAt: now + 60 * 60 * 1000 })).toBeNull();
    expect(claudeUsageAccessTokenNoRefresh({ accessToken: '   ', expiresAt: now + 60 * 60 * 1000 })).toBeNull();
  });
});

/**
 * Read-only usage/probe callers (accessTokenCache) authenticate ONLY with a
 * file-based setup-token and NEVER read Claude Code's interactive login. Reading
 * that ACL-bound OAuth token and transmitting it to Anthropic's usage API from
 * the daemon's warm loop is what got it revoked (the fleet-wide-logout class,
 * RUSH-1822). The interactive login is seeded in the real standalone store; the
 * contract pinned here is what the caller receives — a probe read gets nothing
 * while a live interactive login is present — since the standalone's raw item
 * reads are not individually observable through the seam.
 */
describe.skipIf(!fileBacked)('loadClaudeOauth accessTokenCache never hands out the interactive login', () => {
  useFreshSecretsHome();
  const HOME = '/tmp/agents-cli-usage-cache-test';
  const service = getClaudeKeychainService(HOME);
  const seedSource = (expiresAt: number) =>
    setKeychainTokenSync(
      service,
      JSON.stringify({
        organizationUuid: 'org-1',
        claudeAiOauth: { accessToken: 'tok-live', refreshToken: 'refresh-secret', expiresAt, scopes: ['user:inference'] },
      })
    );

  it('returns null when no setup-token is provisioned, even with a live interactive login present', async () => {
    // The revocation fix: with no file-based setup-token, a probe/usage caller
    // (accessTokenCache) must report unprovisioned rather than fall through to the
    // interactive OAuth credential. Before the fix this handed the interactive
    // credential to the usage probe, which fired it at api.anthropic.com.
    seedSource(Date.now() + 60 * 60 * 1000); // a live interactive login IS present

    const oauth = await loadClaudeOauth(HOME, { accessTokenCache: true });

    expect(oauth).toBeNull();
  });

  it('without the opt-in, returns the full interactive credential with its refresh token (run/cloud-export contract)', async () => {
    // isClaudeAuthValid calls loadClaudeOauth WITHOUT accessTokenCache: it
    // legitimately reads the interactive credential WITH the refresh token to
    // run/refresh Claude. Regression guard for that path.
    // NOTE: Rush Cloud dispatch does not call loadClaudeOauth at all (SING-1b
    // email-only manifest; RUSH-2359 deleted the leftover blob reader).
    seedSource(Date.now() + 60 * 60 * 1000);

    const first = await loadClaudeOauth(HOME); // default: full-credential caller
    const second = await loadClaudeOauth(HOME);

    // Full refresh token every time — never dropped.
    expect(first?.refreshToken).toBe('refresh-secret');
    expect(second?.refreshToken).toBe('refresh-secret');
  });

  it('WITH allowInteractiveLogin, an accessTokenCache read with no setup-token DOES return the interactive login (USAGE-READ-1)', async () => {
    // The regression fix: a foreground human `agents view` on a personal device
    // sets allowInteractiveLogin, and only then may the usage read fall through to
    // the interactive login — the sole credential carrying the `user:profile`
    // scope the usage endpoint requires. No setup-token is provisioned in this
    // block, so the fall-through is the ONLY way to a credential.
    seedSource(Date.now() + 60 * 60 * 1000); // interactive login present

    const oauth = await loadClaudeOauth(HOME, {
      accessTokenCache: true,
      allowInteractiveLogin: true,
    });

    // The interactive credential's access token is returned — the opposite of
    // the default accessTokenCache behavior.
    expect(oauth?.accessToken).toBe('tok-live');
  });

  it('allowInteractiveLogin still yields null when neither a setup-token nor an interactive login exists', async () => {
    // Fail-safe: the opt-in only PERMITS the fall-through; it does not fabricate a
    // credential. A signed-out home returns null even with the flag on.
    // No seedSource(): nothing in the store, no .credentials.json.
    const oauth = await loadClaudeOauth(HOME, {
      accessTokenCache: true,
      allowInteractiveLogin: true,
    });
    expect(oauth).toBeNull();
  });
});

describe('loadClaudeOauth — file-based `auth` setup-token (Touch-ID-free usage read)', () => {
  const EMAIL = 'muqsit@trp.so';
  const SETUP_TOKEN = 'sk-ant-oat01-setup-tok-xyz';
  // email -> claudeAccountTokenKey(email): upper, @->_AT_, .->_DOT_.
  const KEY = 'CLAUDE_CODE_OAUTH_TOKEN_MUQSIT_AT_TRP_DOT_SO';
  let home: string;
  useFreshSecretsHome();

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-home-'));
    // Reserved FILE-BASED `auth` bundle carrying the per-account setup-token,
    // written the way seedReservedAuthToken writes it.
    writeBundleWithItemsSync(
      { name: 'auth', backend: 'file', policy: 'never', vars: { [KEY]: keychainRef(KEY) }, meta: { [KEY]: { type: 'token' } } },
      new Map([[secretsKeychainItem('auth', KEY), SETUP_TOKEN]]),
    );
    // The account's .claude.json so the resolver maps home -> email -> KEY.
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude', '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: EMAIL } }),
    );
  });

  afterEach(() => {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('serves the file-based setup-token to accessTokenCache callers', async () => {
    const oauth = await loadClaudeOauth(home, { accessTokenCache: true });
    expect(oauth?.accessToken).toBe(SETUP_TOKEN);
    // Non-rotating: no expiry => reads as fresh, probe never reports expired.
    expect(oauth?.expiresAt ?? null).toBeNull();
  });

  it('ignores the setup-token for full-credential callers (accessTokenCache off)', async () => {
    // Run/export callers need the real keychain credential (with refresh token),
    // never the access-token-only setup-token — so this path does NOT short out.
    // With no keychain item for this home and no .credentials.json, that
    // resolves to null.
    const oauth = await loadClaudeOauth(home);
    expect(oauth).toBeNull();
  });

  it('an accessTokenCache caller with no setup-token reads NEITHER the keychain NOR .credentials.json', async () => {
    // Strip the email so resolveClaudeSetupToken cannot map home -> setup-token KEY,
    // and drop an interactive token in .credentials.json. A probe/usage caller
    // (accessTokenCache) must still report unprovisioned — the interactive login is
    // untouchable, whether it lives in the keychain or the file (the RUSH-1822 fix).
    fs.writeFileSync(path.join(home, '.claude', '.claude.json'), JSON.stringify({}));
    fs.writeFileSync(
      path.join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'interactive-file-token', expiresAt: Date.now() + 3_600_000 } }),
    );
    const oauth = await loadClaudeOauth(home, { accessTokenCache: true, fileOnly: true });
    expect(oauth).toBeNull();
  });
});

describe('deriveUsageHeadroom — projects minutes-to-cap from the session burn rate', () => {
  const sessionSnap = (usedPercent: number, capturedAtMs: number): UsageSnapshot => ({
    source: 'live',
    sourceLabel: 'live',
    capturedAt: new Date(capturedAtMs),
    windows: [
      { key: 'session', label: '5h', shortLabel: 'S', usedPercent, resetsAt: null, windowMinutes: 300 },
      { key: 'week', label: 'Week', shortLabel: 'W', usedPercent: 40, resetsAt: null, windowMinutes: 10080 },
    ],
  });

  it('projects minutes to the cap from the burn between two samples', () => {
    // 50% -> 70% over 10 minutes = 2%/min; 30% headroom remains => 15 minutes.
    const curr = sessionSnap(70, NOW);
    const headroom = deriveUsageHeadroom(curr, { capturedAt: NOW - 10 * 60_000, usedPercent: 50 });
    expect(headroom.status).toBe('available');
    expect(headroom.minutesToLimit).toBeCloseTo(15, 5);
  });

  it('reports 0 minutes when a blocking window is already maxed', () => {
    const maxed = sessionSnap(100, NOW);
    expect(deriveUsageHeadroom(maxed, { capturedAt: NOW - 60_000, usedPercent: 90 })).toEqual({
      status: 'rate_limited',
      minutesToLimit: 0,
    });
  });

  it('does not project a cap when usage is flat or falling (a reset / idle)', () => {
    const curr = sessionSnap(50, NOW);
    // Flat since prev: no burn to project from.
    expect(deriveUsageHeadroom(curr, { capturedAt: NOW - 10 * 60_000, usedPercent: 50 }).minutesToLimit).toBeNull();
    // Fell (window reset): also not "projected to cap".
    expect(deriveUsageHeadroom(curr, { capturedAt: NOW - 10 * 60_000, usedPercent: 80 }).minutesToLimit).toBeNull();
  });

  it('has no projection without a prior sample or a session window', () => {
    expect(deriveUsageHeadroom(sessionSnap(60, NOW), null).minutesToLimit).toBeNull();
    const noSession: UsageSnapshot = {
      source: 'live', sourceLabel: 'live', capturedAt: new Date(NOW),
      windows: [{ key: 'week', label: 'Week', shortLabel: 'W', usedPercent: 60, resetsAt: null, windowMinutes: 10080 }],
    };
    expect(deriveUsageHeadroom(noSession, { capturedAt: NOW - 60_000, usedPercent: 10 }).minutesToLimit).toBeNull();
  });

  it('returns a null status for an empty/absent snapshot', () => {
    expect(deriveUsageHeadroom(null)).toEqual({ status: null, minutesToLimit: null });
  });
});

describe('readOnly — the `agents run` routing hot path never blocks on the network', () => {
  // The measured cold-start stall: collectRunCandidates passed maxAgeMs=5min, so
  // a snapshot older than that fell through to a blocking live provider fetch —
  // one HTTP round trip per account added to `agents run` startup. readOnly
  // serves the cache and NEVER fetches. Deterministic + no network: the seam
  // points the cache at a tmpdir and no live call is made on any assertion.
  let cacheDir: string;
  let prevPath: string | null;
  const usageKey = 'claude:org=readonly-test';

  const staleButUnexpired = (): UsageSnapshot => ({
    // Captured 30 minutes ago: far past USAGE_DECISION_MAX_AGE_MS (5min) so the
    // router will treat it as unverified — but the week window has not expired,
    // so deserialization keeps the number rather than zeroing it.
    source: 'live',
    sourceLabel: 'live',
    capturedAt: new Date(Date.now() - 30 * 60 * 1000),
    windows: [
      {
        key: 'week',
        label: 'Current week',
        shortLabel: 'W',
        usedPercent: 91,
        resetsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        windowMinutes: 10080,
      },
    ],
  });

  const claudeInput = () => ({
    agentId: 'claude' as const,
    // A network provider (claude) with a usage key but no reachable token here —
    // so if readOnly wrongly fell through to getUsageInfo it would hit the
    // keychain, fail, and stamp an error; error===null proves the short-circuit.
    info: { usageKey } as unknown as AccountInfo,
  });

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-usage-ro-'));
    prevPath = setClaudeUsageCachePathForTest(path.join(cacheDir, 'claude-usage.json'));
  });

  afterEach(() => {
    setClaudeUsageCachePathForTest(prevPath);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('serves a STALE cached snapshot without a live fetch', async () => {
    writeClaudeUsageCache(usageKey, staleButUnexpired());

    const usage = await getUsageInfoForIdentity(claudeInput());

    // The cache is returned verbatim (no network refetch, no error), even though
    // it is well past the routing freshness bar — routing around it is
    // isUsageVerified's job, not a blocking refresh's.
    expect(usage.snapshot?.windows[0]?.usedPercent).toBe(91);
    expect(usage.error).toBeNull();
  });

  it('reports "stale" for an absent snapshot instead of dialing the provider', async () => {
    const usage = await getUsageInfoForIdentity(claudeInput());

    expect(usage.snapshot).toBeNull();
    expect(usage.error).toBe('stale');
  });

  it('flags an all-expired row as not-collected for --json while still returning the snapshot for the view', async () => {
    // The row from the freeze: a session + week both captured long enough ago
    // that BOTH have expired. deserialize now returns a snapshot (windows empty,
    // last-known on staleWindows) so the TERMINAL view renders the number with
    // its age — but `agents view --json` projects only `windows`, so usageError
    // MUST stay non-null or the row reads as a healthy meterless account and a
    // monitoring consumer loses the staleness signal (the RUSH-2858 case).
    const longAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    writeClaudeUsageCache(usageKey, {
      source: 'live',
      sourceLabel: 'live',
      capturedAt: longAgo,
      windows: [
        { key: 'session', label: 'Session', shortLabel: 'S', usedPercent: 30, resetsAt: new Date(longAgo.getTime() + 5 * 60 * 60 * 1000), windowMinutes: 300 },
        { key: 'week', label: 'Current week', shortLabel: 'W', usedPercent: 91, resetsAt: new Date(longAgo.getTime() + 2 * 24 * 60 * 60 * 1000), windowMinutes: 10080 },
      ],
    });

    const usage = await getUsageInfoForIdentity(claudeInput());

    // --json contract restored: non-null error, empty `windows`.
    expect(usage.error).toBe(USAGE_NOT_COLLECTED_MARKER);
    expect(usage.snapshot?.windows).toEqual([]);
    // ...but the view still has the last-known readings to render with an age.
    expect(usage.snapshot?.staleWindows?.map((w) => w.key)).toEqual(['session', 'week']);
  });

  it('keeps usageError null for a meterless plan-only row (healthy, not stale)', async () => {
    writeClaudeUsageCache(usageKey, {
      source: 'live',
      sourceLabel: 'live',
      capturedAt: new Date(Date.now() - 60 * 60 * 1000),
      plan: 'SuperGrok Heavy',
      windows: [],
    });

    const usage = await getUsageInfoForIdentity(claudeInput());

    expect(usage.error).toBeNull();
    expect(usage.snapshot?.plan).toBe('SuperGrok Heavy');
  });

  it('keeps usageError null for an out-of-credits refusal row (a confirmed state, not "not collected")', async () => {
    noteClaudeOutOfCredits(usageKey);

    const usage = await getUsageInfoForIdentity(claudeInput());

    expect(usage.error).toBeNull();
    expect(usage.snapshot?.unavailable).toEqual({ reason: 'out_of_credits' });
  });
});

describe('expired cached windows are unknown, not 0%', () => {
  // The two-week freeze (2026-08-05..20): Anthropic 429'd every account's
  // usage read, the cache never refreshed, and the deserializer zeroed each
  // expired window but KEPT it — so `agents view` drew "S: 0% (now)" and
  // deriveUsageStatusFromSnapshot said 'available' for accounts that were
  // actually rate-limited (RUSH-2858). Expired windows must be dropped, and an
  // all-expired snapshot must read as no-data so the honest "usage unavailable"
  // path renders instead.
  let cacheDir: string;
  let prevPath: string | null;
  const usageKey = 'claude:org=expired-window-test';

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-usage-exp-'));
    prevPath = setClaudeUsageCachePathForTest(path.join(cacheDir, 'claude-usage.json'));
  });

  afterEach(() => {
    setClaudeUsageCachePathForTest(prevPath);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  const window = (over: Partial<UsageSnapshot['windows'][number]>): UsageSnapshot['windows'][number] => ({
    key: 'week',
    label: 'Current week',
    shortLabel: 'W',
    usedPercent: 91,
    resetsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    windowMinutes: 10080,
    ...over,
  });

  it('drops an expired window and keeps a fresh one', () => {
    writeClaudeUsageCache(usageKey, {
      source: 'live',
      sourceLabel: 'live',
      capturedAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
      windows: [
        // Session window reset an hour ago: whatever burned since is unknown.
        window({ key: 'session', shortLabel: 'S', usedPercent: 100, resetsAt: new Date(Date.now() - 60 * 60 * 1000), windowMinutes: 300 }),
        window({}),
      ],
    });

    const snapshot = readClaudeUsageCache(usageKey);

    expect(snapshot?.windows.map((w) => w.key)).toEqual(['week']);
    expect(snapshot?.windows[0]?.usedPercent).toBe(91);
  });

  it('keeps an all-expired snapshot as last-known windows, out of `windows`', () => {
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    writeClaudeUsageCache(usageKey, {
      source: 'live',
      sourceLabel: 'live',
      capturedAt: twoWeeksAgo,
      windows: [
        window({ key: 'session', shortLabel: 'S', usedPercent: 100, resetsAt: new Date(twoWeeksAgo.getTime() + 5 * 60 * 60 * 1000), windowMinutes: 300 }),
        window({ resetsAt: new Date(twoWeeksAgo.getTime() + 4 * 24 * 60 * 60 * 1000) }),
      ],
    });

    const snapshot = readClaudeUsageCache(usageKey);

    // Routing still sees nothing: no fresh window means the RUSH-2858 property
    // holds — deriveUsageStatusFromSnapshot is null, so it is never "available".
    expect(snapshot?.windows).toEqual([]);
    expect(deriveUsageStatusFromSnapshot(snapshot)).toBeNull();
    // But the last-known readings are preserved for the VIEW to render with age.
    expect(snapshot?.staleWindows?.map((w) => w.key)).toEqual(['session', 'week']);
    expect(snapshot?.staleWindows?.find((w) => w.key === 'session')?.usedPercent).toBe(100);

    // The row survives — there is a last-known number worth showing, so it is
    // NOT pruned the way a truly empty row is.
    const raw = JSON.parse(fs.readFileSync(path.join(cacheDir, 'claude-usage.json'), 'utf-8'));
    expect(raw[usageKey]).toBeDefined();
  });

  it('persists a pre-partitioned staleWindow (Grok) across the cache round-trip', () => {
    // Grok's collector pre-partitions in the fetch: an ended-period reading lands
    // on `staleWindows` with `windows` empty. Serializing only `windows` dropped
    // the number, so the daemon-refreshed cache the next plain `agents view grok`
    // reads rendered the plan alone (no bar), even though `--refresh` had just
    // shown "W: 42%* (stale)". The serializer must persist stale readings too.
    const capturedAt = new Date(Date.now() - 60 * 60 * 1000);
    writeClaudeUsageCache(usageKey, {
      source: 'last_seen',
      sourceLabel: 'last seen in Grok logs',
      capturedAt,
      plan: 'SuperGrok Heavy',
      windows: [],
      staleWindows: [
        window({ key: 'week', shortLabel: 'W', usedPercent: 42, resetsAt: new Date(Date.now() - 3 * 60 * 60 * 1000), windowMinutes: 10080 }),
      ],
    });

    const snapshot = readClaudeUsageCache(usageKey);

    // Routing still sees nothing (no fresh window) — the RUSH-2858 property holds.
    expect(snapshot?.windows).toEqual([]);
    expect(deriveUsageStatusFromSnapshot(snapshot)).toBeNull();
    // But the last-known 42% survives for the view to render with its age.
    expect(snapshot?.staleWindows?.map((w) => w.key)).toEqual(['week']);
    expect(snapshot?.staleWindows?.[0]?.usedPercent).toBe(42);
    expect(snapshot?.plan).toBe('SuperGrok Heavy');
  });

  it('keeps a meterless plan-only row so the cached read matches the refreshed one', () => {
    // The exact row Grok's collector writes: a subscription tier and no meters.
    // Dropping it made `agents view grok` print "usage unavailable" on the read
    // immediately after a successful `--refresh`, and pruned the row as a bonus.
    writeClaudeUsageCache(usageKey, {
      source: 'live',
      sourceLabel: 'live',
      capturedAt: new Date(Date.now() - 60 * 60 * 1000),
      plan: 'SuperGrok Heavy',
      windows: [],
    });

    const snapshot = readClaudeUsageCache(usageKey);

    expect(snapshot?.plan).toBe('SuperGrok Heavy');
    expect(snapshot?.windows).toEqual([]);
    // No windows means no throttle claim either way — never a fake 0% bar.
    expect(deriveUsageStatusFromSnapshot(snapshot)).toBeNull();
    expect(formatUsageSummary(snapshot?.plan ?? null, snapshot)).toBe('SuperGrok Heavy');

    // The row survives the read that used to delete it.
    const raw = JSON.parse(fs.readFileSync(path.join(cacheDir, 'claude-usage.json'), 'utf-8'));
    expect(raw[usageKey]?.plan).toBe('SuperGrok Heavy');
  });

  it('renders a stale claude session window as the last-known value with its age', () => {
    // The freeze case: the 5h session window was last read 6h ago and never
    // refreshed (Anthropic 429'd the usage endpoint), so it expired; the weekly
    // window is still fresh. The view must show the last session number + age,
    // not "S: ┄┄┄┄┄ unavailable".
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
    writeClaudeUsageCache(usageKey, {
      source: 'live',
      sourceLabel: 'live',
      capturedAt: sixHoursAgo,
      windows: [
        // Session captured 6h ago: its 5h window (300m) has aged out.
        window({ key: 'session', shortLabel: 'S', usedPercent: 30, resetsAt: new Date(sixHoursAgo.getTime() + 5 * 60 * 60 * 1000), windowMinutes: 300 }),
        // Weekly still fresh (resets 3d out).
        window({ key: 'week', shortLabel: 'W', usedPercent: 62 }),
      ],
    });

    const snapshot = readClaudeUsageCache(usageKey);
    expect(snapshot?.windows.map((w) => w.key)).toEqual(['week']);
    expect(snapshot?.staleWindows?.map((w) => w.key)).toEqual(['session']);

    const rendered = formatUsageSummary(null, snapshot, 3, {
      expectedWindows: [
        { key: 'session', shortLabel: 'S' },
        { key: 'week', shortLabel: 'W' },
      ],
    });
    // The last-known session number is visible with its capture age, and the
    // fresh weekly bar renders normally beside it.
    expect(rendered).toContain('S:');
    expect(rendered).toContain('30%');
    expect(rendered).toContain('6h old');
    expect(rendered).not.toContain('unavailable');
    expect(rendered).toContain('W:');
    expect(rendered).toContain('62%');
  });

  it('still drops a row with neither windows, a refusal, nor a plan', () => {
    writeClaudeUsageCache(usageKey, {
      source: 'live',
      sourceLabel: 'live',
      capturedAt: new Date(Date.now() - 60 * 60 * 1000),
      windows: [],
    });

    expect(readClaudeUsageCache(usageKey)).toBeNull();
    const raw = JSON.parse(fs.readFileSync(path.join(cacheDir, 'claude-usage.json'), 'utf-8'));
    expect(raw[usageKey]).toBeUndefined();
  });
});

describe('observed Claude session limits', () => {
  let cacheDir: string;
  let prevPath: string | null;
  const usageKey = 'claude:org=session-limited-test';

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-session-limit-'));
    prevPath = setClaudeUsageCachePathForTest(path.join(cacheDir, 'claude-usage.json'));
  });

  afterEach(() => {
    setClaudeUsageCachePathForTest(prevPath);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('parses the real Claude refusal and persists it independently of usage windows', () => {
    const now = Date.parse('2026-08-20T17:00:00-07:00');
    const reset = parseClaudeSessionLimitReset(
      "You've hit your session limit · resets 6:20pm (America/Los_Angeles)",
      now,
    );
    expect(reset?.toISOString()).toBe('2026-08-21T01:20:00.000Z');

    const persistedReset = new Date(Date.now() + 60 * 60 * 1000);
    noteClaudeSessionLimit(usageKey, persistedReset);
    const snapshot = readClaudeUsageCache(usageKey, undefined, new Date(now));
    expect(snapshot?.windows).toEqual([]);
    expect(snapshot?.unavailable).toEqual({ reason: 'session_limit', resetsAt: persistedReset });
    expect(deriveUsageStatusFromSnapshot(snapshot)).toBe('rate_limited');
    expect(formatUsageSummary('Max', snapshot)).toContain('session-limited');
  });

  it('drops the observed limit after its reset', () => {
    const reset = new Date(NOW + 60_000);
    noteClaudeSessionLimit(usageKey, reset);
    expect(readClaudeUsageCache(usageKey, undefined, new Date(NOW + 60_001))).toBeNull();
  });

  it('stale expiry cleanup cannot erase a newer session-limit write', () => {
    const reset = new Date(Date.now() + 60 * 60 * 1000);
    noteClaudeSessionLimit(usageKey, reset);

    // Models a reader that observed an expired row before the real-run writer
    // replaced it: cleanup executes afterward and must re-read under its lock.
    pruneExpiredClaudeUsageCacheEntry(usageKey, undefined, new Date());

    expect(readClaudeUsageCache(usageKey)?.unavailable).toEqual({
      reason: 'session_limit',
      resetsAt: reset,
    });
  });
});

describe('per-model Claude refusal tracking (PHNX-3940)', () => {
  let cacheDir: string;
  let prevPath: string | null;
  const accountA = 'native:acct-a';
  const accountB = 'native:acct-b';

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-model-refusal-'));
    prevPath = setClaudeUsageCachePathForTest(path.join(cacheDir, 'claude-usage.json'));
  });

  afterEach(() => {
    setClaudeUsageCachePathForTest(prevPath);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('parses the exact real Fable refusal text', () => {
    const refusal = parseClaudeModelRefusal(
      "You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.",
    );
    expect(refusal).toEqual({ family: 'Fable' });
  });

  it('does not match unrelated text mentioning /usage-credits', () => {
    expect(parseClaudeModelRefusal('See /usage-credits for details on your plan.')).toBeNull();
  });

  it('A/Fable is blocked while A/Sonnet and B/Fable (same org) stay eligible', () => {
    noteClaudeModelRefusal(accountA, 'fable', { family: 'Fable' });

    expect(getClaudeModelRefusal(accountA, 'fable')).toEqual({ family: 'Fable', resetsAt: null });
    // A different model on the SAME account is unaffected.
    expect(getClaudeModelRefusal(accountA, 'sonnet')).toBeNull();
    // A different account — even one that would share an org-scoped usageKey —
    // is unaffected: the marker is keyed on the caller-supplied account key,
    // never a shared org bucket.
    expect(getClaudeModelRefusal(accountB, 'fable')).toBeNull();
  });

  it('a clock-bearing refusal expires; a clock-less one stays sticky', () => {
    const resetsAt = new Date(Date.now() + 60_000);
    noteClaudeModelRefusal(accountA, 'fable', { family: 'Fable', resetsAt });
    expect(getClaudeModelRefusal(accountA, 'fable', Date.now())).not.toBeNull();
    expect(getClaudeModelRefusal(accountA, 'fable', resetsAt.getTime() + 1)).toBeNull();

    noteClaudeModelRefusal(accountA, 'opus', { family: 'Opus' });
    // No resetsAt was given — never invent one, and it must not auto-expire.
    expect(getClaudeModelRefusal(accountA, 'opus', Date.now() + 365 * 24 * 60 * 60 * 1000)).toEqual({
      family: 'Opus',
      resetsAt: null,
    });
  });

  it('clearing one (account, model) leaves a sibling model on the same account untouched', () => {
    noteClaudeModelRefusal(accountA, 'fable', { family: 'Fable' });
    noteClaudeModelRefusal(accountA, 'opus', { family: 'Opus' });

    clearClaudeModelRefusal(accountA, 'fable');

    expect(getClaudeModelRefusal(accountA, 'fable')).toBeNull();
    expect(getClaudeModelRefusal(accountA, 'opus')).toEqual({ family: 'Opus', resetsAt: null });
  });

  it('clearing an account with no refusal is a no-op', () => {
    expect(() => clearClaudeModelRefusal(accountA, 'fable')).not.toThrow();
    expect(getClaudeModelRefusal(accountA, 'fable')).toBeNull();
  });

  it('a model-refusal-only row survives readClaudeUsageCache retention (no windows, no plan)', () => {
    noteClaudeModelRefusal(accountA, 'fable', { family: 'Fable' });
    // The row carries nothing but the model refusal — must not be treated as
    // an empty/prunable row the way a truly-empty cache entry is.
    expect(readClaudeUsageCache(accountA)).not.toBeNull();
    expect(getClaudeModelRefusal(accountA, 'fable')).toEqual({ family: 'Fable', resetsAt: null });
  });

  it('survives a full writeClaudeUsageCache overwrite of the same account row', () => {
    noteClaudeModelRefusal(accountA, 'fable', { family: 'Fable' });

    writeClaudeUsageCache(accountA, {
      source: 'live',
      sourceLabel: 'live',
      capturedAt: new Date(),
      windows: [
        { key: 'week', label: 'Current week', shortLabel: 'W', usedPercent: 10, resetsAt: new Date(Date.now() + 60_000), windowMinutes: 10080 },
      ],
    });

    expect(getClaudeModelRefusal(accountA, 'fable')).toEqual({ family: 'Fable', resetsAt: null });
  });

  it('survives a partial mergeClaudeUsageCacheWindows update of the same account row', () => {
    noteClaudeModelRefusal(accountA, 'fable', { family: 'Fable' });

    mergeClaudeUsageCacheWindows(accountA, {
      source: 'live',
      sourceLabel: 'live',
      capturedAt: new Date(),
      windows: [
        { key: 'session', label: 'Session', shortLabel: 'S', usedPercent: 5, resetsAt: new Date(Date.now() + 60_000), windowMinutes: 300 },
      ],
    });

    expect(getClaudeModelRefusal(accountA, 'fable')).toEqual({ family: 'Fable', resetsAt: null });
  });
});

describe('explicit refresh publication', () => {
  let cacheDir: string;
  let home: string;
  let prevPath: string | null;

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-usage-publish-'));
    home = path.join(cacheDir, 'home');
    fs.mkdirSync(path.join(home, '.grok', 'logs'), { recursive: true });
    prevPath = setClaudeUsageCachePathForTest(path.join(cacheDir, 'usage.json'));
  });

  afterEach(() => {
    setClaudeUsageCachePathForTest(prevPath);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('publishes a local-log snapshot for the next cache-only reader', async () => {
    const now = Date.now();
    fs.writeFileSync(path.join(home, '.grok', 'logs', 'unified.jsonl'), JSON.stringify({
      ts: new Date(now - 60 * 60_000).toISOString(),
      msg: 'billing: fetched credits config',
      ctx: {
        config: {
          creditUsagePercent: 37,
          currentPeriod: {
            type: 'USAGE_PERIOD_TYPE_WEEKLY',
            start: new Date(now - 24 * 60 * 60_000).toISOString(),
            end: new Date(now + 6 * 24 * 60 * 60_000).toISOString(),
          },
        },
        subscriptionTier: 'SuperGrok Heavy',
      },
    }) + '\n');

    const input = {
      agentId: 'grok' as const,
      home,
      cliVersion: null,
      info: { usageKey: 'grok:user=publication-test' } as AccountInfo,
    };
    const refreshed = await getUsageInfoForIdentity(input, { forceRefresh: true });
    const cached = await getUsageInfoForIdentity(input);

    expect(refreshed.snapshot?.source).toBe('last_seen');
    expect(cached.snapshot?.windows.find((window) => window.key === 'week')?.usedPercent).toBe(37);
    expect(cached.error).toBeNull();
  });

  it('exposes the live refresh result for Kimi even when the cache is empty (RUSH-3198)', async () => {
    const credDir = path.join(home, '.kimi-code', 'credentials');
    fs.mkdirSync(credDir, { recursive: true });
    fs.writeFileSync(
      path.join(credDir, 'kimi-code.json'),
      JSON.stringify({ access_token: 'tok-expired', expires_at: Math.floor(Date.now() / 1000) - 60 }),
    );

    const input = {
      agentId: 'kimi' as const,
      home,
      cliVersion: '0.32.0',
      info: { usageKey: 'kimi:user=rush-3198-test' } as AccountInfo,
    };

    const cached = await getUsageInfoForIdentity(input);
    const refreshed = await getUsageInfoForIdentity(input, { forceRefresh: true });

    expect(cached.snapshot).toBeNull();
    expect(cached.error).toBe('stale');
    expect(refreshed.error).toContain('run Kimi once');
    expect(refreshed.error).toContain('Kimi credential expired');
  });
});

describe.skipIf(!fileBacked)('a Claude usage read reports WHY it produced no snapshot', () => {
  // Both of these returned `error: null` before, which is what let an account
  // nobody could read render exactly like a healthy one: the caller fell back to
  // the SWR cache and drew its bars as fact. On yosemite-s1 that hid five
  // accounts whose stored token had expired — one of them eleven days earlier —
  // behind a cache frozen for 26h, and balanced routing launched into an account
  // that was already at its weekly cap.
  //
  // Neither path reaches the network: both return before the fetch, so these
  // exercise the real code path with no live call.

  let home: string;
  useFreshSecretsHome(); // the store holds exactly what each test seeds — nothing else

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-usage-err-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('names a missing credential instead of returning a silent null', async () => {
    const usage = await getUsageInfo('claude', { home });

    expect(usage.snapshot).toBeNull();
    expect(usage.error).toBe(usageNoClaudeUsageCredentialError());
  });

  it('reports unprovisioned even when an interactive login is present — the probe never reads it', async () => {
    // A usage read authenticates only with a file-based setup-token and never
    // touches Claude Code's interactive login (reading it and firing it at
    // api.anthropic.com is what got the token revoked — RUSH-1822). So an account
    // with only an interactive credential (here an expired one) reads the same as
    // an empty home: no usable PROBE credential, unprovisioned.
    setKeychainTokenSync(
      getClaudeKeychainService(home),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'tok-stale', refreshToken: 'r', expiresAt: Date.now() - 60_000 },
      })
    );

    const usage = await getUsageInfo('claude', { home });

    expect(usage.snapshot).toBeNull();
    expect(usage.error).toBe(usageNoClaudeUsageCredentialError());
    // The message must not send this operator back to a login they already
    // have: this account IS signed in and the reader still cannot use it
    // (#2987). The shared wording ("sign in, or provision a long-lived token")
    // is why the reported remedy loop existed.
    expect(usage.error).not.toContain('sign in');
    expect(classifyUsageErrorKind(usage.error)).toBe('no-usage-credential');
  });

  it('WITH allowInteractiveLogin, an EXPIRED interactive login is read but reported expired — never refreshed (USAGE-READ-1)', async () => {
    // The personal-device path (allowInteractiveLogin) DOES read the interactive
    // login — proven here because the error flips from "no-usage-credential" to
    // "expired-credential": getClaudeUsageInfo got PAST the missing-credential
    // branch to the token-freshness check. And it still never rotates the
    // single-use refresh token to read usage (RUSH-1822). Stays offline: an
    // expired token returns before the fetch.
    setKeychainTokenSync(
      getClaudeKeychainService(home),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'tok-stale', refreshToken: 'r', expiresAt: Date.now() - 60_000 },
      })
    );

    const usage = await getUsageInfo('claude', { home, allowInteractiveLogin: true });

    expect(usage.snapshot).toBeNull();
    expect(usage.error).toBe(usageExpiredCredentialError('Claude'));
    expect(classifyUsageErrorKind(usage.error)).toBe('expired-credential');
  });

  it('does NOT read the interactive login when allowInteractiveLogin is unset (background default, RUSH-1822)', async () => {
    // Same expired-login home, no flag: stays unprovisioned — the interactive
    // credential is untouched for every background caller. This is the guarantee
    // that stopped the fleet-wide logouts.
    setKeychainTokenSync(
      getClaudeKeychainService(home),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'tok-stale', refreshToken: 'r', expiresAt: Date.now() - 60_000 },
      })
    );

    const usage = await getUsageInfo('claude', { home });

    expect(usage.snapshot).toBeNull();
    expect(usage.error).toBe(usageNoClaudeUsageCredentialError());
  });
});

describe('formatUsageSummary marks bars the live read could not confirm', () => {
  const snapshot = {
    source: 'cache' as const,
    sourceLabel: 'cached',
    capturedAt: new Date(NOW),
    windows: [
      { key: 'week' as const, label: 'Current week', shortLabel: 'W', usedPercent: 48, resetsAt: null, windowMinutes: 10080 },
    ],
  };

  it('draws the bars AND says they are unverified', () => {
    // The incident in one assertion: a cached "48%" must never render the same
    // as a confirmed one. The number still shows — it is the last thing we saw,
    // and hiding it would be worse — but it no longer reads as current.
    const out = formatUsageSummary(null, snapshot, 3, { unverified: true });

    expect(out).toContain('48%');
    expect(out).toContain('unverified');
  });

  it('stays clean when the reading was confirmed', () => {
    const out = formatUsageSummary(null, snapshot, 3);

    expect(out).toContain('48%');
    expect(out).not.toContain('unverified');
  });

  it('names the headless scope gap instead of unverified (RUSH-2392)', () => {
    // Setup-token accounts used to read as "unverified" — the worst-looking
    // state for the best-provisioned headless credentials. Prefer the scope
    // phrase so operators do not re-mint.
    const out = formatUsageSummary(null, snapshot, 3, { headless: true, unverified: true });

    expect(out).toContain('48%');
    expect(out).toContain(USAGE_HEADLESS_SCOPE_MARKER);
    expect(out).not.toContain('unverified');
  });

  it('shows the headless marker with no bars when usage cannot populate', () => {
    const out = formatUsageSummary(null, null, 3, { headless: true, unavailable: true });

    expect(out).toContain(USAGE_HEADLESS_SCOPE_MARKER);
    // Prefer the headless phrase over the bare generic "usage unavailable".
    expect(out).toContain('(headless)');
    expect(out).not.toMatch(/usage unavailable(?! \(headless\))/);
  });

  it.each([
    [usageExpiredCredentialError('Claude'), 're-auth for usage'],
    [usageExpiredCredentialError('Cursor'), 're-auth for usage'],
    [usageExpiredKimiCredentialError(), 'run Kimi once'],
    [usageNoCredentialError('Cursor'), 'sign in / provision token'],
  ])('renders the specific unavailable state from %s', (error, expected) => {
    const out = formatUsageSummary(null, null, 3, {
      unavailable: true,
      errorKind: classifyUsageErrorKind(error),
      errorDetail: error,
    });

    expect(out).toContain(expected);
    expect(out).not.toContain('usage unavailable');
  });

  it('classifies the Kimi expired-credential error as expired-credential', () => {
    const error = usageExpiredKimiCredentialError();
    expect(classifyUsageErrorKind(error)).toBe('expired-credential');
    expect(error).toContain('run Kimi once');
    expect(error).not.toContain('re-auth');
  });

  it('renders no recent usage as a benign state without an unavailable flag', () => {
    const out = formatUsageSummary(null, null, 3, { benignState: 'no-recent-usage' });

    expect(out).toContain('no usage recorded yet');
    expect(out).not.toContain('usage unavailable');
  });

  it('renders a recorded Retry-After as a compact rate-limit hint', () => {
    const error = 'Muse rate-limited this machine; not retrying for 12m.';
    const out = formatUsageSummary(null, null, 3, {
      unavailable: true,
      errorKind: classifyUsageErrorKind(error),
      errorDetail: error,
    });

    expect(out).toContain('rate-limited (retry ~12m)');
  });
});

describe('formatUsageSummary expected window slots', () => {
  const expectedWindows = [
    { key: 'session', shortLabel: 'S' },
    { key: 'week', shortLabel: 'W' },
  ];
  const base = {
    source: 'cache' as const,
    sourceLabel: 'cached',
    capturedAt: new Date(NOW),
  };

  it('renders a neutral missing session slot and keeps the week column aligned', () => {
    const weekOnly = formatUsageSummary(null, {
      ...base,
      windows: [{ key: 'week' as const, label: 'Week', shortLabel: 'W', usedPercent: 81, resetsAt: null, windowMinutes: 10080 }],
    }, 3, { expectedWindows });
    const both = formatUsageSummary(null, {
      ...base,
      windows: [
        { key: 'session' as const, label: 'Session', shortLabel: 'S', usedPercent: 12, resetsAt: null, windowMinutes: 300 },
        { key: 'week' as const, label: 'Week', shortLabel: 'W', usedPercent: 38, resetsAt: null, windowMinutes: 10080 },
      ],
    }, 3, { expectedWindows });

    expect(weekOnly).toContain('S: ┄┄┄┄┄ unavailable');
    expect(weekOnly.indexOf('W:')).toBe(both.indexOf('W:'));
  });

  it('distinguishes a real zero-percent window from a missing window', () => {
    const rendered = formatUsageSummary(null, {
      ...base,
      windows: [{ key: 'session' as const, label: 'Session', shortLabel: 'S', usedPercent: 0, resetsAt: null, windowMinutes: 300 }],
    }, 3, { expectedWindows });
    expect(rendered).toContain('S: ░░░░░ 0%');
    expect(rendered).toContain('W: ┄┄┄┄┄ unavailable');
  });
});

describe('shared network usage failure classification', () => {
  let dir: string;
  let prevPath: string | null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-shared-usage-failure-'));
    prevPath = setUsageBackoffDirForTest(dir);
  });

  afterEach(() => {
    setUsageBackoffDirForTest(prevPath);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['antigravity' as const, 'Antigravity'],
    ['muse' as const, 'Muse'],
  ])('records %s 429 backoff and returns a specific error', (agentId, agent) => {
    const error = classifyUsageFetchFailure(agent, agentId, 429, '120', 'account-1');

    expect(error).toBe(usageRejectedError(agent, 429));
    expect(usageRateLimitedUntil(agentId, Date.now(), 'account-1')).not.toBeNull();
  });
});

describe('Claude setup-token usage-scope detection (RUSH-2392)', () => {
  it('detects Anthropic user:profile scope denials on 403', () => {
    const body =
      '{"type":"error","error":{"type":"permission_error","message":"OAuth token does not meet scope requirement user:profile"}}';
    expect(isClaudeUsageScopeDenied(403, body)).toBe(true);
    expect(isClaudeUsageScopeDenied(403, 'scope requirement missing')).toBe(true);
  });

  it('does not treat bare 403 or other statuses as the scope gap', () => {
    expect(isClaudeUsageScopeDenied(403, '')).toBe(false);
    expect(isClaudeUsageScopeDenied(403, null)).toBe(false);
    expect(isClaudeUsageScopeDenied(401, 'user:profile')).toBe(false);
    expect(isClaudeUsageScopeDenied(200, 'user:profile')).toBe(false);
    expect(isClaudeUsageScopeDenied(403, 'forbidden')).toBe(false);
  });

  it('builds a detectable headless-scope error string', () => {
    const err = usageHeadlessScopeError('Claude');
    expect(isUsageHeadlessScopeError(err)).toBe(true);
    expect(err).toContain(USAGE_HEADLESS_SCOPE_MARKER);
    expect(err).toContain('user:profile');
    expect(isUsageHeadlessScopeError(usageRejectedError('Claude', 403))).toBe(false);
  });
});

describe('every networked provider names the same three failures', () => {
  // The review that caught this: wiring only Claude would leave `agents view
  // --refresh` reporting Claude accounts while silently presenting stale Kimi,
  // Droid, and Cursor readings as confirmed — all four share one cache fallback
  // in getUsageInfoForIdentity, so a silent null in any of them reproduces the
  // exact bug this change exists to close.
  const NETWORKED = ['Claude', 'Kimi', 'Droid', 'Cursor'];

  it('says which agent could not be read, so a fleet row is actionable', () => {
    for (const agent of NETWORKED) {
      expect(usageNoCredentialError(agent)).toContain(agent);
      expect(usageExpiredCredentialError(agent)).toContain(agent);
      expect(usageRejectedError(agent, 401)).toContain(agent);
    }
  });

  it('distinguishes a rejected read from a throttled one', () => {
    // 429 is the machine being rate-limited on the usage endpoint, not a dead
    // credential — re-authing would not fix it, so the two must not read alike.
    expect(usageRejectedError('Claude', 429)).toContain('429');
    expect(usageRejectedError('Claude', 429)).toContain('rate-limiting');
    expect(usageRejectedError('Claude', 401)).toContain('401');
    expect(usageRejectedError('Claude', 401)).not.toContain('rate-limiting');
  });

  it('says an expired credential will not heal on its own', () => {
    // The yosemite-s1 state: a usage read never refreshes, so the account stays
    // unreadable until the agent itself runs. The message has to say so, or the
    // obvious next action (re-auth) is not obvious.
    expect(usageExpiredCredentialError('Droid')).toContain('never refreshes');
    expect(usageExpiredKimiCredentialError()).toContain('never refreshes');
  });
});

describe('a usage read that THROWS is still a failed read', () => {
  // The re-review caught this: every provider swallowed a thrown request into
  // `error: null`, so a timeout, a TLS failure, or a payload that will not parse
  // handed the caller a stale snapshot to render as confirmed — the same silence
  // as an expired token, through a different door.
  //
  // Driven through a real provider fetch (Kimi) with a credential file that
  // cannot be parsed: JSON.parse throws inside the try, so the catch is the code
  // under test and no network call is made.
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-usage-throw-'));
    const dir = path.join(home, '.kimi-code', 'credentials');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'kimi-code.json'), '{ not json');
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('names the agent and carries the cause, instead of returning null', async () => {
    const usage = await getUsageInfo('kimi', { home });

    expect(usage.snapshot).toBeNull();
    expect(usage.error).toBeTruthy();
    expect(usage.error).toContain('Kimi');
  });
});

describe('a recorded Retry-After actually suppresses the read', () => {
  /** Keychain backend holding exactly what the test seeds — nothing else. */

  // End-to-end through the real getUsageInfo path: with a penalty recorded, the
  // read must return the throttled error WITHOUT making a request. That is the
  // whole fix — the old code fired again 3 minutes into a 45-minute window and
  // re-armed the penalty, so the box never recovered and its cache froze.
  let home: string;
  let dir: string;
  let prevPath: string | null;
  useFreshSecretsHome();

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-throttle-'));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-throttle-cache-'));
    prevPath = setUsageBackoffDirForTest(dir);
  });

  afterEach(() => {
    setUsageBackoffDirForTest(prevPath);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('short-circuits the usage read while the window is open', async () => {
    // A HEALTHY probe credential — this is the case that matters. The credential
    // checks ahead of the guard make no request, so they run first and correctly
    // win for a home that has none; the guard exists to stop the request that a
    // good credential would otherwise make into a live penalty. The probe reads
    // only a file-based setup-token (never the interactive login — RUSH-1822), so
    // provision one here.
    const EMAIL = 'throttle@trp.so';
    const KEY = 'CLAUDE_CODE_OAUTH_TOKEN_THROTTLE_AT_TRP_DOT_SO';
    writeBundleWithItemsSync(
      { name: 'auth', backend: 'file', policy: 'never', vars: { [KEY]: keychainRef(KEY) }, meta: { [KEY]: { type: 'token' } } },
      new Map([[secretsKeychainItem('auth', KEY), 'sk-ant-oat01-throttle-tok-xyz']]),
    );
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude', '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: EMAIL } }),
    );
    // The exact header the endpoint sent on yosemite-s1.
    noteUsageRateLimited('claude', '2678');

    const usage = await getUsageInfo('claude', { home });

    expect(usage.snapshot).toBeNull();
    expect(usage.error).toContain('rate-limited this machine');
    expect(usage.error).toContain('not retrying');
  });

  it('lets the read through once the window has passed', async () => {
    noteUsageRateLimited('claude', '1', { now: Date.now() - 60_000 });

    const usage = await getUsageInfo('claude', { home });

    // Falls through to the ordinary credential check for this empty home.
    expect(usage.error).toBe(usageNoClaudeUsageCredentialError());
  });
});

describe('the throttle guard is exercised beyond Claude', () => {
  // The review that forced this: with only Claude tested, two real bugs got
  // through — Cursor's error `return` was left unconditional by a braceless
  // `if` (so every 200 would have failed), and Kimi's probe guard sat AHEAD of
  // its missing/expired credential checks, misreporting a broken credential as
  // merely throttled.
  //
  // What this actually covers is Claude and Kimi end-to-end, not all four. Droid
  // and Cursor are guarded and recorded identically (see the four
  // usageRateLimitedUntil / noteUsageRateLimited pairs in usage.ts) but are not
  // driven here: Droid's credential is AES-GCM encrypted with an on-disk key, so
  // there is no cheap way to seed one without mocking, which this repo does not
  // do. Naming that is better than a describe() title implying coverage that is
  // not present.
  let home: string;
  let dir: string;
  let prevPath: string | null;
  let prevRealHome: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-throttle-all-'));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-throttle-all-cache-'));
    prevPath = setUsageBackoffDirForTest(dir);
    // resolveKimiCredentialPath falls back to the ACTIVE home when the
    // per-version one is absent (sign-in is account-global), so without this the
    // "missing credential" case finds the developer's real Kimi login and the
    // test passes for the wrong reason. AGENTS_REAL_HOME is the seam the code
    // itself reads.
    prevRealHome = process.env.AGENTS_REAL_HOME;
    process.env.AGENTS_REAL_HOME = home;
  });

  afterEach(() => {
    setUsageBackoffDirForTest(prevPath);
    if (prevRealHome === undefined) delete process.env.AGENTS_REAL_HOME;
    else process.env.AGENTS_REAL_HOME = prevRealHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A real, unexpired Kimi credential at the path the resolver looks for. */
  const seedKimi = () => {
    const credDir = path.join(home, '.kimi-code', 'credentials');
    fs.mkdirSync(credDir, { recursive: true });
    fs.writeFileSync(
      path.join(credDir, 'kimi-code.json'),
      JSON.stringify({ access_token: 'tok-fresh', expires_at: Math.floor(Date.now() / 1000) + 3600 }),
    );
  };

  it('suppresses the Kimi usage read while its window is open', async () => {
    seedKimi();
    noteUsageRateLimited('kimi', '2678');

    const usage = await getUsageInfo('kimi', { home });

    expect(usage.snapshot).toBeNull();
    expect(usage.error).toContain('Kimi rate-limited this machine');
  });

  it('tells the user to run Kimi once when its credential is expired (RUSH-3198)', async () => {
    const credDir = path.join(home, '.kimi-code', 'credentials');
    fs.mkdirSync(credDir, { recursive: true });
    fs.writeFileSync(
      path.join(credDir, 'kimi-code.json'),
      JSON.stringify({ access_token: 'tok-expired', expires_at: Math.floor(Date.now() / 1000) - 60 }),
    );

    const usage = await getUsageInfo('kimi', { home });

    expect(usage.snapshot).toBeNull();
    expect(usage.error).toContain('run Kimi once');
    expect(usage.error).not.toContain('re-auth');
  });

  it('does not let a throttle mask a missing Kimi credential in the probe', async () => {
    // The misplacement the reviewer caught: with the guard ahead of the local
    // checks, this returned 429/present and the account read as merely
    // throttled rather than unconfigured.
    noteUsageRateLimited('kimi', '2678');

    const probe = await probeKimiStatus(home);

    expect(probe.token).toBe('missing');
    expect(probe.status).toBeNull();
  });

  it('reports the throttle from the Kimi probe when the credential IS good', async () => {
    seedKimi();
    noteUsageRateLimited('kimi', '2678');

    const probe = await probeKimiStatus(home);

    // 429 without a request: the recorded window is the answer.
    expect(probe.status).toBe(429);
    expect(probe.token).toBe('present');
  });

  it('does not let a throttle mask a missing Claude credential in the probe', async () => {
    noteUsageRateLimited('claude', '2678');

    const probe = await probeClaudeStatus(home);

    expect(probe.token).toBe('missing');
  });

  it("keeps one provider's penalty out of another's read", async () => {
    seedKimi();
    noteUsageRateLimited('claude', '2678');

    const usage = await getUsageInfo('kimi', { home });

    // Kimi is free; it fails on its own terms (a live call it cannot complete
    // in the test environment), never with Claude's throttle message.
    expect(usage.error ?? '').not.toContain('rate-limited this machine');
  });
});

// RUSH-3040: usage.ts's error scheme was written for "four networked
// providers" (Claude/Kimi/Droid/Cursor) and Antigravity/Muse were added later
// with `error: null` on EVERY failure — an unreadable account was
// indistinguishable from a healthy one with nothing to show. These cover the
// no-credential and throttle-short-circuit paths for both, which need no live
// network call (mirrors the Kimi/Claude pattern above — this repo does not
// mock).
describe('Antigravity and Muse get the same error scheme as the four original providers', () => {
  let home: string;
  let dir: string;
  let prevPath: string | null;
  let prevRealHome: string | undefined;
  let prevNoKeychainProbe: string | undefined;
  let prevMetaKey: string | undefined;
  let prevModelKey: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-agy-muse-'));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-agy-muse-cache-'));
    prevPath = setUsageBackoffDirForTest(dir);
    prevRealHome = process.env.AGENTS_REAL_HOME;
    process.env.AGENTS_REAL_HOME = home;
    // Antigravity falls back to an OS keyring probe when no file credential
    // exists; without this guard, "no credential" finds the developer's real
    // login on a dev machine and the test passes for the wrong reason.
    prevNoKeychainProbe = process.env.AGENTS_NO_KEYCHAIN_PROBE;
    process.env.AGENTS_NO_KEYCHAIN_PROBE = '1';
    // Muse resolves a key from the environment before it looks at
    // ~/.config/muse/auth.json — clear both so "no credential" is genuine.
    prevMetaKey = process.env.META_API_KEY;
    prevModelKey = process.env.MODEL_API_KEY;
    delete process.env.META_API_KEY;
    delete process.env.MODEL_API_KEY;
  });

  afterEach(() => {
    setUsageBackoffDirForTest(prevPath);
    if (prevRealHome === undefined) delete process.env.AGENTS_REAL_HOME;
    else process.env.AGENTS_REAL_HOME = prevRealHome;
    if (prevNoKeychainProbe === undefined) delete process.env.AGENTS_NO_KEYCHAIN_PROBE;
    else process.env.AGENTS_NO_KEYCHAIN_PROBE = prevNoKeychainProbe;
    if (prevMetaKey === undefined) delete process.env.META_API_KEY;
    else process.env.META_API_KEY = prevMetaKey;
    if (prevModelKey === undefined) delete process.env.MODEL_API_KEY;
    else process.env.MODEL_API_KEY = prevModelKey;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A real, unexpired Antigravity `agy` OAuth credential at the file path the resolver looks for. */
  const seedAntigravity = () => {
    const credDir = path.join(home, '.gemini', 'antigravity-cli');
    fs.mkdirSync(credDir, { recursive: true });
    fs.writeFileSync(
      path.join(credDir, 'antigravity-oauth-token'),
      JSON.stringify({
        token: {
          access_token: 'agy-tok-fresh',
          refresh_token: 'agy-refresh-fresh',
          expiry: new Date(Date.now() + 3600_000).toISOString(),
        },
      }),
    );
  };

  it('reports a specific no-credential error for Antigravity, not silent null', async () => {
    const usage = await getUsageInfo('antigravity', { home });
    expect(usage.snapshot).toBeNull();
    expect(usage.error).toBe(usageNoCredentialError('Antigravity'));
  });

  it('suppresses the Antigravity usage read while its window is open (no network call needed)', async () => {
    seedAntigravity();
    noteUsageRateLimited('antigravity', '2678');

    const usage = await getUsageInfo('antigravity', { home });

    expect(usage.snapshot).toBeNull();
    expect(usage.error).toContain('Antigravity rate-limited this machine');
  });

  it('reports a specific no-credential error for Muse when no key and no local log exist', async () => {
    const usage = await getUsageInfo('muse', { home });
    expect(usage.snapshot).toBeNull();
    expect(usage.error).toBe(usageNoCredentialError('Muse'));
  });

  it('suppresses the Muse live probe while throttled but still reads the local session log', async () => {
    process.env.META_API_KEY = 'muse-key-fresh';
    const sessDir = path.join(home, '.local', 'share', 'muse', 'sessions', 's1');
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessDir, 'session.jsonl'),
      JSON.stringify({
        payload: { event: { kind: 'model_completed', usage: { input_tokens: 1000, output_tokens: 500 } } },
      }) + '\n',
    );
    noteUsageRateLimited('muse', '2678');

    const usage = await getUsageInfo('muse', { home });

    // The throttle only blocks the live probe — the local fallback still works.
    expect(usage.error).toBeNull();
    expect(usage.snapshot).not.toBeNull();
  });

  it('reports the throttle for Muse only once every source (live AND local log) is empty', async () => {
    process.env.META_API_KEY = 'muse-key-fresh';
    noteUsageRateLimited('muse', '2678');

    const usage = await getUsageInfo('muse', { home });

    expect(usage.snapshot).toBeNull();
    expect(usage.error).toContain('Muse rate-limited this machine');
  });
});

describe('classifyUsageFetchFailure — shared Antigravity/Muse classification + 429 backoff', () => {
  let dir: string;
  let prevPath: string | null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-classify-fetch-'));
    prevPath = setUsageBackoffDirForTest(dir);
  });

  afterEach(() => {
    setUsageBackoffDirForTest(prevPath);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('notes the 429 backoff and returns the rejected-429 message', () => {
    const message = classifyUsageFetchFailure('Antigravity', 'antigravity', 429, '120', null);
    expect(message).toBe(usageRejectedError('Antigravity', 429));

    // The backoff was actually recorded — a second read short-circuits.
    const usage = classifyUsageFetchFailure('Antigravity', 'antigravity', 429, null, null);
    expect(usage).toBe(usageRejectedError('Antigravity', 429));
  });

  it('returns a plain rejection for a non-429 status, without touching the backoff', () => {
    const message = classifyUsageFetchFailure('Muse', 'muse', 500, null, null);
    expect(message).toBe(usageRejectedError('Muse', 500));
  });

  it('returns unreachable when there is no status at all (a thrown/network failure)', () => {
    const message = classifyUsageFetchFailure('Muse', 'muse', null, null, null);
    expect(message).toBe(usageUnreachableError('Muse'));
  });
});

describe('classifyUsageErrorKind — the interface for view.ts (RUSH-3040)', () => {
  // ## Interface for view-render
  // `classifyUsageErrorKind(usageInfo.error)` returns a `UsageErrorKind | null`
  // that the `agents view` renderer passes as `FormatUsageSummaryOpts.errorKind`
  // (plus the raw `usageInfo.error` string as `errorDetail`, used only to pull
  // the retry-time hint out of a `rate-limited` classification). This table is
  // the full contract — every UsageInfo.error this file can construct maps to
  // exactly one of these kinds, so the renderer never has to special-case a
  // message string itself.
  it('classifies every constructed error string into its documented kind', () => {
    const cases: Array<[string, UsageErrorKind]> = [
      [usageNoCredentialError('Kimi'), 'no-credential'],
      [usageExpiredCredentialError('Droid'), 'expired-credential'],
      [usageThrottledError('Cursor', Date.now() + 60_000), 'rate-limited'],
      [usageRejectedError('Antigravity', 429), 'rate-limited'],
      [usageRejectedError('Muse', 500), 'rejected'],
      [usageUnreachableError('Grok'), 'unreachable'],
    ];
    for (const [error, kind] of cases) {
      expect(classifyUsageErrorKind(error)).toBe(kind);
    }
  });

  it('returns null for no error, and the headless-scope marker classifies distinctly', () => {
    expect(classifyUsageErrorKind(null)).toBeNull();
    expect(classifyUsageErrorKind(undefined)).toBeNull();
    expect(classifyUsageErrorKind(usageHeadlessScopeError('Claude'))).toBe('headless-scope');
  });

  it('classifies the read-only cache miss as not-collected, not a rejection (#2987)', () => {
    // `getUsageInfoForIdentity` returns this sentinel when the read served the
    // cache and the cache was empty — no request was made, so nothing was
    // rejected. It had no arm here and fell through to 'rejected', which is
    // how a cold cache rendered as "usage unavailable".
    expect(classifyUsageErrorKind(USAGE_NOT_COLLECTED_MARKER)).toBe('not-collected');
    expect(classifyUsageErrorKind(USAGE_NOT_COLLECTED_MARKER)).not.toBe('rejected');
  });

  it('classifies the Claude no-usage-credential message distinctly from a generic missing credential', () => {
    expect(classifyUsageErrorKind(usageNoClaudeUsageCredentialError())).toBe('no-usage-credential');
    expect(classifyUsageErrorKind(usageNoCredentialError('Kimi'))).toBe('no-credential');
  });
});

describe('usageErrorForDisplay — no internal sentinel leaks into --json (PHNX-3348)', () => {
  // `agents view --json` emits `usageInfo.error` as the `usageError` field. Without
  // `--refresh` on a never-cached account the read-only lookup returns the internal
  // `'stale'` sentinel (USAGE_NOT_COLLECTED_MARKER) — which is a cache signal, not a
  // human message, and leaking it verbatim contradicts the field's docstring.
  it('maps the internal not-collected sentinel to a human, actionable string', () => {
    const shown = usageErrorForDisplay(USAGE_NOT_COLLECTED_MARKER);
    expect(shown).not.toBe(USAGE_NOT_COLLECTED_MARKER);
    expect(shown).not.toBe('stale');
    expect(shown).toContain('not collected');
    expect(shown).toContain('--refresh');
  });

  it('passes a genuine, already-human error string through unchanged', () => {
    const real = usageNoClaudeUsageCredentialError();
    expect(usageErrorForDisplay(real)).toBe(real);
    const rejected = usageRejectedError('Antigravity', 429);
    expect(usageErrorForDisplay(rejected)).toBe(rejected);
  });

  it('returns null when there is no error', () => {
    expect(usageErrorForDisplay(null)).toBeNull();
    expect(usageErrorForDisplay(undefined)).toBeNull();
  });
});

describe('formatUsageSummary renders the SPECIFIC error kind, not a generic bucket', () => {
  // The bug this closes: opts.unavailable used to render the bare string
  // 'usage unavailable' for ~6 different causes. errorKind lets the no-bars
  // branch name which one.
  it('renders a distinct human label for each error kind', () => {
    expect(formatUsageSummary(null, null, 3, { unavailable: true, errorKind: 'no-credential' })).toContain(
      'sign in / provision token',
    );
    expect(formatUsageSummary(null, null, 3, { unavailable: true, errorKind: 'expired-credential' })).toContain(
      're-auth for usage',
    );
    expect(formatUsageSummary(null, null, 3, { benignState: 'no-recent-usage' })).toContain('no usage recorded yet');
  });

  it('pulls the retry-time hint out of the raw error detail for rate-limited', () => {
    const detail = usageThrottledError('Droid', Date.now() + 12 * 60_000);
    const rendered = formatUsageSummary(null, null, 3, {
      unavailable: true,
      errorKind: 'rate-limited',
      errorDetail: detail,
    });
    expect(rendered).toContain('rate-limited (retry ~');
  });

  it('falls back to the generic label when no errorKind is supplied (unchanged old behavior)', () => {
    expect(formatUsageSummary(null, null, 3, { unavailable: true })).toContain('usage unavailable');
  });

  it('names the scope gap from errorKind alone, without the headless flag (RUSH-2392, #2987)', () => {
    // view.ts sets `headless` from the error string, but every other caller
    // passes only the classified kind. That kind shared the generic bucket, so
    // the same account read as "usage unavailable" on one surface and
    // "usage unavailable (headless)" on another.
    const out = formatUsageSummary(null, null, 3, {
      unavailable: true,
      errorKind: 'headless-scope',
    });

    expect(out).toContain(USAGE_HEADLESS_SCOPE_MARKER);
    expect(out).not.toMatch(/usage unavailable(?! \(headless\))/);
  });

  it('renders a cold cache as pending rather than unavailable (#2987)', () => {
    const out = formatUsageSummary(null, null, 3, {
      unavailable: true,
      errorKind: classifyUsageErrorKind(USAGE_NOT_COLLECTED_MARKER),
      errorDetail: USAGE_NOT_COLLECTED_MARKER,
    });

    expect(out).toContain('usage pending');
    expect(out).not.toContain('usage unavailable');
  });

  it('renders the Claude no-usage-credential state without a remedy that cannot work (#2987)', () => {
    const error = usageNoClaudeUsageCredentialError();
    const out = formatUsageSummary(null, null, 3, {
      unavailable: true,
      errorKind: classifyUsageErrorKind(error),
      errorDetail: error,
    });

    expect(out).toContain(USAGE_NO_USAGE_CREDENTIAL_MARKER);
    expect(out).not.toContain('sign in / provision token');
  });
});

describe('getUsageInfo(codex) — usage is scoped to the current login', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  // Write auth.json whose id_token carries `auth_time` = the login time. The
  // usage floor comes from that claim, NOT the file mtime — a token refresh
  // rewrites auth.json but leaves auth_time at the real login. `fileMtimeMs`
  // lets a test simulate a refresh (file rewritten later than the login).
  function writeAuth(loginMs: number, fileMtimeMs?: number): void {
    const p = path.join(home, '.codex', 'auth.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const payload = Buffer.from(
      JSON.stringify({ auth_time: Math.floor(loginMs / 1000) })
    ).toString('base64url');
    fs.writeFileSync(p, JSON.stringify({ tokens: { id_token: `h.${payload}.s` } }));
    const t = (fileMtimeMs ?? loginMs) / 1000;
    fs.utimesSync(p, t, t);
  }

  function writeSession(mtimeMs: number, usedPercent: number, windowMinutes = 300): void {
    const dir = path.join(home, '.codex', 'sessions', '2026', '08', '05');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `rollout-${mtimeMs}.jsonl`);
    fs.writeFileSync(
      p,
      JSON.stringify({
        timestamp: new Date(mtimeMs).toISOString(),
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: { primary: { used_percent: usedPercent, window_minutes: windowMinutes } },
        },
      }) + '\n'
    );
    fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  }

  const HOUR = 60 * 60 * 1000;

  it('ignores a session written before the current login (prior account is stale)', async () => {
    // Reproduces the bug: log out, log into a different account. The only
    // session on disk predates the new login, so its usage is the OLD account's.
    writeAuth(NOW);
    writeSession(NOW - HOUR, 99);

    const info = await getUsageInfo('codex', { home });
    expect(info.snapshot).toBeNull();
    expect(info.error).toBeNull();
    expect(getUsageBenignState(info)).toBe('no-recent-usage');
  });

  it('reports a benign no-usage marker when no local session exists yet', async () => {
    writeAuth(Date.now() - HOUR);

    const info = await getUsageInfo('codex', { home });

    expect(info.snapshot).toBeNull();
    expect(info.error).toBeNull();
    expect(getUsageBenignState(info)).toBe('no-recent-usage');
    expect(JSON.stringify(info)).toBe('{"snapshot":null,"error":null}');
  });

  it('drops a Codex window after its derived expiry', async () => {
    const capturedAt = Date.now() - 2 * HOUR;
    writeAuth(capturedAt - HOUR);
    writeSession(capturedAt, 100, 60);

    const info = await getUsageInfo('codex', { home });

    expect(info.snapshot).toBeNull();
    expect(info.error).toBeNull();
    expect(getUsageBenignState(info)).toBe('no-recent-usage');
  });

  it('reports a session written after the current login', async () => {
    writeAuth(NOW);
    writeSession(NOW + HOUR, 42);

    const info = await getUsageInfo('codex', { home });
    const session = info.snapshot?.windows.find((w) => w.key === 'session');
    expect(session?.usedPercent).toBe(42);
  });

  it('labels a primary 7-day quota as weekly usage', async () => {
    writeAuth(NOW);
    writeSession(NOW + HOUR, 54, 10_080);

    const info = await getUsageInfo('codex', { home });
    expect(info.snapshot?.windows).toEqual([
      expect.objectContaining({ key: 'week', label: 'Current week', shortLabel: 'W', usedPercent: 54 }),
    ]);
    expect(formatUsageSummary(null, info.snapshot)).toContain('W:');
  });

  it('labels a primary 30-day quota as monthly usage', async () => {
    writeAuth(NOW);
    writeSession(NOW + HOUR, 21, 43_200);

    const info = await getUsageInfo('codex', { home });
    expect(info.snapshot?.windows).toEqual([
      expect.objectContaining({ key: 'month', label: 'Current month', shortLabel: 'M', usedPercent: 21 }),
    ]);
    expect(formatUsageSummary(null, info.snapshot)).toContain('M:');
  });

  it('prefers the current account session over a stale pre-login one', async () => {
    // Old account left a 99% session; the new account then ran a 5% session.
    writeAuth(NOW);
    writeSession(NOW - HOUR, 99);
    writeSession(NOW + HOUR, 5);

    const info = await getUsageInfo('codex', { home });
    const session = info.snapshot?.windows.find((w) => w.key === 'session');
    expect(session?.usedPercent).toBe(5);
  });

  it('reports no usage when no account is signed in (no auth.json)', async () => {
    writeSession(NOW, 99);

    const info = await getUsageInfo('codex', { home });
    expect(info.snapshot).toBeNull();
  });

  it('keeps usage after a token refresh rewrites auth.json (floor is auth_time, not mtime)', async () => {
    // Regression guard: login at NOW, run a session at NOW+1h (42%), then a
    // background token refresh rewrites auth.json with a NOW+2h file mtime. The
    // floor is auth_time (NOW), so the NOW+1h session is still counted — a
    // mtime-based floor (NOW+2h) would wrongly blank the current account.
    writeAuth(NOW, NOW + 2 * HOUR);
    writeSession(NOW + HOUR, 42);

    const info = await getUsageInfo('codex', { home });
    const session = info.snapshot?.windows.find((w) => w.key === 'session');
    expect(session?.usedPercent).toBe(42);
  });

  it('reports a benign no-recent-usage marker when signed in but nothing was ever recorded (RUSH-3040)', async () => {
    writeAuth(NOW);
    // No writeSession() call — a fresh account with no rate-limit event on
    // this machine yet. This used to be silently indistinguishable from a
    // genuine read failure (both were `error: null`).
    const info = await getUsageInfo('codex', { home });
    expect(info.snapshot).toBeNull();
    expect(info.error).toBeNull();
    expect(getUsageBenignState(info)).toBe('no-recent-usage');
  });

  it('skips a stale window and falls back to an earlier session that is still fresh (RUSH-3040)', async () => {
    // Freshness is judged against the REAL wall clock (isCachedUsageWindowFresh
    // compares to `new Date()`), so this test uses actual Date.now() rather than
    // the fixed future `NOW` constant the rest of this suite uses.
    const real = Date.now();
    const HOUR_MS = 60 * 60 * 1000;
    writeAuth(real - 3 * HOUR_MS);
    // Newest file (checked first): a 30-minute window captured an hour ago —
    // already expired. Without the freshness filter this stale 80% would win.
    writeSession(real - HOUR_MS, 80, 30);
    // Older file (checked second, still after the login floor): a 5-hour
    // window captured 2 hours ago — still fresh.
    writeSession(real - 2 * HOUR_MS, 15, 300);

    const info = await getUsageInfo('codex', { home });
    const session = info.snapshot?.windows.find((w) => w.key === 'session');
    expect(session?.usedPercent).toBe(15);
  });
});

describe('getUsageInfo(grok) — last-seen billing from unified.jsonl', () => {
  let home: string;
  // Grok's log resolution falls back to the shared real home
  // (AGENTS_REAL_HOME || os.homedir()), so pin BOTH to a temp dir for the whole
  // block — otherwise these tests would read the developer's real
  // ~/.grok/logs/unified.jsonl and go non-deterministic.
  let sharedHome: string;
  let prevHome: string | undefined;
  let prevRealHome: string | undefined;
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-usage-'));
    sharedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-usage-shared-'));
    prevHome = process.env.HOME;
    prevRealHome = process.env.AGENTS_REAL_HOME;
    process.env.HOME = sharedHome;
    process.env.AGENTS_REAL_HOME = sharedHome;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevRealHome === undefined) delete process.env.AGENTS_REAL_HOME;
    else process.env.AGENTS_REAL_HOME = prevRealHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(sharedHome, { recursive: true, force: true });
  });

  function writeGrokAuth(dir: string, opts: { email: string; userId: string }): void {
    const grokDir = path.join(dir, '.grok');
    fs.mkdirSync(grokDir, { recursive: true });
    fs.writeFileSync(path.join(grokDir, 'auth.json'), JSON.stringify({
      'https://auth.x.ai::test-client': {
        email: opts.email,
        user_id: opts.userId,
        refresh_token: 'rt',
        create_time: '2026-08-30T00:00:00Z',
      },
    }));
  }

  function writeBillingLineTo(dir: string, opts: {
    tsMs: number;
    percent?: number | null;
    periodStartMs: number;
    periodEndMs: number;
    tier?: string;
    userId?: string;
    email?: string;
  }): void {
    const logDir = path.join(dir, '.grok', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const config: Record<string, unknown> = {
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: new Date(opts.periodStartMs).toISOString(),
        end: new Date(opts.periodEndMs).toISOString(),
      },
    };
    if (opts.percent !== null && opts.percent !== undefined) {
      config.creditUsagePercent = opts.percent;
    }
    const ctx: Record<string, unknown> = { config, subscriptionTier: opts.tier ?? 'X Premium+' };
    if (opts.userId) ctx.user_id = opts.userId;
    if (opts.email) ctx.email = opts.email;
    const line = JSON.stringify({
      ts: new Date(opts.tsMs).toISOString(),
      msg: 'billing: fetched credits config',
      ctx,
    });
    fs.appendFileSync(path.join(logDir, 'unified.jsonl'), line + '\n');
  }

  function writeBillingLine(opts: {
    tsMs: number;
    percent?: number | null;
    periodStartMs: number;
    periodEndMs: number;
    tier?: string;
  }): void {
    writeBillingLineTo(home, opts);
  }

  it('reports a benign no-usage marker before the first local log exists', async () => {
    const info = await getUsageInfo('grok', { home });

    expect(info.snapshot).toBeNull();
    expect(info.error).toBeNull();
    expect(getUsageBenignState(info)).toBe('no-recent-usage');
  });

  it('renders the latest in-period creditUsagePercent as the week bar', async () => {
    const now = Date.now();
    writeBillingLine({
      tsMs: now - HOUR,
      percent: 37,
      periodStartMs: now - DAY,
      periodEndMs: now + 6 * DAY,
      tier: 'SuperGrok Heavy',
    });

    const info = await getUsageInfo('grok', { home });
    expect(info.snapshot?.plan).toBe('SuperGrok Heavy');
    expect(info.snapshot?.source).toBe('last_seen');
    const week = info.snapshot?.windows.find((w) => w.key === 'week');
    expect(week?.usedPercent).toBe(37);
  });

  it('does not invent a 0% bar when creditUsagePercent is missing', async () => {
    const now = Date.now();
    // Prior period at 100%, then a new period line with no percent yet — the
    // real fleet case that painted W: 0% on one box while another still
    // showed a stale expired reading.
    writeBillingLine({
      tsMs: now - 2 * HOUR,
      percent: 100,
      periodStartMs: now - 8 * DAY,
      periodEndMs: now - HOUR,
    });
    writeBillingLine({
      tsMs: now - HOUR,
      percent: null,
      periodStartMs: now - HOUR,
      periodEndMs: now + 6 * DAY,
    });

    const info = await getUsageInfo('grok', { home });
    expect(info.snapshot?.windows).toEqual([]);
    expect(info.snapshot?.plan).toBe('X Premium+');
  });

  it('keeps an ended billing window out of `windows` but shows it as last-known', async () => {
    const now = Date.now();
    writeBillingLine({
      tsMs: now - DAY,
      percent: 100,
      periodStartMs: now - 8 * DAY,
      periodEndMs: now - HOUR,
      tier: 'SuperGrok Heavy',
    });

    const info = await getUsageInfo('grok', { home, cliVersion: '0.2.118' });
    // Routing stays honest: the ended-period bar never enters `windows`, so a
    // stale 100% cannot read as rate-limited.
    expect(info.snapshot?.windows).toEqual([]);
    expect(info.snapshot?.plan).toBe('SuperGrok Heavy');
    // A last-known reading exists, so the refresh hint no longer stands alone —
    // and the view renders the number with a "period ended" age instead of the
    // old numberless "run grok once to refresh usage".
    expect(info.snapshot?.refreshHint).toBeNull();
    expect(info.snapshot?.staleWindows?.[0]?.usedPercent).toBe(100);
    const rendered = formatUsageSummary(info.snapshot?.plan ?? null, info.snapshot);
    expect(rendered).toContain('W:');
    expect(rendered).toContain('100%');
    expect(rendered).toContain('period ended');
    expect(rendered).not.toContain('run grok@0.2.118 once to refresh usage');
  });

  it('reports a benign no-recent-usage marker when no log file exists yet (RUSH-3040)', async () => {
    // No writeBillingLine() call — a fresh install with no Grok log at all.
    // This used to be silently indistinguishable from a real read failure.
    const info = await getUsageInfo('grok', { home });
    expect(info.snapshot).toBeNull();
    expect(info.error).toBeNull();
    expect(getUsageBenignState(info)).toBe('no-recent-usage');
  });

  it('falls back to the shared ~/.grok log when the per-version home has none', async () => {
    // The live bug: `agents view grok` reads usage per INSTALLED VERSION, passing
    // each version's isolated home (~/.agents/.history/versions/grok/<ver>), whose
    // .grok/logs/unified.jsonl never exists — Grok writes its billing log only to
    // the user's shared real home ~/.grok. So the per-version read came up empty
    // and every version rendered "run grok@<ver> once to refresh usage" while the
    // real last-known reading (e.g. week 42%) sat unread in the shared home.
    const now = Date.now();
    // Shared home has the reading; the per-version home (`home`) has NO log.
    writeBillingLineTo(sharedHome, {
      tsMs: now - HOUR,
      percent: 42,
      periodStartMs: now - DAY,
      periodEndMs: now + 6 * DAY,
      tier: 'SuperGrok Heavy',
    });
    writeGrokAuth(sharedHome, { email: 'owner@x.com', userId: 'user-owner' });
    writeGrokAuth(home, { email: 'owner@x.com', userId: 'user-owner' });
    expect(fs.existsSync(path.join(home, '.grok', 'logs', 'unified.jsonl'))).toBe(false);

    const info = await getUsageInfo('grok', { home, cliVersion: '0.2.118' });
    expect(info.error).toBeNull();
    expect(info.snapshot?.plan).toBe('SuperGrok Heavy');
    const week = info.snapshot?.windows.find((w) => w.key === 'week');
    expect(week?.usedPercent).toBe(42);
    // A number is present now, so the numberless refresh hint no longer stands alone.
    expect(info.snapshot?.refreshHint).toBeNull();
    const rendered = formatUsageSummary(info.snapshot?.plan ?? null, info.snapshot);
    expect(rendered).toContain('42%');
    expect(rendered).not.toContain('run grok@0.2.118 once to refresh usage');
  });

  it('keeps a stale shared-home reading for the per-version view (period ended)', async () => {
    // The exact live case: the shared log's last reading is from an ENDED billing
    // period, so it is dropped from `windows` (routing stays honest) but kept as a
    // `staleWindow` the per-version view renders with a "period ended" suffix —
    // instead of the old numberless "run grok@<ver> once to refresh usage".
    const now = Date.now();
    writeBillingLineTo(sharedHome, {
      tsMs: now - DAY,
      percent: 42,
      periodStartMs: now - 8 * DAY,
      periodEndMs: now - HOUR,
      tier: 'SuperGrok Heavy',
    });
    writeGrokAuth(sharedHome, { email: 'owner@x.com', userId: 'user-owner' });
    writeGrokAuth(home, { email: 'owner@x.com', userId: 'user-owner' });
    expect(fs.existsSync(path.join(home, '.grok', 'logs', 'unified.jsonl'))).toBe(false);

    const info = await getUsageInfo('grok', { home, cliVersion: '0.2.118' });
    expect(info.snapshot?.windows).toEqual([]);
    expect(info.snapshot?.staleWindows?.[0]?.usedPercent).toBe(42);
    expect(info.snapshot?.refreshHint).toBeNull();
    const rendered = formatUsageSummary(info.snapshot?.plan ?? null, info.snapshot);
    expect(rendered).toContain('42%');
    expect(rendered).toContain('period ended');
    expect(rendered).not.toContain('run grok@0.2.118 once to refresh usage');
  });

  it('prefers the per-version log over the shared one when both exist', async () => {
    // If Grok ever does write a per-version log, it must win over the shared home.
    const now = Date.now();
    writeBillingLineTo(sharedHome, {
      tsMs: now - HOUR,
      percent: 42,
      periodStartMs: now - DAY,
      periodEndMs: now + 6 * DAY,
    });
    writeBillingLineTo(home, {
      tsMs: now - HOUR,
      percent: 71,
      periodStartMs: now - DAY,
      periodEndMs: now + 6 * DAY,
    });

    const info = await getUsageInfo('grok', { home });
    const week = info.snapshot?.windows.find((w) => w.key === 'week');
    expect(week?.usedPercent).toBe(71);
  });

  it('applies an unattributed shared log to only one of two version homes', async () => {
    // Live Grok billing lines have no user/email. Two installed version homes
    // (account A vs account B) must not both inherit the shared 42% meter.
    // Canonical identity = the version home whose auth.json matches the shared
    // ~/.grok/auth.json (the account that owns that directory).
    const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-usage-b-'));
    try {
      const now = Date.now();
      writeBillingLineTo(sharedHome, {
        tsMs: now - HOUR,
        percent: 42,
        periodStartMs: now - DAY,
        periodEndMs: now + 6 * DAY,
        tier: 'SuperGrok Heavy',
      });
      writeGrokAuth(sharedHome, { email: 'a@x.com', userId: 'user-a' });
      writeGrokAuth(home, { email: 'a@x.com', userId: 'user-a' });
      writeGrokAuth(homeB, { email: 'b@x.com', userId: 'user-b' });

      const infoA = await getUsageInfo('grok', { home, cliVersion: '0.2.118' });
      const infoB = await getUsageInfo('grok', { home: homeB, cliVersion: '0.2.101' });

      expect(infoA.snapshot?.windows.find((w) => w.key === 'week')?.usedPercent).toBe(42);
      expect(infoA.snapshot?.plan).toBe('SuperGrok Heavy');
      expect(infoB.snapshot).toBeNull();
      expect(infoB.error).toBeNull();
      expect(getUsageBenignState(infoB)).toBe('no-recent-usage');
    } finally {
      fs.rmSync(homeB, { recursive: true, force: true });
    }
  });

  it('honors a user_id on the shared billing line over shared-home auth', async () => {
    const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-usage-id-b-'));
    try {
      const now = Date.now();
      writeBillingLineTo(sharedHome, {
        tsMs: now - HOUR,
        percent: 42,
        periodStartMs: now - DAY,
        periodEndMs: now + 6 * DAY,
        tier: 'SuperGrok Heavy',
        userId: 'user-b',
      });
      writeGrokAuth(sharedHome, { email: 'a@x.com', userId: 'user-a' });
      writeGrokAuth(home, { email: 'a@x.com', userId: 'user-a' });
      writeGrokAuth(homeB, { email: 'b@x.com', userId: 'user-b' });

      const infoA = await getUsageInfo('grok', { home });
      const infoB = await getUsageInfo('grok', { home: homeB });
      expect(infoA.snapshot).toBeNull();
      expect(getUsageBenignState(infoA)).toBe('no-recent-usage');
      expect(infoB.snapshot?.windows.find((w) => w.key === 'week')?.usedPercent).toBe(42);
    } finally {
      fs.rmSync(homeB, { recursive: true, force: true });
    }
  });

  describe('out_of_credits (tokens/credits exhausted — no clock)', () => {
    const usageKey = 'claude:org=oocred';
    // These write Claude refusal markers via note*/clear* — isolate the Claude
    // usage cache to a temp file so the suite never pollutes the developer's real
    // ~/.agents/.cache/claude-usage.json (the exact hazard usage-backoff.ts documents).
    let cacheDir: string;
    let prevPath: string | null;

    beforeEach(() => {
      cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-oocred-'));
      prevPath = setClaudeUsageCachePathForTest(path.join(cacheDir, 'claude-usage.json'));
    });

    afterEach(() => {
      setClaudeUsageCachePathForTest(prevPath);
      fs.rmSync(cacheDir, { recursive: true, force: true });
    });

    it('persists a clock-less refusal that excludes the account and survives time', () => {
      noteClaudeOutOfCredits(usageKey);
      const snap = readClaudeUsageCache(usageKey, undefined, new Date(Date.now() + 30 * 24 * 3600 * 1000));
      // A month later it is STILL blocking — unlike a session limit, no clock frees it.
      expect(snap?.unavailable).toEqual({ reason: 'out_of_credits' });
      expect(deriveUsageStatusFromSnapshot(snap)).toBe('rate_limited');
      expect(formatUsageSummary('Max', snap)).toContain('out of credits');
    });

    it('is cleared by a successful run (clearClaudeAccountRefusal)', () => {
      noteClaudeOutOfCredits(usageKey);
      expect(readClaudeUsageCache(usageKey)?.unavailable).toEqual({ reason: 'out_of_credits' });
      clearClaudeAccountRefusal(usageKey);
      // Cleared → no longer excluded (no marker, no windows → null snapshot).
      const snap = readClaudeUsageCache(usageKey);
      expect(snap?.unavailable).toBeUndefined();
    });

    it('a session-limit still recovers on its clock, out_of_credits does not', () => {
      const other = 'claude:org=sess-vs-cred';
      noteClaudeSessionLimit(other, new Date(Date.now() + 60_000));
      // past the reset → session limit gone
      expect(readClaudeUsageCache(other, undefined, new Date(Date.now() + 61_000))).toBeNull();
      noteClaudeOutOfCredits(other);
      // out_of_credits ignores the clock entirely
      expect(readClaudeUsageCache(other, undefined, new Date(Date.now() + 10 * 24 * 3600 * 1000))?.unavailable)
        .toEqual({ reason: 'out_of_credits' });
    });
  });

});
