import { describe, expect, it, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SecretsBundle } from '../secrets-types.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-share-config-test-'));
const prevHome = process.env.HOME;
const prevEnvToken = process.env.SHARE_WRITE_TOKEN;

process.env.HOME = HOME;

const {
  DEFAULT_CF_BUNDLE,
  generateWriteToken,
  readShareConfig,
  writeShareConfig,
} = await import('./config.js');

describe('share config — endpoint metadata (no secrets engine involved)', () => {
  beforeEach(() => {
    fs.rmSync(path.join(HOME, '.agents'), { recursive: true, force: true });
  });

  it('mints a 32-byte hex write token', () => {
    expect(generateWriteToken()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('persists endpoint config under agents.yaml share and trims the base URL on read', () => {
    writeShareConfig({
      baseUrl: 'https://share.example.com/',
      accountId: 'acct_123',
      workerName: 'agents-share',
      bucketName: 'agents-share',
      domain: 'share.example.com',
    });

    expect(readShareConfig()).toEqual({
      baseUrl: 'https://share.example.com',
      accountId: 'acct_123',
      workerName: 'agents-share',
      bucketName: 'agents-share',
      domain: 'share.example.com',
    });
    expect(fs.readFileSync(path.join(HOME, '.agents', 'agents.yaml'), 'utf8')).toContain('share:');
  });

  it('treats an empty accountId as publishable config, not "not set up" (RUSH-2837)', () => {
    fs.mkdirSync(path.join(HOME, '.agents'), { recursive: true });
    fs.writeFileSync(
      path.join(HOME, '.agents', 'agents.yaml'),
      [
        'share:',
        '  baseUrl: https://share.agents-cli.sh',
        '  accountId: ""',
        '  workerName: agents-share',
        '  bucketName: agents-share',
        '  domain: share.agents-cli.sh',
        '',
      ].join('\n'),
    );

    expect(readShareConfig()).toEqual({
      baseUrl: 'https://share.agents-cli.sh',
      accountId: '',
      workerName: 'agents-share',
      bucketName: 'agents-share',
      domain: 'share.agents-cli.sh',
    });
  });

  it('returns null only when baseUrl is missing — worker/bucket default', () => {
    fs.mkdirSync(path.join(HOME, '.agents'), { recursive: true });
    fs.writeFileSync(
      path.join(HOME, '.agents', 'agents.yaml'),
      'share:\n  baseUrl: https://share.example.com/\n',
    );

    expect(readShareConfig()).toEqual({
      baseUrl: 'https://share.example.com',
      accountId: '',
      workerName: 'agents-share',
      bucketName: 'agents-share',
    });
  });

  it('does not persist an empty accountId over a stored one', () => {
    writeShareConfig({
      baseUrl: 'https://share.example.com',
      accountId: 'acct_keep',
      workerName: 'agents-share',
      bucketName: 'agents-share',
    });
    writeShareConfig({
      baseUrl: 'https://share.example.com',
      accountId: '',
      workerName: 'agents-share',
      bucketName: 'agents-share',
    });

    expect(readShareConfig()?.accountId).toBe('acct_keep');
    expect(fs.readFileSync(path.join(HOME, '.agents', 'agents.yaml'), 'utf8')).not.toMatch(/accountId:\s*[\"']{2}/);
  });
});

afterAll(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevEnvToken === undefined) delete process.env.SHARE_WRITE_TOKEN;
  else process.env.SHARE_WRITE_TOKEN = prevEnvToken;
});

/**
 * The token-storage / Cloudflare-creds surfaces now resolve through the
 * standalone `secrets` CLI process client (PHNX-3989) — there is no
 * in-process keychain backend left to swap in, so these drive the REAL
 * standalone against a throwaway file-backed home, gated on
 * AGENTS_TEST_SECRETS_BIN (see secrets-client.test.ts). The `hold`/`always`
 * biometry-lock behavior (SEC-13) is keychain-only and stays covered by the
 * standalone's own test suite; a file-backed bundle never exhibits it.
 */
const REAL_BIN = process.env.AGENTS_TEST_SECRETS_BIN;

describe.skipIf(!REAL_BIN)('share config — token storage (real standalone)', () => {
  // `readShareConfig`/`writeShareConfig` go through `state.js`, which resolves
  // `getUserAgentsDir()` from `process.env.HOME` ONCE at that module's first
  // import (already happened, at this file's top-level `await import('./config.js')`
  // above) — reassigning `process.env.HOME` per test has NO effect on it. So
  // agents.yaml state uses the SAME shared `HOME` the file already imported
  // against, cleared per test exactly like the ungated block above; only
  // `SECRETS_HOME` (read live on every client call, never cached) gets a fresh
  // directory per test to isolate bundle state.
  const saved: Record<string, string | undefined> = {};
  const ENV_KEYS = ['SECRETS_BIN', 'SECRETS_HOME', 'AGENTS_SECRETS_PASSPHRASE', 'SECRETS_NO_AGENT', 'SHARE_WRITE_TOKEN'];
  let secretsHome: string;

  beforeEach(async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    fs.rmSync(path.join(HOME, '.agents'), { recursive: true, force: true });
    secretsHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-share-config-real-'));
    process.env.SECRETS_BIN = REAL_BIN;
    process.env.SECRETS_HOME = secretsHome;
    process.env.AGENTS_SECRETS_PASSPHRASE = 'test-passphrase';
    process.env.SECRETS_NO_AGENT = '1';
    delete process.env.SHARE_WRITE_TOKEN;
    const { _resetSecretsClientForTest } = await import('../secrets-client.js');
    _resetSecretsClientForTest();
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    const { _resetSecretsClientForTest } = await import('../secrets-client.js');
    _resetSecretsClientForTest();
    fs.rmSync(secretsHome, { recursive: true, force: true });
  });

  it('stores the raw Worker write token in the share secrets bundle as WRITE_TOKEN', async () => {
    const { storeWriteToken, readWriteToken, SHARE_BUNDLE, SHARE_TOKEN_KEY } = await import('./config.js');
    const { readAndResolveBundleEnvSync } = await import('../secrets-client.js');

    storeWriteToken('write-token-1');

    expect(SHARE_TOKEN_KEY).toBe('WRITE_TOKEN');
    expect(readWriteToken()).toBe('write-token-1');
    expect(readAndResolveBundleEnvSync(SHARE_BUNDLE, { caller: 'test' }).env).toEqual({
      WRITE_TOKEN: 'write-token-1',
    });
    // The token must never reach agents.yaml — it belongs in the secrets store.
    const metaPath = path.join(HOME, '.agents', 'agents.yaml');
    const metaText = fs.existsSync(metaPath) ? fs.readFileSync(metaPath, 'utf8') : '';
    expect(metaText).not.toContain('write-token-1');
  });

  it('prefers an injected SHARE_WRITE_TOKEN over the local bundle', async () => {
    const { storeWriteToken, readWriteToken, SHARE_TOKEN_ENV_KEY } = await import('./config.js');
    storeWriteToken('bundle-token');
    process.env.SHARE_WRITE_TOKEN = 'env-token';

    expect(SHARE_TOKEN_ENV_KEY).toBe('SHARE_WRITE_TOKEN');
    expect(readWriteToken()).toBe('env-token');
  });

  it('builds runtime env only when synced share config exists', async () => {
    const { storeWriteToken, shareRuntimeEnv, writeShareConfig } = await import('./config.js');
    storeWriteToken('bundle-token');

    expect(shareRuntimeEnv()).toBeUndefined();

    writeShareConfig({
      baseUrl: 'https://share.example.com',
      accountId: 'acct',
      workerName: 'agents-share',
      bucketName: 'agents-share',
    });

    expect(shareRuntimeEnv()).toEqual({ SHARE_WRITE_TOKEN: 'bundle-token' });
  });

  it('a new share bundle is stored with the never policy so auto-share is silent', async () => {
    const { storeWriteToken, SHARE_BUNDLE } = await import('./config.js');
    const { readBundleSync } = await import('../secrets-client.js');
    storeWriteToken('bundle-token');
    // storeWriteToken defaults a fresh share bundle to `never` — the low-sensitivity
    // R2 token must not be biometry-gated, or every `agents run` re-prompts.
    expect(readBundleSync(SHARE_BUNDLE).policy).toBe('never');
  });

  it('uses the injected token for runtime env without touching the bundle', async () => {
    const { shareRuntimeEnv, writeShareConfig } = await import('./config.js');
    writeShareConfig({
      baseUrl: 'https://share.example.com',
      accountId: 'acct',
      workerName: 'agents-share',
      bucketName: 'agents-share',
    });
    process.env.SHARE_WRITE_TOKEN = 'env-token';

    expect(shareRuntimeEnv()).toEqual({ SHARE_WRITE_TOKEN: 'env-token' });
  });

  it('reads Cloudflare provisioning credentials from the cloudflare bundle by default', async () => {
    const { readCloudflareCreds } = await import('./config.js');
    const { secretsKeychainItem, writeBundleWithItemsSync } = await import('../secrets-client.js');
    const bundle: SecretsBundle = {
      name: DEFAULT_CF_BUNDLE,
      backend: 'file',
      vars: {
        CLOUDFLARE_API_TOKEN: 'keychain:CLOUDFLARE_API_TOKEN',
        CLOUDFLARE_ACCOUNT_ID: 'keychain:CLOUDFLARE_ACCOUNT_ID',
      },
    } as SecretsBundle;
    writeBundleWithItemsSync(bundle, new Map([
      [secretsKeychainItem(DEFAULT_CF_BUNDLE, 'CLOUDFLARE_API_TOKEN'), 'cf-token-1'],
      [secretsKeychainItem(DEFAULT_CF_BUNDLE, 'CLOUDFLARE_ACCOUNT_ID'), 'cf-account-1'],
    ]));

    expect(DEFAULT_CF_BUNDLE).toBe('cloudflare');
    expect(readCloudflareCreds()).toEqual({
      apiToken: 'cf-token-1',
      accountId: 'cf-account-1',
    });
  });

  it('fails if only the old cloudflare.com bundle exists', async () => {
    const { readCloudflareCreds } = await import('./config.js');
    const { secretsKeychainItem, writeBundleWithItemsSync } = await import('../secrets-client.js');
    const bundle: SecretsBundle = {
      name: 'cloudflare.com',
      backend: 'file',
      vars: { CLOUDFLARE_API_TOKEN: 'keychain:CLOUDFLARE_API_TOKEN' },
    } as SecretsBundle;
    writeBundleWithItemsSync(bundle, new Map([[secretsKeychainItem('cloudflare.com', 'CLOUDFLARE_API_TOKEN'), 'old-token']]));

    expect(() => readCloudflareCreds()).toThrow();
  });
});
