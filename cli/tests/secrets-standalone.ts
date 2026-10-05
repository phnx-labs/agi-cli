/** The real standalone `secrets` CLI for the suite (PHNX-3989): tests need the published
 * `@phnx-labs/secrets-cli`, not a mock. Uses `AGENTS_TEST_SECRETS_BIN`/`SECRETS_BIN` if set, else
 * installs the pinned version into a per-version temp prefix, directory-locked against fork races. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach } from 'vitest';
import { _resetSecretsClientForTest, keychainUsesFileFallback } from '../src/lib/secrets-client.js';
import { invalidateClaudeSetupTokenCache } from '../src/lib/claude-account-token.js';
import { SECRETS_CLI_VERSION } from '../src/lib/secrets-cli.js';

/** The published standalone the suite is pinned to; bump with the protocol. */
const STANDALONE_SECRETS_VERSION = SECRETS_CLI_VERSION;
const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_WAIT_MS = 5 * 60 * 1000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function installPrefix(): string {
  return path.join(os.tmpdir(), `agents-secrets-cli-${STANDALONE_SECRETS_VERSION}`);
}

/** The `secrets` executable for `SECRETS_BIN`: on POSIX the npm bin shim, not `dist/index.js`, since
 * the suite runs under Bun and a `.js` path would run the standalone through Bun, which deadlocks
 * on inherited fds. On Windows (async path) use the `.js` via Node. */
function installedEntry(prefix: string): string {
  if (process.platform === 'win32') {
    return path.join(prefix, 'lib', 'node_modules', '@phnx-labs', 'secrets-cli', 'dist', 'index.js');
  }
  return path.join(prefix, 'bin', 'secrets');
}

function withInstallLock<T>(lock: string, fn: () => T): T {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {
        continue; // released between the mkdir and the stat
      }
      if (age > LOCK_STALE_MS) {
        fs.rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for the standalone secrets install lock at ${lock}`);
      }
      sleepSync(250);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/** Resolve the standalone `secrets` executable for this run, installing the pinned published version
 * on first use; returns the path for `SECRETS_BIN`. */
export function ensureStandaloneSecretsBin(): string {
  const explicit = process.env.AGENTS_TEST_SECRETS_BIN?.trim() || process.env.SECRETS_BIN?.trim();
  if (explicit) return explicit;
  const prefix = installPrefix();
  const entry = installedEntry(prefix);
  const marker = path.join(prefix, `.installed-${STANDALONE_SECRETS_VERSION}`);
  if (fs.existsSync(marker) && fs.existsSync(entry)) return entry;
  return withInstallLock(`${prefix}.lock`, () => {
    if (fs.existsSync(marker) && fs.existsSync(entry)) return entry; // a sibling installed it while we waited
    fs.rmSync(prefix, { recursive: true, force: true });
    fs.mkdirSync(prefix, { recursive: true });
    const result = spawnSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', '-g', '--prefix', prefix, '--no-audit', '--no-fund', `@phnx-labs/secrets-cli@${STANDALONE_SECRETS_VERSION}`],
      { encoding: 'utf8', shell: process.platform === 'win32', timeout: 4 * 60 * 1000 },
    );
    if (result.status !== 0 || !fs.existsSync(entry)) {
      throw new Error(
        `Installing @phnx-labs/secrets-cli@${STANDALONE_SECRETS_VERSION} into ${prefix} failed ` +
          `(exit ${result.status ?? 'signal'}). The suite needs the real standalone; set ` +
          `AGENTS_TEST_SECRETS_BIN to a built secrets-cli entrypoint to skip the install.\n${result.stderr ?? ''}`,
      );
    }
    fs.writeFileSync(marker, new Date().toISOString());
    return entry;
  });
}

/** Give the file a fresh empty standalone state root per test: `SECRETS_HOME` is pointed at a new
 * temp dir and restored after, and the process-local setup-token memo (`claude-account-token.ts`)
 * is dropped so a fresh store is never served a stale token. */
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

/** True when the standalone routes `keychain` items to its encrypted file store (headless
 * Linux/Windows). Keychain-backed tests gate on this, since on a headed macOS box they would reach
 * the operator's real login keychain; file-backed bundles run everywhere. */
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
