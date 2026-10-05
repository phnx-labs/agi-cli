
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as yaml from 'yaml';
import * as TOML from 'smol-toml';
import {
  parsePermissionSet,
  discoverPermissionsFromRepo,
  convertToClaudeFormat,
  convertToOpenCodeFormat,
  convertToCursorFormat,
  convertToCopilotFormat,
  convertToCodexFormat,
  codexDefaultWritableRoots,
  convertToAntigravityFormat,
  convertToGrokFormat,
  claudeToCanonical,
  openCodeToCanonical,
  codexToCanonical,
  applyPermissionsToVersion,
  convertDenyToCodexRules,
  CODEX_RULES_FILENAME,
} from '../src/lib/permissions.js';
import type { PermissionSet, ClaudePermissions, OpenCodePermissions, CodexPermissions } from '../src/lib/types.js';

const TEST_DIR = join(tmpdir(), 'agents-cli-permissions-test');

describe('parsePermissionSet', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('parses a valid YAML permission file', () => {
    const filePath = join(TEST_DIR, 'test.yml');
    writeFileSync(filePath, yaml.stringify({
      name: 'test-perms',
      description: 'Test permissions',
      allow: ['Bash(git *)', 'Read(**)'],
      deny: ['Bash(rm -rf *)'],
    }));

    const result = parsePermissionSet(filePath);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('test-perms');
    expect(result!.description).toBe('Test permissions');
    expect(result!.allow).toEqual(['Bash(git *)', 'Read(**)']);
    expect(result!.deny).toEqual(['Bash(rm -rf *)']);
  });

  it('returns null for non-existent file', () => {
    const result = parsePermissionSet(join(TEST_DIR, 'nonexistent.yml'));
    expect(result).toBeNull();
  });

  it('returns null for invalid YAML', () => {
    const filePath = join(TEST_DIR, 'invalid.yml');
    writeFileSync(filePath, '{{{{invalid yaml');

    const result = parsePermissionSet(filePath);
    expect(result).toBeNull();
  });

  it('uses filename as name if not specified', () => {
    const filePath = join(TEST_DIR, 'my-perms.yml');
    writeFileSync(filePath, yaml.stringify({
      allow: ['Bash(git *)'],
    }));

    const result = parsePermissionSet(filePath);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('my-perms');
  });

  it('handles empty allow/deny arrays', () => {
    const filePath = join(TEST_DIR, 'empty.yml');
    writeFileSync(filePath, yaml.stringify({
      name: 'empty',
    }));

    const result = parsePermissionSet(filePath);
    expect(result).not.toBeNull();
    expect(result!.allow).toEqual([]);
    expect(result!.deny).toEqual([]);
  });
});

describe('discoverPermissionsFromRepo', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('discovers permissions in permissions/ directory', () => {
    const permsDir = join(TEST_DIR, 'permissions');
    mkdirSync(permsDir, { recursive: true });
    writeFileSync(join(permsDir, 'dev.yml'), yaml.stringify({
      name: 'dev',
      allow: ['Bash(git *)'],
    }));

    const results = discoverPermissionsFromRepo(TEST_DIR);
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('dev');
  });

  it('discovers permissions in agent-permissions/ directory', () => {
    const permsDir = join(TEST_DIR, 'agent-permissions');
    mkdirSync(permsDir, { recursive: true });
    writeFileSync(join(permsDir, 'prod.yaml'), yaml.stringify({
      name: 'prod',
      allow: ['Read(**)'],
    }));

    const results = discoverPermissionsFromRepo(TEST_DIR);
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('prod');
  });

  it('discovers permissions in root directory', () => {
    writeFileSync(join(TEST_DIR, 'root-perms.yml'), yaml.stringify({
      name: 'root-perms',
      allow: ['Bash(npm *)'],
    }));

    const results = discoverPermissionsFromRepo(TEST_DIR);
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('root-perms');
  });

  it('returns empty array for empty directory', () => {
    const results = discoverPermissionsFromRepo(TEST_DIR);
    expect(results).toEqual([]);
  });

  it('ignores non-YAML files', () => {
    writeFileSync(join(TEST_DIR, 'readme.md'), '# Readme');
    writeFileSync(join(TEST_DIR, 'config.json'), '{}');

    const results = discoverPermissionsFromRepo(TEST_DIR);
    expect(results).toEqual([]);
  });
});

describe('convertToClaudeFormat', () => {
  it('converts canonical format to Claude format', () => {
    const set: PermissionSet = {
      name: 'test',
      allow: ['Bash(git *)', 'Read(**)', 'WebSearch(*)'],
      deny: ['Bash(rm -rf *)'],
    };

    const result = convertToClaudeFormat(set);
    expect(result.permissions.allow).toEqual(['Bash(git *)', 'Read(**)', 'WebSearch(*)']);
    expect(result.permissions.deny).toEqual(['Bash(rm -rf *)']);
  });

  it('handles empty deny array', () => {
    const set: PermissionSet = {
      name: 'test',
      allow: ['Bash(git *)'],
    };

    const result = convertToClaudeFormat(set);
    expect(result.permissions.allow).toEqual(['Bash(git *)']);
    expect(result.permissions.deny).toEqual([]);
  });

  it('rewrites Write(path) rules to Edit(path) and dedupes against Edit twins', () => {
    const set: PermissionSet = {
      name: 'test',
      allow: ['Write(~/.claude/**)', 'Edit(~/.claude/**)', 'Write(/tmp/*)', 'Write'],
      deny: ['Write(~/.ssh/**)', 'Edit(~/.ssh/**)'],
    };

    const result = convertToClaudeFormat(set);
    expect(result.permissions.allow).toEqual(['Edit(~/.claude/**)', 'Edit(/tmp/*)', 'Write']);
    expect(result.permissions.deny).toEqual(['Edit(~/.ssh/**)']);
  });
});

describe('convertToOpenCodeFormat', () => {
  it('converts Bash permissions to OpenCode format', () => {
    const set: PermissionSet = {
      name: 'test',
      allow: ['Bash(git *)', 'Bash(npm *)'],
      deny: ['Bash(rm *)'],
    };

    const result = convertToOpenCodeFormat(set);
    expect(result.permission.bash['git *']).toBe('allow');
    expect(result.permission.bash['npm *']).toBe('allow');
    expect(result.permission.bash['rm *']).toBe('deny');
  });

  it('ignores non-Bash permissions', () => {
    const set: PermissionSet = {
      name: 'test',
      allow: ['Read(**)', 'WebSearch(*)', 'Bash(git *)'],
    };

    const result = convertToOpenCodeFormat(set);
    expect(Object.keys(result.permission.bash)).toEqual(['git *']);
  });

  it('handles empty permissions', () => {
    const set: PermissionSet = {
      name: 'test',
      allow: [],
    };

    const result = convertToOpenCodeFormat(set);
    expect(result.permission.bash).toEqual({});
  });

  it('maps the bare blanket form "Bash" to an allow-all bash pattern', () => {
    const set: PermissionSet = {
      name: 'test',
      allow: ['Bash'],
    };

    const result = convertToOpenCodeFormat(set);
    expect(result.permission.bash['*']).toBe('allow');
  });
});

describe('convertToCodexFormat', () => {
  it('sets full-auto mode for broad bash permissions', () => {
    const set: PermissionSet = {
      name: 'test',
      allow: ['Bash(*)'],
    };

    const result = convertToCodexFormat(set);
    expect(result.approval_policy).toBe('never');
    expect(result.sandbox_mode).toBe('workspace-write');
  });

  it('treats the bare blanket form "Bash" as broad bash (auto-approve)', () => {
    const set: PermissionSet = {
      name: 'test',
      allow: ['Bash'],
    };

    const result = convertToCodexFormat(set);
    expect(result.approval_policy).toBe('never');
    expect(result.sandbox_mode).toBe('workspace-write');
  });

  it('sets on-request mode for limited permissions', () => {
    const set: PermissionSet = {
      name: 'test',
      allow: ['Bash(git *)'],
    };

    const result = convertToCodexFormat(set);
    expect(result.approval_policy).toBe('on-request');
    expect(result.sandbox_mode).toBe('workspace-write');
  });

  it('enables network access for web permissions', () => {
    const set: PermissionSet = {
      name: 'test',
      allow: ['WebSearch(*)', 'WebFetch(*)'],
    };

    const result = convertToCodexFormat(set);
    expect(result.sandbox_workspace_write?.network_access).toBe(true);
  });

  it('grants the baseline cache writable_roots even with no permissions', () => {
    const set: PermissionSet = {
      name: 'test',
      allow: [],
    };

    const result = convertToCodexFormat(set);
    expect(result.approval_policy).toBeUndefined();
    expect(result.sandbox_mode).toBeUndefined();
    expect(result.sandbox_workspace_write?.writable_roots).toEqual(codexDefaultWritableRoots());
  });
});

describe('claudeToCanonical', () => {
  it('converts Claude permissions back to canonical format', () => {
    const perms: ClaudePermissions = {
      permissions: {
        allow: ['Bash(git *)', 'Read(**)'],
        deny: ['Bash(rm *)'],
      },
    };

    const result = claudeToCanonical(perms);
    expect(result.name).toBe('exported');
    expect(result.allow).toEqual(['Bash(git *)', 'Read(**)']);
    expect(result.deny).toEqual(['Bash(rm *)']);
  });

  it('omits deny if empty', () => {
    const perms: ClaudePermissions = {
      permissions: {
        allow: ['Bash(git *)'],
        deny: [],
      },
    };

    const result = claudeToCanonical(perms);
    expect(result.deny).toBeUndefined();
  });
});

describe('openCodeToCanonical', () => {
  it('converts OpenCode permissions back to canonical format', () => {
    const perms: OpenCodePermissions = {
      permission: {
        bash: {
          'git *': 'allow',
          'npm *': 'allow',
          'rm *': 'deny',
        },
      },
    };

    const result = openCodeToCanonical(perms);
    expect(result.allow).toContain('Bash(git *)');
    expect(result.allow).toContain('Bash(npm *)');
    expect(result.deny).toContain('Bash(rm *)');
  });

  it('ignores ask permissions', () => {
    const perms: OpenCodePermissions = {
      permission: {
        bash: {
          'git *': 'allow',
          'mv *': 'ask',
        },
      },
    };

    const result = openCodeToCanonical(perms);
    expect(result.allow).toEqual(['Bash(git *)']);
    expect(result.deny).toBeUndefined();
  });
});

describe('codexToCanonical', () => {
  it('converts full access mode to broad permissions', () => {
    const perms: CodexPermissions = {
      approval_policy: 'never',
      sandbox_mode: 'danger-full-access',
    };

    const result = codexToCanonical(perms);
    expect(result.allow).toContain('Bash(*)');
    expect(result.allow).toContain('Read(**)');
    expect(result.allow).toContain('Write(**)');
    expect(result.allow).toContain('Edit(**)');
  });

  it('converts workspace-write to bash + read', () => {
    const perms: CodexPermissions = {
      sandbox_mode: 'workspace-write',
    };

    const result = codexToCanonical(perms);
    expect(result.allow).toContain('Bash(*)');
    expect(result.allow).toContain('Read(**)');
    expect(result.allow).not.toContain('Write(**)');
  });

  it('adds web permissions when network_access is true', () => {
    const perms: CodexPermissions = {
      sandbox_workspace_write: {
        network_access: true,
      },
    };

    const result = codexToCanonical(perms);
    expect(result.allow).toContain('WebSearch(*)');
    expect(result.allow).toContain('WebFetch(*)');
  });
});

describe('round-trip conversion', () => {
  it('Claude: canonical -> claude -> canonical preserves permissions', () => {
    const original: PermissionSet = {
      name: 'test',
      allow: ['Bash(git *)', 'Read(**)', 'WebSearch(*)'],
      deny: ['Bash(rm *)'],
    };

    const claude = convertToClaudeFormat(original);
    const canonical = claudeToCanonical(claude);

    expect(canonical.allow).toEqual(original.allow);
    expect(canonical.deny).toEqual(original.deny);
  });

  it('OpenCode: canonical -> opencode -> canonical preserves bash permissions', () => {
    const original: PermissionSet = {
      name: 'test',
      allow: ['Bash(git *)', 'Bash(npm *)'],
      deny: ['Bash(rm *)'],
    };

    const opencode = convertToOpenCodeFormat(original);
    const canonical = openCodeToCanonical(opencode);

    expect(canonical.allow).toEqual(original.allow);
    expect(canonical.deny).toEqual(original.deny);
  });
});

describe('applyClaudePermissions', () => {
  const testDir = join(TEST_DIR, 'apply-claude');

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('creates settings.json with permissions', async () => {
    const { applyClaudePermissions } = await import('../src/lib/permissions.js');

    const set: PermissionSet = {
      name: 'test',
      allow: ['Bash(git *)', 'Read(**)'],
      deny: ['Bash(rm *)'],
    };

    const claudeDir = join(testDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    const converted = convertToClaudeFormat(set);
    const settingsPath = join(claudeDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify(converted, null, 2));

    const written = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(written.permissions.allow).toEqual(['Bash(git *)', 'Read(**)']);
    expect(written.permissions.deny).toEqual(['Bash(rm *)']);
  });

  it('merges with existing permissions', async () => {
    const claudeDir = join(testDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    const existing = {
      permissions: {
        allow: ['Bash(npm *)'],
        deny: [],
      },
      otherSetting: true,
    };
    const settingsPath = join(claudeDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify(existing, null, 2));

    const newSet: PermissionSet = {
      name: 'test',
      allow: ['Bash(git *)'],
      deny: ['Bash(rm *)'],
    };

    const existingConfig = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const newConverted = convertToClaudeFormat(newSet);

    const mergedAllow = new Set([
      ...(existingConfig.permissions?.allow || []),
      ...newConverted.permissions.allow,
    ]);
    const mergedDeny = new Set([
      ...(existingConfig.permissions?.deny || []),
      ...newConverted.permissions.deny,
    ]);

    existingConfig.permissions = {
      allow: [...mergedAllow],
      deny: [...mergedDeny],
    };

    writeFileSync(settingsPath, JSON.stringify(existingConfig, null, 2));

    const result = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(result.permissions.allow).toContain('Bash(npm *)');
    expect(result.permissions.allow).toContain('Bash(git *)');
    expect(result.permissions.deny).toContain('Bash(rm *)');
    expect(result.otherSetting).toBe(true);
  });
});

describe('applyOpenCodePermissions', () => {
  const testDir = join(TEST_DIR, 'apply-opencode');

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('creates opencode.jsonc with permissions', () => {
    const opencodeDir = join(testDir, '.opencode');
    mkdirSync(opencodeDir, { recursive: true });

    const set: PermissionSet = {
      name: 'test',
      allow: ['Bash(git *)', 'Bash(npm *)'],
      deny: ['Bash(rm *)'],
    };

    const converted = convertToOpenCodeFormat(set);
    const configPath = join(opencodeDir, 'opencode.jsonc');
    writeFileSync(configPath, JSON.stringify(converted, null, 2));

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.permission.bash['git *']).toBe('allow');
    expect(written.permission.bash['npm *']).toBe('allow');
    expect(written.permission.bash['rm *']).toBe('deny');
  });

  it('merges with existing bash permissions', () => {
    const opencodeDir = join(testDir, '.opencode');
    mkdirSync(opencodeDir, { recursive: true });

    const existing = {
      permission: {
        bash: {
          'bun *': 'allow',
        },
      },
      mcp: { someServer: {} },
    };
    const configPath = join(opencodeDir, 'opencode.jsonc');
    writeFileSync(configPath, JSON.stringify(existing, null, 2));

    const newSet: PermissionSet = {
      name: 'test',
      allow: ['Bash(git *)'],
    };

    const existingConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    const newConverted = convertToOpenCodeFormat(newSet);

    existingConfig.permission = {
      ...existingConfig.permission,
      bash: {
        ...(existingConfig.permission?.bash || {}),
        ...newConverted.permission.bash,
      },
    };

    writeFileSync(configPath, JSON.stringify(existingConfig, null, 2));

    const result = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(result.permission.bash['bun *']).toBe('allow');
    expect(result.permission.bash['git *']).toBe('allow');
    expect(result.mcp).toBeDefined();
  });
});

describe('applyCodexPermissions', () => {
  const testDir = join(TEST_DIR, 'apply-codex');

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('creates config.toml with sandbox settings', () => {
    const codexDir = join(testDir, '.codex');
    mkdirSync(codexDir, { recursive: true });

    const set: PermissionSet = {
      name: 'test',
      allow: ['Bash(*)', 'WebSearch(*)'],
    };

    const converted = convertToCodexFormat(set);
    const configPath = join(codexDir, 'config.toml');
    writeFileSync(configPath, TOML.stringify(converted as any));

    const content = readFileSync(configPath, 'utf-8');
    const written = TOML.parse(content) as Record<string, unknown>;

    expect(written.approval_policy).toBe('never');
    expect(written.sandbox_mode).toBe('workspace-write');
    expect((written.sandbox_workspace_write as any)?.network_access).toBe(true);
  });

  it('preserves existing codex config when merging', () => {
    const codexDir = join(testDir, '.codex');
    mkdirSync(codexDir, { recursive: true });

    const existing = {
      model: 'gpt-4',
      personality: 'pragmatic',
    };
    const configPath = join(codexDir, 'config.toml');
    writeFileSync(configPath, TOML.stringify(existing));

    const newSet: PermissionSet = {
      name: 'test',
      allow: ['WebSearch(*)'],
    };

    const existingConfig = TOML.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const newConverted = convertToCodexFormat(newSet);

    Object.assign(existingConfig, newConverted);

    writeFileSync(configPath, TOML.stringify(existingConfig as any));

    const result = TOML.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(result.model).toBe('gpt-4');
    expect(result.personality).toBe('pragmatic');
    expect((result.sandbox_workspace_write as any)?.network_access).toBe(true);
  });
});

describe('applyPermissionsToVersion', () => {
  const testDir = join(TEST_DIR, 'apply-version');

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('applies Claude permissions to version home', () => {
    const versionHome = join(testDir, 'claude-version-home');
    mkdirSync(versionHome, { recursive: true });

    const set: PermissionSet = {
      name: 'test',
      allow: ['Bash(git *)', 'Read(**)'],
      deny: ['Bash(rm *)'],
    };

    const result = applyPermissionsToVersion('claude', set, versionHome, true);
    expect(result.success).toBe(true);

    const settingsPath = join(versionHome, '.claude', 'settings.json');
    expect(existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(settings.permissions.allow).toEqual(['Bash(git *)', 'Read(**)']);
    expect(settings.permissions.deny).toEqual(['Bash(rm *)']);
  });

  it('merges with existing Claude version permissions', () => {
    const versionHome = join(testDir, 'claude-version-merge');
    const claudeDir = join(versionHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    const existing = {
      permissions: {
        allow: ['Bash(npm *)'],
        deny: [],
      },
      otherSetting: 'preserved',
    };
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(existing, null, 2));

    const set: PermissionSet = {
      name: 'test',
      allow: ['Bash(git *)'],
      deny: ['Bash(rm *)'],
    };

    const result = applyPermissionsToVersion('claude', set, versionHome, true);
    expect(result.success).toBe(true);

    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf-8'));
    expect(settings.permissions.allow).toContain('Bash(npm *)');
    expect(settings.permissions.allow).toContain('Bash(git *)');
    expect(settings.permissions.deny).toContain('Bash(rm *)');
    expect(settings.otherSetting).toBe('preserved');
  });

  it('migrates stale Write(path) rules in existing Claude settings on merge', () => {
    const versionHome = join(testDir, 'claude-version-migrate');
    const claudeDir = join(versionHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    const existing = {
      permissions: {
        allow: ['Write(~/.claude/**)', 'Edit(~/.claude/**)'],
        deny: ['Write(~/.ssh/**)', 'Edit(~/.ssh/**)'],
      },
    };
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(existing, null, 2));

    const set: PermissionSet = {
      name: 'test',
      allow: ['Bash(git *)'],
    };

    const result = applyPermissionsToVersion('claude', set, versionHome, true);
    expect(result.success).toBe(true);

    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf-8'));
    expect(settings.permissions.allow).toEqual(['Edit(~/.claude/**)', 'Bash(git *)']);
    expect(settings.permissions.deny).toEqual(['Edit(~/.ssh/**)']);
  });

  it('preserves env, hooks, mcpServers, and custom top-level keys (regression #137)', () => {
    const versionHome = join(testDir, 'claude-version-survival');
    const claudeDir = join(versionHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    const existing = {
      env: { FOO: 'bar', DEBUG: 'true' },
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo test' }],
          },
        ],
      },
      mcpServers: {
        fooServer: { command: '/bin/foo', args: ['--bar'] },
      },
      customKey: { nested: 'preserved' },
      permissions: { allow: ['Bash(npm *)'], deny: [] },
    };
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(existing, null, 2));

    const set: PermissionSet = {
      name: 'test',
      allow: ['Bash(git *)'],
      deny: ['Bash(rm *)'],
    };

    const result = applyPermissionsToVersion('claude', set, versionHome, true);
    expect(result.success).toBe(true);

    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf-8'));

    expect(settings.env).toEqual({ FOO: 'bar', DEBUG: 'true' });
    expect(settings.hooks).toEqual({
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'echo test' }],
        },
      ],
    });
    expect(settings.mcpServers).toEqual({
      fooServer: { command: '/bin/foo', args: ['--bar'] },
    });
    expect(settings.customKey).toEqual({ nested: 'preserved' });

    expect(settings.permissions.allow).toContain('Bash(npm *)');
    expect(settings.permissions.allow).toContain('Bash(git *)');
    expect(settings.permissions.deny).toContain('Bash(rm *)');
  });

  it('applies OpenCode permissions to version home', () => {
    const versionHome = join(testDir, 'opencode-version-home');
    mkdirSync(versionHome, { recursive: true });

    const set: PermissionSet = {
      name: 'test',
      allow: ['Bash(git *)', 'Bash(npm *)'],
      deny: ['Bash(rm *)'],
    };

    const result = applyPermissionsToVersion('opencode', set, versionHome, true);
    expect(result.success).toBe(true);

    const configPath = join(versionHome, '.config', 'opencode', 'opencode.jsonc');
    expect(existsSync(configPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.permission.bash['git *']).toBe('allow');
    expect(config.permission.bash['npm *']).toBe('allow');
    expect(config.permission.bash['rm *']).toBe('deny');
  });

  it('applies Codex permissions to version home', () => {
    const versionHome = join(testDir, 'codex-version-home');
    mkdirSync(versionHome, { recursive: true });

    const set: PermissionSet = {
      name: 'test',
      allow: ['Bash(*)', 'WebSearch(*)'],
    };

    const result = applyPermissionsToVersion('codex', set, versionHome, true);
    expect(result.success).toBe(true);

    const configPath = join(versionHome, '.codex', 'config.toml');
    expect(existsSync(configPath)).toBe(true);

    const config = TOML.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(config.approval_policy).toBe('never');
    expect(config.sandbox_mode).toBe('workspace-write');
    expect((config.sandbox_workspace_write as any)?.network_access).toBe(true);
  });

  it('does not write permissions for hard-deprecated gemini', () => {
    const versionHome = join(testDir, 'gemini-version-home');
    mkdirSync(versionHome, { recursive: true });

    const set: PermissionSet = {
      name: 'test',
      allow: ['Bash(git *)', 'Bash(mq:*)'],
      deny: ['Bash(rm -rf *)'],
    };

    const result = applyPermissionsToVersion('gemini', set, versionHome, false);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Agent 'gemini' does not support permissions");

    const settingsPath = join(versionHome, '.gemini', 'settings.json');
    expect(existsSync(settingsPath)).toBe(false);
  });

  it('returns error for unsupported agent', () => {
    const versionHome = join(testDir, 'unsupported');
    mkdirSync(versionHome, { recursive: true });

    const set: PermissionSet = {
      name: 'test',
      allow: ['Bash(git *)'],
    };

    const result = applyPermissionsToVersion('amp' as any, set, versionHome, true);
    expect(result.success).toBe(false);
    expect(result.error).toContain('does not support permissions');
  });

  it('writes Cursor permissions to .cursor/cli-config.json (Bash→Shell)', () => {
    const versionHome = join(testDir, 'cursor-write');
    mkdirSync(versionHome, { recursive: true });

    const set: PermissionSet = {
      name: 'test',
      allow: ['Bash(git *)', 'Read(src/**)'],
      deny: ['Bash(rm *)'],
    };

    const result = applyPermissionsToVersion('cursor' as any, set, versionHome, false);
    expect(result.success).toBe(true);
    const configPath = join(versionHome, '.cursor', 'cli-config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.permissions.allow).toContain('Shell(git *)');
    expect(config.permissions.allow).toContain('Read(src/**)');
    expect(config.permissions.deny).toContain('Shell(rm *)');
  });

  it('convertToCursorFormat maps Edit(...) to Write(...) for both allow and deny (Cursor has no Edit prefix)', () => {
    const set: PermissionSet = {
      name: 'test',
      allow: ['Edit(src/**)'],
      deny: ['Edit(secrets/**)'],
    };

    const out = convertToCursorFormat(set);
    expect(out.permissions.allow).toContain('Write(src/**)');
    expect(out.permissions.allow).not.toContain('Edit(src/**)');
    expect(out.permissions.deny).toContain('Write(secrets/**)');
    expect(out.permissions.deny).not.toContain('Edit(secrets/**)');
  });

  it('writes Copilot permissions to .copilot/permissions-config.json for the current location', () => {
    const versionHome = join(testDir, 'copilot-write');
    const cwd = join(testDir, 'copilot-project');
    mkdirSync(versionHome, { recursive: true });
    mkdirSync(cwd, { recursive: true });

    const set: PermissionSet = {
      name: 'test',
      allow: ['Bash(git:*)', 'Bash(npm test)', 'Read(**)', 'Write(**)', 'MCP(github-mcp-server)'],
      deny: ['Bash(git push)'],
      additionalDirectories: ['shared'],
    };

    const result = applyPermissionsToVersion('copilot' as any, set, versionHome, false, cwd);
    expect(result.success).toBe(true);
    const configPath = join(versionHome, '.copilot', 'permissions-config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.locations[cwd].tool_approvals).toEqual([
      { kind: 'commands', commandIdentifiers: ['git:*', 'npm test'] },
      { kind: 'read' },
      { kind: 'write' },
      { kind: 'mcp', serverName: 'github-mcp-server', toolName: null },
    ]);
    expect(config.locations[cwd].allowed_directories).toEqual([join(cwd, 'shared')]);
  });

  it('merge=false drops stale Copilot location keys when the replacement omits them', () => {
    const versionHome = join(testDir, 'copilot-replace-drops-empty-kind');
    const cwd = join(testDir, 'copilot-replace-project');
    mkdirSync(versionHome, { recursive: true });
    mkdirSync(cwd, { recursive: true });

    applyPermissionsToVersion('copilot' as any, {
      name: 'test',
      allow: ['Bash(git:*)'],
      deny: [],
    }, versionHome, false, cwd);

    applyPermissionsToVersion('copilot' as any, {
      name: 'test',
      allow: [],
      deny: [],
      additionalDirectories: ['docs'],
    }, versionHome, false, cwd);

    const configPath = join(versionHome, '.copilot', 'permissions-config.json');
    let config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.locations[cwd].tool_approvals).toBeUndefined();
    expect(config.locations[cwd].allowed_directories).toEqual([join(cwd, 'docs')]);

    applyPermissionsToVersion('copilot' as any, {
      name: 'test',
      allow: ['Read(**)'],
      deny: [],
    }, versionHome, false, cwd);

    config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.locations[cwd].tool_approvals).toEqual([{ kind: 'read' }]);
    expect(config.locations[cwd].allowed_directories).toBeUndefined();
  });

  it('convertToCopilotFormat keeps persistent Copilot approvals to supported allow rules', () => {
    const out = convertToCopilotFormat({
      name: 'test',
      allow: ['Bash(gh pr:*)', 'Bash(ls *)', 'Read(**)', 'Edit(src/**)'],
      deny: ['Bash(rm:*)'],
    }, '/repo');
    expect(out.locations['/repo'].tool_approvals).toEqual([
      { kind: 'commands', commandIdentifiers: ['gh pr:*', 'ls:*'] },
      { kind: 'read' },
    ]);
  });

  it('writes Antigravity permissions to .gemini/antigravity-cli/settings.json', () => {
    const versionHome = join(testDir, 'antigravity-write');
    mkdirSync(versionHome, { recursive: true });

    const set: PermissionSet = {
      name: 'test',
      allow: ['Bash(git *)', 'Bash(mq:*)', 'Read(/Users/me)', 'Bash(*)'],
      deny: ['Bash(rm -rf *)'],
    };

    const result = applyPermissionsToVersion('antigravity' as any, set, versionHome, false);
    expect(result.success).toBe(true);

    const settingsPath = join(versionHome, '.gemini', 'antigravity-cli', 'settings.json');
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(settings.permissions.allow).toContain('command(git *)');
    expect(settings.permissions.allow).toContain('command(mq *)');
    expect(settings.permissions.allow).toContain('command(*)');
    expect(settings.permissions.allow).toContain('read_file(/Users/me)');
    expect(settings.permissions.deny).toEqual(['command(rm -rf *)']);
  });

  it('merge=true preserves existing Antigravity entries and dedupes', () => {
    const versionHome = join(testDir, 'antigravity-merge');
    const dir = join(versionHome, '.gemini', 'antigravity-cli');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({
      colorScheme: 'tokyo night',
      permissions: { allow: ['command(npm test)', 'command(git *)'] },
    }), 'utf-8');

    const set: PermissionSet = {
      name: 'test',
      allow: ['Bash(git *)', 'Bash(yarn:*)'],
    };

    const result = applyPermissionsToVersion('antigravity' as any, set, versionHome, true);
    expect(result.success).toBe(true);

    const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf-8'));
    expect(settings.colorScheme).toBe('tokyo night');
    expect(settings.permissions.allow).toContain('command(npm test)');
    expect(settings.permissions.allow).toContain('command(git *)');
    expect(settings.permissions.allow).toContain('command(yarn *)');
    expect(settings.permissions.allow.filter((e: string) => e === 'command(git *)')).toHaveLength(1);
  });

  it('writes Grok permissions to .grok/config.toml under [permission].rules', () => {
    const versionHome = join(testDir, 'grok-write');
    mkdirSync(versionHome, { recursive: true });

    const set: PermissionSet = {
      name: 'test',
      allow: ['Bash(git *)', 'Bash(*)', 'Read(/Users/me)', 'Write(src/)', 'WebFetch(example.com)'],
      deny: ['Bash(rm -rf *)'],
    };

    const result = applyPermissionsToVersion('grok' as any, set, versionHome, false);
    expect(result.success).toBe(true);

    const configPath = join(versionHome, '.grok', 'config.toml');
    expect(existsSync(configPath)).toBe(true);
    const config = TOML.parse(readFileSync(configPath, 'utf-8')) as any;
    const rules = config.permission.rules as Array<{ action: string; tool: string; pattern?: string }>;
    expect(rules).toContainEqual({ action: 'allow', tool: 'bash', pattern: 'git *' });
    expect(rules).toContainEqual({ action: 'allow', tool: 'bash' });
    expect(rules).not.toContainEqual({ action: 'allow', tool: 'bash', pattern: '*' });
    expect(rules).toContainEqual({ action: 'allow', tool: 'read', pattern: '/Users/me' });
    expect(rules).toContainEqual({ action: 'allow', tool: 'edit', pattern: 'src/' });
    expect(rules).toContainEqual({ action: 'allow', tool: 'webfetch', pattern: 'example.com' });
    expect(rules).toContainEqual({ action: 'deny', tool: 'bash', pattern: 'rm -rf *' });
  });

  it('merge=true preserves existing Grok rules and dedupes', () => {
    const versionHome = join(testDir, 'grok-merge');
    const dir = join(versionHome, '.grok');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.toml'), TOML.stringify({
      ui: { permission_mode: 'ask' },
      permission: { rules: [{ action: 'allow', tool: 'bash', pattern: 'git *' }] },
    } as any), 'utf-8');

    const set: PermissionSet = {
      name: 'test',
      allow: ['Bash(git *)', 'Bash(yarn:*)'],
    };

    const result = applyPermissionsToVersion('grok' as any, set, versionHome, true);
    expect(result.success).toBe(true);

    const config = TOML.parse(readFileSync(join(dir, 'config.toml'), 'utf-8')) as any;
    expect(config.ui.permission_mode).toBe('ask');
    const rules = config.permission.rules as Array<{ action: string; tool: string; pattern?: string }>;
    expect(rules.filter(r => r.action === 'allow' && r.tool === 'bash' && r.pattern === 'git *')).toHaveLength(1);
    expect(rules).toContainEqual({ action: 'allow', tool: 'bash', pattern: 'yarn *' });
  });

  it('merge=true keeps existing Claude rules not present in new set', () => {
    const versionHome = join(testDir, 'claude-merge-keeps');
    const claudeDir = join(versionHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
      permissions: {
        allow: ['Bash(git push --force:*)'],
        deny: [],
      },
    }, null, 2));

    const narrowed: PermissionSet = {
      name: 'test',
      allow: ['Read(**)'],
      deny: [],
    };

    applyPermissionsToVersion('claude', narrowed, versionHome, true);

    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf-8'));
    expect(settings.permissions.allow).toContain('Bash(git push --force:*)');
    expect(settings.permissions.allow).toContain('Read(**)');
  });

  it('merge=false drops Claude rules removed from the central set', () => {
    const versionHome = join(testDir, 'claude-replace-drops');
    const claudeDir = join(versionHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
      permissions: {
        allow: ['Bash(git push --force:*)'],
        deny: ['Bash(rm -rf *)'],
      },
      otherSetting: 'preserved',
    }, null, 2));

    const narrowed: PermissionSet = {
      name: 'test',
      allow: ['Read(**)'],
      deny: [],
    };

    applyPermissionsToVersion('claude', narrowed, versionHome, false);

    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf-8'));
    expect(settings.permissions.allow).not.toContain('Bash(git push --force:*)');
    expect(settings.permissions.allow).toContain('Read(**)');
    expect(settings.permissions.deny).not.toContain('Bash(rm -rf *)');
    expect(settings.otherSetting).toBe('preserved');
  });

  it('merge=false drops OpenCode rules removed from the central set', () => {
    const versionHome = join(testDir, 'opencode-replace-drops');
    const opencodeDir = join(versionHome, '.config', 'opencode');
    mkdirSync(opencodeDir, { recursive: true });

    writeFileSync(join(opencodeDir, 'opencode.jsonc'), JSON.stringify({
      permission: {
        bash: {
          'git push --force': 'allow',
          'rm *': 'deny',
        },
      },
    }, null, 2));

    const narrowed: PermissionSet = {
      name: 'test',
      allow: ['Bash(npm *)'],
      deny: [],
    };

    applyPermissionsToVersion('opencode', narrowed, versionHome, false);

    const config = JSON.parse(readFileSync(join(opencodeDir, 'opencode.jsonc'), 'utf-8'));
    expect(config.permission.bash['git push --force']).toBeUndefined();
    expect(config.permission.bash['npm *']).toBe('allow');
  });
});

describe('convertDenyToCodexRules', () => {
  it('converts single-word deny to prefix_rule', () => {
    const result = convertDenyToCodexRules(['Bash(sudo:*)']);
    expect(result).toContain('pattern = ["sudo"]');
    expect(result).toContain('decision = "forbidden"');
  });

  it('converts multi-word deny to prefix_rule', () => {
    const result = convertDenyToCodexRules(['Bash(git reset:*)']);
    expect(result).toContain('pattern = ["git", "reset"]');
    expect(result).toContain('decision = "forbidden"');
  });

  it('converts git push --force deny', () => {
    const result = convertDenyToCodexRules(['Bash(git push --force:*)']);
    expect(result).toContain('pattern = ["git", "push", "--force"]');
  });

  it('ignores non-Bash deny rules', () => {
    const result = convertDenyToCodexRules(['Read(~/.ssh/**)']);
    expect(result).toBeNull();
  });

  it('handles mixed deny rules', () => {
    const result = convertDenyToCodexRules([
      'Bash(sudo:*)',
      'Read(~/.ssh/**)',
      'Bash(git reset:*)',
    ]);
    expect(result).toContain('pattern = ["sudo"]');
    expect(result).toContain('pattern = ["git", "reset"]');
    expect(result).not.toContain('.ssh');
  });

  it('returns null for empty array', () => {
    expect(convertDenyToCodexRules([])).toBeNull();
  });

  it('generates header comment', () => {
    const result = convertDenyToCodexRules(['Bash(sudo:*)']);
    expect(result).toContain('Auto-generated by agents-cli');
  });
});

describe('applyPermissionsToVersion codex deny rules', () => {
  it('writes config.toml and .rules file for allow+deny set', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'agents-test-'));
    const versionHome = tmpDir;
    const codexDir = join(versionHome, '.codex');

    try {
      const set = {
        name: 'test',
        allow: ['Bash(*)'],
        deny: ['Bash(sudo:*)', 'Bash(git reset:*)'],
      };
      const result = applyPermissionsToVersion('codex', set, versionHome);
      expect(result.success).toBe(true);

      const configPath = join(codexDir, 'config.toml');
      expect(existsSync(configPath)).toBe(true);
      const config = TOML.parse(readFileSync(configPath, 'utf-8'));
      expect(config.approval_policy).toBe('never');
      expect(config.sandbox_mode).toBe('workspace-write');

      const rulesPath = join(codexDir, 'rules', CODEX_RULES_FILENAME);
      expect(existsSync(rulesPath)).toBe(true);
      const rulesContent = readFileSync(rulesPath, 'utf-8');
      expect(rulesContent).toContain('pattern = ["sudo"]');
      expect(rulesContent).toContain('pattern = ["git", "reset"]');
      expect(rulesContent).toContain('decision = "forbidden"');
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('writes only .rules file for deny-only set', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'agents-test-'));
    const versionHome = tmpDir;
    const codexDir = join(versionHome, '.codex');

    try {
      const set = {
        name: '99-deny',
        allow: [],
        deny: ['Bash(sudo:*)', 'Bash(git reset:*)', 'Bash(git push --force:*)'],
      };

      const result = applyPermissionsToVersion('codex', set, versionHome);
      expect(result.success).toBe(true);

      const rulesPath = join(codexDir, 'rules', CODEX_RULES_FILENAME);
      expect(existsSync(rulesPath)).toBe(true);
      const rulesContent = readFileSync(rulesPath, 'utf-8');
      expect(rulesContent).toContain('pattern = ["sudo"]');
      expect(rulesContent).toContain('pattern = ["git", "reset"]');
      expect(rulesContent).toContain('pattern = ["git", "push", "--force"]');
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });
});
