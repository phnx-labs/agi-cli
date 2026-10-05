import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveSecretsBin,
  buildServeEnv,
  REMOTE_USER_AGENTS_DIR,
  withRemoteStateRoot,
  bundleBackend,
  bundleBackendSync,
  bundleExists,
  bundleExistsSync,
  deleteBundleSync,
  deleteKeychainTokenSync,
  hasKeychainTokenSync,
  getKeychainTokenSync,
  keychainRef,
  keychainUsesFileFallback,
  listBundlesSync,
  parseBundleValue,
  profileKeychainItem,
  readBundleSync,
  renameBundle,
  rotateBundleSecretSync,
  secretsKeychainItem,
  setKeychainTokenSync,
  writeBundleWithItems,
  writeBundleWithItemsSync,
  readAndResolveBundleEnv,
  readAndResolveBundleEnvSync,
  secretsRequest,
  secretsRequestSync,
  SecretsClientError,
  isSecretsClientError,
  _resetSecretsClientForTest,
  PROTOCOL_VERSION,
  _setSyncServeTimeoutForTest,
  SYNC_SERVE_TIMEOUT_MS,
} from './secrets-client.js';
import { getShimsDir, getUserAgentsDir } from './state.js';
import type { SecretsBundle } from './secrets-types.js';

describe('resolveSecretsBin', () => {
  const savedBin = process.env.SECRETS_BIN;
  const savedPath = process.env.PATH;
  afterEach(() => {
    process.env.SECRETS_BIN = savedBin;
    process.env.PATH = savedPath;
    if (savedBin === undefined) delete process.env.SECRETS_BIN;
    _resetSecretsClientForTest();
  });

  it('honours an explicit $SECRETS_BIN', () => {
    process.env.SECRETS_BIN = '/opt/custom/secrets';
    _resetSecretsClientForTest();
    expect(resolveSecretsBin()).toBe('/opt/custom/secrets');
  });

  it('fails loud with install guidance and no engine fallback when absent', () => {
    delete process.env.SECRETS_BIN;
    process.env.PATH = '';
    _resetSecretsClientForTest();
    try {
      resolveSecretsBin();
      throw new Error('expected resolveSecretsBin to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SecretsClientError);
      expect((error as SecretsClientError).code).toBe('SECRETS_BIN_MISSING');
      expect((error as SecretsClientError).message).toContain('npm i -g @phnx-labs/secrets-cli');
    }
  });

  describe.skipIf(process.platform === 'win32')('never resolves to the legacy shim in agents-cli\'s own shims dir', () => {
    let realDir: string;
    let shimsDir: string;
    beforeEach(() => {
      shimsDir = getShimsDir();
      fs.mkdirSync(shimsDir, { recursive: true });
      const shim = path.join(shimsDir, 'secrets');
      fs.writeFileSync(shim, `#!/bin/sh\nAGENTS_BIN='/opt/agents-cli/dist/index.js'\nexec "$AGENTS_BIN" secrets "$@"\n`);
      fs.chmodSync(shim, 0o755);
      realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-real-bin-'));
      const real = path.join(realDir, 'secrets');
      fs.writeFileSync(real, '#!/bin/sh\necho standalone\n');
      fs.chmodSync(real, 0o755);
      delete process.env.SECRETS_BIN;
    });
    afterEach(() => {
      fs.rmSync(path.join(shimsDir, 'secrets'), { force: true });
      fs.rmSync(realDir, { recursive: true, force: true });
    });

    it('skips the shim and resolves the standalone further down PATH', () => {
      process.env.PATH = [shimsDir, realDir].join(path.delimiter);
      _resetSecretsClientForTest();
      expect(resolveSecretsBin()).toBe(fs.realpathSync(path.join(realDir, 'secrets')));
    });

    it('skips a non-executable namesake earlier on PATH, like `which` does', () => {
      const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-decoy-'));
      try {
        fs.writeFileSync(path.join(decoy, 'secrets'), 'not a program\n', { mode: 0o644 });
        process.env.PATH = [shimsDir, decoy, realDir].join(path.delimiter);
        _resetSecretsClientForTest();
        expect(resolveSecretsBin()).toBe(fs.realpathSync(path.join(realDir, 'secrets')));
      } finally {
        fs.rmSync(decoy, { recursive: true, force: true });
      }
    });

    it('reports SECRETS_BIN_MISSING when the shim is the only `secrets` on PATH', () => {
      process.env.PATH = shimsDir;
      _resetSecretsClientForTest();
      try {
        resolveSecretsBin();
        throw new Error('expected resolveSecretsBin to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(SecretsClientError);
        expect((error as SecretsClientError).code).toBe('SECRETS_BIN_MISSING');
      }
    });
  });
});

describe('withRemoteStateRoot', () => {
  it('names the remote user agents dir for a push unless the caller chose a root', () => {
    expect(withRemoteStateRoot({ remoteBackend: 'file', operation: 'seam' }).remoteSecretsHome).toBe(REMOTE_USER_AGENTS_DIR);
    expect(REMOTE_USER_AGENTS_DIR).toBe('~/.agents');
    expect(withRemoteStateRoot({ remoteBackend: 'file', operation: 'seam', remoteSecretsHome: '/srv/agents' }).remoteSecretsHome).toBe('/srv/agents');
  });
});

describe('buildServeEnv', () => {
  it('defaults SECRETS_HOME to the user agents dir, letting an explicit value win', () => {
    expect(buildServeEnv({}).SECRETS_HOME).toBe(getUserAgentsDir());
    expect(buildServeEnv({ SECRETS_HOME: '/somewhere/else' }).SECRETS_HOME).toBe('/somewhere/else');
  });

  it('bridges the old AGENTS_SECRETS_PASSPHRASE onto the standalone SECRETS_PASSPHRASE', () => {
    expect(buildServeEnv({ AGENTS_SECRETS_PASSPHRASE: 'p1' }).SECRETS_PASSPHRASE).toBe('p1');
  });

  it('never overrides an explicit SECRETS_PASSPHRASE', () => {
    expect(
      buildServeEnv({ SECRETS_PASSPHRASE: 'new', AGENTS_SECRETS_PASSPHRASE: 'old' }).SECRETS_PASSPHRASE,
    ).toBe('new');
  });

  it('leaves SECRETS_PASSPHRASE unset when neither name is present', () => {
    expect(buildServeEnv({}).SECRETS_PASSPHRASE).toBeUndefined();
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

  it('isSecretsClientError narrows on class and optional code', () => {
    const err = new SecretsClientError('NOT_FOUND', 'x');
    expect(isSecretsClientError(err)).toBe(true);
    expect(isSecretsClientError(err, 'NOT_FOUND')).toBe(true);
    expect(isSecretsClientError(err, 'LOCKED')).toBe(false);
    expect(isSecretsClientError(new Error('x'))).toBe(false);
  });
});

describe('SecretsClientError serializes to a plain {code, message}', () => {
  it('JSON.stringify yields only code and message', () => {
    expect(JSON.parse(JSON.stringify(new SecretsClientError('LOCKED', 'boom')))).toEqual({
      code: 'LOCKED',
      message: 'boom',
    });
  });

  it('a container holding one never throws when stringified', () => {
    const record: Record<string, unknown> = { stage: 'spawn' };
    record.error = new SecretsClientError('SECRETS_BIN_MISSING', 'not found');
    expect(() => JSON.stringify(record)).not.toThrow();
  });
});

describe.skipIf(process.platform === 'win32')('synchronous status path is bounded and diagnosable', () => {
  let dir: string;
  const savedBin = process.env.SECRETS_BIN;
  const savedPath = process.env.PATH;

  function plantServe(body: string): void {
    const bin = path.join(dir, 'mock-secrets');
    fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(bin, 0o755);
    process.env.SECRETS_BIN = bin;
    _resetSecretsClientForTest();
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-sync-mock-'));
  });
  afterEach(() => {
    if (savedBin === undefined) delete process.env.SECRETS_BIN;
    else process.env.SECRETS_BIN = savedBin;
    process.env.PATH = savedPath;
    _resetSecretsClientForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a hanging standalone fails loud at the bound, never the server 60s deadline', () => {
    plantServe('sleep 30');
    _setSyncServeTimeoutForTest(3_000);
    const t0 = Date.now();
    try {
      secretsRequestSync('handshake', []);
      throw new Error('expected the bounded sync serve to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SecretsClientError);
      expect((error as SecretsClientError).code).toBe('TIMEOUT');
      expect((error as SecretsClientError).message).toContain('did not answer within 3s');
      expect((error as SecretsClientError).message).toContain('secrets --version');
      expect(Date.now() - t0).toBeLessThan(6_000);
    }
  });

  it('the shipped bound absorbs a cold standalone boot on a loaded box', () => {
    plantServe(
      `cat <&3 >/dev/null; sleep 4; ` +
        `printf '%s' '{"v":1,"id":"x","ok":true,"result":{"protocol":1,"operations":{}}}' >&4`,
    );
    expect(SYNC_SERVE_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    const result = secretsRequestSync<{ protocol: number }>('handshake', []);
    expect(result.protocol).toBe(PROTOCOL_VERSION);
  });

  it('one request is one spawn — no handshake round trip precedes the first op', () => {
    const tally = path.join(dir, 'spawns');
    plantServe(
      `cat <&3 >/dev/null; echo x >> '${tally}'; ` +
        `printf '%s' '{"v":1,"id":"x","ok":true,"result":{"protocol":1,"operations":{}}}' >&4`,
    );
    secretsRequestSync('handshake', []);
    expect(fs.readFileSync(tally, 'utf8').trim().split('\n')).toHaveLength(1);
    secretsRequestSync('bundles.listBundles', []);
    expect(fs.readFileSync(tally, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('a standalone speaking another protocol is named, on any op, not called malformed', () => {
    plantServe(
      `cat <&3 >/dev/null; printf '%s' '{"v":2,"id":"x","ok":true,"result":{}}' >&4`,
    );
    try {
      secretsRequestSync('bundles.listBundles', []);
      throw new Error('expected PROTOCOL_UNSUPPORTED');
    } catch (error) {
      expect(error).toBeInstanceOf(SecretsClientError);
      expect((error as SecretsClientError).code).toBe('PROTOCOL_UNSUPPORTED');
      expect((error as SecretsClientError).message).toContain('secrets speaks protocol 2');
      expect((error as SecretsClientError).message).toContain('@phnx-labs/secrets-cli');
    }
  });

  it('a standalone that writes nothing to fd 4 is surfaced as an empty response', () => {
    plantServe('exit 0');
    try {
      secretsRequestSync('handshake', []);
      throw new Error('expected a non-JSON failure');
    } catch (error) {
      expect(error).toBeInstanceOf(SecretsClientError);
      expect((error as SecretsClientError).code).toBe('INVALID_RESPONSE');
      expect((error as SecretsClientError).message).toContain('wrote nothing to fd 4');
    }
  });

  it('non-JSON bytes on fd 4 are surfaced (first 200 bytes), not a bare error', () => {
    plantServe(`printf '%s' 'garbage-not-json-response' >&4`);
    try {
      secretsRequestSync('handshake', []);
      throw new Error('expected a non-JSON failure');
    } catch (error) {
      expect(error).toBeInstanceOf(SecretsClientError);
      expect((error as SecretsClientError).message).toContain('first 200 bytes on fd 4');
      expect((error as SecretsClientError).message).toContain('garbage-not-json-response');
    }
  });

  it('a missing standalone fails loud immediately, never hanging', () => {
    delete process.env.SECRETS_BIN;
    process.env.PATH = '';
    _resetSecretsClientForTest();
    const t0 = Date.now();
    try {
      secretsRequestSync('handshake', []);
      throw new Error('expected SECRETS_BIN_MISSING');
    } catch (error) {
      expect(error).toBeInstanceOf(SecretsClientError);
      expect((error as SecretsClientError).code).toBe('SECRETS_BIN_MISSING');
      expect(Date.now() - t0).toBeLessThan(3_000);
    }
  });
});

const REAL_BIN = process.env.AGENTS_TEST_SECRETS_BIN;

describe.skipIf(!REAL_BIN)('secrets protocol client against the real standalone', () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};

  const ENV_KEYS = ['SECRETS_BIN', 'HOME', 'SECRETS_HOME', 'AGENTS_SECRETS_PASSPHRASE', 'SECRETS_NO_AGENT'];

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-secrets-client-'));
    process.env.SECRETS_BIN = REAL_BIN;
    process.env.HOME = home;
    process.env.SECRETS_HOME = path.join(home, '.agents');
    process.env.AGENTS_SECRETS_PASSPHRASE = 'test-passphrase';
    process.env.SECRETS_NO_AGENT = '1';
    _resetSecretsClientForTest();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    _resetSecretsClientForTest();
    fs.rmSync(home, { recursive: true, force: true });
  });

  function fileBundle(name: string): { bundle: SecretsBundle; items: Map<string, string>; value: string } {
    const value = `s3cr3t-${name}`;
    const bundle: SecretsBundle = { name, backend: 'file', vars: { MY_KEY: 'keychain:MY_KEY' } };
    const items = new Map([[`agents-cli.secrets.${name}.MY_KEY`, value]]);
    return { bundle, items, value };
  }

  it('handshakes and reports protocol version 1', async () => {
    const result = await secretsRequest<{ protocol: number; operations: Record<string, string[]> }>('handshake');
    expect(result.protocol).toBe(PROTOCOL_VERSION);
    expect(result.operations.bundles).toContain('readAndResolveBundleEnv');
  });

  it('reports bundleExists=false on a fresh home', async () => {
    expect(await bundleExists('absent-bundle')).toBe(false);
    expect(bundleExistsSync('absent-bundle')).toBe(false);
  });

  it('the synchronous handshake round-trips under the bound (no fd-3 EOF hang)', () => {
    const t0 = Date.now();
    const result = secretsRequestSync<{ protocol: number }>('handshake', []);
    expect(result.protocol).toBe(PROTOCOL_VERSION);
    expect(Date.now() - t0).toBeLessThan(SYNC_SERVE_TIMEOUT_MS);
  });

  it('round-trips writeBundleWithItems -> readAndResolveBundleEnv on a file bundle', async () => {
    const { bundle, items, value } = fileBundle('round-trip');
    await writeBundleWithItems(bundle, items);
    expect(await bundleExists('round-trip')).toBe(true);

    const resolved = await readAndResolveBundleEnv('round-trip');
    expect(resolved.bundle.name).toBe('round-trip');
    expect(resolved.bundle.backend).toBe('file');
    expect(resolved.env).toEqual({ MY_KEY: value });

    const sync = readAndResolveBundleEnvSync('round-trip');
    expect(sync.env).toEqual({ MY_KEY: value });
  });

  it('an arbitrarily large synchronous request completes — spawnSync services stdin and fd 4 concurrently, no deadlock', () => {
    const bigName = 'x'.repeat(200_000);
    let answered = false;
    try {
      expect(typeof bundleExistsSync(bigName)).toBe('boolean');
      answered = true;
    } catch (error) {
      expect(error).toBeInstanceOf(SecretsClientError);
      answered = true;
    }
    expect(answered).toBe(true);
  });

  it('denies access when context.allowedBundles excludes the bundle', async () => {
    const { bundle, items } = fileBundle('scoped');
    await writeBundleWithItems(bundle, items);

    expect(await bundleExists('scoped', { allowedBundles: ['scoped'], scope: 'claude' })).toBe(true);

    await expect(bundleExists('scoped', { allowedBundles: ['other'], scope: 'claude' })).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
  });

  it('reports the backend a bundle lives on and lists it', async () => {
    const { bundle, items } = fileBundle('where');
    writeBundleWithItemsSync(bundle, items);
    expect(await bundleBackend('where')).toBe('file');
    expect(bundleBackendSync('where')).toBe('file');
    expect(listBundlesSync().map((b) => b.name)).toEqual(['where']);
    expect(readBundleSync('where').vars).toEqual({ MY_KEY: 'keychain:MY_KEY' });
    expect(deleteBundleSync('where')).toBe(true);
    expect(listBundlesSync()).toEqual([]);
  });

  it('renames a bundle with its raw items and rotates a key in place', async () => {
    const { bundle, items, value } = fileBundle('before');
    await writeBundleWithItems(bundle, items);

    await renameBundle('before', 'after');
    expect(await bundleExists('before')).toBe(false);
    expect(hasKeychainTokenSync(secretsKeychainItem('before', 'MY_KEY'))).toBe(false);
    expect(readAndResolveBundleEnvSync('after').env).toEqual({ MY_KEY: value });

    rotateBundleSecretSync(readBundleSync('after'), 'MY_KEY', { newValue: 'rotated', meta: { type: 'token' } });
    const rotated = readAndResolveBundleEnvSync('after');
    expect(rotated.env).toEqual({ MY_KEY: 'rotated' });
    expect(rotated.bundle.meta?.MY_KEY?.type).toBe('token');
  });

  it('writes, reads and deletes a raw keychain item synchronously', () => {
    const item = profileKeychainItem('openrouter');
    expect(hasKeychainTokenSync(item)).toBe(false);
    setKeychainTokenSync(item, 'tok-1');
    expect(hasKeychainTokenSync(item)).toBe(true);
    expect(getKeychainTokenSync(item)).toBe('tok-1');
    expect(deleteKeychainTokenSync(item)).toBe(true);
    expect(hasKeychainTokenSync(item)).toBe(false);
  });

  it('surfaces a missing bundle as the NOT_FOUND code on both transports', async () => {
    await expect(renameBundle('nope', 'still-nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    try {
      readBundleSync('nope');
      throw new Error('expected readBundleSync to throw');
    } catch (error) {
      expect(isSecretsClientError(error, 'NOT_FOUND')).toBe(true);
    }
  });

  it('reports whether keychain items fall back to the file store on this host', async () => {
    expect(typeof (await keychainUsesFileFallback())).toBe('boolean');
  });
});
