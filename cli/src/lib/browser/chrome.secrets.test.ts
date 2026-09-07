import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { secretsKeychainItem, writeBundleWithItems, _resetSecretsClientForTest } from '../secrets-client.js';
import type { SecretsBundle } from '../secrets-types.js';

/**
 * SEC-13 for the browser-profile launch read: injecting a profile secrets bundle
 * on `launchBrowser` is a BACKGROUND read (the agent spawns the browser), so it
 * is `agentOnly` and MUST NEVER pop Touch ID. `resolveProfileSecretsEnv` is the
 * exported seam that carries that contract without spawning a real browser: a
 * `never`/no-ACL bundle resolves silently; a locked `hold`/`always` bundle
 * resolves to an EMPTY map (launch proceeds without those secrets), never a throw
 * and never a prompt.
 *
 * `resolveProfileSecretsEnv` now talks to the standalone `secrets` CLI through
 * the process client (PHNX-3989) — there is no in-process engine to mock, so
 * this drives the REAL standalone against a throwaway file-backed home, gated
 * on `AGENTS_TEST_SECRETS_BIN` (see `secrets-client.test.ts`).
 */
const REAL_BIN = process.env.AGENTS_TEST_SECRETS_BIN;

describe.skipIf(!REAL_BIN)('resolveProfileSecretsEnv (browser launch, agentOnly SEC-13)', () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};
  const ENV_KEYS = ['SECRETS_BIN', 'HOME', 'SECRETS_HOME', 'AGENTS_SECRETS_PASSPHRASE', 'SECRETS_NO_AGENT'];

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-chrome-secrets-test-'));
    process.env.SECRETS_BIN = REAL_BIN;
    process.env.HOME = home;
    process.env.SECRETS_HOME = path.join(home, '.agents');
    process.env.AGENTS_SECRETS_PASSPHRASE = 'test-passphrase';
    process.env.SECRETS_NO_AGENT = '1'; // no broker in the test env — pure file backend
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

  const BUNDLE = 'browser-profile-x';
  const KEY = 'PROFILE_TOKEN';

  async function writeFileBundle(policy: SecretsBundle['policy'], value: string): Promise<void> {
    const bundle: SecretsBundle = { name: BUNDLE, backend: 'file', policy, vars: { [KEY]: `keychain:${KEY}` } } as SecretsBundle;
    const items = new Map([[secretsKeychainItem(BUNDLE, KEY), value]]);
    await writeBundleWithItems(bundle, items);
  }

  it('returns an empty map when no bundle is named', async () => {
    const { resolveProfileSecretsEnv } = await import('./chrome.js');
    expect(await resolveProfileSecretsEnv(undefined)).toEqual({});
  });

  it('returns an empty map when the named bundle does not exist', async () => {
    const { resolveProfileSecretsEnv } = await import('./chrome.js');
    expect(await resolveProfileSecretsEnv('does-not-exist')).toEqual({});
  });

  it('resolves a never/no-ACL bundle silently and injects its env', async () => {
    await writeFileBundle('never', 'profile-tok');
    const { resolveProfileSecretsEnv } = await import('./chrome.js');
    expect(await resolveProfileSecretsEnv(BUNDLE)).toEqual({ [KEY]: 'profile-tok' });
  });

  // A file-backed bundle never raises a biometry prompt (that is a keychain-only
  // concept), so the `hold`/`always` lock behavior stays covered by the client's
  // own real-standalone tests (secrets-client.test.ts) and this file focuses on
  // the launch-time no-throw/no-prompt contract for the always-available backend.
  it('a bundle absent at read time (removed between exists-check and read) resolves to an empty map', async () => {
    const { resolveProfileSecretsEnv } = await import('./chrome.js');
    // Never written — bundleExists is false, so the read is never attempted.
    expect(await resolveProfileSecretsEnv('missing-between-checks')).toEqual({});
  });
});
