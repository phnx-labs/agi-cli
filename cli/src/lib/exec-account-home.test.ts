import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addNativeAccount, nativeAccountHome, removeAccount } from './account-registry.js';
import { recordSlot, slotDir } from './accounts/slots.js';
import { getAgentConfigPath, isSymlinkAdoptedHarness } from './installations/shims.js';
import { getVersionDir, getVersionHomePath, invalidateInstalledVersionsCache } from './installations/store.js';
import { getHistoryDir, getVersionsDir, readMeta, updateMeta } from './state.js';
import { seedReservedStoreKey, workerCredentialStoreKey } from './auth-mint.js';
import { collectRunCandidates } from './accounting/rotate.js';
import { authCacheKey, slotAuthVersionKey, writeAuthHealthEntries } from './auth-health.js';
import {
  adoptedConfigPointsAtHome,
  adoptedSymlinkMismatchError,
  durableSlotEnv,
  ensureAdoptedDefaultRepoint,
  isAccountSlotDir,
  missingSlotHint,
  resolveNativeSpawnHome,
  symlinkAdoptedAccountError,
} from './exec-account-home.js';

const suffix = `t5-${Date.now()}`;
const planted: string[] = [];

function clearDevice() {
  updateMeta((m) => ({
    ...m,
    accounts: { ...m.accounts, native: {}, defaults: {} },
    deviceAccounts: undefined,
  }));
}

beforeEach(() => {
  process.env.AGENTS_SYNC_MACHINE_ID = 't5-spawn-box';
  clearDevice();
});

afterEach(() => {
  clearDevice();
  for (const p of planted) fs.rmSync(p, { recursive: true, force: true });
  planted.length = 0;
  delete process.env.AGENTS_SYNC_MACHINE_ID;
});

describe('isAccountSlotDir', () => {
  it('recognizes dirs under ~/.agents/.history/accounts/', () => {
    const dir = path.join(getHistoryDir(), 'accounts', 'claude', 'abc');
    expect(isAccountSlotDir(dir)).toBe(true);
    expect(isAccountSlotDir(path.join(getHistoryDir(), 'versions', 'claude', 'main', 'home'))).toBe(false);
  });
});

describe('isSymlinkAdoptedHarness', () => {
  it('is the slotEnv-null set that is not CONFIG_ENV isolated', () => {
    expect(isSymlinkAdoptedHarness('droid')).toBe(true);
    expect(isSymlinkAdoptedHarness('antigravity')).toBe(true);
    expect(isSymlinkAdoptedHarness('gemini')).toBe(true);
    expect(isSymlinkAdoptedHarness('openclaw')).toBe(true);
    expect(isSymlinkAdoptedHarness('amp')).toBe(true);
    expect(isSymlinkAdoptedHarness('goose')).toBe(true);
    expect(isSymlinkAdoptedHarness('hermes')).toBe(true);
    expect(isSymlinkAdoptedHarness('warp')).toBe(true);
    expect(isSymlinkAdoptedHarness('claude')).toBe(false);
    expect(isSymlinkAdoptedHarness('cursor')).toBe(false);
    expect(isSymlinkAdoptedHarness('grok')).toBe(false);
  });
});

describe('resolveNativeSpawnHome', () => {
  it('uses a slot dir that exists on disk', async () => {
    const account = addNativeAccount(`work-${suffix}`, 'claude', `claude:user=t5-work-${suffix}`, 'work@example.com', 'version');
    const dir = slotDir('claude', account.id);
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    planted.push(dir);
    recordSlot(account.id, {
      accountId: account.id,
      slotDir: dir,
      authMode: 'native',
      verdict: 'live',
    });
    const resolved = await resolveNativeSpawnHome('claude', account, readMeta());
    expect(resolved.source).toBe('slot');
    expect(resolved.execHome).toBe(dir);
    removeAccount(account.name);
  });

  it('falls back to the recorded homes label when the slot dir was never created (T1 backfill)', async () => {
    const account = addNativeAccount(`legacy-${suffix}`, 'claude', `claude:user=t5-legacy-${suffix}`, 'legacy@example.com', 'version');
    const missingSlot = slotDir('claude', account.id);
    expect(fs.existsSync(missingSlot)).toBe(false);
    recordSlot(account.id, {
      accountId: account.id,
      slotDir: missingSlot,
      authMode: 'native',
      verdict: 'unconfigured',
    });
    const label = `acct-${suffix}`;
    updateMeta((m) => ({
      ...m,
      deviceAccounts: {
        ...m.deviceAccounts,
        homes: { ...m.deviceAccounts?.homes, [account.id]: label },
      },
    }));
    expect(nativeAccountHome(account.id, readMeta())).toBe(label);
    const legacyHome = getVersionHomePath('claude', label);
    fs.mkdirSync(legacyHome, { recursive: true });
    planted.push(path.join(getVersionsDir(), 'claude', label));
    const resolved = await resolveNativeSpawnHome('claude', account, readMeta());
    expect(resolved.source).toBe('legacy-home');
    expect(resolved.execHome).toBe(legacyHome);
    expect(resolved.execHome).not.toBe(missingSlot);
    removeAccount(account.name);
  });

  it('matches identity across installed homes when no homes label was recorded', async () => {
    const email = `ident-${suffix}@example.com`;
    const label = `99.0.0-t5-ident-${suffix}`;
    const dir = getVersionDir('claude', label);
    const pkgRoot = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code');
    fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
    fs.mkdirSync(path.join(pkgRoot, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({
      name: '@anthropic-ai/claude-code', version: label, bin: { claude: 'bin/claude-launcher' },
    }));
    fs.writeFileSync(path.join(pkgRoot, 'bin', 'claude-launcher'), 'REAL BINARY');
    const home = getVersionHomePath('claude', label);
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
      oauthAccount: {
        emailAddress: email,
        accountUuid: `acct-${email}`,
        organizationUuid: `org-${email}`,
        organizationType: 'claude_max',
      },
    }));
    fs.writeFileSync(
      path.join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 86_400_000 } }),
    );
    planted.push(dir);
    invalidateInstalledVersionsCache('claude');
    const account = addNativeAccount(
      `ident-${suffix}`,
      'claude',
      `claude:account=acct-${email}:org=org-${email}`,
      email,
      'version',
    );
    expect(nativeAccountHome(account.id, readMeta())).toBeNull();
    const resolved = await resolveNativeSpawnHome('claude', account, readMeta());
    expect(resolved.source).toBe('legacy-home');
    expect(resolved.execHome).toBe(home);
    expect(resolved.label).toBe(label);
    const candidates = await collectRunCandidates('claude');
    expect(candidates.find(candidate => candidate.nativeAccountId === account.id)).toMatchObject({
      nativeAccount: account.name, slotDir: home, version: label, signedIn: true,
    });
    recordSlot(account.id, { accountId: account.id, slotDir: home, authMode: 'native', verdict: 'unconfigured' });
    const checkedAt = Date.now();
    writeAuthHealthEntries({ [authCacheKey('t5-spawn-box', 'claude', slotAuthVersionKey(account.id))]: { verdict: 'unverified', checkedAt, accountId: account.id } });
    const refreshed = (await collectRunCandidates('claude')).find(candidate => candidate.nativeAccountId === account.id);
    expect(refreshed).toMatchObject({ signedIn: true, authVerdict: 'unverified', authCheckedAt: checkedAt });
    removeAccount(account.name);
    invalidateInstalledVersionsCache('claude');
  });

  it('fails loud with the T4 hint when there is no slot and no legacy home', async () => {
    const account = addNativeAccount(`gone-${suffix}`, 'claude', `claude:user=t5-gone-${suffix}`, 'gone@example.com', 'version');
    await expect(resolveNativeSpawnHome('claude', account, readMeta())).rejects.toThrow(/has no slot on this device/);
    expect(missingSlotHint('claude', account.name)).toMatch(/accounts (login|add) claude/);
    removeAccount(account.name);
  });
});

describe('symlinkAdoptedAccountError', () => {
  it('names the one-active-slot rule and the default command', () => {
    expect(symlinkAdoptedAccountError('droid', 'work', 'personal')).toMatch(/one active account per device/);
    expect(symlinkAdoptedAccountError('droid', 'work', 'personal')).toMatch(/accounts default droid work/);
    expect(symlinkAdoptedAccountError('droid', 'work', undefined)).toMatch(/Set the default first/);
    expect(adoptedSymlinkMismatchError('droid', 'work', '/slot')).toMatch(/does not point at that account's home/);
  });
});

describe('adopted default repoint + symlink guard (PHNX-3940 T5 review)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't5-adopt-default-'));
  const prevReal = process.env.AGENTS_REAL_HOME;

  afterEach(() => {
    if (prevReal === undefined) delete process.env.AGENTS_REAL_HOME;
    else process.env.AGENTS_REAL_HOME = prevReal;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('ensureAdoptedDefaultRepoint fails loud when the slot is missing and does not write a default', () => {
    const account = addNativeAccount(`droid-miss-${suffix}`, 'droid', `droid:opaque=t5-miss-${suffix}`, undefined, 'device');
    const before = readMeta().accounts?.defaults?.droid;
    expect(() => ensureAdoptedDefaultRepoint('droid', account, readMeta())).toThrow(/has no slot on this device/);
    expect(readMeta().accounts?.defaults?.droid).toBe(before);
    removeAccount(account.name);
  });

  it('ensureAdoptedDefaultRepoint repoints the adopted symlink at the slot', () => {
    process.env.AGENTS_REAL_HOME = tmp;
    const account = addNativeAccount(`droid-ok-${suffix}`, 'droid', `droid:opaque=t5-ok-${suffix}`, undefined, 'device');
    const dir = slotDir('droid', account.id);
    fs.mkdirSync(path.join(dir, '.factory'), { recursive: true });
    planted.push(dir);
    recordSlot(account.id, { accountId: account.id, slotDir: dir, authMode: 'native', verdict: 'live' });
    const other = path.join(tmp, 'other-slot', '.factory');
    fs.mkdirSync(other, { recursive: true });
    const configPath = getAgentConfigPath('droid');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.symlinkSync(other, configPath);
    ensureAdoptedDefaultRepoint('droid', account, readMeta());
    expect(adoptedConfigPointsAtHome('droid', dir)).toBe(true);
    removeAccount(account.name);
  });

  it('adoptedConfigPointsAtHome is false when the symlink still points at another slot', () => {
    process.env.AGENTS_REAL_HOME = tmp;
    const home = path.join(tmp, 'slot-work');
    const other = path.join(tmp, 'slot-other', '.factory');
    fs.mkdirSync(path.join(home, '.factory'), { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    const configPath = getAgentConfigPath('droid');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.symlinkSync(other, configPath);
    expect(adoptedConfigPointsAtHome('droid', home)).toBe(false);
    fs.unlinkSync(configPath);
    fs.symlinkSync(path.join(home, '.factory'), configPath);
    expect(adoptedConfigPointsAtHome('droid', home)).toBe(true);
  });
});

// A worker's durable api-key slot holds no file: the launch must carry the
// pushed key in the harness env var. Nothing else injects (a native login in
// the slot, a harness without an api-key worker kind, a key not on the box).
describe('durableSlotEnv', () => {
  it('injects the reserved worker API key for a durable api-key slot, and nothing otherwise', () => {
    const account = addNativeAccount(`gmail-${suffix}`, 'cursor', `cursor:user=t6-${suffix}`, 'g@example.com', 'version');
    const key = workerCredentialStoreKey('cursor', account.id);
    seedReservedStoreKey('cursor', 'api-key', key, 'crsr_test_worker_key');
    updateMeta((m) => ({
      ...m,
      accounts: {
        ...m.accounts,
        native: {
          ...m.accounts?.native,
          [account.id]: { ...m.accounts!.native![account.id], workerCredential: { bundle: '__cursor__', key, kind: 'api-key', mintedAt: 'm1' } },
        },
      },
    }));
    const meta = readMeta();
    const dir = slotDir('cursor', account.id);
    const durable = { accountId: account.id, slotDir: dir, authMode: 'durable' as const, verdict: 'live' as const };
    expect(durableSlotEnv('cursor', account, { slot: durable }, meta)).toEqual({ CURSOR_API_KEY: 'crsr_test_worker_key' });
    // A native login in the slot (headed device) keeps its own credential.
    expect(durableSlotEnv('cursor', account, { slot: { ...durable, authMode: 'native' } }, meta)).toEqual({});
    // No slot at all (legacy home) injects nothing.
    expect(durableSlotEnv('cursor', account, {}, meta)).toEqual({});
    // A harness whose worker credential is a setup-token file, not an env key.
    expect(durableSlotEnv('claude', account, { slot: durable }, meta)).toEqual({});
    // A headed device never trusts a durable record it did not provision — a
    // stale one survives `agents devices role <box> personal` — and keeps its
    // native login (invariant 7).
    expect(durableSlotEnv('cursor', account, { slot: durable }, meta, { selfRole: () => 'personal' })).toEqual({});
    expect(durableSlotEnv('cursor', account, { slot: durable }, meta, { selfRole: () => 'desktop' })).toEqual({});
    expect(durableSlotEnv('cursor', account, { slot: durable }, meta, { selfRole: () => 'worker' })).toEqual({ CURSOR_API_KEY: 'crsr_test_worker_key' });
    removeAccount(account.name);
  });
});
