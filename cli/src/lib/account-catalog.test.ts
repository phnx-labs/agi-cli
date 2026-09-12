import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  accountListJson,
  aggregateAccountVerdict,
  applyUsageHonesty,
  buildNativeCatalog,
  groupNativeAccountRows,
  isLaunchableSignedIn,
  listDevicesWithoutAccountVerdicts,
  loadAccountCatalog,
  readSharedAccountVerdicts,
  resolveLocalAccountObservation,
  secretsUnavailableNote,
  toProviderRow,
  coverageNote,
  type NativeHomeRow,
} from './account-catalog.js';
import { USAGE_NOT_COLLECTED_MARKER, deriveUsageStatusFromSnapshot, usageErrorForDisplay, usageHeadlessScopeError } from './accounting/usage.js';
import type { UsageSnapshot } from './accounting/usage.js';
import { setKeychainTokenSync, _resetSecretsClientForTest } from './secrets-client.js';
import { standaloneKeychainIsFileBacked, useFreshSecretsHome } from '../../tests/secrets-standalone.js';
import type { CredentialAccount } from './account-registry.js';
import type { QuotaSummary } from './devices/harness-inventory.js';
import type { Meta } from './types.js';

// The provider-row verdict reads the secret's presence through the process
// client, which honors SECRETS_HOME; the embedded engine did not (PHNX-3989).
// Account bundles carry no explicit backend, so on a headed macOS box the real
// standalone would use the operator's login keychain — run where items are
// file-backed (headless Linux/Windows, CI).
const fileBacked = await standaloneKeychainIsFileBacked();

describe('native account catalog', () => {
  it('groups matching identities across versions without merging different harnesses', () => {
    const rows = [
      { agent: 'claude' as const, version: '2.1.1', accountKey: 'claude:user=1', email: 'a@example.com', signedIn: true },
      { agent: 'claude' as const, version: '2.1.2', accountKey: 'claude:user=1', email: 'a@example.com', signedIn: true },
      { agent: 'codex' as const, version: '1.0.0', accountKey: 'codex:user=1', email: 'a@example.com', signedIn: true },
      { agent: 'claude' as const, version: '2.0.0', accountKey: 'claude:user=2', email: 'out@example.com', signedIn: false },
    ];
    expect(groupNativeAccountRows(rows)).toEqual([
      { kind: 'native', id: 'claude:user=1', agent: 'claude', display: 'a@example.com', email: 'a@example.com', versions: ['2.1.1', '2.1.2'] },
      { kind: 'native', id: 'codex:user=1', agent: 'codex', display: 'a@example.com', email: 'a@example.com', versions: ['1.0.0'] },
    ]);
  });
});

describe('buildNativeCatalog account-first read model', () => {
  const home = (over: Partial<NativeHomeRow>): NativeHomeRow => ({
    agent: 'claude', label: 'acct-1', releaseVersion: '2.1.220', accountKey: 'claude:user=1', email: 'a@example.com', signedIn: true, ...over,
  });
  const noGlobalDefault = () => null;

  it('folds homes by identity and reports connected state + release/home diagnostics', () => {
    const rows = [
      home({ label: 'acct-1', releaseVersion: '2.1.220' }),
      home({ label: 'acct-2', releaseVersion: '2.1.219' }),
    ];
    const meta: Pick<Meta, 'accounts' | 'deviceAccounts'> = {
      accounts: { native: { 'id-1': { id: 'id-1', name: 'work', agent: 'claude', identityKey: 'claude:user=1', identityLabel: 'a@example.com', scope: 'version' } } },
      deviceAccounts: { homes: { 'id-1': 'acct-1' } },
    };
    const [row] = buildNativeCatalog(rows, meta, noGlobalDefault);
    expect(row).toMatchObject({
      kind: 'native', agent: 'claude', identityKey: 'claude:user=1', name: 'work', id: 'id-1',
      email: 'a@example.com', home: 'acct-1', isDefault: false, state: 'connected',
    });
    expect(row.installations).toEqual([
      { label: 'acct-1', releaseVersion: '2.1.220', signedIn: true },
      { label: 'acct-2', releaseVersion: '2.1.219', signedIn: true },
    ]);
  });

  it('reports reconnect-needed for a registered account whose homes are all signed out', () => {
    const rows = [home({ signedIn: false })];
    const meta: Pick<Meta, 'accounts' | 'deviceAccounts'> = {
      accounts: { native: { 'id-1': { id: 'id-1', name: 'work', agent: 'claude', identityKey: 'claude:user=1', scope: 'version' } } },
    };
    expect(buildNativeCatalog(rows, meta, noGlobalDefault)[0].state).toBe('reconnect-needed');
  });

  it('surfaces a registered account with NO discovered home as reconnect-needed', () => {
    const meta: Pick<Meta, 'accounts' | 'deviceAccounts'> = {
      accounts: { native: { 'id-1': { id: 'id-1', name: 'gone', agent: 'claude', identityKey: 'claude:user=9', identityLabel: 'g@x.com', scope: 'version' } } },
    };
    const [row] = buildNativeCatalog([], meta, noGlobalDefault);
    expect(row).toMatchObject({ name: 'gone', state: 'reconnect-needed', installations: [], email: 'g@x.com' });
  });

  it('marks the configured default account authoritative regardless of homes', () => {
    const rows = [home({})];
    const meta: Pick<Meta, 'accounts' | 'deviceAccounts'> = {
      accounts: {
        defaults: { claude: 'work' },
        native: { 'id-1': { id: 'id-1', name: 'work', agent: 'claude', identityKey: 'claude:user=1', scope: 'version' } },
      },
    };
    expect(buildNativeCatalog(rows, meta, noGlobalDefault)[0].isDefault).toBe(true);
  });

  it('does not invent a native default from an unmatched/provider account default', () => {
    const rows = [home({})];
    const meta: Pick<Meta, 'accounts' | 'deviceAccounts'> = {
      // The configured default names a provider bundle, not this native account.
      accounts: { defaults: { claude: 'openrouter-work' }, native: { 'id-1': { id: 'id-1', name: 'work', agent: 'claude', identityKey: 'claude:user=1', scope: 'version' } } },
    };
    expect(buildNativeCatalog(rows, meta, () => 'acct-1')[0].isDefault).toBe(false);
  });

  it('falls back to the global-default home only when no account default is configured', () => {
    const rows = [home({ label: 'acct-1' }), home({ label: 'acct-2', accountKey: 'claude:user=2', email: 'b@example.com' })];
    const meta: Pick<Meta, 'accounts' | 'deviceAccounts'> = { accounts: {} };
    const catalog = buildNativeCatalog(rows, meta, (a) => (a === 'claude' ? 'acct-2' : null));
    expect(catalog.find(r => r.identityKey === 'claude:user=2')?.isDefault).toBe(true);
    expect(catalog.find(r => r.identityKey === 'claude:user=1')?.isDefault).toBe(false);
  });

  it('emits the version 2 public JSON shape without installation or store internals', () => {
    const [row] = buildNativeCatalog([home({})], {
      accounts: {
        defaults: { claude: 'work' },
        native: { 'id-1': { id: 'id-1', name: 'work', agent: 'claude', identityKey: 'claude:user=1', identityLabel: 'a@example.com', scope: 'version' } },
      },
    }, noGlobalDefault);
    row.verdict = 'expired';
    row.checkedAt = '2026-09-06T01:02:03.000Z';
    row.devices = [{ device: 'zion', authMode: 'native', verdict: 'expired' }];
    row.fix = 'agents accounts login claude#work';

    expect(accountListJson([row])).toEqual({
      version: 2,
      accounts: [{
        kind: 'native',
        id: 'id-1',
        harness: 'claude',
        name: 'work',
        identityLabel: 'a@example.com',
        isDefault: true,
        provisioning: 'portable',
        verdict: 'expired',
        checkedAt: '2026-09-06T01:02:03.000Z',
        devices: [{ device: 'zion', authMode: 'native', verdict: 'expired' }],
        usage: null,
        fix: 'agents accounts login claude#work',
      }],
    });
  });
});

describe('applyUsageHonesty (scope failure is never a credit claim)', () => {
  const quota = (over: Partial<QuotaSummary> = {}): QuotaSummary => ({
    status: 'out_of_credits',
    verdict: 'out_of_credits',
    usedPercent: 100,
    stale: false,
    capturedAt: null,
    resetsAt: null,
    unavailableReason: usageHeadlessScopeError(),
    ...over,
  });

  it('turns a live worker whose usage probe 403s on scope into unverified, with no credits', () => {
    const out = applyUsageHonesty('live', quota());
    expect(out.verdict).toBe('unverified');
    expect(out.usage?.status).toBeNull();
    expect(out.usage?.usedPercent).toBeNull();
    expect(out.usage?.verdict).toBe('unavailable');
  });

  it('does not hide an expired or revoked auth failure behind unread usage', () => {
    expect(applyUsageHonesty('expired', quota()).verdict).toBe('expired');
    expect(applyUsageHonesty('revoked', quota()).verdict).toBe('revoked');
    expect(applyUsageHonesty('expired', quota()).usage?.status).toBeNull();
  });

  it('lets a genuine rate-limit on a live account through when usage is readable', () => {
    const out = applyUsageHonesty('live', quota({
      status: 'rate_limited',
      verdict: 'rate_limited',
      usedPercent: 100,
      unavailableReason: null,
    }));
    expect(out.verdict).toBe('rate_limited');
    expect(out.usage?.status).toBe('rate_limited');
  });
});

describe('resolveLocalAccountObservation (newest observation wins)', () => {
  const slot = (checkedAt: string, verdict: 'live' | 'revoked' = 'live') => ({
    authMode: 'native' as const, verdict, checkedAt,
  });
  const cached = (checkedAt: string, verdict: 'live' | 'revoked' = 'revoked') => ({
    verdict, checkedAt: Date.parse(checkedAt),
  });

  it('a NEWER daemon cache verdict beats an older slot verdict — revoked is never masked', () => {
    // The regression this fixes: T1 wrote slot live at t1, the daemon probed
    // revoked at t2 > t1, and `slot ?? cached` kept rendering LIVE.
    const out = resolveLocalAccountObservation(
      slot('2026-09-06T01:00:00.000Z', 'live'),
      cached('2026-09-06T02:00:00.000Z', 'revoked'),
      true,
    );
    expect(out.verdict).toBe('revoked');
    expect(out.checkedAt).toBe('2026-09-06T02:00:00.000Z');
    expect(out.authMode).toBeUndefined();
  });

  it('a NEWER slot verdict beats an older cache verdict and keeps the slot authMode', () => {
    const out = resolveLocalAccountObservation(
      slot('2026-09-06T03:00:00.000Z', 'live'),
      cached('2026-09-06T02:00:00.000Z', 'revoked'),
      true,
    );
    expect(out).toEqual({ verdict: 'live', authMode: 'native', checkedAt: '2026-09-06T03:00:00.000Z' });
  });

  it('an untimestamped slot never masks a timestamped cache observation', () => {
    const out = resolveLocalAccountObservation(
      { authMode: 'native', verdict: 'live' },
      cached('2026-09-06T02:00:00.000Z', 'revoked'),
      true,
    );
    expect(out.verdict).toBe('revoked');
  });

  it('falls back to whichever source exists, and to signedIn when neither does', () => {
    expect(resolveLocalAccountObservation(slot('2026-09-06T01:00:00.000Z'), undefined, true).verdict).toBe('live');
    expect(resolveLocalAccountObservation(undefined, cached('2026-09-06T01:00:00.000Z', 'revoked'), true).verdict).toBe('revoked');
    expect(resolveLocalAccountObservation(undefined, undefined, true).verdict).toBe('unverified');
    expect(resolveLocalAccountObservation(undefined, undefined, false).verdict).toBe('missing');
  });

  it("an `unconfigured` slot record is ensureSlot's default, not a verdict — the live signedIn read decides", () => {
    // The 2026-09-10 zion case: `accounts login` re-materialized the slot while the
    // device doc was unreadable (verdict: unconfigured, no checkedAt), the user
    // logged in, and the row still rendered MISSING because `unconfigured` was
    // mapped to missing unconditionally.
    const stale = { authMode: 'native' as const, verdict: 'unconfigured' as const };
    expect(resolveLocalAccountObservation(stale, undefined, true).verdict).toBe('unverified');
    expect(resolveLocalAccountObservation(stale, undefined, false).verdict).toBe('missing');
    // A newer daemon probe of the slot still wins over the default.
    expect(resolveLocalAccountObservation(stale, cached('2026-09-10T19:06:37.000Z', 'live'), true).verdict).toBe('live');
  });
});

describe('fleet-synced account verdict rows', () => {
  it('reads per-account device verdicts from real daemon-state files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-account-state-'));
    try {
      const dir = path.join(root, 'devices', 'worker-1');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'daemon-state.json'), JSON.stringify({
        version: 1,
        device: 'worker-1',
        accounts: {
          rows: [{
            accountId: 'id-work',
            harness: 'claude',
            authMode: 'durable',
            verdict: 'live',
            checkedAt: '2026-09-06T01:02:03.000Z',
          }],
        },
      }));
      expect(readSharedAccountVerdicts(root).get('claude:id-work')).toEqual([{
        device: 'worker-1',
        authMode: 'durable',
        verdict: 'live',
        checkedAt: '2026-09-06T01:02:03.000Z',
      }]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('indexes the display label separately so only UNNAMED logins join on it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-account-state-'));
    try {
      const dir = path.join(root, 'devices', 'worker-1');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'daemon-state.json'), JSON.stringify({
        version: 1,
        device: 'worker-1',
        accounts: {
          rows: [{
            accountId: 'id-work',
            identityLabel: 'shared@example.com',
            harness: 'claude',
            authMode: 'durable',
            verdict: 'revoked',
          }],
        },
      }));
      const shared = readSharedAccountVerdicts(root);
      // The stable id key is the join a REGISTERED account uses…
      expect(shared.get('claude:id-work')?.[0]?.verdict).toBe('revoked');
      // …and the label index exists for unnamed legacy logins only. Both index
      // the same row; the catalog never resolves a registered row by label.
      expect(shared.get('label:claude:shared@example.com')?.[0]?.verdict).toBe('revoked');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('lists devices whose daemon-state carries no account verdicts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-account-state-'));
    try {
      const withRows = path.join(root, 'devices', 'zion');
      const without = path.join(root, 'devices', 'mac-mini');
      fs.mkdirSync(withRows, { recursive: true });
      fs.mkdirSync(without, { recursive: true });
      fs.writeFileSync(path.join(withRows, 'daemon-state.json'), JSON.stringify({
        version: 1,
        device: 'zion',
        accounts: { rows: [{ accountId: 'id-work', harness: 'claude', authMode: 'native', verdict: 'live' }] },
      }));
      fs.writeFileSync(path.join(without, 'daemon-state.json'), JSON.stringify({
        version: 1,
        device: 'mac-mini',
        usage: { rows: {} },
      }));
      expect(listDevicesWithoutAccountVerdicts(root)).toEqual(['mac-mini']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('isLaunchableSignedIn (strict — a live credential, not metadata alone)', () => {
  const tmps: string[] = [];
  const originalRealHome = process.env.AGENTS_REAL_HOME;
  const mkHome = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-launchable-')); tmps.push(d); return d; };
  beforeEach(() => { process.env.AGENTS_REAL_HOME = mkHome(); });
  afterEach(() => {
    if (originalRealHome === undefined) delete process.env.AGENTS_REAL_HOME;
    else process.env.AGENTS_REAL_HOME = originalRealHome;
    for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('returns false when the metadata says signed in but no credential file exists in the home', () => {
    const home = mkHome();
    expect(isLaunchableSignedIn('claude', home, { signedIn: true })).toBe(false);
  });

  it.skipIf(process.platform === 'darwin')('is still false with metadata present but a BLANK credential (stale/expired login)', () => {
    const home = mkHome();
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    // `.claude.json` metadata exists but no usable credential behind it.
    fs.writeFileSync(path.join(home, '.claude', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com' } }));
    expect(isLaunchableSignedIn('claude', home, { signedIn: true })).toBe(false);
  });

  it('returns true once a real credential sits behind the metadata', () => {
    const home = mkHome();
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com' } }));
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok', refreshToken: 'ref' } }));
    expect(isLaunchableSignedIn('claude', home, { signedIn: true })).toBe(true);
  });

  it('is false when metadata itself is not signed in, regardless of files', () => {
    const home = mkHome();
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', '.claude.json'), '{}');
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }));
    expect(isLaunchableSignedIn('claude', home, { signedIn: false })).toBe(false);
  });
});

describe.skipIf(!fileBacked)('toProviderRow secret verdict reads through the process client (PHNX-3989)', () => {
  useFreshSecretsHome();

  const account = (secretRef: string): CredentialAccount => ({
    id: 'id-e2e',
    name: 'e2e',
    provider: 'anthropic',
    auth: 'api-key',
    secretRef,
  });
  const meta: Pick<Meta, 'accounts'> = { accounts: { defaults: {} } };

  it('reports "missing" when the secret is absent from this SECRETS_HOME', () => {
    const row = toProviderRow(account('agents-cli.accounts.id-e2e.credential'), meta);
    expect(row.verdict).toBe('missing');
    expect(row.fix).toBe('agents accounts set-key e2e');
  });

  it('reports "ready" for a secret written through the client under the same SECRETS_HOME', () => {
    const ref = 'agents-cli.accounts.id-e2e.credential';
    setKeychainTokenSync(ref, 'sk-ant-e2e-token');
    const row = toProviderRow(account(ref), meta);
    expect(row.verdict).toBe('ready');
    expect(row.fix).toBeNull();
  });
});

describe.skipIf(process.platform === 'win32')('loadAccountCatalog tolerates an unreachable standalone (read-only surface)', () => {
  const savedBin = process.env.SECRETS_BIN;
  afterEach(() => {
    if (savedBin === undefined) delete process.env.SECRETS_BIN;
    else process.env.SECRETS_BIN = savedBin;
    _resetSecretsClientForTest();
  });

  it('renders native rows + flags secretsUnavailable instead of throwing when secrets is broken', async () => {
    // A standalone that answers nothing (the class of failure PHNX-3989 hit under
    // Bun) must not take down `agents view` / `agents accounts`: the provider
    // section is reported unavailable while the rest of the catalog still loads.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-broken-secrets-'));
    const bin = path.join(dir, 'mock-secrets');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n'); // writes nothing to fd 4
    fs.chmodSync(bin, 0o755);
    process.env.SECRETS_BIN = bin;
    _resetSecretsClientForTest();
    try {
      const catalog = await loadAccountCatalog();
      expect(catalog.provider).toEqual([]);
      expect(catalog.secretsUnavailable).toBeDefined();
      expect(catalog.secretsUnavailable?.code).toBe('INVALID_RESPONSE');
      const note = secretsUnavailableNote(catalog);
      expect(note).toContain('secrets unavailable');
      expect(note).toContain('INVALID_RESPONSE');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('secretsUnavailableNote is null for a complete catalog', () => {
    expect(secretsUnavailableNote({ secretsUnavailable: undefined })).toBeNull();
  });
});

describe('account catalog per-window USAGE rendering (PHNX-3940 regression)', () => {
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const snapshotWithBoth = (): UsageSnapshot => ({
    source: 'live',
    sourceLabel: 'live account data',
    capturedAt: new Date(Date.now() - 60 * 60 * 1000),
    windows: [
      { key: 'session', label: 'Current session', shortLabel: 'S', usedPercent: 58, resetsAt: new Date(Date.now() + 2 * 60 * 60 * 1000), windowMinutes: 300 },
      { key: 'week', label: 'Current week', shortLabel: 'W', usedPercent: 41, resetsAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000), windowMinutes: 10080 },
    ],
  });

  it('catalog row with 5h + 7d windows renders BOTH labeled bars', async () => {
    const { renderAccountRows } = await import('./account-catalog.js');
    const row: import('./account-catalog.js').NativeAccountCatalogRow = {
      kind: 'native',
      agent: 'claude',
      identityKey: 'claude:user=1',
      name: 'work',
      id: 'id-1',
      email: 'w@example.com',
      display: 'w@example.com',
      identityLabel: 'w@example.com',
      home: 'main',
      installations: [{ label: 'main', releaseVersion: '2.0.0', signedIn: true }],
      isDefault: false,
      state: 'connected',
      provisioning: 'portable',
      verdict: 'live',
      checkedAt: null,
      devices: [{ device: 'zion', authMode: 'native', verdict: 'live' }],
      usage: { status: 'available', verdict: 'available', usedPercent: 58, stale: false, capturedAt: new Date().toISOString(), resetsAt: null, unavailableReason: null },
      usageSnapshot: snapshotWithBoth(),
      usageError: null,
      fix: null,
    };
    const { renderAccountRows: render } = await import('./account-catalog.js');
    const out = stripAnsi(render([row], { heading: false, footer: false, harnessHeadings: false, localDevice: 'zion', harness: 'claude' }));
    expect(out).toContain('S:');
    expect(out).toContain('58%');
    expect(out).toContain('W:');
    expect(out).toContain('41%');
  });

  it('overview cap limits to 2 windows while single-harness view shows all', async () => {
    const { renderAccountRows } = await import('./account-catalog.js');
    const snapshot: UsageSnapshot = {
      source: 'live',
      sourceLabel: 'live',
      capturedAt: new Date(),
      windows: [
        { key: 'session', label: 'Current session', shortLabel: 'S', usedPercent: 10, resetsAt: null, windowMinutes: 300 },
        { key: 'week', label: 'Current week', shortLabel: 'W', usedPercent: 20, resetsAt: null, windowMinutes: 10080 },
        { key: 'month', label: 'Current month', shortLabel: 'M', usedPercent: 30, resetsAt: null, windowMinutes: 43200 },
      ],
    };
    const row: import('./account-catalog.js').NativeAccountCatalogRow = {
      kind: 'native',
      agent: 'droid',
      identityKey: 'droid:user=1',
      name: 'work',
      id: 'id-1',
      email: null,
      display: 'work',
      identityLabel: 'work',
      home: 'main',
      installations: [{ label: 'main', releaseVersion: '1.0.0', signedIn: true }],
      isDefault: false,
      state: 'connected',
      provisioning: 'portable',
      verdict: 'live',
      checkedAt: null,
      devices: [{ device: 'zion', authMode: 'native', verdict: 'live' }],
      usage: { status: 'available', verdict: 'available', usedPercent: 30, stale: false, capturedAt: new Date().toISOString(), resetsAt: null, unavailableReason: null },
      usageSnapshot: snapshot,
      usageError: null,
      fix: null,
    };
    const overview = stripAnsi(renderAccountRows([row], { heading: false, footer: false, harnessHeadings: false, localDevice: 'zion' }));
    const single = stripAnsi(renderAccountRows([row], { heading: false, footer: false, harnessHeadings: false, localDevice: 'zion', harness: 'droid' }));
    expect(overview).toContain('S:');
    expect(overview).toContain('W:');
    expect(overview).not.toContain('M:');
    expect(overview).toContain('+1');
    expect(single).toContain('S:');
    expect(single).toContain('W:');
    expect(single).toContain('M:');
    expect(single).not.toContain('+1');
  });
});

describe('agents accounts list --json never leaks the stale sentinel (PHNX-3348 follow-up)', () => {
  it('a signed-in account with no collected usage has a display-safe usageError', () => {
    // Real path: harness-inventory sanitizes via usageErrorForDisplay before the
    // row reaches NativeAccountCatalogRow and accountListJson (fix/view-usage-windows).
    // A never-refreshed cache returns USAGE_NOT_COLLECTED_MARKER ('stale') from
    // getUsageInfoForIdentity (readOnly); the JSON must never carry that raw sentinel.
    const row: import('./account-catalog.js').NativeAccountCatalogRow = {
      kind: 'native',
      agent: 'claude',
      identityKey: 'claude:user=1',
      name: 'work',
      id: 'id-1',
      email: 'w@example.com',
      display: 'w@example.com',
      identityLabel: 'w@example.com',
      home: 'main',
      installations: [{ label: 'main', releaseVersion: '2.1.220', signedIn: true }],
      isDefault: false,
      state: 'connected',
      provisioning: 'portable',
      verdict: 'live',
      checkedAt: null,
      devices: [{ device: 'zion', authMode: 'native', verdict: 'live' }],
      usage: null,
      usageSnapshot: null,
      usageError: usageErrorForDisplay(USAGE_NOT_COLLECTED_MARKER),
      fix: null,
    };
    const json = accountListJson([row]);
    const entry = json.accounts[0] as unknown as { usageError?: string | null };
    expect(entry.usageError).toBeTruthy();
    expect(entry.usageError).not.toBe(USAGE_NOT_COLLECTED_MARKER);
    expect(entry.usageError).not.toBe('stale');
    expect(entry.usageError).toContain('not collected');
    expect(entry.usageError).toContain('--refresh');
    expect(JSON.stringify(json)).not.toContain('"stale"');
    expect(JSON.stringify(json)).not.toContain(USAGE_NOT_COLLECTED_MARKER);
  });

  it('the sanitizer is exactly one hop — harness row display value passes through unchanged', () => {
    const display = usageErrorForDisplay(USAGE_NOT_COLLECTED_MARKER)!;
    const row: import('./account-catalog.js').NativeAccountCatalogRow = {
      kind: 'native',
      agent: 'claude',
      identityKey: 'claude:user=2',
      name: 'personal',
      id: 'id-2',
      email: 'p@example.com',
      display: 'p@example.com',
      identityLabel: 'p@example.com',
      home: 'main',
      installations: [{ label: 'main', releaseVersion: '2.1.220', signedIn: true }],
      isDefault: false,
      state: 'connected',
      provisioning: 'portable',
      verdict: 'live',
      checkedAt: null,
      devices: [{ device: 'zion', authMode: 'native', verdict: 'live' }],
      usage: null,
      usageSnapshot: null,
      usageError: display,
      fix: null,
    };
    const json = accountListJson([row]);
    expect((json.accounts[0] as unknown as { usageError?: string | null }).usageError).toBe(display);
  });
});

describe('aggregateAccountVerdict honours local usage snapshot (PHNX-3940/4051)', () => {
  const staleBelow100: QuotaSummary = {
    status: 'available',
    verdict: 'available',
    usedPercent: 83,
    stale: true,
    capturedAt: new Date().toISOString(),
    resetsAt: new Date(Date.now() + 60_000).toISOString(),
    unavailableReason: null,
  };
  const noSnapshot: QuotaSummary = {
    status: 'available',
    verdict: 'available',
    usedPercent: null,
    stale: false,
    capturedAt: null,
    resetsAt: null,
    unavailableReason: 'usage unavailable',
  };
  const blocking100Limited: QuotaSummary = {
    status: 'rate_limited',
    verdict: 'rate_limited',
    usedPercent: 100,
    stale: true,
    capturedAt: new Date().toISOString(),
    resetsAt: new Date(Date.now() + 60_000).toISOString(),
    unavailableReason: null,
  };
  const devices = (verdicts: Array<'live' | 'rate_limited' | 'revoked' | 'expired' | 'unverified' | 'missing'> ) =>
    verdicts.map((v, i) => ({ device: `box-${i}`, authMode: 'native' as const, verdict: v as never }));

  it('a stale last_seen snapshot with windows below 100% ignores six remote rate_limited rows — STATE stays LIVE', () => {
    const all = [
      { device: 'zion', authMode: 'native' as const, verdict: 'live' as const },
      ...devices(['rate_limited', 'rate_limited', 'rate_limited', 'rate_limited', 'rate_limited', 'rate_limited']),
    ];
    // aggregate ignores remote rate_limited when hasLocalSnapshot (usedPercent !== null)
    expect(aggregateAccountVerdict('portable', all, staleBelow100)).toBe('live');
    // honesty keeps it live because usage is available, not throttled
    const honest = applyUsageHonesty(aggregateAccountVerdict('portable', all, staleBelow100), staleBelow100);
    expect(honest.verdict).toBe('live');
  });

  it('a local snapshot with a blocking window at 100% renders LIMITED via usage honesty', () => {
    const snap = {
      source: 'live' as const,
      sourceLabel: 'live',
      capturedAt: new Date(),
      windows: [{ key: 'session' as const, label: 'Session', shortLabel: 'S', usedPercent: 100, resetsAt: new Date(Date.now() + 60_000), windowMinutes: 300 }],
    };
    expect(deriveUsageStatusFromSnapshot(snap)).toBe('rate_limited');
    // Even with a stale surrounding tick, a 100% blocking window is rate_limited
    const all = [
      { device: 'zion', authMode: 'native' as const, verdict: 'live' as const },
      ...devices(['rate_limited', 'rate_limited']),
    ];
    const base = aggregateAccountVerdict('portable', all, blocking100Limited);
    // base is live (remote ignored), honesty promotes to rate_limited
    expect(base).toBe('live');
    const honest = applyUsageHonesty(base, blocking100Limited);
    expect(honest.verdict).toBe('rate_limited');
  });

  it('no local snapshot plus remote rate_limited renders LIMITED', () => {
    const all = devices(['live', 'rate_limited']);
    expect(aggregateAccountVerdict('portable', all, null)).toBe('rate_limited');
    expect(aggregateAccountVerdict('portable', all, noSnapshot)).toBe('rate_limited');
  });

  it('freshly added account with no usage windows but a genuine remote rate_limited is not discarded as LIVE (reviewer BLOCKING)', () => {
    // summarizeQuota NO-SNAPSHOT branch for Claude returns status available + usedPercent null (hardcoded available)
    const all = [
      { device: 'zion', authMode: 'native' as const, verdict: 'live' as const },
      { device: 'worker-1', authMode: 'durable' as const, verdict: 'rate_limited' as const },
    ];
    expect(aggregateAccountVerdict('portable', all, noSnapshot)).toBe('rate_limited');
    expect(aggregateAccountVerdict('portable', all, null)).toBe('rate_limited');
  });

  it('a remote revoked/expired still wins even against a stale available snapshot', () => {
    expect(aggregateAccountVerdict('portable', devices(['live', 'revoked']), staleBelow100)).toBe('revoked');
    expect(aggregateAccountVerdict('portable', devices(['live', 'expired']), staleBelow100)).toBe('expired');
  });
});

describe('device coverage is a note, not a column (PHNX-4051)', () => {
  const mkRow = (devices: Array<{ device: string; verdict: 'live' | 'revoked' | 'rate_limited' | 'unverified' | 'missing' | 'expired' }>, provisioning: 'portable' | 'per-device' = 'portable'): Parameters<typeof coverageNote>[0] =>
    ({ kind: 'native', agent: 'claude', identityKey: 'k', name: 'n', id: 'id', email: null, display: 'd', identityLabel: 'd', home: null, installations: [], isDefault: false, state: 'connected', provisioning, verdict: 'live', checkedAt: null, devices: devices as never, usage: null, fix: null } as never);

  it('says nothing when only the local device reports — that is a gap in what we can see', () => {
    expect(coverageNote(mkRow([{ device: 'zion', verdict: 'live' }]), 'zion')).toBeNull();
  });
  it('says nothing when every provisioned device is usable (live + rate_limited + unverified)', () => {
    const devices = [
      ...Array.from({ length: 2 }, (_, i) => ({ device: `live-${i}`, verdict: 'live' as const })),
      ...Array.from({ length: 2 }, (_, i) => ({ device: `limited-${i}`, verdict: 'rate_limited' as const })),
      ...Array.from({ length: 2 }, (_, i) => ({ device: `unverified-${i}`, verdict: 'unverified' as const })),
    ];
    expect(coverageNote(mkRow(devices), 'zion')).toBeNull();
    expect(coverageNote(mkRow([{ device: 'a', verdict: 'live' }, { device: 'b', verdict: 'missing' }]), 'zion')).toBeNull();
  });
  it('names the usable fraction when some provisioned device is not usable (revoked/expired)', () => {
    const devices = [
      { device: 'a', verdict: 'live' as const },
      { device: 'b', verdict: 'rate_limited' as const },
      { device: 'c', verdict: 'unverified' as const },
      { device: 'd', verdict: 'revoked' as const },
      { device: 'e', verdict: 'expired' as const },
    ];
    expect(coverageNote(mkRow(devices), 'zion')).toBe('usable on 3 of 5 boxes');
  });
  it('says nothing when NO box can use it — the row state already says that', () => {
    expect(coverageNote(mkRow([{ device: 'a', verdict: 'missing' }, { device: 'b', verdict: 'missing' }]), 'zion')).toBeNull();
    expect(coverageNote(mkRow([{ device: 'a', verdict: 'expired' }, { device: 'b', verdict: 'expired' }]), 'zion')).toBeNull();
    expect(coverageNote(mkRow([]), 'zion')).toBeNull();
  });
  it('per-device branch names the boxes it is NOT on, and nothing when it is on all of them', () => {
    const devices = [
      { device: 'zion', verdict: 'live' as const },
      { device: 'worker-1', verdict: 'live' as const },
      { device: 'worker-2', verdict: 'missing' as const },
    ];
    expect(coverageNote(mkRow(devices, 'per-device'), 'zion')).toBe('not on worker-2');
    expect(coverageNote(mkRow(devices.slice(0, 2), 'per-device'), 'zion')).toBeNull();
  });
  it('legend line is present in rendered output', async () => {
    const { renderAccountRows } = await import('./account-catalog.js');
    const row = mkRow([{ device: 'zion', verdict: 'live' }]) as never;
    const out = renderAccountRows([row] as never, { localDevice: 'zion' } as never);
    expect(out).toContain('* stale usage');
    expect(out).toContain('agents accounts list --fleet');
  });
});
