import { beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { deleteBundleSync, _resetSecretsClientForTest } from '../secrets-client.js';


export function installKeychainHermeticity(): void {
  let home = '';
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.SECRETS_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-daemon-secrets-home-'));
    process.env.SECRETS_HOME = home;
    _resetSecretsClientForTest();
  });

  afterEach(() => {
    try { deleteBundleSync('claude'); } catch {  }
    if (saved === undefined) delete process.env.SECRETS_HOME;
    else process.env.SECRETS_HOME = saved;
    _resetSecretsClientForTest();
    fs.rmSync(home, { recursive: true, force: true });
  });
}

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const DIST_ENTRY = path.join(REPO_ROOT, 'dist', 'index.js');
