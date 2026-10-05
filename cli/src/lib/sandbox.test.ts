import { describe, it, expect } from 'vitest';
import { buildSpawnEnv, getJobHomePath, hostHasGhAuth, resolveHostGhConfigDir, assertSandboxForwardsHostGhAuth, prepareJobHome } from './sandbox.js';
import { getUserAgentsDir, getRoutinesDir } from './state.js';
import { getVersionHomePath } from './installations/versions.js';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

describe('buildSpawnEnv', () => {
  it('sets HOME to the overlay and AGENTS_USER_DIR to the real user agents dir', () => {
    const overlayHome = path.join(os.tmpdir(), 'test-overlay-home');
    const env = buildSpawnEnv(overlayHome);

    expect(env.HOME).toBe(overlayHome);
    expect(env.AGENTS_USER_DIR).toBe(getUserAgentsDir());
  });

  it('preserves other allowlisted env vars', () => {
    if (process.env.PATH) {
      const env = buildSpawnEnv('/tmp/overlay');
      expect(env.PATH).toBe(process.env.PATH);
    }
  });

  it('allows extra env overrides', () => {
    const env = buildSpawnEnv('/tmp/overlay', { FOO: 'bar' });
    expect(env.FOO).toBe('bar');
  });

  it('does not forward CLAUDE_CODE_OAUTH_TOKEN from the parent process', () => {
    const prev = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-test-token';
    try {
      const env = buildSpawnEnv('/tmp/overlay');
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = prev;
    }
  });

  it('pins GH_CONFIG_DIR at the host gh config when present (RUSH-2860)', () => {
    const hostConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-host-cfg-'));
    const ghDir = path.join(hostConfig, 'gh');
    fs.mkdirSync(ghDir, { recursive: true });
    fs.writeFileSync(path.join(ghDir, 'hosts.yml'), 'github.com:\n    oauth_token: gho_test\n', { mode: 0o600 });
    const prev = process.env.GH_CONFIG_DIR;
    process.env.GH_CONFIG_DIR = ghDir;
    try {
      const env = buildSpawnEnv(path.join(os.tmpdir(), 'overlay-gh'));
      expect(env.GH_CONFIG_DIR).toBe(ghDir);
      expect(hostHasGhAuth()).toBe(true);
      expect(resolveHostGhConfigDir()).toBe(ghDir);
    } finally {
      if (prev === undefined) delete process.env.GH_CONFIG_DIR;
      else process.env.GH_CONFIG_DIR = prev;
      fs.rmSync(hostConfig, { recursive: true, force: true });
    }
  });

  it('forwards GH_TOKEN from the parent when set (RUSH-2860)', () => {
    const prev = process.env.GH_TOKEN;
    process.env.GH_TOKEN = 'gho_forward_me';
    try {
      const env = buildSpawnEnv('/tmp/overlay-token');
      expect(env.GH_TOKEN).toBe('gho_forward_me');
    } finally {
      if (prev === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = prev;
    }
  });
});

describe('assertSandboxForwardsHostGhAuth (RUSH-2860 — fail loud, never hollow ok)', () => {
  it('throws when the host holds gh auth but the spawn env would hide it', () => {
    const hostConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-assert-host-'));
    const ghDir = path.join(hostConfig, 'gh');
    fs.mkdirSync(ghDir, { recursive: true });
    fs.writeFileSync(path.join(ghDir, 'hosts.yml'), 'github.com:\n    oauth_token: gho_test\n', { mode: 0o600 });
    const prev = process.env.GH_CONFIG_DIR;
    process.env.GH_CONFIG_DIR = ghDir;
    try {
      expect(() => assertSandboxForwardsHostGhAuth({ HOME: path.join(hostConfig, 'empty-overlay') })).toThrow(
        /hide this host's GitHub auth|RUSH-2860/,
      );
    } finally {
      if (prev === undefined) delete process.env.GH_CONFIG_DIR;
      else process.env.GH_CONFIG_DIR = prev;
      fs.rmSync(hostConfig, { recursive: true, force: true });
    }
  });

  it('passes when buildSpawnEnv forwarded the host config', () => {
    const hostConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-assert-ok-'));
    const ghDir = path.join(hostConfig, 'gh');
    fs.mkdirSync(ghDir, { recursive: true });
    fs.writeFileSync(path.join(ghDir, 'hosts.yml'), 'github.com:\n    oauth_token: gho_test\n', { mode: 0o600 });
    const prev = process.env.GH_CONFIG_DIR;
    process.env.GH_CONFIG_DIR = ghDir;
    try {
      const env = buildSpawnEnv(path.join(hostConfig, 'overlay'));
      expect(() => assertSandboxForwardsHostGhAuth(env)).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.GH_CONFIG_DIR;
      else process.env.GH_CONFIG_DIR = prev;
      fs.rmSync(hostConfig, { recursive: true, force: true });
    }
  });

  it('is a no-op when the host has no gh auth (jobs that do not need GitHub still run)', () => {
    const prevDir = process.env.GH_CONFIG_DIR;
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const prevTok = process.env.GH_TOKEN;
    const prevGht = process.env.GITHUB_TOKEN;
    const prevEnt = process.env.GH_ENTERPRISE_TOKEN;
    const emptyConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-empty-xdg-'));
    process.env.XDG_CONFIG_HOME = emptyConfig;
    process.env.GH_CONFIG_DIR = path.join(emptyConfig, 'missing-gh');
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_ENTERPRISE_TOKEN;
    try {
      expect(hostHasGhAuth()).toBe(false);
      expect(() => assertSandboxForwardsHostGhAuth({ HOME: '/tmp/overlay' })).not.toThrow();
    } finally {
      if (prevDir === undefined) delete process.env.GH_CONFIG_DIR;
      else process.env.GH_CONFIG_DIR = prevDir;
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
      if (prevTok === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = prevTok;
      if (prevGht === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prevGht;
      if (prevEnt === undefined) delete process.env.GH_ENTERPRISE_TOKEN;
      else process.env.GH_ENTERPRISE_TOKEN = prevEnt;
      fs.rmSync(emptyConfig, { recursive: true, force: true });
    }
  });
});

describe('getJobHomePath — routine-name path containment (C4)', () => {
  const routinesDir = path.resolve(getRoutinesDir());

  it('returns a contained overlay path for a normal job name', () => {
    const p = getJobHomePath('daily-standup');
    expect(p).toBe(path.join(routinesDir, 'daily-standup', 'home'));
    expect(p.startsWith(routinesDir + path.sep)).toBe(true);
  });

  it('allows dot-prefixed names', () => {
    expect(() => getJobHomePath('.hidden-job')).not.toThrow();
  });

  it('rejects parent-traversal names so rmSync cannot escape the routines dir', () => {
    expect(() => getJobHomePath('../../../../..')).toThrow();
    expect(() => getJobHomePath('..')).toThrow();
  });

  it('rejects names containing path separators', () => {
    expect(() => getJobHomePath('a/b')).toThrow();
    expect(() => getJobHomePath('a\\b')).toThrow();
  });

  it('rejects names with null bytes', () => {
    expect(() => getJobHomePath('evil\x00')).toThrow();
  });
});

describe('prepareJobHome — routine agent auth', () => {
  it('links the selected Codex auth without importing hook-bearing settings', () => {
    const version = `99.0.0-phnx3406-${process.pid}`;
    const name = `phnx3406-${process.pid}`;
    const versionHome = getVersionHomePath('codex', version);
    const configDir = path.join(versionHome, '.codex');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'auth.json'), '{"auth_mode":"chatgpt"}');

    try {
      const overlay = prepareJobHome({ name, agent: 'codex', mode: 'auto', enabled: true }, version);
      expect(fs.realpathSync(path.join(overlay, '.codex', 'auth.json')))
        .toBe(fs.realpathSync(path.join(configDir, 'auth.json')));
    } finally {
      fs.rmSync(versionHome, { recursive: true, force: true });
      fs.rmSync(path.dirname(getJobHomePath(name)), { recursive: true, force: true });
    }
  });
});
