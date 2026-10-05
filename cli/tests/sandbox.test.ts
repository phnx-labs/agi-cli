import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync, lstatSync } from 'fs';
import { join, relative } from 'path';
import { tmpdir, homedir } from 'os';

const { TEST_REAL_HOME } = vi.hoisted(() => {
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const { realpathSync } = require('node:fs');
  // Canonicalize the tmp base so the mocked homedir() matches realpathSync() inside
  // symlinkAllowedDirs: Windows tmpdir() is an 8.3 short name and macOS /var symlinks to
  // /private/var, which would make the HOME-containment guard skip the link.
  return { TEST_REAL_HOME: join(realpathSync(tmpdir()), 'agents-cli-sandbox-real-home') };
});

// vi.importActual / importOriginal are vitest-only; pull the real `os` via
// `node:os` so this mock works under Bun's native test runner too.
vi.mock('os', () => {
  const actual = require('node:os') as typeof import('os');
  return {
    ...actual,
    default: actual,
    homedir: () => TEST_REAL_HOME,
  };
});

import {
  prepareJobHome,
  cleanJobHome,
  generateClaudeConfig,
  generateCodexConfig,
  symlinkAllowedDirs,
  buildSpawnEnv,
} from '../src/lib/sandbox.js';
import type { JobConfig } from '../src/lib/jobs.js';

const TEST_DIR = join(tmpdir(), 'agents-cli-sandbox-test');

function makeConfig(overrides: Partial<JobConfig> = {}): JobConfig {
  return {
    name: 'test-job',
    schedule: '0 9 * * *',
    agent: 'claude',
    mode: 'plan',
    effort: 'default',
    timeout: '30m',
    enabled: true,
    prompt: 'do something',
    ...overrides,
  };
}

describe('generateClaudeConfig', () => {
  const overlayHome = join(TEST_DIR, 'claude-overlay');

  beforeEach(() => {
    mkdirSync(overlayHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('creates .claude/settings.json', () => {
    const config = makeConfig({ allow: { tools: ['web_search'] } });
    generateClaudeConfig(overlayHome, config);

    const settingsPath = join(overlayHome, '.claude', 'settings.json');
    expect(existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(settings.permissions).toBeDefined();
    expect(settings.permissions.deny).toEqual([]);
  });

  it('grants safe tool wildcards for non-filesystem tools', () => {
    const config = makeConfig({
      allow: { tools: ['web_search', 'web_fetch'] },
    });
    generateClaudeConfig(overlayHome, config);

    const settings = JSON.parse(
      readFileSync(join(overlayHome, '.claude', 'settings.json'), 'utf-8')
    );
    const perms = settings.permissions.allow;
    expect(perms).toContain('WebSearch(*)');
    expect(perms).toContain('WebFetch(*)');
  });

  it('throws on bare "bash" — requires scoped pattern', () => {
    const config = makeConfig({ allow: { tools: ['bash'] } });
    expect(() => generateClaudeConfig(overlayHome, config)).toThrow(/scoped patterns/);
  });

  it('throws on wildcard patterns like Bash(*)', () => {
    const config = makeConfig({ allow: { tools: ['Bash(*)'] } });
    expect(() => generateClaudeConfig(overlayHome, config)).toThrow(/scoped patterns/);
  });

  it('passes through scoped bash patterns', () => {
    const config = makeConfig({ allow: { tools: ['Bash(git *)'] } });
    generateClaudeConfig(overlayHome, config);

    const settings = JSON.parse(
      readFileSync(join(overlayHome, '.claude', 'settings.json'), 'utf-8')
    );
    expect(settings.permissions.allow).toContain('Bash(git *)');
  });

  it('scopes dir-based tools to allow.dirs instead of wildcarding', () => {
    const config = makeConfig({
      mode: 'edit',
      allow: { tools: ['read', 'write', 'edit', 'glob', 'grep'], dirs: ['/tmp/test-dir'] },
    });
    generateClaudeConfig(overlayHome, config);

    const settings = JSON.parse(
      readFileSync(join(overlayHome, '.claude', 'settings.json'), 'utf-8')
    );
    const perms = settings.permissions.allow;

    // Scoped to dir, not wildcarded
    expect(perms).toContain('Read(/tmp/test-dir/**)');
    expect(perms).toContain('Write(/tmp/test-dir/**)');
    expect(perms).toContain('Edit(/tmp/test-dir/**)');
    expect(perms).toContain('Glob(/tmp/test-dir/**)');
    expect(perms).toContain('Grep(/tmp/test-dir/**)');

    // No wildcards
    expect(perms).not.toContain('Read(*)');
    expect(perms).not.toContain('Write(*)');
    expect(perms).not.toContain('Edit(*)');
    expect(perms).not.toContain('Bash(*)');
  });

  it('adds Read for allowed dirs in plan mode, no Write/Edit', () => {
    const config = makeConfig({
      mode: 'plan',
      allow: { dirs: ['/tmp/test-dir'] },
    });
    generateClaudeConfig(overlayHome, config);

    const settings = JSON.parse(
      readFileSync(join(overlayHome, '.claude', 'settings.json'), 'utf-8')
    );
    const perms = settings.permissions.allow;
    expect(perms).toContain('Read(/tmp/test-dir/**)');
    expect(perms).not.toContain('Write(/tmp/test-dir/**)');
    expect(perms).not.toContain('Edit(/tmp/test-dir/**)');
  });

  it('adds Read+Write+Edit for allowed dirs in edit mode', () => {
    const config = makeConfig({
      mode: 'edit',
      allow: { dirs: ['/tmp/test-dir'] },
    });
    generateClaudeConfig(overlayHome, config);

    const settings = JSON.parse(
      readFileSync(join(overlayHome, '.claude', 'settings.json'), 'utf-8')
    );
    const perms = settings.permissions.allow;
    expect(perms).toContain('Read(/tmp/test-dir/**)');
    expect(perms).toContain('Write(/tmp/test-dir/**)');
    expect(perms).toContain('Edit(/tmp/test-dir/**)');
  });

  it('produces empty allow list with no tools or dirs', () => {
    const config = makeConfig();
    generateClaudeConfig(overlayHome, config);

    const settings = JSON.parse(
      readFileSync(join(overlayHome, '.claude', 'settings.json'), 'utf-8')
    );
    expect(settings.permissions.allow).toEqual([]);
  });
});

describe('generateCodexConfig', () => {
  const overlayHome = join(TEST_DIR, 'codex-overlay');

  beforeEach(() => {
    mkdirSync(overlayHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('creates .codex/config.toml', () => {
    const config = makeConfig({ agent: 'codex' });
    generateCodexConfig(overlayHome, config);

    const tomlPath = join(overlayHome, '.codex', 'config.toml');
    expect(existsSync(tomlPath)).toBe(true);
  });

  it('sets suggest mode for plan', () => {
    const config = makeConfig({ agent: 'codex', mode: 'plan' });
    generateCodexConfig(overlayHome, config);

    const content = readFileSync(join(overlayHome, '.codex', 'config.toml'), 'utf-8');
    expect(content).toContain('approval_mode = "suggest"');
  });

  it('sets full-auto mode for edit', () => {
    const config = makeConfig({ agent: 'codex', mode: 'edit' });
    generateCodexConfig(overlayHome, config);

    const content = readFileSync(join(overlayHome, '.codex', 'config.toml'), 'utf-8');
    expect(content).toContain('approval_mode = "full-auto"');
  });

  it('includes model when specified in config', () => {
    const config = makeConfig({
      agent: 'codex',
      config: { model: 'gpt-5.2-codex' },
    });
    generateCodexConfig(overlayHome, config);

    const content = readFileSync(join(overlayHome, '.codex', 'config.toml'), 'utf-8');
    expect(content).toContain('model = "gpt-5.2-codex"');
  });

  it('includes extra config keys', () => {
    const config = makeConfig({
      agent: 'codex',
      config: { model: 'gpt-5.2-codex', sandbox: true, max_tokens: 4096 },
    });
    generateCodexConfig(overlayHome, config);

    const content = readFileSync(join(overlayHome, '.codex', 'config.toml'), 'utf-8');
    expect(content).toContain('sandbox = true');
    expect(content).toContain('max_tokens = 4096');
    expect(content.match(/model/g)?.length).toBe(1);
  });
});

// generateGeminiConfig was removed with RUSH-2202: gemini is hard-deprecated
// and a gemini routine is now rejected in runner.ts before it ever reaches
// prepareJobHome, so there is no sandbox-config writer left to test here.

describe('symlinkAllowedDirs', () => {
  const overlayHome = join(TEST_DIR, 'symlink-overlay');
  // Must be inside homedir() so symlinkAllowedDirs treats it as HOME-relative.
  const realDir = join(homedir(), '.agents-cli-test-symlink-target');

  beforeEach(() => {
    mkdirSync(overlayHome, { recursive: true });
    mkdirSync(realDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    rmSync(TEST_REAL_HOME, { recursive: true, force: true });
  });

  it('creates symlink for HOME-relative dirs', () => {
    symlinkAllowedDirs(overlayHome, [realDir]);

    const expectedLink = join(overlayHome, relative(homedir(), realDir));
    expect(existsSync(expectedLink)).toBe(true);
    // Node reports a Windows junction as a symbolic link (a reparse point maps to
    // S_IFLNK), so isSymbolicLink() holds on both POSIX (symlink) and Windows
    // (junction).
    expect(lstatSync(expectedLink).isSymbolicLink()).toBe(true);
  });

  it('skips dirs outside HOME', () => {
    symlinkAllowedDirs(overlayHome, ['/var/log/something']);

    const entries = require('fs').readdirSync(overlayHome);
    expect(entries.length).toBe(0);
  });

  it('creates parent dirs for nested paths', () => {
    const nestedDir = join(homedir(), '.agents-cli-test-symlink-target', 'nested');
    mkdirSync(nestedDir, { recursive: true });

    symlinkAllowedDirs(overlayHome, [nestedDir]);

    const expectedLink = join(overlayHome, relative(homedir(), nestedDir));
    expect(existsSync(expectedLink)).toBe(true);
  });
});

describe('buildSpawnEnv', () => {
  it('sets HOME to overlay path', () => {
    const env = buildSpawnEnv('/fake/overlay');
    expect(env.HOME).toBe('/fake/overlay');
  });

  it('includes PATH from process.env', () => {
    const env = buildSpawnEnv('/fake/overlay');
    expect(env.PATH).toBe(process.env.PATH);
  });

  it('does not include sensitive env vars', () => {
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test-secret';
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret';
    process.env.OPENAI_API_KEY = 'openai-secret';

    const env = buildSpawnEnv('/fake/overlay');

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();

    if (original) {
      process.env.ANTHROPIC_API_KEY = original;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  // The daemon holds no Claude token; the sandbox strips CLAUDE_CODE_OAUTH_TOKEN
  // from the ambient env — routines authenticate via the per-account
  // CLAUDE_CONFIG_DIR login, not an injected token.
  it('does not forward CLAUDE_CODE_OAUTH_TOKEN', () => {
    const original = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-test';
    try {
      const env = buildSpawnEnv('/fake/overlay');
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    } finally {
      if (original) process.env.CLAUDE_CODE_OAUTH_TOKEN = original;
      else delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
  });

  it('does not include SSH_AUTH_SOCK', () => {
    const original = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = '/tmp/ssh-agent.sock';

    const env = buildSpawnEnv('/fake/overlay');
    expect(env.SSH_AUTH_SOCK).toBeUndefined();

    if (original) {
      process.env.SSH_AUTH_SOCK = original;
    } else {
      delete process.env.SSH_AUTH_SOCK;
    }
  });

  it('merges extraEnv overrides', () => {
    const env = buildSpawnEnv('/fake/overlay', { CUSTOM_VAR: 'hello' });
    expect(env.CUSTOM_VAR).toBe('hello');
  });
});

describe('cleanJobHome', () => {
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('does nothing if overlay does not exist', () => {
    expect(() => cleanJobHome('nonexistent-job-xyz')).not.toThrow();
  });
});
