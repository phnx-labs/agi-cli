import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as published from '@phnx-labs/secrets-cli/client';
import {
  bundleBackend,
  bundleBackendSync,
  bundleExists,
  bundleExistsSync,
  deleteBundleSync,
  keychainRef,
  listBundlesSync,
  parseBundleValue,
  profileKeychainItem,
  readBundleSync,
  renameBundle,
  rotateBundleSecretSync,
  secretsKeychainItem,
  writeBundleWithItems,
  writeBundleWithItemsSync,
  readAndResolveBundleEnv,
  readAndResolveBundleEnvSync,
  secretsRequest,
  secretsRequestSync,
  buildServeEnv,
  isSecretsClientError,
  isSecretsTransportError,
  _resetSecretsClientForTest,
  invocation,
  PROTOCOL_VERSION,
} from './secrets-client.js';
import type { SecretsBundle } from './secrets-types.js';
import { SECRETS_CLI_VERSION } from './secrets-cli.js';
import { ensureStandaloneSecretsBin } from '../../tests/secrets-standalone.js';
import pkg from '../../package.json' with { type: 'json' };

const REAL_BIN = ensureStandaloneSecretsBin();
const RUN = `agents-client-${process.pid}-${Date.now().toString(36)}`;
const name = (suffix: string) => `${RUN}-${suffix}`;

describe('the transport is the published client, not a copy', () => {
  it('re-exports the same functions and error class', () => {
    expect(secretsRequest).toBe(published.secretsRequest);
    expect(secretsRequestSync).toBe(published.secretsRequestSync);
    expect(readAndResolveBundleEnv).toBe(published.readAndResolveBundleEnv);
    expect(readAndResolveBundleEnvSync).toBe(published.readAndResolveBundleEnvSync);
    expect(buildServeEnv).toBe(published.buildServeEnv);
    expect(isSecretsClientError).toBe(published.isSecretsClientError);
    expect(PROTOCOL_VERSION).toBe(2);
  });

  it('passes an explicit root through, leaves an unset one unset, and keeps the passphrase alias', () => {
    expect(buildServeEnv({ SECRETS_HOME: '/srv/store' }).SECRETS_HOME).toBe('/srv/store');
    expect('SECRETS_HOME' in buildServeEnv({ HOME: '/home/x' })).toBe(false);
    expect(buildServeEnv({ AGENTS_SECRETS_PASSPHRASE: 'p1' }).SECRETS_PASSPHRASE).toBe('p1');
    expect(buildServeEnv({ SECRETS_PASSPHRASE: 'new', AGENTS_SECRETS_PASSPHRASE: 'old' }).SECRETS_PASSPHRASE).toBe('new');
  });
});

describe('the standalone pin', () => {
  it('installs the same exact version agents-cli imports its client from', () => {
    expect(pkg.dependencies['@phnx-labs/secrets-cli']).toBe(SECRETS_CLI_VERSION);
  });
});

describe('item naming (the seam\'s shared identifier scheme)', () => {
  it('derives raw item names and refs the standalone stores under', () => {
    expect(secretsKeychainItem('work', 'API_KEY')).toBe('agents-cli.secrets.work.API_KEY');
    expect(profileKeychainItem('openrouter')).toBe('agents-cli.openrouter.token');
    expect(keychainRef('API_KEY')).toBe('keychain:API_KEY');
  });

  it('parses literals, escaped literals, and typed refs', () => {
    expect(parseBundleValue('plain')).toEqual({ literal: 'plain' });
    expect(parseBundleValue({ value: 'env:not-a-ref' })).toEqual({ literal: 'env:not-a-ref' });
    expect(parseBundleValue('keychain:API_KEY')).toEqual({ ref: { provider: 'keychain', value: 'API_KEY' } });
    expect(parseBundleValue('exec:op read x')).toEqual({ ref: { provider: 'exec', value: 'op read x' } });
    expect(() => parseBundleValue(42 as unknown as string)).toThrow(/Invalid bundle value/);
  });
});

describe.skipIf(process.platform === 'win32')('agents-cli wrappers against the real standalone from @phnx-labs/secrets-cli', () => {
  const ENV_KEYS = ['SECRETS_BIN', 'HOME', 'USERPROFILE', 'AGENTS_REAL_HOME', 'SECRETS_HOME', 'SECRETS_PASSPHRASE', 'AGENTS_SECRETS_PASSPHRASE', 'SECRETS_NO_AGENT', 'SECRETS_NO_USAGE_TRACK'];
  const saved: Record<string, string | undefined> = {};
  let home: string;

  function useRoot(root: 'explicit' | 'default'): void {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.AGENTS_REAL_HOME = home;
    process.env.SECRETS_BIN = REAL_BIN;
    process.env.SECRETS_NO_AGENT = '1';
    process.env.SECRETS_NO_USAGE_TRACK = '1';
    delete process.env.SECRETS_PASSPHRASE;
    delete process.env.AGENTS_SECRETS_PASSPHRASE;
    if (root === 'explicit') {
      process.env.SECRETS_HOME = path.join(home, 'store');
      process.env.AGENTS_SECRETS_PASSPHRASE = 'agents-client-test';
    } else {
      delete process.env.SECRETS_HOME;
    }
    _resetSecretsClientForTest();
  }

  function fileBundle(bundleName: string, value: string): { bundle: SecretsBundle; items: Map<string, string> } {
    return {
      bundle: { name: bundleName, backend: 'file', vars: { MY_KEY: 'keychain:MY_KEY', OTHER: 'keychain:OTHER' } },
      items: new Map([[secretsKeychainItem(bundleName, 'MY_KEY'), value], [secretsKeychainItem(bundleName, 'OTHER'), 'other-value']]),
    };
  }

  async function codeOf(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
      return 'resolved';
    } catch (error) {
      expect(isSecretsClientError(error)).toBe(true);
      return (error as { code: string }).code;
    }
  }

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-secrets-client-'));
    expect(fs.existsSync(REAL_BIN), REAL_BIN).toBe(true);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    _resetSecretsClientForTest();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('writes and resolves exact bytes on both transports under an explicit root, honouring a key subset', async () => {
    useRoot('explicit');
    const bundleName = name('backups');
    const value = 'value with spaces ünïcode = and "quotes"';
    const { bundle, items } = fileBundle(bundleName, value);
    await writeBundleWithItems(bundle, items);
    expect(fs.existsSync(path.join(home, 'store'))).toBe(true);

    const opts = { caller: 'session-transport', agentOnly: true };
    const scope = { allowedBundles: [bundleName] };
    const resolved = await readAndResolveBundleEnv(bundleName, opts, scope);
    expect(resolved.bundle.name).toBe(bundleName);
    expect(resolved.env).toEqual({ MY_KEY: value, OTHER: 'other-value' });
    expect(readAndResolveBundleEnvSync(bundleName, opts, scope).env).toEqual({ MY_KEY: value, OTHER: 'other-value' });
    expect(readAndResolveBundleEnvSync(bundleName, { keys: ['OTHER'] }).env).toEqual({ OTHER: 'other-value' });
  }, 90_000);

  it('an unset SECRETS_HOME reaches the engine default root under HOME', async () => {
    useRoot('default');
    const bundleName = name('default');
    const { bundle, items } = fileBundle(bundleName, 'default-root-value');
    writeBundleWithItemsSync(bundle, items);
    expect(fs.existsSync(path.join(home, '.agents', '.secrets'))).toBe(true);
    expect((await readAndResolveBundleEnv(bundleName)).env.MY_KEY).toBe('default-root-value');
  }, 90_000);

  it('a harness HOME swap still reaches the default root under AGENTS_REAL_HOME', async () => {
    useRoot('default');
    const bundleName = name('real-home');
    const { bundle, items } = fileBundle(bundleName, 'real-home-value');
    writeBundleWithItemsSync(bundle, items);
    const versionHome = path.join(home, 'version-home');
    fs.mkdirSync(versionHome);
    process.env.HOME = versionHome;
    process.env.USERPROFILE = versionHome;
    _resetSecretsClientForTest();
    expect(readAndResolveBundleEnvSync(bundleName).env.MY_KEY).toBe('real-home-value');
    expect(fs.existsSync(path.join(versionHome, '.agents'))).toBe(false);
  }, 90_000);

  it('keeps denial and missing-data failures typed, never transport errors', async () => {
    useRoot('explicit');
    const bundleName = name('scoped');
    const { bundle, items } = fileBundle(bundleName, 'scoped-value');
    await writeBundleWithItems(bundle, items);

    expect(await bundleExists(bundleName, { allowedBundles: [bundleName], scope: 'claude' })).toBe(true);
    const denied = await codeOf(readAndResolveBundleEnv(bundleName, {}, { allowedBundles: [name('other')], scope: 'claude' }));
    expect(denied).toBe('ACCESS_DENIED');
    try {
      readAndResolveBundleEnvSync(bundleName, {}, { allowedBundles: [name('other')] });
      throw new Error('expected ACCESS_DENIED');
    } catch (error) {
      expect(isSecretsClientError(error, 'ACCESS_DENIED')).toBe(true);
      expect(isSecretsTransportError(error)).toBe(false);
    }
    expect(await codeOf(readAndResolveBundleEnv(name('absent')))).toBe('NOT_FOUND');
    expect(await codeOf(renameBundle(name('absent'), name('still-absent')))).toBe('NOT_FOUND');
    expect(() => readBundleSync(name('absent'))).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  }, 90_000);

  it('lists, renames, rotates and deletes a file bundle through the wrappers', async () => {
    useRoot('explicit');
    const before = name('before');
    const after = name('after');
    const { bundle, items } = fileBundle(before, 'rotating-value');
    writeBundleWithItemsSync(bundle, items);
    expect(await bundleBackend(before)).toBe('file');
    expect(bundleBackendSync(before)).toBe('file');
    expect(listBundlesSync().map((b) => b.name)).toEqual([before]);

    await renameBundle(before, after);
    expect(bundleExistsSync(before)).toBe(false);
    expect(readAndResolveBundleEnvSync(after).env.MY_KEY).toBe('rotating-value');

    rotateBundleSecretSync(readBundleSync(after), 'MY_KEY', { newValue: 'rotated', meta: { type: 'token' } });
    const rotated = readAndResolveBundleEnvSync(after);
    expect(rotated.env.MY_KEY).toBe('rotated');
    expect(rotated.bundle.meta?.MY_KEY?.type).toBe('token');
    expect(deleteBundleSync(after)).toBe(true);
    expect(listBundlesSync()).toEqual([]);
  }, 90_000);
});

describe.skipIf(process.platform === 'win32')('one agents-cli process talking to the real engine', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-secrets-engine-')); });
  afterEach(() => {
    fs.chmodSync(dir, 0o700);
    for (const entry of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, entry), 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function runConsumer(logsDir: string, cwd = dir): { stdout: string; stderr: string; status: number | null; spawns: number; home: string } {
    const tally = path.join(dir, 'engine-spawns');
    const engine = invocation(REAL_BIN);
    const wrapper = path.join(dir, 'secrets');
    fs.writeFileSync(
      wrapper,
      `#!/bin/sh\necho "engine-stderr-probe $$" >&2\necho $$ >> '${tally}'\nexec ${[engine.command, ...engine.prefix].map((a) => `'${a}'`).join(' ')} "$@"\n`,
      { mode: 0o755 },
    );
    const client = fileURLToPath(new URL('./secrets-client.ts', import.meta.url));
    const script = path.join(dir, 'consumer.ts');
    fs.writeFileSync(script, [
      `import { writeBundleWithItemsSync, readAndResolveBundleEnvSync, readAndResolveBundleEnv, secretsKeychainItem } from ${JSON.stringify(client)};`,
      `writeBundleWithItemsSync({ name: 'probe', backend: 'file', vars: { TOKEN: 'keychain:TOKEN' } }, new Map([[secretsKeychainItem('probe', 'TOKEN'), 'engine-value']]));`,
      `const sync = readAndResolveBundleEnvSync('probe').env.TOKEN;`,
      `const async_ = (await readAndResolveBundleEnv('probe')).env.TOKEN;`,
      `console.log(JSON.stringify({ sync, async: async_ }));`,
    ].join('\n'));
    const home = path.join(dir, 'home');
    fs.mkdirSync(home, { recursive: true });
    const run = spawnSync('bun', [script], {
      cwd,
      encoding: 'utf8',
      timeout: 90_000,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        AGENTS_REAL_HOME: home,
        AGENTS_LOGS_DIR: logsDir,
        SECRETS_BIN: wrapper,
        SECRETS_HOME: path.join(home, 'store'),
        SECRETS_PASSPHRASE: 'agents-engine-stderr-test',
        SECRETS_NO_AGENT: '1',
        SECRETS_NO_USAGE_TRACK: '1',
      },
    });
    const spawns = fs.existsSync(tally) ? fs.readFileSync(tally, 'utf8').trim().split('\n').length : 0;
    return { stdout: run.stdout, stderr: run.stderr, status: run.status, spawns, home };
  }

  function expectQuietSuccess(run: ReturnType<typeof runConsumer>): void {
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout.trim())).toEqual({ sync: 'engine-value', async: 'engine-value' });
    expect(run.stderr).not.toContain('engine-stderr-probe');
    expect(run.spawns).toBe(3);
  }

  function probeLines(log: string): number {
    return fs.readFileSync(log, 'utf8').match(/engine-stderr-probe/g)?.length ?? 0;
  }

  it('spawns one engine per request and sends its stderr to secrets-serve.log, never the terminal', () => {
    const logs = path.join(dir, 'logs');
    const run = runConsumer(logs);
    expectQuietSuccess(run);
    const log = path.join(logs, 'secrets-serve.log');
    expect(probeLines(log)).toBe(3);
    expect(fs.statSync(log).mode & 0o777).toBe(0o600);
  }, 120_000);

  it('an empty AGENTS_LOGS_DIR falls back to the default logs dir', () => {
    const run = runConsumer('');
    expectQuietSuccess(run);
    expect(probeLines(path.join(run.home, '.agents', '.cache', 'logs', 'secrets-serve.log'))).toBe(3);
  }, 120_000);

  it('a relative AGENTS_LOGS_DIR resolves against the working directory', () => {
    const cwd = path.join(dir, 'work');
    fs.mkdirSync(cwd);
    const run = runConsumer('rel-logs', cwd);
    expectQuietSuccess(run);
    expect(probeLines(path.join(cwd, 'rel-logs', 'secrets-serve.log'))).toBe(3);
  }, 120_000);

  it.skipIf(process.getuid?.() === 0)('an unwritable logs dir drops engine stderr instead of failing requests', () => {
    const locked = path.join(dir, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o500);
    const run = runConsumer(path.join(locked, 'logs'));
    expectQuietSuccess(run);
    expect(fs.existsSync(path.join(locked, 'logs'))).toBe(false);
  }, 120_000);
});
