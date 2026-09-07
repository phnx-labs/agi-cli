import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { Command } from 'commander';

import {
  accountNameFromEmail,
  assertValidSetupToken,
  buildMintCommand,
  driveSetupTokenMint,
  extractClaudeSetupToken,
  extractMintUrl,
  getMintFlow,
  hasMintedSetupToken,
  listMintableHarnesses,
  mintAndSeed,
  MINT_FLOWS,
  resolveMintIdentity,
  resolveSyncTargets,
  seedNamedAccount,
  seedReservedAuthToken,
  seedReservedStoreKey,
  adoptLegacyReservedStoreItems,
  stripAnsi,
  unmintableMessage,
  workerCredentialEnv,
  workerCredentialStoreKey,
  type MintDriveHooks,
} from './auth-mint.js';
import { harnessWorkerKinds } from './harness-auth-capabilities.js';
import { upsertDevice } from './devices/registry.js';
import { resetSelfHostCache } from './devices/self-host.js';
import {
  AUTH_BUNDLE,
  claudeAccountTokenKey,
  isValidClaudeSetupToken,
  readReservedCredential,
  resolveClaudeSetupToken,
} from './claude-account-token.js';
import { findAccount } from './account-registry.js';
import { _resetSecretsClientForTest, bundleBackendSync, bundleExistsSync, readAndResolveBundleEnvSync, secretsKeychainItem, storeSetSync } from './secrets-client.js';
import { standaloneKeychainIsFileBacked, useFreshSecretsHome } from '../../tests/secrets-standalone.js';
import type { PtyDriver } from './fleet/remote-login.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => fs.readFileSync(path.join(here, 'testdata', name), 'utf-8');

const TOKEN = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz012345';
const EMAIL = 'ada@example.com';

function fakeDriver(frames: { screen: string; exited?: boolean }[]): PtyDriver & { writes: string[]; execs: string[]; stopped: string[] } {
  let i = 0;
  const writes: string[] = [];
  const execs: string[] = [];
  const stopped: string[] = [];
  return {
    writes,
    execs,
    stopped,
    async start() { return 'sess-mint'; },
    async exec(_id, command) { execs.push(command); },
    async write(_id, input) { writes.push(input); },
    async screen() {
      const frame = frames[Math.min(i, frames.length - 1)]!;
      i++;
      return { screen: frame.screen, exited: Boolean(frame.exited) };
    },
    async stop(id) { stopped.push(id); },
  };
}

describe('mint flow table', () => {
  it('lists only harnesses with a real interactive mint command', () => {
    expect(listMintableHarnesses()).toEqual(['claude']);
    expect(MINT_FLOWS.claude.mintArgs).toEqual(['setup-token']);
    expect(getMintFlow('claude').provider).toBe('anthropic');
  });

  it('fails loud for a harness with no setup-token mint', () => {
    expect(() => getMintFlow('kimi')).toThrow(/Cannot mint a setup-token for 'kimi'/);
    // api-key harnesses have no derivable token — the error names the collection path.
    expect(() => getMintFlow('grok')).toThrow(/no derivable token.*agents accounts add grok/);
    expect(() => getMintFlow('codex')).toThrow(/OPENAI_API_KEY/);
    expect(() => getMintFlow('not-an-agent')).toThrow(/Unknown harness/);
    expect(unmintableMessage('droid')).toMatch(/agents accounts add/);
  });

  it('api-key collection flows stay in lockstep with HARNESS_AUTH worker kinds', () => {
    const flows = Object.values(MINT_FLOWS).filter((f) => f.auth === 'api-key');
    expect(flows.map((f) => f.harness).sort()).toEqual(['codex', 'cursor', 'droid', 'grok', 'opencode']);
    for (const flow of flows) {
      const kinds = harnessWorkerKinds(flow.harness);
      expect(
        kinds.some((k) => k === `api-key:${flow.apiKeyEnv}` || k === 'api-key:provider'),
        `${flow.harness}: MINT_FLOWS apiKeyEnv must match a HARNESS_AUTH api-key worker kind`,
      ).toBe(true);
    }
  });

  it('keys worker credentials by account id (hyphens stripped, never by name/email)', () => {
    expect(workerCredentialEnv('claude')).toBe('CLAUDE_CODE_OAUTH_TOKEN');
    expect(workerCredentialEnv('grok')).toBe('XAI_API_KEY');
    expect(workerCredentialStoreKey('claude', '12f8a2df-d37b-4205-9658-498c2070736a'))
      .toBe('CLAUDE_CODE_OAUTH_TOKEN_12f8a2dfd37b42059658498c2070736a');
    expect(workerCredentialStoreKey('codex', 'id_1')).toBe('OPENAI_API_KEY_id_1');
    expect(() => workerCredentialStoreKey('claude', '../escape')).toThrow(/Invalid account id/);
    expect(() => workerCredentialEnv('kimi')).toThrow(/logs in per box/);
  });

  it('buildMintCommand quotes HOME and the binary', () => {
    expect(buildMintCommand(MINT_FLOWS.claude, '/opt/claude', '/tmp/home with space')).toBe(
      "HOME='/tmp/home with space' /opt/claude setup-token",
    );
  });
});

describe('extractClaudeSetupToken — the #1767 guard', () => {
  it('pulls the token out of a real completed setup-token screen', () => {
    expect(extractClaudeSetupToken(fixture('claude-setup-token-done.txt'))).toBe(TOKEN);
  });

  it('returns null on the authorize-URL screen (no token yet)', () => {
    expect(extractClaudeSetupToken(fixture('claude-setup-token.txt'))).toBeNull();
  });

  it('extracts a clean token from the #1767 ANSI-banner blob instead of treating the blob as the token', () => {
    const blob = '\x1b[?2004h\x1b[?1004hWelcome to Claude Code\n  sk-ant-oat01-abcdefghijklmnopqrstuvwxyz012345\n';
    expect(isValidClaudeSetupToken(blob)).toBe(false);
    expect(extractClaudeSetupToken(blob)).toBe(TOKEN);
    expect(assertValidSetupToken(extractClaudeSetupToken(blob)!)).toBe(TOKEN);
  });

  it('refuses a banner with no token', () => {
    expect(extractClaudeSetupToken('\x1b[32mWelcome to Claude Code\x1b[0m')).toBeNull();
    expect(() => assertValidSetupToken('\x1b[32mWelcome to Claude Code\x1b[0m')).toThrow(/Not a Claude setup-token/);
  });

  it('refuses two distinct tokens rather than guessing', () => {
    expect(() => extractClaudeSetupToken(`a ${TOKEN} b sk-ant-oat01-other-token-zzzz`)).toThrow(/2 distinct setup-tokens/);
  });

  it('strips CSI sequences so a wrapped URL still parses', () => {
    const raw = '\x1b[1mhttps://claude.ai/oauth/authorize?state=abc\x1b[0m';
    expect(stripAnsi(raw)).toContain('https://claude.ai/oauth/authorize?state=abc');
    expect(extractMintUrl(fixture('claude-setup-token.txt'), MINT_FLOWS.claude)).toMatch(/^https:\/\/claude\.ai\/oauth\/authorize/);
  });
});

describe('resolveMintIdentity', () => {
  it('treats --account email as both the name source and the bundle key', () => {
    expect(resolveMintIdentity({ account: EMAIL })).toEqual({
      accountName: 'ada-at-example.com',
      email: EMAIL,
    });
    expect(accountNameFromEmail(EMAIL)).toBe('ada-at-example.com');
  });

  it('keeps a name and requires --email when --account is not an email', () => {
    expect(resolveMintIdentity({ account: 'work', email: EMAIL })).toEqual({
      accountName: 'work',
      email: EMAIL,
    });
    expect(() => resolveMintIdentity({ account: 'work' })).toThrow(/without an email/);
  });

  it('reads the signed-in email from a version home when flags omit it', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mint-identity-home-'));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude', '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: EMAIL } }),
    );
    try {
      expect(resolveMintIdentity({ home })).toEqual({
        accountName: 'ada-at-example.com',
        email: EMAIL,
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('driveSetupTokenMint', () => {
  const fast = { initialDelayMs: 0, pollMs: 1, timeoutMs: 400 };
  const flow = MINT_FLOWS.claude;

  it('opens the authorize URL then captures the token from a later screen', async () => {
    const opened: string[] = [];
    const driver = fakeDriver([
      { screen: fixture('claude-setup-token.txt') },
      { screen: fixture('claude-setup-token-done.txt') },
    ]);
    const r = await driveSetupTokenMint('HOME=/tmp/x /bin/claude setup-token', flow, {
      driver,
      openUrl: async (url) => { opened.push(url); },
      drive: fast,
    });
    expect(driver.execs[0]).toContain('setup-token');
    expect(opened[0]).toMatch(/^https:\/\/claude\.ai\/oauth\/authorize/);
    expect(r.token).toBe(TOKEN);
    expect(driver.stopped).toEqual(['sess-mint']);
  });

  it('driveSetupTokenMint with json writes no Authorize URL on stdout', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => {
      logs.push(a.map(String).join(' '));
    });
    const driver = fakeDriver([
      { screen: fixture('claude-setup-token.txt') },
      { screen: fixture('claude-setup-token-done.txt') },
    ]);
    try {
      await driveSetupTokenMint('claude setup-token', flow, {
        driver,
        json: true,
        openUrl: async () => {},
        drive: fast,
        code: 'AUTHCODE#state',
      });
      expect(logs).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('pastes --code into the PTY after the URL appears', async () => {
    const driver = fakeDriver([
      { screen: fixture('claude-setup-token.txt') },
      { screen: fixture('claude-setup-token-done.txt') },
    ]);
    await driveSetupTokenMint('claude setup-token', flow, {
      driver,
      openUrl: async () => {},
      drive: fast,
      code: 'AUTHCODE#state',
    });
    expect(driver.writes).toEqual(['AUTHCODE#state\r']);
  });

  it('stops the PTY and fails loud when the process exits with no token', async () => {
    const driver = fakeDriver([{ screen: 'denied', exited: true }]);
    await expect(driveSetupTokenMint('claude setup-token', flow, {
      driver,
      openUrl: async () => {},
      drive: fast,
    })).rejects.toThrow(/exited before printing/);
    expect(driver.stopped).toContain('sess-mint');
  });
});

// A named provider account (seedNamedAccount → addAccount) is a bundle with no
// explicit backend, which the real standalone would put in the operator's login
// keychain on a headed macOS box; those blocks run only where keychain items
// are file-backed (headless Linux/Windows, CI). The reserved `auth` bundle is
// written with `backend: 'file'` and runs everywhere.
const fileBacked = await standaloneKeychainIsFileBacked();

/** A real version home signed into EMAIL (writes .claude.json), removed after each test. */
function useSignedInHome(): () => string {
  let home = '';
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-mint-home-'));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude', '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: EMAIL } }),
    );
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });
  return () => home;
}

describe('seedReservedAuthToken — the reserved file-backed auth bundle', () => {
  useFreshSecretsHome();
  const home = useSignedInHome();

  it('seeds the reserved file-backed auth bundle so resolveClaudeSetupToken reads it', () => {
    expect(hasMintedSetupToken().ready).toBe(false);
    const { key } = seedReservedAuthToken(EMAIL, TOKEN);
    expect(key).toBe(claudeAccountTokenKey(EMAIL));
    expect(bundleExistsSync(AUTH_BUNDLE)).toBe(true);
    expect(bundleBackendSync(AUTH_BUNDLE)).toBe('file');
    expect(resolveClaudeSetupToken(home())).toBe(TOKEN);
    const { env } = readAndResolveBundleEnvSync(AUTH_BUNDLE, { caller: 'test', agentOnly: true });
    expect(env[key]).toBe(TOKEN);
    expect(hasMintedSetupToken().ready).toBe(true);
  });

  it('seedReservedStoreKey writes __<harness>__ as a file-backed bundle the push can read, rotates in place, and refuses rotating kinds', () => {
    const accountId = '12f8a2df-d37b-4205-9658-498c2070736a';
    const key = workerCredentialStoreKey('claude', accountId);
    const first = seedReservedStoreKey('claude', 'setup-token', key, TOKEN);
    expect(first).toEqual({ bundle: '__claude__', key });
    // The worker slot reads the raw item (readReservedCredential) …
    expect(readReservedCredential('__claude__', key)).toBe(TOKEN);
    // … and the daemon push reads the store AS A BUNDLE (pushBundleToHost →
    // readAndResolveBundleEnv). A bare raw item with no bundle record made every
    // reserved-store push fail with "Invalid bundle name" / OPERATION_FAILED and
    // left every worker without a Cursor/Codex/Grok key — so this is the read
    // that must succeed, on a FILE-backed, policy-never bundle.
    expect(bundleExistsSync('__claude__')).toBe(true);
    expect(bundleBackendSync('__claude__')).toBe('file');
    const resolved = readAndResolveBundleEnvSync('__claude__', { caller: 'test', agentOnly: true, keyMode: 'storage' });
    expect(resolved.env[key]).toBe(TOKEN);
    expect(resolved.bundle.policy).toBe('never');

    // Rotation: same key, new value (re-mint after expiry).
    seedReservedStoreKey('claude', 'setup-token', key, `${TOKEN}rotated`);
    expect(readReservedCredential('__claude__', key)).toBe(`${TOKEN}rotated`);
    expect(readAndResolveBundleEnvSync('__claude__', { caller: 'test', agentOnly: true, keyMode: 'storage' }).env[key]).toBe(`${TOKEN}rotated`);

    // A second harness gets its own store and value.
    const grokKey = workerCredentialStoreKey('grok', accountId);
    seedReservedStoreKey('grok', 'api-key', grokKey, 'xai-test');
    expect(readReservedCredential('__grok__', grokKey)).toBe('xai-test');
    expect(bundleBackendSync('__grok__')).toBe('file');
    expect(readAndResolveBundleEnvSync('__grok__', { caller: 'test', agentOnly: true, keyMode: 'storage' }).env[grokKey]).toBe('xai-test');

    // The write boundary refuses a rotating OAuth/session credential (RUSH-1958).
    expect(() => seedReservedStoreKey('codex', 'oauth-session' as never, 'OPENAI_API_KEY_x', 'v'))
      .toThrow(/rotating session/);
  });

  it('adoptLegacyReservedStoreItems folds a pre-bundle raw reserved item into its file-backed bundle, once', () => {
    // The shape 1.22.84–1.22.89 left behind: the value sits at the item name the
    // bundle would use, but no bundle record exists, so the push cannot read it.
    const accountId = '3dbc408e-a885-4571-8137-2c7ddc84a2ad';
    const key = workerCredentialStoreKey('cursor', accountId);
    storeSetSync('file', secretsKeychainItem('__cursor__', key), 'crsr_legacy_value');
    expect(readReservedCredential('__cursor__', key)).toBe('crsr_legacy_value');
    expect(bundleExistsSync('__cursor__')).toBe(false);

    const meta = { accounts: { native: { [accountId]: { id: accountId, name: 'gmail', agent: 'cursor' as const, identityKey: 'cursor:user=u', scope: 'version' as const, identityLabel: 'g.io', workerCredential: { bundle: '__cursor__', key, kind: 'api-key' as const, mintedAt: 'm1' } } } } };
    const first = adoptLegacyReservedStoreItems(meta);
    expect(first).toEqual({ adopted: [{ bundle: '__cursor__', key }], errors: [] });
    expect(bundleBackendSync('__cursor__')).toBe('file');
    const resolved = readAndResolveBundleEnvSync('__cursor__', { caller: 'test', agentOnly: true, keyMode: 'storage' });
    expect(resolved.env[key]).toBe('crsr_legacy_value');
    expect(resolved.bundle.policy).toBe('never');
    // The raw reader keeps working on the adopted item (same name).
    expect(readReservedCredential('__cursor__', key)).toBe('crsr_legacy_value');

    // Idempotent: the bundle now carries the key, so a second pass adopts nothing.
    expect(adoptLegacyReservedStoreItems(meta)).toEqual({ adopted: [], errors: [] });
  });

  it('reports not-ready instead of crashing when the standalone secrets CLI is unreachable (PHNX-3385)', () => {
    // `agents setup` / `agents doctor` call this as a read-only probe; both the
    // account-registry read and the auth-bundle read go through the client, so
    // a missing / unspawnable `secrets` executable must degrade to "cannot
    // confirm", never throw out of the status command.
    const savedBin = process.env.SECRETS_BIN;
    process.env.SECRETS_BIN = path.join(os.tmpdir(), 'no-such-secrets-cli');
    _resetSecretsClientForTest();
    try {
      const status = hasMintedSetupToken();
      expect(status.ready).toBe(false);
      expect(status.detail).toMatch(/could not check the secret store/);
    } finally {
      if (savedBin === undefined) delete process.env.SECRETS_BIN;
      else process.env.SECRETS_BIN = savedBin;
      _resetSecretsClientForTest();
    }
  });

  it('rotates an existing account key in place and keeps a second account beside it', () => {
    seedReservedAuthToken(EMAIL, TOKEN);
    const rotated = 'sk-ant-oat01-rotatedtokenvaluezzzzzzzzzz';
    expect(seedReservedAuthToken(EMAIL, rotated).key).toBe(claudeAccountTokenKey(EMAIL));
    const other = 'bob@example.com';
    const otherToken = 'sk-ant-oat01-bobtokenvalue0123456789';
    seedReservedAuthToken(other, otherToken);
    const { bundle, env } = readAndResolveBundleEnvSync(AUTH_BUNDLE, { caller: 'test', agentOnly: true });
    expect(bundle.backend).toBe('file');
    expect(env[claudeAccountTokenKey(EMAIL)]).toBe(rotated);
    expect(env[claudeAccountTokenKey(other)]).toBe(otherToken);
    expect(resolveClaudeSetupToken(home())).toBe(rotated);
  });

  it('refuses to seed the #1767 TTY blob into the reserved bundle', () => {
    const blob = '\x1b[?2004hWelcome to Claude Code\n  sk-ant-oat01-abcdefghijklmnopqrstuvwxyz012345\n';
    expect(() => seedReservedAuthToken(EMAIL, blob)).toThrow(/Not a Claude setup-token/);
    expect(bundleExistsSync(AUTH_BUNDLE)).toBe(false);
    expect(resolveClaudeSetupToken(home())).toBeNull();
  });
});

describe.skipIf(!fileBacked)('mintAndSeed — named account + reserved auth key', () => {
  useFreshSecretsHome();
  const home = useSignedInHome();

  it('mintAndSeed --token path writes the named account AND the reserved auth key', async () => {
    const result = await mintAndSeed({
      harness: 'claude',
      account: EMAIL,
      token: TOKEN,
    });
    expect(result.account).toBe('ada-at-example.com');
    expect(result.email).toBe(EMAIL);
    expect(result.rotated).toBe(false);
    expect(result.fleet).toEqual([]);
    expect(findAccount(result.account)?.auth).toBe('setup-token');
    expect(resolveClaudeSetupToken(home())).toBe(TOKEN);
    expect(result.authBundleKey).toBe(claudeAccountTokenKey(EMAIL));
  });

  it('rotates an existing anthropic setup-token account instead of colliding', async () => {
    seedNamedAccount('work', TOKEN, MINT_FLOWS.claude);
    const rotated = 'sk-ant-oat01-rotatedtokenvaluezzzzzzzzzz';
    const result = await mintAndSeed({
      harness: 'claude',
      account: 'work',
      email: EMAIL,
      token: rotated,
    });
    expect(result.rotated).toBe(true);
    expect(result.account).toBe('work');
    expect(resolveClaudeSetupToken(home())).toBe(rotated);
  });

  it('mintAndSeed --code --json writes no progress lines; stdout is only valid JSON', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => {
      logs.push(a.map(String).join(' '));
    });
    const driver = fakeDriver([
      { screen: fixture('claude-setup-token.txt') },
      { screen: fixture('claude-setup-token-done.txt') },
    ]);
    try {
      const result = await mintAndSeed({
        harness: 'claude',
        account: EMAIL,
        code: 'AUTHCODE#state',
        json: true,
        open: false,
        hooks: { driver, drive: { initialDelayMs: 0, pollMs: 1, timeoutMs: 400 } },
      });
      expect(result.account).toBe('ada-at-example.com');
      expect(result.email).toBe(EMAIL);
      expect(logs).toEqual([]);
      expect(result).not.toHaveProperty('token');
    } finally {
      spy.mockRestore();
    }
  });

  it('mintAndSeed --code without --json prints the authorize URL on stdout', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => {
      logs.push(a.map(String).join(' '));
    });
    const driver = fakeDriver([
      { screen: fixture('claude-setup-token.txt') },
      { screen: fixture('claude-setup-token-done.txt') },
    ]);
    try {
      await mintAndSeed({
        harness: 'claude',
        account: EMAIL,
        code: 'AUTHCODE#state',
        open: false,
        hooks: { driver, drive: { initialDelayMs: 0, pollMs: 1, timeoutMs: 400 } },
      });
      const stdout = logs.join('\n');
      expect(stdout).toMatch(/Authorize: https:\/\/claude\.ai\/oauth\/authorize/);
      expect(stdout).toMatch(/Authorize URL: https:\/\/claude\.ai\/oauth\/authorize/);
    } finally {
      spy.mockRestore();
    }
  });

  it('accounts mint --code --json stdout is only parseable JSON', async () => {
    const { registerMintCommand } = await import('../commands/auth-mint.js');
    const driver = fakeDriver([
      { screen: fixture('claude-setup-token.txt') },
      { screen: fixture('claude-setup-token-done.txt') },
    ]);
    const hooks: MintDriveHooks = {
      driver,
      drive: { initialDelayMs: 0, pollMs: 1, timeoutMs: 400 },
    };
    const program = new Command();
    program.exitOverride();
    registerMintCommand(program.command('accounts'), hooks);
    const out: string[] = [];
    const err: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.map(String).join(' ')));
    const error = vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(a.map(String).join(' ')));
    const proc = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit__:${code}`);
    }) as never);
    try {
      await program.parseAsync([
        'node', 'agents', 'accounts', 'mint', 'claude',
        '--code', 'AUTHCODE#state',
        '--json',
        '--no-open',
        '--account', EMAIL,
      ]);
    } catch (e) {
      if (!(e instanceof Error) || !e.message.startsWith('__exit__')) throw e;
    } finally {
      log.mockRestore();
      error.mockRestore();
      proc.mockRestore();
    }
    const stdout = out.join('\n');
    expect(stdout).not.toMatch(/Authorize/);
    const parsed = JSON.parse(stdout) as {
      harness: string;
      account: string;
      email: string;
      authBundleKey: string;
      rotated: boolean;
      fleet: unknown[];
      token?: string;
      error?: string;
    };
    expect(parsed).toEqual({
      harness: 'claude',
      account: 'ada-at-example.com',
      email: EMAIL,
      authBundleKey: claudeAccountTokenKey(EMAIL),
      rotated: false,
      fleet: [],
    });
    expect(parsed).not.toHaveProperty('token');
    expect(parsed.error).toBeUndefined();
  });

  describe('--fleet / --device through mintAndSeed', () => {
    const SELF = 'mint-self';
    const PEER = 'peer-a';
    let devicesDir: string;
    let prevDevicesDir: string | undefined;
    let prevMachineId: string | undefined;

    beforeEach(async () => {
      devicesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-mint-seed-devices-'));
      prevDevicesDir = process.env.AGENTS_DEVICES_DIR;
      prevMachineId = process.env.AGENTS_SYNC_MACHINE_ID;
      process.env.AGENTS_DEVICES_DIR = devicesDir;
      process.env.AGENTS_SYNC_MACHINE_ID = SELF;
      resetSelfHostCache();
      await upsertDevice(SELF, {
        platform: 'linux',
        user: 'test',
        address: { via: 'manual', dnsName: `${SELF}.example.ts.net` },
      });
      await upsertDevice(PEER, {
        platform: 'linux',
        user: 'test',
        address: { via: 'manual', dnsName: `${PEER}.example.ts.net` },
      });
      resetSelfHostCache();
    });

    afterEach(() => {
      if (prevDevicesDir === undefined) delete process.env.AGENTS_DEVICES_DIR;
      else process.env.AGENTS_DEVICES_DIR = prevDevicesDir;
      if (prevMachineId === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
      else process.env.AGENTS_SYNC_MACHINE_ID = prevMachineId;
      resetSelfHostCache();
      fs.rmSync(devicesDir, { recursive: true, force: true });
    });

    it('fails loud on an unknown --device', async () => {
      await expect(mintAndSeed({
        harness: 'claude',
        account: EMAIL,
        token: TOKEN,
        devices: ['no-such-box'],
      })).rejects.toThrow(/Unknown device 'no-such-box'/);
    });

    it('skips --device self and returns an empty fleet list', async () => {
      const result = await mintAndSeed({
        harness: 'claude',
        account: EMAIL,
        token: TOKEN,
        devices: [SELF],
      });
      expect(result.fleet).toEqual([]);
    });

    it('throws a partial-fleet-failure after seeding locally when a peer sync fails', async () => {
      await expect(mintAndSeed({
        harness: 'claude',
        account: EMAIL,
        token: TOKEN,
        devices: [PEER],
      })).rejects.toThrow(/Minted locally but fleet sync failed for: peer-a/);
      expect(findAccount('ada-at-example.com')?.auth).toBe('setup-token');
      expect(resolveClaudeSetupToken(home())).toBe(TOKEN);
    });
  });
});

describe('agents auth mint / accounts mint command wiring', () => {
  async function run(group: 'auth' | 'accounts', ...argv: string[]): Promise<{ out: string; err: string; exit: number | undefined }> {
    const { registerAuthCommand } = await import('../commands/auth.js');
    const { registerAccountsCommand } = await import('../commands/accounts.js');
    const program = new Command();
    program.exitOverride();
    registerAuthCommand(program);
    registerAccountsCommand(program);
    const out: string[] = [];
    const err: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.map(String).join(' ')));
    const error = vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(a.map(String).join(' ')));
    let exit: number | undefined;
    const proc = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exit = code;
      throw new Error('__exit__');
    }) as never);
    try {
      await program.parseAsync(['node', 'agents', group, ...argv]);
    } catch (e) {
      if (!(e instanceof Error) || e.message !== '__exit__') throw e;
    } finally {
      log.mockRestore();
      error.mockRestore();
      proc.mockRestore();
    }
    return { out: out.join('\n'), err: err.join('\n'), exit };
  }

  it('registers mint on both auth and accounts as hidden, teaching add/login', async () => {
    const { registerAuthCommand } = await import('../commands/auth.js');
    const { registerAccountsCommand } = await import('../commands/accounts.js');
    const { applyGlobalHelpConventions } = await import('./help.js');
    const program = new Command('agents');
    applyGlobalHelpConventions(program);
    registerAuthCommand(program);
    registerAccountsCommand(program);
    const auth = program.commands.find((c) => c.name() === 'auth')!;
    const accounts = program.commands.find((c) => c.name() === 'accounts')!;
    const authMint = auth.commands.find((c) => c.name() === 'mint')!;
    const accountsMint = accounts.commands.find((c) => c.name() === 'mint')!;
    expect((authMint as unknown as { _hidden: boolean })._hidden).toBe(true);
    expect((accountsMint as unknown as { _hidden: boolean })._hidden).toBe(true);
    expect(auth.helpInformation()).not.toMatch(/^  mint\b/m);
    expect(accounts.helpInformation()).not.toMatch(/^  mint\b/m);
    const authHelp = authMint.helpInformation();
    const accountsHelp = accountsMint.helpInformation();
    expect(authHelp).toContain('agents accounts add claude work');
    expect(authHelp).toContain('agents accounts login claude#work');
    expect(authHelp).toContain('--token-stdin');
    expect(authHelp).toContain('--code AUTHCODE --json');
    expect(accountsHelp).toContain('sk-ant-oat01-');
    expect(program.commands.find((c) => c.name() === 'auth')!.commands.map((c) => c.name())).toContain('mint');
    expect(program.commands.find((c) => c.name() === 'accounts')!.commands.map((c) => c.name())).toContain('mint');
  });

  it('fails loud for an unmintable harness before touching a PTY', async () => {
    const r = await run('auth', 'mint', 'grok');
    const text = `${r.out}${r.err}`;
    expect(text).toMatch(/no derivable token.*agents accounts add grok/);
    expect(r.err).toContain("hidden alias; use `agents accounts add <harness> [name] / agents accounts login <harness>#<name>`");
    expect(r.exit).toBe(1);
  });

  it('mint --json for an unmintable harness emits only parseable JSON on stdout', async () => {
    const r = await run('accounts', 'mint', 'grok', '--json');
    expect(r.exit).toBe(1);
    expect(r.out).not.toMatch(/Authorize/);
    expect(r.err).toContain("hidden alias; use `agents accounts add <harness> [name] / agents accounts login <harness>#<name>`");
    const parsed = JSON.parse(r.out);
    expect(parsed.error).toMatch(/no derivable token.*agents accounts add grok/);
  });
});

describe('resolveSyncTargets — --fleet / --device', () => {
  const SELF = 'mint-self';
  const PEER_A = 'peer-a';
  const PEER_B = 'peer-b';
  let devicesDir: string;
  let prevDevicesDir: string | undefined;
  let prevMachineId: string | undefined;

  beforeEach(async () => {
    devicesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-mint-devices-'));
    prevDevicesDir = process.env.AGENTS_DEVICES_DIR;
    prevMachineId = process.env.AGENTS_SYNC_MACHINE_ID;
    process.env.AGENTS_DEVICES_DIR = devicesDir;
    process.env.AGENTS_SYNC_MACHINE_ID = SELF;
    resetSelfHostCache();
    fs.mkdirSync(devicesDir, { recursive: true });
    await upsertDevice(SELF, {
      platform: 'linux',
      user: 'test',
      address: { via: 'manual', dnsName: `${SELF}.example.ts.net` },
    });
    await upsertDevice(PEER_A, {
      platform: 'linux',
      user: 'test',
      address: { via: 'manual', dnsName: `${PEER_A}.example.ts.net` },
    });
    await upsertDevice(PEER_B, {
      platform: 'linux',
      user: 'test',
      address: { via: 'manual', dnsName: `${PEER_B}.example.ts.net` },
    });
    resetSelfHostCache();
  });

  afterEach(() => {
    if (prevDevicesDir === undefined) delete process.env.AGENTS_DEVICES_DIR;
    else process.env.AGENTS_DEVICES_DIR = prevDevicesDir;
    if (prevMachineId === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
    else process.env.AGENTS_SYNC_MACHINE_ID = prevMachineId;
    resetSelfHostCache();
    fs.rmSync(devicesDir, { recursive: true, force: true });
  });

  it('returns no targets when neither --fleet nor --device is set', async () => {
    expect(await resolveSyncTargets(false, [])).toEqual([]);
  });

  it('fails loud for an unknown --device name', async () => {
    await expect(resolveSyncTargets(false, ['no-such-box'])).rejects.toThrow(
      /Unknown device 'no-such-box'/,
    );
  });

  it('skips a --device that is this host', async () => {
    expect(await resolveSyncTargets(false, [SELF])).toEqual([]);
    expect(await resolveSyncTargets(false, ['localhost'])).toEqual([]);
  });

  it('unions --fleet with named --device and drops self + duplicates', async () => {
    expect(await resolveSyncTargets(true, [])).toEqual([PEER_A, PEER_B]);
    expect(await resolveSyncTargets(true, [PEER_A, SELF])).toEqual([PEER_A, PEER_B]);
    expect(await resolveSyncTargets(false, [PEER_A, PEER_A, SELF])).toEqual([PEER_A]);
  });
});
