import { beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { deleteBundleSync, _resetSecretsClientForTest } from '../secrets-client.js';

/** Shared fixture for the daemon.*.test.ts slices (RUSH-2819). daemon.test.ts was a 2201-line,
 * 88-test, ~112s file serializing a vitest fork, so it was split into topical slices for per-file
 * fork parallelism; helpers shared by more than one live here. */

/** Isolate every slice against a fresh, empty standalone `secrets` store (PHNX-3989): an in-process
 * fake keychain can't serve reads, and slices spawning a REAL `__daemon-run` need the same store
 * (`useFreshSecretsHome` sets SECRETS_HOME, inherited by children). */
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
    try { deleteBundleSync('claude'); } catch { /* not created */ }
    if (saved === undefined) delete process.env.SECRETS_HOME;
    else process.env.SECRETS_HOME = saved;
    _resetSecretsClientForTest();
    fs.rmSync(home, { recursive: true, force: true });
  });
}

// The real compiled CLI entry shared by slices that drive an actual `__daemon-run` subprocess,
// computed relative to this file (which stays in src/lib/daemon/) so the split doesn't affect the
// path.
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const DIST_ENTRY = path.join(REPO_ROOT, 'dist', 'index.js');
