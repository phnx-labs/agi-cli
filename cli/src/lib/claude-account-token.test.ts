import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  claudeAccountTokenKey,
  invalidateClaudeSetupTokenCache,
  isValidClaudeSetupToken,
  provisionWorkerSlot,
  readClaudeAccountEmail,
  readReservedCredential,
  resolveClaudeSetupToken,
  resolveClaudeSetupTokenForEmail,
  seedClaudeWorkerHomeIdentity,
  isClaudeWorkerHomeSeeded,
  writeClaudeWorkerOauthToken,
} from './claude-account-token.js';
import { seedReservedAuthToken } from './auth-mint.js';
import { isReservedBundleBackendError } from './secrets-policy.js';
import {
  SecretsClientError,
  bundleExistsSync,
  keychainRef,
  readBundleSync,
  rotateBundleSecretSync,
  secretsKeychainItem,
  storeSet,
  writeBundleWithItemsSync,
} from './secrets-client.js';
import type { SecretsBundle } from './secrets-types.js';
import { useFreshSecretsHome } from '../../tests/secrets-standalone.js';
import { readSlots, slotDir } from './accounts/slots.js';
import { readMeta } from './state.js';
import type { NativeAccountRecord } from './types.js';
import { buildExecEnv } from './exec.js';
import { getVersionHomePath } from './installations/versions.js';

// Every bundle read/write below goes through the real standalone `secrets`
// CLI (PHNX-3989). useFreshSecretsHome gives each test an empty SECRETS_HOME;
// the fork defaults in tests/setup.ts pin no broker + a deterministic
// file-store passphrase. The reserved `auth` bundle and the `__<harness>__`
// stores are file-backed by policy, so nothing here can reach a host keychain.
describe('claude-account-token (standalone secrets)', () => {
  useFreshSecretsHome();

  let homes: string[] = [];
  let versionDirs: string[] = [];
  let prevClaudeToken: string | undefined;
  let prevMachineId: string | undefined;

  beforeEach(() => {
    homes = [];
    versionDirs = [];
    prevClaudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    prevMachineId = process.env.AGENTS_SYNC_MACHINE_ID;
    // These buildExecEnv cases exercise worker credential injection. Pin an
    // unconfigured device id so their result cannot depend on the fleet role of
    // whichever machine happens to run the suite (PHNX-3588).
    process.env.AGENTS_SYNC_MACHINE_ID = 'phnx-3588-worker-fixture';
    // The setup-token memo is process-local and keyed by home / email, and the
    // email-keyed entries would otherwise survive from one test's store into
    // the next test's fresh, empty one.
    invalidateClaudeSetupTokenCache();
  });

  afterEach(() => {
    if (prevClaudeToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevClaudeToken;
    if (prevMachineId === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
    else process.env.AGENTS_SYNC_MACHINE_ID = prevMachineId;
    for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
    for (const dir of versionDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeHome(email?: string): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-account-token-home-'));
    homes.push(home);
    if (email !== undefined) {
      const configDir = path.join(home, '.claude');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: email } }),
      );
    }
    return home;
  }

  /**
   * Write the reserved `auth` bundle with exactly these raw keys, in the shape
   * `seedReservedAuthToken` produces (file-backed, policy never, one raw item
   * per key). Unlike the seed helper it accepts any key and any value, which the
   * bare-shared-key and malformed-blob cases need, and it does NOT touch the
   * process-local memo — it is what an out-of-band write (another process,
   * a fleet sync) looks like to this process.
   */
  function writeAuthBundle(values: Record<string, string>): void {
    const bundle: SecretsBundle = { name: 'auth', backend: 'file', policy: 'never', vars: {}, meta: {} };
    const items = new Map<string, string>();
    for (const [key, value] of Object.entries(values)) {
      bundle.vars[key] = keychainRef(key);
      bundle.meta![key] = { type: 'token' };
      items.set(secretsKeychainItem('auth', key), value);
    }
    writeBundleWithItemsSync(bundle, items);
  }

  /** Seed raw items of a reserved `__<harness>__` store the way the mint path does (no bundle meta). */
  async function seedReservedStore(name: string, values: Record<string, string>): Promise<void> {
    for (const [key, value] of Object.entries(values)) {
      await storeSet('file', secretsKeychainItem(name, key), value);
    }
  }

  function nativeRow(over: Partial<NativeAccountRecord>): NativeAccountRecord {
    return { id: 'acc', name: 'name', agent: 'claude', identityKey: 'claude:account=a:org=o', scope: 'version', ...over };
  }

  describe('resolveClaudeSetupToken', () => {
    it('refuses a bare shared CLAUDE_CODE_OAUTH_TOKEN as a per-account source', () => {
      const home = makeHome('alpha@example.com');
      writeAuthBundle({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-shared-must-not-resolve' });

      expect(resolveClaudeSetupToken(home)).toBeNull();
    });

    it('returns no token when the version home has no resolvable account email', () => {
      const home = makeHome();
      writeAuthBundle({
        [claudeAccountTokenKey('alpha@example.com')]: 'sk-ant-oat01-alpha',
      });

      expect(resolveClaudeSetupToken(home)).toBeNull();
    });

    it('returns no token when no auth bundle exists at all', () => {
      const home = makeHome('alpha@example.com');
      expect(bundleExistsSync('auth')).toBe(false);

      expect(resolveClaudeSetupToken(home)).toBeNull();
    });

    it('resolves different tokens for different account-bound homes', () => {
      const alphaHome = makeHome('alpha@example.com');
      const betaHome = makeHome('beta@example.com');
      writeAuthBundle({
        [claudeAccountTokenKey('alpha@example.com')]: 'sk-ant-oat01-alpha',
        [claudeAccountTokenKey('beta@example.com')]: 'sk-ant-oat01-beta',
      });

      expect(resolveClaudeSetupToken(alphaHome)).toBe('sk-ant-oat01-alpha');
      expect(resolveClaudeSetupToken(betaHome)).toBe('sk-ant-oat01-beta');
    });

    it('memoizes a resolved token per cache key until an in-process writer invalidates it', () => {
      const home = makeHome('alpha@example.com');
      const key = claudeAccountTokenKey('alpha@example.com');
      writeAuthBundle({ [key]: 'sk-ant-oat01-alpha' });
      expect(resolveClaudeSetupToken(home)).toBe('sk-ant-oat01-alpha');

      // An out-of-band rotation (what another process's write looks like) is
      // served from the memo for this cache key: the memo is what keeps a probe
      // loop over many accounts from spawning the standalone per account.
      rotateBundleSecretSync(readBundleSync('auth'), key, { newValue: 'sk-ant-oat01-rotated', meta: { type: 'token' } });
      expect(resolveClaudeSetupToken(home)).toBe('sk-ant-oat01-alpha');
      // A distinct cache key (the email-keyed read) gets its own read.
      expect(resolveClaudeSetupTokenForEmail('alpha@example.com')).toBe('sk-ant-oat01-rotated');

      invalidateClaudeSetupTokenCache();
      expect(resolveClaudeSetupToken(home)).toBe('sk-ant-oat01-rotated');
    });

    it('memoizes a missing per-account credential as a negative result until invalidated', () => {
      const home = makeHome('missing@example.com');
      writeAuthBundle({ [claudeAccountTokenKey('other@example.com')]: 'sk-ant-oat01-other' });
      expect(resolveClaudeSetupToken(home)).toBeNull();

      writeAuthBundle({
        [claudeAccountTokenKey('other@example.com')]: 'sk-ant-oat01-other',
        [claudeAccountTokenKey('missing@example.com')]: 'sk-ant-oat01-missing',
      });
      expect(resolveClaudeSetupToken(home)).toBeNull();

      invalidateClaudeSetupTokenCache();
      expect(resolveClaudeSetupToken(home)).toBe('sk-ant-oat01-missing');
    });

    it('returns the rotated token immediately after an in-process seed', () => {
      const home = makeHome('alpha@example.com');
      seedReservedAuthToken('alpha@example.com', 'sk-ant-oat01-alpha');
      expect(resolveClaudeSetupToken(home)).toBe('sk-ant-oat01-alpha');

      // seedReservedAuthToken rotates the stored item AND drops the memo, so
      // the next resolve observes the rotation with no TTL wait.
      seedReservedAuthToken('alpha@example.com', 'sk-ant-oat01-rotated');

      expect(resolveClaudeSetupToken(home)).toBe('sk-ant-oat01-rotated');
    });

    it('never shares a cached token between version homes', () => {
      const alphaHome = makeHome('alpha@example.com');
      const betaHome = makeHome('beta@example.com');
      writeAuthBundle({
        [claudeAccountTokenKey('alpha@example.com')]: 'sk-ant-oat01-alpha',
        [claudeAccountTokenKey('beta@example.com')]: 'sk-ant-oat01-beta',
      });
      expect(resolveClaudeSetupToken(alphaHome)).toBe('sk-ant-oat01-alpha');
      expect(resolveClaudeSetupToken(betaHome)).toBe('sk-ant-oat01-beta');
      // Both memoized now — a second round must still be keyed per home.
      expect(resolveClaudeSetupToken(alphaHome)).toBe('sk-ant-oat01-alpha');
      expect(resolveClaudeSetupToken(betaHome)).toBe('sk-ant-oat01-beta');
    });

    it('invalidates a version-home entry when that home changes accounts', () => {
      const home = makeHome('alpha@example.com');
      writeAuthBundle({
        [claudeAccountTokenKey('alpha@example.com')]: 'sk-ant-oat01-alpha',
        [claudeAccountTokenKey('beta@example.com')]: 'sk-ant-oat01-beta',
      });
      expect(resolveClaudeSetupToken(home)).toBe('sk-ant-oat01-alpha');

      fs.writeFileSync(
        path.join(home, '.claude', '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: 'beta@example.com' } }),
      );

      expect(resolveClaudeSetupToken(home)).toBe('sk-ant-oat01-beta');
    });

    it('rejects a malformed captured setup-token TTY blob rather than resolving it (#1767)', () => {
      const home = makeHome('alpha@example.com');
      // The #1767 shape: the raw `claude setup-token` TTY stream (ANSI + banner +
      // token) stored as the credential instead of the parsed value. Injecting this
      // as CLAUDE_CODE_OAUTH_TOKEN builds an invalid Authorization header and crashes
      // the run — resolve must refuse it, so the caller falls back to normal login.
      const blob = '\x1b[?2004h\x1b[?1004hWelcome to Claude Code\n  sk-ant-oat01-abcdefghij\n';
      writeAuthBundle({ [claudeAccountTokenKey('alpha@example.com')]: blob });

      expect(resolveClaudeSetupToken(home)).toBeNull();
    });

    it('buildExecEnv injects the token keyed to the selected version home account', () => {
      const version = `rush-2099-token-test-${process.pid}`;
      const versionHome = getVersionHomePath('claude', version);
      versionDirs.push(path.dirname(versionHome));
      const configDir = path.join(versionHome, '.claude');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: 'alpha@example.com' } }),
      );
      writeAuthBundle({
        [claudeAccountTokenKey('alpha@example.com')]: 'sk-ant-oat01-alpha',
      });
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-shared-must-not-win';

      const env = buildExecEnv({
        agent: 'claude',
        version,
        mode: 'plan',
        effort: 'auto',
        prompt: 'do the thing',
      });

      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-alpha');
      expect(env.CLAUDE_CONFIG_DIR).toBe(configDir);
    });

    it('buildExecEnv injects the setup-token for an interactive run on a worker', () => {
      // A remotely interactive TUI on a worker has no headed-device login. It must
      // use the same account-bound setup-token as a headless worker run (PHNX-3502).
      const version = `interactive-token-test-${process.pid}`;
      const versionHome = getVersionHomePath('claude', version);
      versionDirs.push(path.dirname(versionHome));
      const configDir = path.join(versionHome, '.claude');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: 'alpha@example.com' } }),
      );
      writeAuthBundle({
        [claudeAccountTokenKey('alpha@example.com')]: 'sk-ant-oat01-alpha',
      });
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

      // No prompt at all -> inferred interactive (the `agents run claude` TUI).
      const inferred = buildExecEnv({ agent: 'claude', version, mode: 'plan', effort: 'auto' });
      expect(inferred.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-alpha');
      expect(inferred.CLAUDE_CONFIG_DIR).toBe(configDir);

      // An explicit --interactive wins even when a prompt is present.
      const explicit = buildExecEnv({
        agent: 'claude',
        version,
        mode: 'plan',
        effort: 'auto',
        prompt: 'do the thing',
        interactive: true,
      });
      expect(explicit.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-alpha');
    });

    it('buildExecEnv keeps the account setup-token for an interactive worker run', () => {
      const version = `interactive-inherited-test-${process.pid}`;
      const versionHome = getVersionHomePath('claude', version);
      versionDirs.push(path.dirname(versionHome));
      const configDir = path.join(versionHome, '.claude');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: 'alpha@example.com' } }),
      );
      writeAuthBundle({
        [claudeAccountTokenKey('alpha@example.com')]: 'sk-ant-oat01-alpha',
      });
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-alpha';

      const env = buildExecEnv({ agent: 'claude', version, mode: 'plan', effort: 'auto' });

      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-alpha');
    });

    it('buildExecEnv replaces an ambient token with the account token on an interactive worker run', () => {
      // Worker launches never inherit a caller's account. The selected version's
      // account-bound setup-token wins for interactive and headless runs alike.
      const version = `interactive-user-token-test-${process.pid}`;
      const versionHome = getVersionHomePath('claude', version);
      versionDirs.push(path.dirname(versionHome));
      const configDir = path.join(versionHome, '.claude');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: 'alpha@example.com' } }),
      );
      writeAuthBundle({
        [claudeAccountTokenKey('alpha@example.com')]: 'sk-ant-oat01-alpha',
      });
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-user-exported';

      const env = buildExecEnv({ agent: 'claude', version, mode: 'plan', effort: 'auto' });

      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-alpha');
    });
  });

  describe('reserved auth backend policy (SEC-GAP-3)', () => {
    // A keychain-backed `auth` cannot be created through the standalone at all:
    // its write guard refuses it, so the read-side wrong-backend path is not
    // reproducible here. What is observable is the refusal itself and that
    // agents-cli recognizes the standalone's code as the reserved-backend error.
    it('the standalone refuses a keychain-backed auth bundle and the refusal reads as a reserved-backend error', () => {
      const home = makeHome('alpha@example.com');
      const key = claudeAccountTokenKey('alpha@example.com');
      let caught: unknown;
      try {
        writeBundleWithItemsSync(
          { name: 'auth', backend: 'keychain', vars: { [key]: keychainRef(key) } },
          new Map([[secretsKeychainItem('auth', key), 'sk-ant-oat01-alpha']]),
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SecretsClientError);
      expect((caught as SecretsClientError).code).toBe('WRONG_BACKEND');
      expect(isReservedBundleBackendError(caught)).toBe(true);

      // Nothing was created, so the resolver sees no auth bundle at all.
      expect(bundleExistsSync('auth')).toBe(false);
      expect(resolveClaudeSetupToken(home)).toBeNull();
    });
  });

  describe('isValidClaudeSetupToken', () => {
    it('accepts a clean single-line sk-ant-oat01- token', () => {
      expect(isValidClaudeSetupToken('sk-ant-oat01-alpha')).toBe(true);
      expect(isValidClaudeSetupToken('sk-ant-oat01-AbC_123-xyz')).toBe(true);
    });

    it('rejects a captured TTY blob, wrong prefix, and whitespace/control chars (#1767)', () => {
      expect(isValidClaudeSetupToken('\x1b[?2004hWelcome\n  sk-ant-oat01-abc\n')).toBe(false);
      expect(isValidClaudeSetupToken('sk-ant-oat01-abc\n')).toBe(false);
      expect(isValidClaudeSetupToken('sk-ant-oat01-abc def')).toBe(false);
      expect(isValidClaudeSetupToken('sk-ant-api03-abc')).toBe(false);
      expect(isValidClaudeSetupToken('sk-ant-oat01-')).toBe(false);
      expect(isValidClaudeSetupToken('')).toBe(false);
    });
  });

  describe('resolveClaudeSetupTokenForEmail + seedClaudeWorkerHomeIdentity (worker bootstrap)', () => {
    it('resolves a setup-token by explicit email with no version-home identity', () => {
      writeAuthBundle({ [claudeAccountTokenKey('social@swarmify.co')]: 'sk-ant-oat01-social' });
      expect(resolveClaudeSetupTokenForEmail('social@swarmify.co')).toBe('sk-ant-oat01-social');
      // An account with no token in the bundle resolves to null, never another account's.
      expect(resolveClaudeSetupTokenForEmail('nobody@nowhere.dev')).toBeNull();
      expect(resolveClaudeSetupTokenForEmail('')).toBeNull();
    });

    it('seeds a signed-out worker home so its account then resolves end to end', () => {
      writeAuthBundle({ [claudeAccountTokenKey('dev@getrush.ai')]: 'sk-ant-oat01-dev' });
      const home = makeHome(); // no oauthAccount → reads as signed out
      expect(readClaudeAccountEmail(home)).toBeNull();
      expect(resolveClaudeSetupToken(home)).toBeNull();
      seedClaudeWorkerHomeIdentity(home, 'dev@getrush.ai');
      expect(readClaudeAccountEmail(home)).toBe('dev@getrush.ai');
      expect(resolveClaudeSetupToken(home)).toBe('sk-ant-oat01-dev');
    });

    it('seeds the slot as onboarded so a worker launch skips Claude Code first-run onboarding', () => {
      // A worker has no human at it: nothing else can answer the theme picker /
      // "Let's get started" that every provisioned slot showed (yosemite-m1, 2026-09-10).
      const home = makeHome();
      expect(isClaudeWorkerHomeSeeded(home)).toBe(false);
      seedClaudeWorkerHomeIdentity(home, 'dev@getrush.ai');
      for (const rel of [path.join('.claude', '.claude.json'), '.claude.json']) {
        const doc = JSON.parse(fs.readFileSync(path.join(home, rel), 'utf-8')) as { hasCompletedOnboarding?: boolean };
        expect(doc.hasCompletedOnboarding).toBe(true);
      }
      expect(isClaudeWorkerHomeSeeded(home)).toBe(true);
    });

    it('reports a slot seeded before onboarding was written as not seeded', () => {
      const home = makeHome();
      for (const rel of [path.join('.claude', '.claude.json'), '.claude.json']) {
        fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
        fs.writeFileSync(path.join(home, rel), JSON.stringify({ oauthAccount: { emailAddress: 'dev@getrush.ai' } }));
      }
      expect(isClaudeWorkerHomeSeeded(home)).toBe(false);
    });

    it('preserves existing .claude.json fields when seeding the identity', () => {
      const home = makeHome();
      const cfg = path.join(home, '.claude', '.claude.json');
      fs.mkdirSync(path.dirname(cfg), { recursive: true });
      fs.writeFileSync(cfg, JSON.stringify({ numStartups: 7, tipsHistory: { a: 1 }, oauthAccount: { displayName: 'Keep' } }));
      seedClaudeWorkerHomeIdentity(home, 'tech@prix.dev');
      const doc = JSON.parse(fs.readFileSync(cfg, 'utf-8')) as {
        numStartups: number; tipsHistory: Record<string, number>; oauthAccount: { emailAddress: string; displayName: string };
      };
      expect(doc.numStartups).toBe(7);
      expect(doc.tipsHistory).toEqual({ a: 1 });
      expect(doc.oauthAccount.displayName).toBe('Keep');
      expect(doc.oauthAccount.emailAddress).toBe('tech@prix.dev');
    });
  });

  describe('resolveClaudeSetupToken identity self-heal from .oauth_token (PHNX-3660)', () => {
    function writeOauthToken(home: string, value: string): void {
      const configDir = path.join(home, '.claude');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, '.oauth_token'), `${value}\n`);
    }

    it('recovers the account email from a matching .oauth_token and converges the home', () => {
      const home = makeHome(); // no oauthAccount — the pre-seed-on-attach legacy shape
      writeOauthToken(home, 'sk-ant-oat01-alpha');
      writeAuthBundle({ [claudeAccountTokenKey('alpha@example.com')]: 'sk-ant-oat01-alpha' });

      expect(resolveClaudeSetupToken(home)).toBe('sk-ant-oat01-alpha');
      // Identity was written back, so later reads take the plain email path.
      expect(readClaudeAccountEmail(home)).toBe('alpha@example.com');
    });

    it('fails closed and writes nothing when the .oauth_token matches no bundle key', () => {
      const home = makeHome();
      writeOauthToken(home, 'sk-ant-oat01-rotated-out-of-the-bundle');
      writeAuthBundle({ [claudeAccountTokenKey('alpha@example.com')]: 'sk-ant-oat01-alpha' });

      expect(resolveClaudeSetupToken(home)).toBeNull();
      expect(readClaudeAccountEmail(home)).toBeNull();
      expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(false);
    });

    it('ignores a malformed .oauth_token blob', () => {
      const home = makeHome();
      writeOauthToken(home, 'Welcome to Claude Code\n  sk-ant-oat01-alpha\n');
      writeAuthBundle({ [claudeAccountTokenKey('alpha@example.com')]: 'sk-ant-oat01-alpha' });

      expect(resolveClaudeSetupToken(home)).toBeNull();
      expect(readClaudeAccountEmail(home)).toBeNull();
    });

    it('lets an explicit home email win over a mismatched .oauth_token, unmodified', () => {
      const home = makeHome('beta@example.com');
      writeOauthToken(home, 'sk-ant-oat01-alpha');
      writeAuthBundle({
        [claudeAccountTokenKey('alpha@example.com')]: 'sk-ant-oat01-alpha',
        [claudeAccountTokenKey('beta@example.com')]: 'sk-ant-oat01-beta',
      });

      expect(resolveClaudeSetupToken(home)).toBe('sk-ant-oat01-beta');
      expect(readClaudeAccountEmail(home)).toBe('beta@example.com');
    });

    it('never rewrites the operator home on an ambient (no-home) resolve', () => {
      const home = makeHome();
      writeOauthToken(home, 'sk-ant-oat01-alpha');
      writeAuthBundle({ [claudeAccountTokenKey('alpha@example.com')]: 'sk-ant-oat01-alpha' });
      // os.homedir() follows $HOME on POSIX — steer the ambient probe at the
      // fixture. Only the home probe moves: the standalone's store root is
      // SECRETS_HOME (pinned by useFreshSecretsHome), not HOME.
      const prevHome = process.env.HOME;
      process.env.HOME = home;
      try {
        expect(resolveClaudeSetupToken()).toBeNull();
      } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
      }
      expect(readClaudeAccountEmail(home)).toBeNull();
    });

    it('fails closed on a dotted local part — the decode is ambiguous and must not seed (review BLOCKER 1)', () => {
      // first.last@example.com encodes to FIRST_DOT_LAST_AT_EXAMPLE_DOT_COM, which a
      // naive decode reads as first_dot_last@example.com — and that WRONG address
      // round-trips under the bare re-encode check.
      const home = makeHome();
      writeOauthToken(home, 'sk-ant-oat01-dotted');
      writeAuthBundle({ [claudeAccountTokenKey('first.last@example.com')]: 'sk-ant-oat01-dotted' });

      expect(resolveClaudeSetupToken(home)).toBeNull();
      expect(readClaudeAccountEmail(home)).toBeNull();
      expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(false);
    });

    it('fails closed on a collapsed-separator local part (a+b@example.com)', () => {
      const home = makeHome();
      writeOauthToken(home, 'sk-ant-oat01-plus');
      writeAuthBundle({ [claudeAccountTokenKey('a+b@example.com')]: 'sk-ant-oat01-plus' });

      expect(resolveClaudeSetupToken(home)).toBeNull();
      expect(readClaudeAccountEmail(home)).toBeNull();
    });

    it('caches a no-match discovery against the .oauth_token fingerprint (review SHOULD-2)', () => {
      const home = makeHome();
      writeOauthToken(home, 'sk-ant-oat01-rotated-out');
      writeAuthBundle({ [claudeAccountTokenKey('alpha@example.com')]: 'sk-ant-oat01-alpha' });

      expect(resolveClaudeSetupToken(home)).toBeNull();
      // The bundle now carries the token, but the home's .oauth_token is
      // unchanged, so the no-match discovery is served from the fingerprint
      // cache rather than re-reading the bundle.
      writeAuthBundle({
        [claudeAccountTokenKey('alpha@example.com')]: 'sk-ant-oat01-alpha',
        [claudeAccountTokenKey('rotated@example.com')]: 'sk-ant-oat01-rotated-out',
      });
      expect(resolveClaudeSetupToken(home)).toBeNull();
      expect(readClaudeAccountEmail(home)).toBeNull();

      // A rewritten .oauth_token is a new fingerprint: discovery runs again.
      const tokenPath = path.join(home, '.claude', '.oauth_token');
      fs.writeFileSync(tokenPath, 'sk-ant-oat01-alpha\n');
      const later = new Date(Date.now() + 5_000);
      fs.utimesSync(tokenPath, later, later);
      expect(resolveClaudeSetupToken(home)).toBe('sk-ant-oat01-alpha');
      expect(readClaudeAccountEmail(home)).toBe('alpha@example.com');
    });

    it('seeding skips a .claude.json that exists but is mid-write unparseable (review SHOULD-3)', () => {
      const home = makeHome();
      const cfg = path.join(home, '.claude.json');
      fs.writeFileSync(cfg, '{"numStartups": 7,'); // truncated by a concurrent writer
      seedClaudeWorkerHomeIdentity(home, 'tech@prix.dev');
      // The corrupt doc must survive untouched — never overwritten by a minimal one.
      expect(fs.readFileSync(cfg, 'utf-8')).toBe('{"numStartups": 7,');
      // The nested location still seeded fine.
      expect(readClaudeAccountEmail(home)).toBe('tech@prix.dev');
    });
  });

  describe('writeClaudeWorkerOauthToken', () => {
    it('writes a valid token 0600 and refuses a malformed one', () => {
      const home = makeHome();
      const p = writeClaudeWorkerOauthToken(home, 'sk-ant-oat01-abc123');
      expect(fs.readFileSync(p, 'utf-8')).toBe('sk-ant-oat01-abc123');
      expect(fs.statSync(p).mode & 0o777).toBe(0o600);
      expect(() => writeClaudeWorkerOauthToken(home, 'not-a-token')).toThrow(/malformed/i);
    });
  });

  describe('readReservedCredential', () => {
    it('reads a stored key value and returns null for a missing bundle/key', async () => {
      await seedReservedStore('__claude__', { CLAUDE_CODE_OAUTH_TOKEN_acc1: 'sk-ant-oat01-acc1' });
      expect(readReservedCredential('__claude__', 'CLAUDE_CODE_OAUTH_TOKEN_acc1')).toBe('sk-ant-oat01-acc1');
      expect(readReservedCredential('__claude__', 'CLAUDE_CODE_OAUTH_TOKEN_missing')).toBeNull();
      expect(readReservedCredential('__nope__', 'X')).toBeNull();
    });
  });

  describe('provisionWorkerSlot (PHNX-3940 T6)', () => {
    it('materializes a durable claude slot: .oauth_token 0600 + seeded identity + slot record', async () => {
      await seedReservedStore('__claude__', { CLAUDE_CODE_OAUTH_TOKEN_acc1: 'sk-ant-oat01-acc1' });
      const account = nativeRow({
        id: 'acc1',
        agent: 'claude',
        identityLabel: 'work@getrush.ai',
        workerCredential: { bundle: '__claude__', key: 'CLAUDE_CODE_OAUTH_TOKEN_acc1', kind: 'setup-token', mintedAt: '2026-09-06T00:00:00Z' },
      });
      const slot = provisionWorkerSlot(account);
      expect(slot.authMode).toBe('durable');
      expect(slot.verdict).toBe('unverified');

      const dir = slotDir('claude', 'acc1');
      const tokenPath = path.join(dir, '.claude', '.oauth_token');
      homes.push(dir);
      expect(fs.readFileSync(tokenPath, 'utf-8')).toBe('sk-ant-oat01-acc1');
      expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
      expect(readClaudeAccountEmail(dir)).toBe('work@getrush.ai');
      expect(readSlots(readMeta()).acc1?.authMode).toBe('durable');
    });

    it('falls back to the legacy auth bundle for a claude row predating T1 (no workerCredential)', () => {
      writeAuthBundle({ [claudeAccountTokenKey('dev@getrush.ai')]: 'sk-ant-oat01-dev' });
      const account = nativeRow({ id: 'legacy1', agent: 'claude', identityLabel: 'dev@getrush.ai', identityKey: 'claude:account=b:org=o' });
      const slot = provisionWorkerSlot(account);
      homes.push(slotDir('claude', 'legacy1'));
      expect(slot.authMode).toBe('durable');
      expect(fs.readFileSync(path.join(slotDir('claude', 'legacy1'), '.claude', '.oauth_token'), 'utf-8')).toBe('sk-ant-oat01-dev');
    });

    it('records an api-key harness slot durable with no credential file', () => {
      const account = nativeRow({
        id: 'gk1',
        agent: 'grok',
        identityKey: 'grok:account=g',
        identityLabel: 'z@example.com',
        workerCredential: { bundle: '__grok__', key: 'XAI_API_KEY_gk1', kind: 'api-key', mintedAt: '2026-09-06T00:00:00Z' },
      });
      const slot = provisionWorkerSlot(account);
      homes.push(slotDir('grok', 'gk1'));
      expect(slot.authMode).toBe('durable');
      // No .oauth_token is written — the key is injected at spawn (T5).
      expect(fs.existsSync(path.join(slotDir('grok', 'gk1'), '.claude', '.oauth_token'))).toBe(false);
      expect(readSlots(readMeta()).gk1?.authMode).toBe('durable');
    });

    it('records a per-device harness slot per-device with no push', () => {
      const account = nativeRow({ id: 'km1', agent: 'kimi', identityKey: 'kimi:user=k', identityLabel: undefined });
      const slot = provisionWorkerSlot(account);
      homes.push(slotDir('kimi', 'km1'));
      expect(slot.authMode).toBe('per-device');
      expect(slot.verdict).toBe('unconfigured');
    });

    it('fails loud when a durable claude account has no resolvable token', () => {
      const account = nativeRow({
        id: 'acc2',
        agent: 'claude',
        identityLabel: 'missing@getrush.ai',
        workerCredential: { bundle: '__claude__', key: 'CLAUDE_CODE_OAUTH_TOKEN_acc2', kind: 'setup-token', mintedAt: '2026-09-06T00:00:00Z' },
      });
      expect(() => provisionWorkerSlot(account)).toThrow(/No durable Claude setup-token/);
      homes.push(slotDir('claude', 'acc2'));
    });
  });
});
