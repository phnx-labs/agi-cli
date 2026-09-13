import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import { password } from '@inquirer/prompts';
import { parseBundleKey, parseLogoutTarget, registerAccountsCommand, setDefaultAccount } from './accounts.js';
import { addAccount, addNativeAccount, labelNativeAccount, removeAccount } from '../lib/account-registry.js';
import { recordSlot, slotDir } from '../lib/accounts/slots.js';
import { getAgentConfigPath } from '../lib/installations/shims.js';

import { getUserAgentsDir, readMeta, updateMeta } from '../lib/state.js';
import { standaloneKeychainIsFileBacked, useFreshSecretsHome } from '../../tests/secrets-standalone.js';

vi.mock('@inquirer/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@inquirer/prompts')>();
  return { ...actual, password: vi.fn(actual.password) };
});

// Provider accounts (`agents accounts add`, addAccount) are bundles with no
// explicit backend, so on a headed macOS box the real standalone would write
// them to the operator's login keychain; those tests run where keychain items
// are file-backed (headless Linux/Windows, CI). The reserved `auth` bundle is
// explicitly file-backed and runs everywhere.
const fileBacked = await standaloneKeychainIsFileBacked();

function cancelledPromptError(): Error {
  return Object.assign(new Error('User force closed the prompt with 0 null'), { name: 'ExitPromptError' });
}

describe('accounts credential import', () => {
  it('parses the bundle and key without tying the account to an agent version', () => {
    expect(parseBundleKey('openrouter.ai:OPENROUTER_API_KEY')).toEqual({
      bundle: 'openrouter.ai',
      key: 'OPENROUTER_API_KEY',
    });
  });

  it('rejects incomplete secret references', () => {
    expect(() => parseBundleKey('openrouter.ai')).toThrow('Expected bundle:key');
    expect(() => parseBundleKey(':KEY')).toThrow('Expected bundle:key');
  });
});

/**
 * PHNX-2578: add --from-secrets and inspect used to throw a raw Error that
 * bootstrap rethrows as an uncaught Node stack dump. They must fail as a
 * commander CLI error (code accounts.error) with a one-line message.
 */
describe('accounts add/inspect CLI errors', () => {
  useFreshSecretsHome();

  async function runAccounts(args: string[]): Promise<string> {
    const program = new Command();
    program.exitOverride();
    registerAccountsCommand(program);
    const chunks: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      chunks.push(a.map(String).join(' '));
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await program.parseAsync(['node', 'agents', 'accounts', ...args]);
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
    return chunks.join('\n');
  }

  async function captureAccountsError(args: string[]): Promise<{ code?: string; exitCode?: number; message: string }> {
    try {
      await runAccounts(args);
      throw new Error('expected accounts command to fail');
    } catch (err) {
      const e = err as { code?: string; exitCode?: number; message: string };
      return { code: e.code, exitCode: e.exitCode, message: e.message };
    }
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('inspect of an unknown account is a clean CLI error, not an uncaught throw', async () => {
    const err = await captureAccountsError(['inspect', 'phnx-2578-not-an-account']);
    expect(err).toMatchObject({ code: 'accounts.error', exitCode: 1 });
    expect(err.message).toContain("Unknown account 'phnx-2578-not-an-account'");
  });

  it('refuses a bare name shared by several harnesses; a harness selector scopes view', async () => {
    const testName = 'phnx3988icloud';
    const clear = (): void => updateMeta(meta => {
      const native = Object.fromEntries(Object.entries(meta.accounts?.native ?? {}).filter(([, account]) => account.name !== testName));
      return { ...meta, accounts: { ...meta.accounts, native } };
    });
    clear();
    try {
      const claude = labelNativeAccount('claude', 'claude:phnx3988=view', 'me@example.com', testName, 'version');
      const codex = labelNativeAccount('codex', 'codex:phnx3988=view', 'me@example.com', testName, 'version');
      const err = await captureAccountsError(['view', testName]);
      expect(err).toMatchObject({ code: 'accounts.error', exitCode: 1 });
      expect(err.message).toBe(
        `Account '${testName}' exists for several harnesses (claude, codex). Pick one with <harness>#${testName}, e.g. claude#${testName}.`,
      );

      const out = await runAccounts(['view', `codex#${testName}`, '--json']);
      const parsed = JSON.parse(out) as { id: string; name: string; agent: string; kind: string };
      expect(parsed).toMatchObject({ id: codex.id, name: testName, agent: 'codex', kind: 'native' });
      expect(parsed.id).not.toBe(claude.id);
    } finally {
      clear();
    }
  });

  it('add --from-secrets against a missing bundle is a clean CLI error', async () => {
    const err = await captureAccountsError([
      'add', 'phnx-2578-missing',
      '--provider', 'openrouter',
      '--auth', 'api-key',
      '--from-secrets', 'does-not-exist:KEY',
    ]);
    expect(err).toMatchObject({ code: 'accounts.error', exitCode: 1 });
    // The standalone reports only a code; agents-cli names the bundle, as one
    // clean line, never a stack dump.
    expect(err.message).toMatch(/Secrets bundle 'does-not-exist' not found/);
    expect(err.message).not.toMatch(/\n\s+at /);
  });

  async function runCancelledSecretPrompt(args: string[]): Promise<{ errors: string; thrown: unknown; exitCodes: number[] }> {
    vi.mocked(password).mockRejectedValueOnce(cancelledPromptError());
    const errors: string[] = [];
    const exitCodes: number[] = [];
    const program = new Command();
    program.exitOverride();
    registerAccountsCommand(program);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(' '));
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCodes.push(code ?? 0);
    }) as typeof process.exit);
    let thrown: unknown;
    try {
      await program.parseAsync(['node', 'agents', 'accounts', ...args]);
    } catch (err) {
      thrown = err;
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
    return { errors: errors.join('\n'), thrown, exitCodes };
  }

  it('cancelled add password prompt exits 130 silently, not as accounts.error', async () => {
    const result = await runCancelledSecretPrompt([
      'add', 'phnx-2578-cancel', '--provider', 'openrouter', '--auth', 'api-key',
    ]);
    expect(result.exitCodes).toEqual([130]);
    expect(result.thrown).toBeUndefined();
    expect(result.errors).not.toMatch(/force closed|accounts\.error|error:/i);
  });

});


describe('accounts default write path', () => {
  useFreshSecretsHome();

  const TEST_NATIVE_NAMES = ['claude-native-default', 'antigravity-home'];
  const clearTestNativeAccounts = (): void => updateMeta(meta => {
    const native = Object.fromEntries(Object.entries(meta.accounts?.native ?? {}).filter(([, account]) =>
      !TEST_NATIVE_NAMES.includes(account.name),
    ));
    return { ...meta, accounts: { ...meta.accounts, native } };
  });

  beforeEach(clearTestNativeAccounts);
  afterEach(() => {
    clearTestNativeAccounts();
    vi.restoreAllMocks();
  });

  async function runAccounts(args: string[]): Promise<string> {
    const program = new Command();
    program.exitOverride();
    registerAccountsCommand(program);
    const chunks: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      chunks.push(a.map(String).join(' '));
    });
    try {
      await program.parseAsync(['node', 'agents', 'accounts', ...args]);
    } finally {
      log.mockRestore();
    }
    return chunks.join('\n');
  }


  it('setDefaultAccount succeeds for a native account and records it as the harness default (follow-up to PR #2810)', () => {
    addNativeAccount('claude-native-default', 'claude', 'native-identity-key-1', 'user@example.com', 'version');
    const result = setDefaultAccount('claude', 'claude-native-default');
    expect(result.agent).toBe('claude');
    expect(result.account.name).toBe('claude-native-default');
    expect(readMeta().accounts?.defaults?.claude).toBe('claude-native-default');
  });

  it('setDefaultAccount on a symlink-adopted harness fails loud without writing the default when the slot is missing', () => {
    const name = `droid-default-miss-${Date.now()}`;
    const native = addNativeAccount(name, 'droid', `droid:opaque=${name}`, undefined, 'device');
    try {
      const before = readMeta().accounts?.defaults?.droid;
      expect(() => setDefaultAccount('droid', name)).toThrow(/has no slot on this device/);
      expect(() => setDefaultAccount('droid', name)).toThrow(/accounts (login|add) droid/);
      expect(readMeta().accounts?.defaults?.droid).toBe(before);
    } finally {
      removeAccount(native.name);
    }
  });

  it('setDefaultAccount on a symlink-adopted harness repoints then records the default', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't5-acct-default-'));
    const prevReal = process.env.AGENTS_REAL_HOME;
    const name = `droid-default-ok-${Date.now()}`;
    process.env.AGENTS_REAL_HOME = tmp;
    let native: ReturnType<typeof addNativeAccount> | undefined;
    let dir: string | undefined;
    try {
      native = addNativeAccount(name, 'droid', `droid:opaque=${name}`, undefined, 'device');
      dir = slotDir('droid', native.id);
      fs.mkdirSync(path.join(dir, '.factory'), { recursive: true });
      recordSlot(native.id, { accountId: native.id, slotDir: dir, authMode: 'native', verdict: 'live' });
      const configPath = getAgentConfigPath('droid');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.mkdirSync(path.join(tmp, 'other', '.factory'), { recursive: true });
      fs.symlinkSync(path.join(tmp, 'other', '.factory'), configPath);
      const result = setDefaultAccount('droid', name);
      expect(result.account.name).toBe(name);
      expect(readMeta().accounts?.defaults?.droid).toBe(name);
      const target = fs.readlinkSync(configPath);
      expect(path.resolve(path.dirname(configPath), target)).toBe(path.resolve(dir, '.factory'));
    } finally {
      if (native) {
        try { removeAccount(native.name); } catch { /* already gone */ }
      }
      updateMeta((m) => {
        const defaults = { ...m.accounts?.defaults };
        delete defaults.droid;
        const slots = { ...m.deviceAccounts?.slots };
        if (native) delete slots[native.id];
        return { ...m, accounts: { ...m.accounts, defaults }, deviceAccounts: { ...m.deviceAccounts, slots } };
      });
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
      if (prevReal === undefined) delete process.env.AGENTS_REAL_HOME;
      else process.env.AGENTS_REAL_HOME = prevReal;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });




});




describe('parseLogoutTarget (PHNX-3940 — honor @label / #account selectors)', () => {
  it('splits a bare harness', () => {
    expect(parseLogoutTarget('claude')).toEqual({ agentRaw: 'claude' });
  });
  it('splits a harness@installation-label', () => {
    expect(parseLogoutTarget('claude@acct-abc123')).toEqual({ agentRaw: 'claude', installationLabel: 'acct-abc123' });
  });
  it('splits a harness#account selector, binding # tighter than @', () => {
    expect(parseLogoutTarget('claude#work')).toEqual({ agentRaw: 'claude', identitySelector: 'work' });
    expect(parseLogoutTarget('claude#user@example.com')).toEqual({ agentRaw: 'claude', identitySelector: 'user@example.com' });
  });
  it('treats a bare non-harness token as an account name', () => {
    expect(parseLogoutTarget('work')).toEqual({ agentRaw: 'work' });
  });
});

describe('accounts add/login/default surface (PHNX-3940 T4)', () => {
  // Each case gets its own SECRETS_HOME (real standalone), so bundle writes are
  // isolated per test with no in-memory keychain mock.
  useFreshSecretsHome();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function runAccounts(args: string[]): Promise<{ out: string; err: string; thrown?: { code?: string; message: string } }> {
    const program = new Command();
    program.exitOverride();
    registerAccountsCommand(program);
    const out: string[] = [];
    const err: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
    const error = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.map(String).join(' ')); });
    let thrown: { code?: string; message: string } | undefined;
    try {
      await program.parseAsync(['node', 'agents', 'accounts', ...args]);
    } catch (e) {
      thrown = e as { code?: string; message: string };
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
    return { out: out.join('\n'), err: err.join('\n'), thrown };
  }

  it('the provider form still works when the first arg is NOT a harness id', async () => {
    vi.mocked(password).mockResolvedValueOnce('sk-t4-provider');
    const r = await runAccounts(['add', 't4-provider', '--provider', 'openrouter', '--auth', 'api-key']);
    expect(r.thrown).toBeUndefined();
    expect(r.out).toContain("Added openrouter api-key account 't4-provider'.");
  });

  it('fails loud on the ambiguous harness + provider-flag mix', async () => {
    const r = await runAccounts(['add', 'claude', 'work', '--provider', 'anthropic', '--auth', 'setup-token']);
    expect(r.thrown).toMatchObject({ code: 'accounts.error' });
    expect(r.thrown!.message).toMatch(/'claude' is a harness id.*ambiguous/);
  });

  it('a non-harness target without --provider/--auth is told both forms', async () => {
    const r = await runAccounts(['add', 't4-incomplete']);
    expect(r.thrown).toMatchObject({ code: 'accounts.error' });
    expect(r.thrown!.message).toContain("--provider <provider> --auth <type>");
    expect(r.thrown!.message).toContain('agents accounts add <harness> [name]');
  });

  it('default <harness> <name> writes the per-harness default (the shared write path)', async () => {
    addAccount('t4-default', 'openrouter', 'api-key', 'sk-or', getUserAgentsDir());
    try {
      const r = await runAccounts(['default', 'claude', 't4-default']);
      expect(r.thrown).toBeUndefined();
      expect(r.out).toContain("claude now uses account 't4-default'");
      expect(readMeta().accounts?.defaults?.claude).toBe('t4-default');
    } finally {
      updateMeta(meta => ({ ...meta, accounts: { ...meta.accounts, defaults: { ...meta.accounts?.defaults, claude: undefined } } }));
      try { removeAccount('t4-default'); } catch { /* absent */ }
    }
  });



  it('accounts registers add/login/default and none of the retired verbs', async () => {
    const program = new Command();
    registerAccountsCommand(program);
    const accounts = program.commands.find(c => c.name() === 'accounts')!;
    const help = accounts.helpInformation();
    const names = accounts.commands.map(c => c.name());
    for (const verb of ['add', 'login', 'default', 'rename', 'remove', 'logout', 'sync']) {
      expect(help).toMatch(new RegExp(`^  ${verb}\\b`, 'm'));
      expect(names).toContain(verb);
    }
    for (const retired of ['connect', 'mint', 'attach', 'detach', 'switch', 'set-default', 'label', 'name']) {
      expect(names).not.toContain(retired);
    }
  });
});
