import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isSecretsCliInstalled,
  runSecretsSetupWizard,
  setupSecretsPrefsPath,
} from './setup-secrets.js';
import { _resetSecretsClientForTest } from '../lib/secrets-client.js';

/**
 * `agents setup secrets` installs the standalone `secrets` CLI when missing
 * (declared host-CLI manifest, else the pinned npm package), then hands off to
 * `secrets migrate`. DIST-1: agents-cli never rebundles the engine. A PATH with
 * no `secrets` and no npm is the always-testable miss — install fails loud
 * rather than throwing or writing setup prefs.
 */
describe('agents setup secrets', () => {
  const saved: Record<string, string | undefined> = {};
  const ENV_KEYS = ['SECRETS_BIN', 'PATH'];

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    // A PATH with no `secrets` on it and no explicit override — deterministic
    // "not installed" regardless of what's on the real machine running this.
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

  it('reports not installed when $SECRETS_BIN is unset and PATH has no `secrets`', () => {
    expect(isSecretsCliInstalled()).toBe(false);
  });

  it('attempts install and returns false rather than throwing when npm is also missing', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    console.error = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    try {
      expect(await runSecretsSetupWizard()).toBe(false);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    const text = logs.join('\n');
    expect(text).toMatch(/not installed/i);
    expect(text).toMatch(/Failed to install @phnx-labs\/secrets-cli@0\.1\.2/);
    expect(text).toMatch(/npm i -g @phnx-labs\/secrets-cli@0\.1\.2/);
  });

  it('reports installed once $SECRETS_BIN points at a real executable', () => {
    const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agents-setup-secrets-')), 'secrets');
    fs.writeFileSync(fake, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.SECRETS_BIN = fake;
    _resetSecretsClientForTest();
    expect(isSecretsCliInstalled()).toBe(true);
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

  it('is reported installed', () => {
    expect(isSecretsCliInstalled()).toBe(true);
  });

  it('hands off to the real `secrets migrate`, which refuses without an interactive confirmation', async () => {
    // `secrets migrate` always demands an interactive confirmation before
    // touching anything, even with nothing to migrate — this test process has
    // no TTY, so the real spawn exits non-zero. That is the honest outcome:
    // the wizard hands off faithfully and does not fake success.
    const ok = await runSecretsSetupWizard();
    expect(ok).toBe(false);
    expect(fs.existsSync(setupSecretsPrefsPath())).toBe(false);
  });
});
