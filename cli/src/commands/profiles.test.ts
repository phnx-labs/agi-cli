import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as state from '../lib/state.js';
import { addProfile, applyFromSecrets } from './profiles.js';
import { readProfile, resolveProfileForRun } from '../lib/profiles.js';
import {
  getKeychainTokenSync,
  keychainRef,
  profileKeychainItem,
  secretsKeychainItem,
  setKeychainTokenSync,
  writeBundleWithItemsSync,
} from '../lib/secrets-client.js';
import { standaloneKeychainIsFileBacked, useFreshSecretsHome } from '../../tests/secrets-standalone.js';
import { addAccount, findAccount } from '../lib/account-registry.js';

const fileBacked = await standaloneKeychainIsFileBacked();

let TEST_ROOT: string;
let USER_DIR: string;

useFreshSecretsHome();

beforeEach(() => {
  TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-cmd-test-'));
  USER_DIR = path.join(TEST_ROOT, '.agents');
  fs.mkdirSync(path.join(USER_DIR, 'profiles'), { recursive: true });
  vi.spyOn(state, 'getUserAgentsDir').mockReturnValue(USER_DIR);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  writeBundleWithItemsSync(
    { name: 'prod', vars: { OPENROUTER_KEY: keychainRef('OPENROUTER_KEY') } },
    new Map([[secretsKeychainItem('prod', 'OPENROUTER_KEY'), 'sk-test-secret']]),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe.skipIf(!fileBacked)('addProfile — --from-secrets threading (host + model path)', () => {
  it('migrates the copied bundle value into a durable account reference', async () => {
    await addProfile('corp', { host: 'claude', model: 'gpt-x', authProvider: 'corp', fromSecrets: 'prod' }, 'Harness');
    const p = readProfile('corp');
    expect(p.auth).toBeUndefined();
    const account = findAccount(p.account!);
    expect(account?.provider).toBe('proxy');
    expect(getKeychainTokenSync(account!.secretRef)).toBe('sk-test-secret');
    expect(resolveProfileForRun('corp').env.ANTHROPIC_AUTH_TOKEN).toBe('sk-test-secret');
  });

  it('does not clobber the host\'s own keychain item when --from-secrets is given without --auth-provider', async () => {
    const preExisting = 'pre-existing-claude-host-token';
    setKeychainTokenSync(profileKeychainItem('claude'), preExisting);

    await addProfile('corp', { host: 'claude', model: 'gpt-x', fromSecrets: 'prod' }, 'Harness');

    expect(getKeychainTokenSync(profileKeychainItem('claude'))).toBe(preExisting);
    const p = readProfile('corp');
    expect(p.provider).toBe('proxy');
    const account = findAccount(p.account!);
    expect(account?.provider).toBe('proxy');
    expect(getKeychainTokenSync(account!.secretRef)).toBe('sk-test-secret');
  });
});

describe.skipIf(!fileBacked)('addProfile — --from-secrets threading (preset path)', () => {
  it('uses a durable account without acquiring the preset legacy token', async () => {
    const account = addAccount('openrouter-work', 'openrouter', 'api-key', 'sk-account-secret', USER_DIR);

    await expect(
      addProfile('kimi-account', { preset: 'kimi', account: 'openrouter-work' }, 'Harness'),
    ).resolves.toBeUndefined();

    const profile = readProfile('kimi-account');
    expect(profile.account).toBe(account.name);
    expect(profile.provider).toBe('openrouter');
  });

  it('skips the interactive key prompt entirely — a preset that normally requires auth still succeeds non-interactively', async () => {
    await expect(
      addProfile('kimi', { preset: 'kimi', fromSecrets: 'prod' }, 'Harness'),
    ).resolves.toBeUndefined();
    const p = readProfile('kimi');
    const account = findAccount(p.account!);
    expect(account?.provider).toBe('openrouter');
    expect(getKeychainTokenSync(account!.secretRef)).toBe('sk-test-secret');
  });
});

describe.skipIf(!fileBacked)('applyFromSecrets — provider precedence and error paths', () => {
  it('prefers an explicit auth-provider over the profile\'s existing one', async () => {
    const profile = {
      name: 'x',
      host: { agent: 'claude' as const },
      env: {},
      provider: 'old-provider',
      auth: { envVar: 'ANTHROPIC_AUTH_TOKEN', keychainItem: 'agents-cli.old-provider.token' },
    };
    await applyFromSecrets(profile, 'prod', 'new-provider');
    expect(getKeychainTokenSync(profileKeychainItem('new-provider'))).toBe('sk-test-secret');
  });

  it('names a bundle that does not exist instead of the standalone\'s opaque NOT_FOUND', async () => {
    const profile = { name: 'x', host: { agent: 'claude' as const }, env: {} };
    await expect(applyFromSecrets(profile, 'no-such-bundle', 'x')).rejects.toThrow(
      /Secrets bundle 'no-such-bundle' not found/,
    );
  });

  it('allowInheritedAuth: false rejects reusing an inherited auth binding (the fork-clobber gap)', async () => {
    const sourceToken = 'REAL-OPENROUTER-KEY-FOR-SOURCE-HARNESS';
    setKeychainTokenSync(profileKeychainItem('openrouter'), sourceToken);

    const forked = {
      name: 'forked-harness',
      host: { agent: 'claude' as const },
      env: {},
      provider: 'openrouter',
      auth: { envVar: 'ANTHROPIC_AUTH_TOKEN', keychainItem: profileKeychainItem('openrouter') },
    };

    await expect(
      applyFromSecrets(forked, 'prod', undefined, { allowInheritedAuth: false }),
    ).rejects.toThrow(/inherited its auth binding/i);

    expect(getKeychainTokenSync(profileKeychainItem('openrouter'))).toBe(sourceToken);
  });

  it('allowInheritedAuth: false still allows an explicit --auth-provider to rotate a fork\'s own credential', async () => {
    const forked = {
      name: 'forked-harness',
      host: { agent: 'claude' as const },
      env: {},
      provider: 'openrouter',
      auth: { envVar: 'ANTHROPIC_AUTH_TOKEN', keychainItem: profileKeychainItem('openrouter') },
    };
    await applyFromSecrets(forked, 'prod', 'openrouter', { allowInheritedAuth: false });
    expect(getKeychainTokenSync(profileKeychainItem('openrouter'))).toBe('sk-test-secret');
  });
});
