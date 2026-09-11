import { machineId } from './machine-id.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  accountListJson,
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
  type NativeHomeRow,
} from './account-catalog.js';
import { usageHeadlessScopeError } from './accounting/usage.js';
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

  it('serializes this device observation separately from the fleet verdict and timestamp', () => {
    const [row] = buildNativeCatalog([home({})], { accounts: {} }, noGlobalDefault);
    row.verdict = 'revoked';
    row.checkedAt = '2026-09-10T12:00:00.000Z';
    row.devices = [
      { device: machineId(), authMode: 'native', verdict: 'live', checkedAt: '2026-09-10T11:00:00.000Z' },
      { device: 'peer-device', authMode: 'durable', verdict: 'revoked', checkedAt: row.checkedAt },
    ];
    const serialized = accountListJson([row]).accounts[0];
    expect(serialized.verdict).toBe('revoked');
    expect(serialized.local).toMatchObject({ verdict: 'live', checkedAt: '2026-09-10T11:00:00.000Z' });
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
