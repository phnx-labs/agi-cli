/**
 * The real standalone `secrets` CLI for the test suite (PHNX-3989).
 *
 * agents-cli talks to secrets only through `src/lib/secrets-client.ts`, which
 * spawns the published `@phnx-labs/secrets-cli` executable — so every test that
 * touches an account bundle, a profile token, or the reserved `auth` bundle
 * needs that executable, not a mock (repo rule: real services only). This
 * module resolves it once per machine:
 *
 *   1. `AGENTS_TEST_SECRETS_BIN` / `SECRETS_BIN` already set → use it as-is (a
 *      secrets-cli checkout's `dist/index.js`, or an operator-installed shim).
 *   2. Otherwise install the pinned published version into a per-version prefix
 *      under the OS temp dir with `npm i -g --prefix <prefix>` — exactly the
 *      artifact a user installs — and reuse it across runs and forks. The
 *      install is serialized by a directory lock so parallel vitest forks (or
 *      two suites on one box) never race the same prefix.
 *
 * `tests/global-setup.ts` calls {@link ensureStandaloneSecretsBin} in the main
 * process before any fork spawns, so `SECRETS_BIN` is inherited everywhere;
 * `tests/setup.ts` pins the per-fork posture (no broker, deterministic file-store
 * passphrase); {@link useFreshSecretsHome} gives one test file — or one test — its
 * own empty `SECRETS_HOME`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach } from 'vitest';
import { _resetSecretsClientForTest, keychainUsesFileFallback } from '../src/lib/secrets-client.js';
import { invalidateClaudeSetupTokenCache } from '../src/lib/claude-account-token.js';

/** The published standalone the suite is pinned to; bump with the protocol. */
export const STANDALONE_SECRETS_VERSION = '0.1.2';
const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_WAIT_MS = 5 * 60 * 1000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function installPrefix(): string {
  return path.join(os.tmpdir(), `agents-secrets-cli-${STANDALONE_SECRETS_VERSION}`);
}

/**
 * The installed `secrets` executable to hand the client as `SECRETS_BIN`.
 *
 * On POSIX this is the npm-created **bin shim** (`<prefix>/bin/secrets`, a
 * `#!/usr/bin/env node` launcher), NOT the raw `dist/index.js`. This matters
 * because the repo runs its whole CLI suite as `bun src/index.ts`: pointing at
 * the `.js` makes the client spawn the standalone through the PARENT's runtime
 * (`process.execPath` → Bun), and the standalone deadlocks reading the inherited
 * protocol fds under Bun. The shim's shebang pins the child to Node regardless of
 * who spawned it — exactly what a real `npm i -g` install resolves from PATH in
 * production. On Windows (async path only; the sync path is refused there) the
 * shim is a `.cmd`, so fall back to the `.js` entry run via Node.
 */
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

/**
 * Resolve the standalone `secrets` executable for this test run, installing the
 * pinned published version on first use. Returns the path to hand to
 * `SECRETS_BIN`.
 */
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

/**
 * Give the enclosing describe/file a fresh, empty standalone state root per
 * test: `SECRETS_HOME` is pointed at a new temp dir before each test and the
 * previous value restored after. The process-local setup-token memo
 * (`claude-account-token.ts`) is dropped with it — a fresh store must never be
 * served a token memoized against the previous one. Returns a getter for the
 * current root.
 */
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

/**
 * True when the standalone routes `keychain`-backend items to its encrypted
 * file store on this host (headless Linux/Windows with no keyring). Tests that
 * exercise keychain-backed bundles or profile tokens gate on this, because on
 * a headed macOS box the same calls would reach the operator's real login
 * keychain (there is no per-test keychain to isolate); file-backed bundles
 * (the reserved `auth` bundle, reserved stores) run everywhere.
 */
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
