import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach } from 'vitest';
import { _resetSecretsClientForTest, keychainUsesFileFallback } from '../src/lib/secrets-client.js';
import { invalidateClaudeSetupTokenCache } from '../src/lib/claude-account-token.js';

export function ensureStandaloneSecretsBin(): string {
  const explicit = process.env.AGENTS_TEST_SECRETS_BIN?.trim() || process.env.SECRETS_BIN?.trim();
  if (explicit) return explicit;
  const entry = fileURLToPath(new URL('../node_modules/@phnx-labs/secrets-cli/dist/index.js', import.meta.url));
  if (!fs.existsSync(entry)) throw new Error(`The @phnx-labs/secrets-cli dependency has no ${entry}; run bun install.`);
  return entry;
}

export function useFreshSecretsHome(): () => string {
  let home = '';
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.SECRETS_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-secrets-home-'));
    process.env.SECRETS_HOME = home;
    _resetSecretsClientForTest();
    invalidateClaudeSetupTokenCache();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.SECRETS_HOME;
    else process.env.SECRETS_HOME = saved;
    _resetSecretsClientForTest();
    invalidateClaudeSetupTokenCache();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return () => home;
}

let fileBacked: Promise<boolean> | undefined;

export function standaloneKeychainIsFileBacked(): Promise<boolean> {
  if (!fileBacked) {
    const saved = process.env.SECRETS_HOME;
    const probeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-secrets-probe-'));
    process.env.SECRETS_HOME = probeHome;
    _resetSecretsClientForTest();
    fileBacked = keychainUsesFileFallback().finally(() => {
      if (saved === undefined) delete process.env.SECRETS_HOME;
      else process.env.SECRETS_HOME = saved;
      _resetSecretsClientForTest();
      fs.rmSync(probeHome, { recursive: true, force: true });
    });
  }
  return fileBacked;
}
