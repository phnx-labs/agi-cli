import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { addAccount, resolveCredentialAccount } from './account-registry.js';
import { accountSecretItem } from './account-schema.js';
import { deleteBundleSync, deleteKeychainTokenSync } from './secrets-client.js';

const realHome = process.env.AGENTS_TEST_REAL_KEYCHAIN_HOME;

describe.skipIf(process.platform !== 'darwin' || !realHome)('provider accounts (real macOS keychain)', () => {
  it('stores policy-never credentials no-ACL and resolves them in a headless launch', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-account-keychain-'));
    const name = `phnx-2939-${randomUUID()}`;
    const secret = `sk-or-v1-${randomUUID()}`;
    const previousRuntime = process.env.AGENTS_RUNTIME;

    try {
      addAccount(name, 'openrouter', 'api-key', secret, root);
      process.env.AGENTS_RUNTIME = 'headless';

      expect(resolveCredentialAccount(name, 'claude', undefined, root).env.ANTHROPIC_AUTH_TOKEN).toBe(secret);
    } finally {
      if (previousRuntime === undefined) delete process.env.AGENTS_RUNTIME;
      else process.env.AGENTS_RUNTIME = previousRuntime;
      deleteKeychainTokenSync(accountSecretItem(name, 'api-key'));
      deleteBundleSync(name);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
