import { beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { deleteBundleSync, _resetSecretsClientForTest } from '../secrets-client.js';

/**
 * Shared fixture for the daemon.*.test.ts suite slices (RUSH-2819).
 *
 * daemon.test.ts was a single 2201-line file (88 tests, ~112s in CI) — the
 * slowest file in the daemon test-ownership group, serializing an entire
 * vitest fork while every other selected file finished. The suite is split
 * into topical slices so per-file fork parallelism can spread the
 * process-spawning / real-daemon integration tests across workers; the
 * helpers shared by more than one slice live here.
 */

/**
 * Isolates every slice against a fresh, empty standalone `secrets` store
 * (PHNX-3989) — an in-process fake keychain can no longer serve reads, since
 * the client always spawns the real standalone, and several slices here also
 * spawn a REAL `__daemon-run` subprocess that must see the SAME isolated
 * store (a fresh `SECRETS_HOME` covers both: `useFreshSecretsHome` sets it as
 * a `process.env` var, which every spawned child inherits by default). Call
 * once at the top level of each slice file.
 */
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

// The real compiled CLI entry, shared by every slice that drives an actual
// `__daemon-run` subprocess (lifecycle/registry/stop). Computed relative to
// this file's own location, which stays in src/lib/daemon/ alongside every
// slice, so the path math is unaffected by the split.
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const DIST_ENTRY = path.join(REPO_ROOT, 'dist', 'index.js');
