import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  addRefusal,
  addSupported,
  addWorkerRefusal,
  ambientTokenRefusal,
  findAddAccount,
  runAdd,
  runLogin,
  supportedAddHarnesses,
  verifyConnectedIdentity,
  workerApiKeyEnv,
  type AddRunners,
} from './add.js';
import { readSlots, slotDir } from './slots.js';
import { listNativeAccounts, removeAccount, type NativeAccount } from '../account-registry.js';
import { setConfiguredDeviceRole } from '../device-config.js';
import { getHistoryDir, getVersionsDir, readMeta, updateMeta } from '../state.js';
import { bundleExistsSync, readAndResolveBundleEnvSync } from '../secrets-client.js';
import { AUTH_BUNDLE, claudeAccountTokenKey, readReservedCredential } from '../claude-account-token.js';
import { workerCredentialStoreKey } from '../auth-mint.js';
import { useFreshSecretsHome } from '../../../tests/secrets-standalone.js';

const account = (over: Partial<NativeAccount> = {}): NativeAccount => ({
  id: 'id-1',
  name: 'work',
  kind: 'native',
  agent: 'claude',
  identityKey: 'claude:user=1',
  identityLabel: 'work@example.com',
  scope: 'version',
  ...over,
});

describe('add support gating', () => {
  it('supports the version-scoped harnesses with a wired native login', () => {
    expect(addSupported('claude')).toBe(true);
    expect(addSupported('codex')).toBe(true);
    expect(addSupported('grok')).toBe(true);
    expect(addSupported('cursor')).toBe(true);
    expect(addRefusal('claude')).toBeNull();
  });

  it('refuses a device-scoped harness with a capability reason, not a fake flow', () => {
    expect(addSupported('droid')).toBe(false);
    expect(addRefusal('droid')).toMatch(/device-scoped|can't be/);
    expect(addSupported('opencode')).toBe(false);
  });

  it('refuses a per-device harness with no finite login command, naming the per-device path', () => {
    expect(addSupported('kimi')).toBe(false);
    expect(addRefusal('kimi')).toMatch(/no finite login command/);
    expect(addRefusal('kimi')).toMatch(/agents run kimi --device/);
  });

  it('the supported list is the registry-driven truth (claude, codex, cursor, grok)', () => {
    expect(supportedAddHarnesses()).toEqual(['claude', 'codex', 'cursor', 'grok']);
  });
});

describe('workerApiKeyEnv', () => {
  it('reads the env out of HARNESS_AUTH worker kinds', () => {
    expect(workerApiKeyEnv('codex')).toBe('OPENAI_API_KEY');
    expect(workerApiKeyEnv('grok')).toBe('XAI_API_KEY');
    expect(workerApiKeyEnv('cursor')).toBe('CURSOR_API_KEY');
    expect(workerApiKeyEnv('claude')).toBeNull();
    expect(workerApiKeyEnv('kimi')).toBeNull();
  });
});

describe('verifyConnectedIdentity (fail closed)', () => {
  const observed = (identityKey: string | null, signedIn = true) => ({ identityKey, signedIn });

  it('throws when no live credential is present, even with a metadata identity', () => {
    expect(() => verifyConnectedIdentity({ agent: 'claude', home: '/h' }, observed('claude:user=9', false))).toThrow(/no live credential/);
    expect(() => verifyConnectedIdentity({ agent: 'claude', home: '/h' }, observed(null))).toThrow(/no live credential/);
  });

  it('accepts any signed-in identity for a NEW add', () => {
    expect(() => verifyConnectedIdentity({ agent: 'claude', home: '/h' }, observed('claude:user=9'))).not.toThrow();
  });

  it('refuses a different identity on re-auth (account left unchanged)', () => {
    expect(() => verifyConnectedIdentity({ agent: 'claude', home: '/h', existing: account() }, observed('claude:user=2')))
      .toThrow(/different identity/);
  });

  it('accepts a matching identity on re-auth', () => {
    expect(() => verifyConnectedIdentity({ agent: 'claude', home: '/h', existing: account() }, observed('claude:user=1'))).not.toThrow();
  });
});

describe('ambientTokenRefusal', () => {
  it('refuses to mint under an ambient CLAUDE_CODE_OAUTH_TOKEN', () => {
    expect(ambientTokenRefusal('claude', { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x' })).toMatch(/ambient CLAUDE_CODE_OAUTH_TOKEN/);
    expect(ambientTokenRefusal('claude', {})).toBeNull();
    expect(ambientTokenRefusal('codex', { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x' })).toBeNull();
  });
});

describe('findAddAccount', () => {
  const meta = {
    accounts: {
      native: {
        'id-1': { id: 'id-1', name: 'work', agent: 'claude' as const, identityKey: 'claude:user=1', identityLabel: 'work@x.com', scope: 'version' as const },
        'id-2': { id: 'id-2', name: 'work', agent: 'codex' as const, identityKey: 'codex:user=1', scope: 'version' as const },
      },
    },
  };

  it('scopes the lookup to the requested harness', () => {
    expect(findAddAccount('claude', 'work', meta)).toMatchObject({ id: 'id-1', agent: 'claude' });
    expect(findAddAccount('codex', 'work', meta)).toMatchObject({ id: 'id-2', agent: 'codex' });
  });

  it('matches by id and by identity email, and returns null for no name', () => {
    expect(findAddAccount('claude', 'id-1', meta)).toMatchObject({ id: 'id-1' });
    expect(findAddAccount('claude', 'WORK@X.COM', meta)).toMatchObject({ id: 'id-1' });
    expect(findAddAccount('claude', undefined, meta)).toBeNull();
    expect(findAddAccount('claude', 'missing', meta)).toBeNull();
  });
});

describe('runAdd / runLogin (injected runners, real meta + filesystem)', () => {
  type Identity = { identityKey: string | null; email: string | null; signedIn: boolean };

  function fakeRunners(over: {
    defaultObserved?: Identity;
    loginCode?: number;
    mintToken?: string;
    promptKey?: string | null;
  } = {}): AddRunners & {
    installs: number;
    logins: { home: string; args: string[] }[];
    mints: string[];
    reconciles: number;
  } {
    const installs = { n: 0 };
    const logins: { home: string; args: string[] }[] = [];
    const mints: string[] = [];
    const loggedIn = new Set<string>();
    const postLogin: Identity = over.defaultObserved ?? { identityKey: 'claude:user=1', email: 'a@example.com', signedIn: true };
    return {
      get installs() { return installs.n; },
      logins,
      mints,
      reconciles: 0,
      ensureInstallation: async () => { installs.n++; return { label: 'main' }; },
      launchLogin: async (_a, { home, args }) => {
        logins.push({ home, args });
        if ((over.loginCode ?? 0) === 0) loggedIn.add(home);
        return { code: over.loginCode ?? 0 };
      },
      observeIdentity: async (_a, home) => {
        const id = loggedIn.has(home) ? postLogin : { identityKey: null, email: null, signedIn: false };
        return { ...id, releaseVersion: '2.1.220' };
      },
      mintSetupToken: async (_a, { home }) => { mints.push(home); return over.mintToken ?? 'sk-ant-oat01-testtoken'; },
      promptApiKey: over.promptKey === undefined ? undefined : async () => over.promptKey ?? null,
      requestReconcile() { (this as { reconciles: number }).reconciles++; },
    };
  }

  const DEVICE = `add-role-fixture-${process.pid}`;
  let prevMachineId: string | undefined;
  const createdSlotDirs: string[] = [];
  const createdNames: string[] = [];

  const reset = () => updateMeta(meta => ({
    ...meta,
    accounts: { ...meta.accounts, native: {}, defaults: {} },
    deviceAccounts: { ...meta.deviceAccounts, native: {}, homes: {}, pendingConnects: {}, slots: {} },
  }));

  beforeEach(() => {
    prevMachineId = process.env.AGENTS_SYNC_MACHINE_ID;
    process.env.AGENTS_SYNC_MACHINE_ID = DEVICE;
    // Headed role so the worker gate does not break the happy path when this
    // file runs on a worker or unmarked box.
    setConfiguredDeviceRole(DEVICE, 'personal');
    reset();
  });

  afterEach(() => {
    reset();
    setConfiguredDeviceRole(DEVICE, undefined);
    if (prevMachineId === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
    else process.env.AGENTS_SYNC_MACHINE_ID = prevMachineId;
    for (const dir of createdSlotDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    for (const name of createdNames.splice(0)) { try { removeAccount(name); } catch { /* already gone */ } }
  });

  function trackResult(result: { slotDir: string; name: string }): void {
    createdSlotDirs.push(result.slotDir);
    createdNames.push(result.name);
  }

  it('refuses on a worker before any install, slot, login, or registration', async () => {
    setConfiguredDeviceRole(DEVICE, 'worker');
    const versionsDir = path.join(getVersionsDir(), 'codex');
    const accountsRoot = path.join(getHistoryDir(), 'accounts', 'codex');
    const beforeVersions = fs.existsSync(versionsDir) ? fs.readdirSync(versionsDir).sort() : [];
    const beforeSlots = fs.existsSync(accountsRoot) ? fs.readdirSync(accountsRoot).sort() : [];
    const runners = fakeRunners();
    await expect(runAdd('codex', 'icloud', { meta: readMeta() }, runners)).rejects.toThrow(/this device is a worker \(role worker\)/);
    expect(runners.installs).toBe(0);
    expect(runners.logins).toEqual([]);
    expect(listNativeAccounts(readMeta()).find(a => a.agent === 'codex' && a.name === 'icloud')).toBeUndefined();
    expect(fs.existsSync(versionsDir) ? fs.readdirSync(versionsDir).sort() : []).toEqual(beforeVersions);
    expect(fs.existsSync(accountsRoot) ? fs.readdirSync(accountsRoot).sort() : []).toEqual(beforeSlots);
  });

  it('the worker refusal names the laptop add command and the automatic provisioning', () => {
    setConfiguredDeviceRole(DEVICE, 'worker');
    const reason = addWorkerRefusal('codex', 'icloud')!;
    expect(reason).toContain('agents accounts add codex icloud');
    expect(reason).toContain('provisioned from the durable credential automatically');
    expect(reason).toContain('OPENAI_API_KEY');
    expect(reason).toContain(`agents devices role ${DEVICE} personal`);
  });

  it('a headed add creates a SLOT and NO new installation dir, registers the row, and sets the first default', async () => {
    const versionsDir = path.join(getVersionsDir(), 'claude');
    const beforeVersions = fs.existsSync(versionsDir) ? fs.readdirSync(versionsDir).sort() : [];
    const runners = fakeRunners();
    const result = await runAdd('claude', 'work', { meta: readMeta(), noWorkerToken: true }, runners);
    trackResult(result);

    expect(result).toMatchObject({ mode: 'new', name: 'work', identityKey: 'claude:user=1', becameDefault: true, provisioning: 'per-device', workerCredential: 'skipped' });
    expect(runners.installs).toBe(1);               // the ONE managed installation, reused
    expect(runners.logins).toHaveLength(1);
    expect(result.slotDir).toBe(slotDir('claude', result.accountId));
    expect(fs.existsSync(path.join(result.slotDir, '.claude'))).toBe(true);
    // The login ran with HOME = the slot (pending id, renamed onto the account id).
    expect(runners.logins[0]!.home).toContain(path.join(getHistoryDir(), 'accounts', 'claude'));
    // No per-account installation dir was minted.
    expect(fs.existsSync(versionsDir) ? fs.readdirSync(versionsDir).sort() : []).toEqual(beforeVersions);

    const row = listNativeAccounts(readMeta()).find(a => a.name === 'work')!;
    expect(row).toMatchObject({ agent: 'claude', identityKey: 'claude:user=1', provisioning: 'per-device', createdOn: DEVICE });
    expect(readSlots(readMeta())[row.id]).toMatchObject({ accountId: row.id, slotDir: result.slotDir, verdict: 'live' });
    expect(readMeta().accounts?.defaults?.claude).toBe('work');
    expect(result.warnings.join('\n')).toMatch(/no worker credential/i);
    expect(runners.reconciles).toBe(1);
  });

  it('a second account does not override the default', async () => {
    const r1 = await runAdd('claude', 'work', { meta: readMeta(), noWorkerToken: true },
      fakeRunners({ defaultObserved: { identityKey: 'claude:user=A', email: 'a@x.com', signedIn: true } }));
    trackResult(r1);
    const r2 = await runAdd('claude', 'work2', { meta: readMeta(), noWorkerToken: true },
      fakeRunners({ defaultObserved: { identityKey: 'claude:user=B', email: 'b@x.com', signedIn: true } }));
    trackResult(r2);
    expect(r2.becameDefault).toBe(false);
    expect(readMeta().accounts?.defaults?.claude).toBe('work');
  });

  it('add on an already-registered NAME points at login, before any side effect', async () => {
    const r1 = await runAdd('claude', 'work', { meta: readMeta(), noWorkerToken: true }, fakeRunners());
    trackResult(r1);
    const runners = fakeRunners();
    await expect(runAdd('claude', 'work', { meta: readMeta() }, runners)).rejects.toThrow(/already added.*accounts login claude#work/);
    expect(runners.installs).toBe(0);
    expect(runners.logins).toEqual([]);
  });

  it('add of an already-registered IDENTITY under a new name points at login and removes the slot', async () => {
    const r1 = await runAdd('claude', 'work', { meta: readMeta(), noWorkerToken: true }, fakeRunners());
    trackResult(r1);
    // Same identity signs in again under a different requested name.
    const runners = fakeRunners();
    await expect(runAdd('claude', 'other', { meta: readMeta(), noWorkerToken: true }, runners))
      .rejects.toThrow(/already added as 'work'.*accounts login claude#work/);
    expect(runners.logins).toHaveLength(1); // the login ran; the slot was cleaned up
    expect(listNativeAccounts(readMeta()).filter(a => a.agent === 'claude')).toHaveLength(1);
  });

  it('a cancelled login removes the slot and registers nothing', async () => {
    const accountsRoot = path.join(getHistoryDir(), 'accounts', 'claude');
    const before = fs.existsSync(accountsRoot) ? fs.readdirSync(accountsRoot).sort() : [];
    const runners = fakeRunners({ loginCode: 1 });
    await expect(runAdd('claude', 'work', { meta: readMeta(), noWorkerToken: true }, runners))
      .rejects.toThrow(/did not complete.*slot was removed/);
    expect(listNativeAccounts(readMeta()).find(a => a.name === 'work')).toBeUndefined();
    expect(fs.existsSync(accountsRoot) ? fs.readdirSync(accountsRoot).sort() : []).toEqual(before);
  });

  it('a login with no live credential fails closed even if metadata has an identity', async () => {
    const runners = fakeRunners({ defaultObserved: { identityKey: 'claude:user=1', email: null, signedIn: false } });
    await expect(runAdd('claude', 'work', { meta: readMeta(), noWorkerToken: true }, runners)).rejects.toThrow(/no live credential/);
  });

  it('an UNNAMED add derives the name from the login email', async () => {
    const result = await runAdd('claude', undefined, { meta: readMeta(), noWorkerToken: true },
      fakeRunners({ defaultObserved: { identityKey: 'claude:user=A', email: 'ada@example.com', signedIn: true } }));
    trackResult(result);
    expect(result.name).toBe('ada');
    expect(listNativeAccounts(readMeta()).find(a => a.name === 'ada')).toMatchObject({ identityKey: 'claude:user=A' });
  });

  it('a new named add validates the NAME before install/login', async () => {
    const runners = fakeRunners();
    await expect(runAdd('claude', 'bad name!', { meta: readMeta(), noWorkerToken: true }, runners)).rejects.toThrow(/must start with|letters/i);
    expect(runners.installs).toBe(0);
    expect(runners.logins).toEqual([]);
  });

  it('refuses to mint under an ambient CLAUDE_CODE_OAUTH_TOKEN, before any side effect', async () => {
    const runners = fakeRunners();
    await expect(runAdd('claude', 'work', { meta: readMeta(), env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x' } }, runners))
      .rejects.toThrow(/ambient CLAUDE_CODE_OAUTH_TOKEN/);
    expect(runners.installs).toBe(0);
    expect(runners.logins).toEqual([]);
  });

  it('runLogin re-auths into the SAME slot and fails closed on a different identity', async () => {
    const r1 = await runAdd('claude', 'work', { meta: readMeta(), noWorkerToken: true }, fakeRunners());
    trackResult(r1);

    // Same identity: reuses the slot.
    const relogin = fakeRunners();
    const r2 = await runLogin('claude', 'work', { meta: readMeta(), noWorkerToken: true }, relogin);
    expect(r2.mode).toBe('reconnect');
    expect(r2.slotDir).toBe(r1.slotDir);
    expect(relogin.logins[0]!.home).toBe(r1.slotDir);

    // Different identity in the slot: refused, account untouched.
    const stranger = fakeRunners({ defaultObserved: { identityKey: 'claude:user=OTHER', email: 'x@x.com', signedIn: true } });
    // Pre-launch guard: the slot is signed in as claude:user=1 from r1, and the
    // stranger's login never lands. Simulate by observing the stranger identity.
    await expect(runLogin('claude', 'work', { meta: readMeta(), noWorkerToken: true }, stranger))
      .rejects.toThrow(/currently signed in|different identity/);
    expect(listNativeAccounts(readMeta()).find(a => a.name === 'work')).toMatchObject({ identityKey: 'claude:user=1' });
  });

  it('runLogin on an unknown account fails loud with the add command', async () => {
    await expect(runLogin('claude', 'ghost', { meta: readMeta() }, fakeRunners()))
      .rejects.toThrow(/No claude account 'ghost'.*agents accounts add claude ghost/);
  });

  describe('worker credential minting (real reserved store, isolated backend)', () => {
    // Each case gets its own SECRETS_HOME (real standalone). Reserved `__<harness>__`
    // stores are raw file items, read back via readReservedCredential — the same
    // path the worker slot uses — since the standalone rejects a `__`-wrapped bundle
    // name. The legacy `auth` bundle is a plain name read through the client.
    useFreshSecretsHome();

    it('claude: mints the setup-token into __claude__ keyed by account id (+ legacy auth key) and records workerCredential', async () => {
      const result = await runAdd('claude', 'work', { meta: readMeta() }, fakeRunners());
      trackResult(result);
      expect(result.workerCredential).toBe('minted');
      expect(result.provisioning).toBe('portable');

      const key = workerCredentialStoreKey('claude', result.accountId);
      expect(result.workerCredentialRef).toEqual({ bundle: '__claude__', key });
      expect(readReservedCredential('__claude__', key)).toBe('sk-ant-oat01-testtoken');

      // Legacy `auth` bundle key for this release's pre-v2 readers.
      const legacyKey = claudeAccountTokenKey('a@example.com');
      expect(bundleExistsSync(AUTH_BUNDLE)).toBe(true);
      const legacy = readAndResolveBundleEnvSync(AUTH_BUNDLE, { keys: [legacyKey], keyMode: 'storage', agentOnly: true, caller: 'add.test' });
      expect(legacy.env[legacyKey]).toBe('sk-ant-oat01-testtoken');

      const row = listNativeAccounts(readMeta()).find(a => a.name === 'work')!;
      expect(row.workerCredential).toMatchObject({ bundle: '__claude__', key, kind: 'setup-token' });
      expect(row.provisioning).toBe('portable');
    });

    it('codex: stores --api-key as OPENAI_API_KEY_<accountId> in __codex__', async () => {
      const result = await runAdd('codex', 'personal', { meta: readMeta(), apiKey: 'sk-test-key' },
        fakeRunners({ defaultObserved: { identityKey: 'codex:user=1', email: 'c@x.com', signedIn: true } }));
      trackResult(result);
      expect(result.workerCredential).toBe('stored');
      const key = workerCredentialStoreKey('codex', result.accountId);
      expect(readReservedCredential('__codex__', key)).toBe('sk-test-key');
      const row = listNativeAccounts(readMeta()).find(a => a.name === 'personal')!;
      expect(row.workerCredential).toMatchObject({ bundle: '__codex__', key, kind: 'api-key' });
    });

    it('codex --per-device stores nothing and marks provisioning per-device', async () => {
      const result = await runAdd('codex', 'gmail', { meta: readMeta(), perDevice: true },
        fakeRunners({ defaultObserved: { identityKey: 'codex:user=9', email: 'g@x.com', signedIn: true } }));
      trackResult(result);
      expect(result.workerCredential).toBe('per-device');
      expect(result.provisioning).toBe('per-device');
      expect(result.workerCredentialRef).toBeUndefined();
      expect(readReservedCredential('__codex__', workerCredentialStoreKey('codex', result.accountId))).toBeNull();
    });

    it('--per-device on a harness without a per-device path fails loud', async () => {
      await expect(runAdd('claude', 'work', { meta: readMeta(), perDevice: true }, fakeRunners()))
        .rejects.toThrow(/--per-device is only valid/);
    });

    it('codex interactive prompt collects the key when --api-key is absent', async () => {
      const result = await runAdd('codex', 'prompted', { meta: readMeta() },
        fakeRunners({ defaultObserved: { identityKey: 'codex:user=7', email: 'p@x.com', signedIn: true }, promptKey: 'sk-prompted' }));
      trackResult(result);
      expect(result.workerCredential).toBe('stored');
      const key = workerCredentialStoreKey('codex', result.accountId);
      expect(readReservedCredential('__codex__', key)).toBe('sk-prompted');
    });

    it('codex without --api-key and no prompt driver fails loud naming --api-key', async () => {
      await expect(runAdd('codex', 'nokey', { meta: readMeta() },
        fakeRunners({ defaultObserved: { identityKey: 'codex:user=8', email: 'n@x.com', signedIn: true } })))
        .rejects.toThrow(/--api-key/);
      // The account registered (the login completed); only the mint failed loud.
      const row = listNativeAccounts(readMeta()).find(a => a.name === 'nokey')!;
      createdNames.push(row.name);
      createdSlotDirs.push(slotDir('codex', row.id));
      expect(row.workerCredential).toBeUndefined();
    });

    it('runLogin claude re-mints into the same reserved-store key', async () => {
      const r1 = await runAdd('claude', 'work', { meta: readMeta() },
        fakeRunners({ mintToken: 'sk-ant-oat01-first' }));
      trackResult(r1);
      const r2 = await runLogin('claude', 'work', { meta: readMeta() },
        fakeRunners({ mintToken: 'sk-ant-oat01-second' }));
      expect(r2.workerCredential).toBe('minted');
      expect(r2.workerCredentialRef).toEqual(r1.workerCredentialRef);
      const key = r1.workerCredentialRef!.key;
      expect(readReservedCredential('__claude__', key)).toBe('sk-ant-oat01-second');
    });
  });
});
