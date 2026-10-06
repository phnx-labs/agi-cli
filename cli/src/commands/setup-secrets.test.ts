import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  runSecretsSetupWizard,
  setupSecretsPrefsPath,
  installSecretsCli,
  SECRETS_CLI_PACKAGE,
} from './setup-secrets.js';
import { _resetSecretsClientForTest } from '../lib/secrets-client.js';

describe('agents setup secrets', () => {
  const saved: Record<string, string | undefined> = {};
  const ENV_KEYS = ['SECRETS_BIN', 'PATH'];

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    process.env.SECRETS_BIN = '';
    delete process.env.SECRETS_BIN;
    process.env.PATH = '';
    _resetSecretsClientForTest();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    _resetSecretsClientForTest();
  });

  it('prints install guidance and returns false rather than throwing', async () => {
    expect(await runSecretsSetupWizard()).toBe(false);
  });

  it('installSecretsCli fails closed when npm is not on PATH (does not throw)', async () => {
    expect(await installSecretsCli()).toBe(false);
  });

  it('pins a published package, not @latest', () => {
    expect(SECRETS_CLI_PACKAGE).toBe('@phnx-labs/secrets-cli@0.3.0');
    expect(SECRETS_CLI_PACKAGE).not.toMatch(/@latest$/);
  });

  it.skipIf(process.platform === 'win32')('accepts an explicit $SECRETS_BIN at the floor and refuses one below it without installing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-setup-secrets-'));
    const bin = path.join(dir, 'secrets');
    process.env.PATH = '/usr/bin:/bin';
    process.env.SECRETS_BIN = bin;
    fs.writeFileSync(bin, `#!/bin/sh\necho ${SECRETS_CLI_PACKAGE.split('@').pop()}\n`, { mode: 0o755 });
    expect(await installSecretsCli()).toBe(true);
    fs.writeFileSync(bin, '#!/bin/sh\necho 0.1.8\n', { mode: 0o755 });
    expect(await installSecretsCli()).toBe(false);
    expect(await runSecretsSetupWizard()).toBe(false);
    expect(fs.existsSync(setupSecretsPrefsPath())).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('names a stable, version-independent prefs path', () => {
    expect(setupSecretsPrefsPath()).toMatch(/setup[/\\]secrets\.json$/);
  });
});

const REAL_BIN = process.env.AGENTS_TEST_SECRETS_BIN;

describe.skipIf(!REAL_BIN)('agents setup secrets — against the real standalone', () => {
  const saved: Record<string, string | undefined> = {};
  const ENV_KEYS = ['SECRETS_BIN', 'HOME', 'SECRETS_HOME', 'SECRETS_NO_AGENT'];
  let home: string;

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-setup-secrets-real-'));
    process.env.SECRETS_BIN = REAL_BIN;
    process.env.HOME = home;
    process.env.SECRETS_HOME = path.join(home, '.agents');
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

  it('meets the pinned floor', async () => {
    expect(await installSecretsCli()).toBe(true);
  });

  it('hands off to the real `secrets migrate`, which leaves an explicit SECRETS_HOME in place and records setup', async () => {
    fs.rmSync(setupSecretsPrefsPath(), { force: true });
    const ok = await runSecretsSetupWizard();
    expect(ok).toBe(true);
    expect(fs.existsSync(setupSecretsPrefsPath())).toBe(true);
    expect(fs.existsSync(path.join(home, '.agents', '.secrets'))).toBe(false);
  });
});
