/**
 * Tests for the standalone-secrets process client (secrets-client.ts).
 *
 * The integration block drives the REAL standalone `secrets __serve` server (no
 * mocks — repo rule): it spawns the actual executable and exchanges real wire
 * messages over the fd 3 / fd 4 pipes. It is gated on AGENTS_TEST_SECRETS_BIN
 * pointing at a built standalone entrypoint (e.g. `dist/index.js` from a
 * `secrets-cli` checkout after `bash scripts/build.sh`); with the var unset it
 * skips cleanly, so CI — which has no standalone checkout — stays green. This is
 * the same env-gated real-dependency pattern as the Windows `--device` e2e
 * suites (AGENTS_TEST_WIN_HOST). Point it at the binary to exercise it:
 *
 *   AGENTS_TEST_SECRETS_BIN=/path/to/secrets-cli/dist/index.js \
 *     bun run test src/lib/secrets-client.test.ts
 *
 * Every op runs against a throwaway HOME/SECRETS_HOME so the real user store is
 * never touched (the standalone's file store is keyed off HOME).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveSecretsBin,
  buildServeEnv,
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
    process.env.PATH = ''; // nothing to resolve `secrets` from
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

  // The pre-PHNX-3989 shims dir carried a `secrets` command shim that `exec`s
  // `agents secrets` — first on PATH, and alive across every in-place upgrade. A
  // resolver that took it spawned `agents secrets` → shim → `agents secrets` → …
  // without bound. The real standalone bin further down PATH must win, and with
  // nothing but the shim the answer is MISSING, never the shim.
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

describe('buildServeEnv', () => {
  it('defaults SECRETS_HOME to the user agents dir, letting an explicit value win', () => {
    expect(buildServeEnv({}).SECRETS_HOME).toBe(getUserAgentsDir());
    expect(buildServeEnv({ SECRETS_HOME: '/somewhere/else' }).SECRETS_HOME).toBe('/somewhere/else');
  });

  it('bridges the old AGENTS_SECRETS_PASSPHRASE onto the standalone SECRETS_PASSPHRASE', () => {
    // The standalone renamed AGENTS_SECRETS_* -> SECRETS_*; without this bridge
    // it never sees the passphrase agents-cli's own file store was written under
    // and would provision a fresh machine-local key it can't decrypt with.
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
  // A consumer that folds a failure into a JSON.stringify'd structure (a
  // teammate's meta.json, a failure record, a spawn env) must never make the
  // serializer chase the Error's internal references and throw `Converting
  // circular structure to JSON` mid-launch (PHNX-3989 design constraint b).
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

// The synchronous read-only STATUS path, exercised WITHOUT the real standalone
// so it runs on every runtime. It reproduces the PHNX-3989 CI failure shapes — a
// standalone that hangs (the 60s deadlock when it ran under Bun) and one that
// answers with non-JSON — and pins the ≤3s bound + fd-4 diagnostic that keep a
// read-only surface from blocking or failing blind.
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

  it('a hanging standalone fails loud within the ~3s bound, never the server 60s deadline', () => {
    plantServe('sleep 30'); // never answers on fd 4
    const t0 = Date.now();
    try {
      secretsRequestSync('handshake', []);
      throw new Error('expected the bounded sync serve to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SecretsClientError);
      expect((error as SecretsClientError).code).toBe('TIMEOUT');
      expect(Date.now() - t0).toBeLessThan(6_000); // 3s bound + spawn slack, far under 60s
    }
  });

  it('a standalone that writes nothing to fd 4 is surfaced as an empty response', () => {
    plantServe('exit 0'); // answers nothing
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
    process.env.PATH = ''; // nothing to resolve `secrets` from
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
    process.env.HOME = home; // the standalone file store lives under $HOME/.agents/.cache/secrets
    process.env.SECRETS_HOME = path.join(home, '.agents');
    // Set the OLD name on purpose: the client's buildServeEnv must bridge it onto
    // the standalone's renamed SECRETS_PASSPHRASE, so this exercises that bridge
    // end-to-end against the real store (a fresh key would still round-trip, so
    // the bridge is pinned deterministically by the buildServeEnv unit tests too).
    process.env.AGENTS_SECRETS_PASSPHRASE = 'test-passphrase'; // file-backend encryption key
    process.env.SECRETS_NO_AGENT = '1'; // no broker in the test env
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
    expect(bundleExistsSync('absent-bundle')).toBe(false); // sync fd-3-over-stdin transport
  });

  it('the synchronous handshake round-trips well under the ~3s bound (no fd-3 EOF hang)', () => {
    // Regression for the macOS sync-path hang: the standalone wraps fd 3 in a
    // `net.Socket`, and a Socket over a NAMED FIFO reads the request but never
    // fires EOF on macOS — so the old FIFO wiring left `for await (chunk of
    // input)` blocked until the 3s SYNC_SERVE_TIMEOUT_MS fired (`ETIMEDOUT`).
    // Feeding fd 3 the stdin pipe/socketpair (the async path's fd type) EOFs, so a
    // real handshake now completes in tens of ms against the real standalone.
    const t0 = Date.now();
    const result = secretsRequestSync<{ protocol: number }>('handshake', []);
    expect(result.protocol).toBe(PROTOCOL_VERSION);
    expect(Date.now() - t0).toBeLessThan(2_000); // real op is tens of ms; never the 3s timeout
  });

  it('round-trips writeBundleWithItems -> readAndResolveBundleEnv on a file bundle', async () => {
    const { bundle, items, value } = fileBundle('round-trip');
    await writeBundleWithItems(bundle, items);
    expect(await bundleExists('round-trip')).toBe(true);

    const resolved = await readAndResolveBundleEnv('round-trip');
    expect(resolved.bundle.name).toBe('round-trip');
    expect(resolved.bundle.backend).toBe('file');
    expect(resolved.env).toEqual({ MY_KEY: value });

    // The same read on the synchronous path returns the same env.
    const sync = readAndResolveBundleEnvSync('round-trip');
    expect(sync.env).toEqual({ MY_KEY: value });
  });

  it('an arbitrarily large synchronous request completes — spawnSync services stdin and fd 4 concurrently, no deadlock', () => {
    // The request rides spawnSync's stdin (dup'd onto fd 3), and the standalone
    // drains fd 3 to EOF while spawnSync is still writing it, so there is no size
    // at which the sync path deadlocks on a full pipe buffer. A name well past any
    // pipe-buffer bound (~64 KiB on Linux) still round-trips: the server answers
    // even when it rejects the oversized name, and nothing hangs.
    const bigName = 'x'.repeat(200_000);
    let answered = false;
    try {
      expect(typeof bundleExistsSync(bigName)).toBe('boolean');
      answered = true;
    } catch (error) {
      expect(error).toBeInstanceOf(SecretsClientError);
      answered = true; // a coded error is still a completed round-trip, not a hang
    }
    expect(answered).toBe(true);
  });

  it('denies access when context.allowedBundles excludes the bundle', async () => {
    const { bundle, items } = fileBundle('scoped');
    await writeBundleWithItems(bundle, items);

    // In scope: allowed.
    expect(await bundleExists('scoped', { allowedBundles: ['scoped'], scope: 'claude' })).toBe(true);

    // Out of scope: the server fails closed with ACCESS_DENIED.
    await expect(bundleExists('scoped', { allowedBundles: ['other'], scope: 'claude' })).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
  });

  it('reports the backend a bundle lives on and lists it', async () => {
    const { bundle, items } = fileBundle('where');
    writeBundleWithItemsSync(bundle, items); // sync writer
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
