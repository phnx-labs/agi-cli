import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { buildRoutineSpawnEnv } from './runner.js';
import { claudeAccountTokenKey } from '../claude-account-token.js';
import { keychainRef, secretsKeychainItem, writeBundleWithItemsSync } from '../secrets-client.js';
import { useFreshSecretsHome } from '../../../tests/secrets-standalone.js';
import { getVersionHomePath } from '../installations/versions.js';
import { setConfiguredDeviceRole } from '../device-config.js';

// A routine authenticates via a per-account non-rotating `claude setup-token` (the cure for the
// refresh-token revocation storm), but buildRoutineSpawnEnv deleted CLAUDE_CODE_OAUTH_TOKEN
// unconditionally. These pin the rule: KEEP a per-account token, STRIP an ambient one.
let versionDirs: string[] = [];
let prevClaudeToken: string | undefined;
let prevMachineId: string | undefined;

beforeEach(() => {
  versionDirs = [];
  prevClaudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  prevMachineId = process.env.AGENTS_SYNC_MACHINE_ID;
  // These cases assert the worker routine credential rule. Pin the self device id to a role-less
  // name so selfConfiguredDeviceRole() is undefined; on a personal machine (e.g. zion) a routine
  // defers to the login (RUSH-2395), flipping them.
  process.env.AGENTS_SYNC_MACHINE_ID = 'runner-setup-token-worker-fixture';
});

afterEach(() => {
  if (prevClaudeToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevClaudeToken;
  if (prevMachineId === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
  else process.env.AGENTS_SYNC_MACHINE_ID = prevMachineId;
  for (const dir of versionDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Create a real version home for `version` signed into `email` (writes .claude.json). */
function makeVersionHome(version: string, email: string): void {
  const versionHome = getVersionHomePath('claude', version);
  versionDirs.push(path.dirname(versionHome));
  const configDir = path.join(versionHome, '.claude');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email } }),
  );
}

/** Seed the reserved file-backed `auth` bundle through the standalone `secrets` CLI, in the shape
 * `seedReservedAuthToken` writes (file backend, never policy, one keychain ref + raw item per
 * account key). */
function writeAuthBundle(values: Record<string, string>): void {
  const keys = Object.keys(values);
  writeBundleWithItemsSync(
    {
      name: 'auth',
      backend: 'file',
      policy: 'never',
      vars: Object.fromEntries(keys.map((key) => [key, keychainRef(key)])),
      meta: Object.fromEntries(keys.map((key) => [key, { type: 'token' as const }])),
    },
    new Map(keys.map((key) => [secretsKeychainItem('auth', key), values[key]!])),
  );
}

describe('buildRoutineSpawnEnv — CLAUDE_CODE_OAUTH_TOKEN handling', () => {
  useFreshSecretsHome();

  it('KEEPS a per-account setup-token even when an ambient token is inherited', () => {
    const version = `rush-setup-keep-${process.pid}`;
    const email = 'alpha@example.com';
    makeVersionHome(version, email);
    writeAuthBundle({ [claudeAccountTokenKey(email)]: 'sk-ant-oat01-alpha' });
    // A stale/rotating value inherited from the daemon env must NOT win.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-inherited-ambient';

    const env = buildRoutineSpawnEnv({ ...process.env } as Record<string, string>, 'claude', version);

    // The routine runs on the non-rotating per-account setup-token, not the ambient one.
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-alpha');
  });

  it('STRIPS an inherited ambient token when no per-account setup-token is provisioned', () => {
    const version = `rush-setup-strip-${process.pid}`;
    // Version home is signed in, but the `auth` bundle has no token for this account.
    makeVersionHome(version, 'beta@example.com');
    // Inherited shared/rotating token — the RUSH-1822 fleet-wide-logout path.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-inherited-ambient';

    const env = buildRoutineSpawnEnv({ ...process.env } as Record<string, string>, 'claude', version);

    // No provisioned setup-token → the ambient value is dropped, routine uses the
    // version home's own login instead.
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  // On a personal device routines defer to the per-version login like an interactive run; the
  // setup-token is worker-only (RUSH-2395). Mirrors the adapter matrix in
  // harness/adapters/claude.test.ts on the routines path.
  describe('on a personal device', () => {
    it('does NOT inject a provisioned setup-token — defers to the per-version login', () => {
      const device = `rush-2395-personal-defer-${process.pid}`;
      process.env.AGENTS_SYNC_MACHINE_ID = device;
      setConfiguredDeviceRole(device, 'personal');
      const version = `rush-2395-personal-defer-v-${process.pid}`;
      const email = 'alpha@example.com';
      makeVersionHome(version, email);
      // A per-account setup-token IS provisioned; on a worker this would be injected.
      writeAuthBundle({ [claudeAccountTokenKey(email)]: 'sk-ant-oat01-alpha' });

      const env = buildRoutineSpawnEnv({ ...process.env } as Record<string, string>, 'claude', version);

      // Personal box → the routine runs on the login, not the setup-token.
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });

    it('strips an inherited copy of its OWN setup-token so the login wins', () => {
      const device = `rush-2395-personal-strip-${process.pid}`;
      process.env.AGENTS_SYNC_MACHINE_ID = device;
      setConfiguredDeviceRole(device, 'personal');
      const version = `rush-2395-personal-strip-v-${process.pid}`;
      const email = 'alpha@example.com';
      makeVersionHome(version, email);
      writeAuthBundle({ [claudeAccountTokenKey(email)]: 'sk-ant-oat01-alpha' });
      // A leaked copy of this account's own token inherited from a headless parent.
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-alpha';

      const env = buildRoutineSpawnEnv({ ...process.env } as Record<string, string>, 'claude', version);

      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });
  });

  // A DESKTOP device is in the same headed bucket as personal (isHeadedDeviceRole):
  // a headed always-on box holds a real per-version login, so a routine there must
  // ALSO defer to it, never the worker setup-token (PHNX-3392).
  describe('on a desktop device', () => {
    it('does NOT inject a provisioned setup-token — defers to the per-version login', () => {
      const device = `phnx-3392-desktop-defer-${process.pid}`;
      process.env.AGENTS_SYNC_MACHINE_ID = device;
      setConfiguredDeviceRole(device, 'desktop');
      const version = `phnx-3392-desktop-defer-v-${process.pid}`;
      const email = 'alpha@example.com';
      makeVersionHome(version, email);
      writeAuthBundle({ [claudeAccountTokenKey(email)]: 'sk-ant-oat01-alpha' });

      const env = buildRoutineSpawnEnv({ ...process.env } as Record<string, string>, 'claude', version);

      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });
  });
});
