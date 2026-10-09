import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { buildRoutineSpawnEnv, claudeVersionIsAuthenticated } from './runner.js';
import { claudeAccountTokenKey } from '../claude-account-token.js';
import { keychainRef, secretsKeychainItem, writeBundleWithItemsSync } from '../secrets-client.js';
import { useFreshSecretsHome } from '../../../tests/secrets-standalone.js';
import { getBinaryPath, getVersionHomePath } from '../installations/versions.js';
import { setConfiguredDeviceRole } from '../device-config.js';

let versionDirs: string[] = [];
let prevClaudeToken: string | undefined;
let prevMachineId: string | undefined;

beforeEach(() => {
  versionDirs = [];
  prevClaudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  prevMachineId = process.env.AGENTS_SYNC_MACHINE_ID;
  process.env.AGENTS_SYNC_MACHINE_ID = 'runner-setup-token-worker-fixture';
});

afterEach(() => {
  if (prevClaudeToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevClaudeToken;
  if (prevMachineId === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
  else process.env.AGENTS_SYNC_MACHINE_ID = prevMachineId;
  for (const dir of versionDirs) fs.rmSync(dir, { recursive: true, force: true });
});

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
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-inherited-ambient';

    const env = buildRoutineSpawnEnv({ ...process.env } as Record<string, string>, 'claude', version);

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-alpha');
  });

  it('STRIPS an inherited ambient token when no per-account setup-token is provisioned', () => {
    const version = `rush-setup-strip-${process.pid}`;
    makeVersionHome(version, 'beta@example.com');
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-inherited-ambient';

    const env = buildRoutineSpawnEnv({ ...process.env } as Record<string, string>, 'claude', version);

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  describe('on a personal device', () => {
    it('does NOT inject a provisioned setup-token — defers to the per-version login', () => {
      const device = `rush-2395-personal-defer-${process.pid}`;
      process.env.AGENTS_SYNC_MACHINE_ID = device;
      setConfiguredDeviceRole(device, 'personal');
      const version = `rush-2395-personal-defer-v-${process.pid}`;
      const email = 'alpha@example.com';
      makeVersionHome(version, email);
      writeAuthBundle({ [claudeAccountTokenKey(email)]: 'sk-ant-oat01-alpha' });

      const env = buildRoutineSpawnEnv({ ...process.env } as Record<string, string>, 'claude', version);

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
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-alpha';

      const env = buildRoutineSpawnEnv({ ...process.env } as Record<string, string>, 'claude', version);

      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });
  });

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

function installAuthStatusBinary(version: string): void {
  const binary = getBinaryPath('claude', version);
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(
    binary,
    '#!/bin/sh\nif [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then echo \'{"loggedIn":true}\'; else echo \'{"loggedIn":false}\'; fi\n',
    { mode: 0o755 },
  );
}

describe('claudeVersionIsAuthenticated on a worker', () => {
  useFreshSecretsHome();

  it('counts the provisioned setup-token the routine launch injects as signed in', () => {
    const version = `routine-auth-worker-token-${process.pid}`;
    const email = 'alpha@example.com';
    makeVersionHome(version, email);
    installAuthStatusBinary(version);
    writeAuthBundle({ [claudeAccountTokenKey(email)]: 'sk-ant-oat01-alpha' });

    expect(claudeVersionIsAuthenticated(version)).toBe(true);
  });

  it('on a desktop device, ignores the setup-token and checks the native login', () => {
    const device = `routine-auth-desktop-${process.pid}`;
    process.env.AGENTS_SYNC_MACHINE_ID = device;
    setConfiguredDeviceRole(device, 'desktop');
    const version = `routine-auth-desktop-v-${process.pid}`;
    const email = 'alpha@example.com';
    makeVersionHome(version, email);
    installAuthStatusBinary(version);
    writeAuthBundle({ [claudeAccountTokenKey(email)]: 'sk-ant-oat01-alpha' });
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

    expect(claudeVersionIsAuthenticated(version)).toBe(false);
  });

  it('reports signed out when no setup-token is provisioned for the account', () => {
    const version = `routine-auth-worker-none-${process.pid}`;
    makeVersionHome(version, 'beta@example.com');
    installAuthStatusBinary(version);
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

    expect(claudeVersionIsAuthenticated(version)).toBe(false);
  });
});
