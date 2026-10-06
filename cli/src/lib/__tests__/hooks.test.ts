import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

import { registerHooksToSettings, selectHookManifest, unmanagedHookNames, computeCodexHookTrustHash, toPortableCommand, pruneVersionHomeHookEntriesFromSettings } from '../hooks/install.js';
import { getHookShimPath } from '../hooks/cache.js';
import * as TOML from 'smol-toml';
import * as yaml from 'yaml';
import { CODEX_HOOKS_MIN_VERSION } from '../agents.js';
import { compareVersions } from '../installations/versions.js';
import { toPosix } from '../platform/index.js';
import type { ManifestHook } from '../types.js';

let agentsDir: string;
let tmpDir: string;

function resolvedCommand(command: string): string {
  const expanded = command.startsWith('~/')
    ? path.join(os.homedir(), command.slice(2))
    : command;
  return toPosix(expanded);
}

function makeScript(name: string): string {
  const scriptPath = path.join(agentsDir, 'hooks', name);
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, '#!/bin/sh\necho hello\n', 'utf-8');
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function makeVersionHome(): string {
  const home = path.join(tmpDir, 'version-home');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  return home;
}

describe('unmanagedHookNames', () => {
  it('flags installed hooks whose name matches no source script basename (PHNX-2693)', () => {
    const installed = [
      'permission-handler',
      'dead-hook',
      '03-linear-inject-tasks-context',
      'git-guard',
    ];
    const sourceScripts = [
      'permission-handler.sh',
      '03-linear-inject-tasks-context.sh',
      'git-guard.sh',
      'rm-guard.sh',
    ];
    expect(unmanagedHookNames(installed, sourceScripts)).toEqual(['dead-hook']);
  });

  it('matches on script basename regardless of extension (.sh, .py)', () => {
    expect(unmanagedHookNames(['guard'], ['guard.py'])).toEqual([]);
    expect(unmanagedHookNames(['guard'], ['guard.sh'])).toEqual([]);
  });

  it('returns nothing when every installed hook is present in source', () => {
    expect(unmanagedHookNames(['a', 'b'], ['a.sh', 'b.sh'])).toEqual([]);
  });

  it('returns all installed hooks when no source is present', () => {
    expect(unmanagedHookNames(['a', 'b'], [])).toEqual(['a', 'b']);
  });
});

describe('registerHooksToSettings - Codex', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
    agentsDir = path.join(tmpDir, '.agents');
    fs.mkdirSync(path.join(agentsDir, 'hooks'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes hooks.json with correct nested schema for UserPromptSubmit', () => {
    const versionHome = makeVersionHome();
    const scriptPath = makeScript('on-prompt.sh');

    const manifest: Record<string, ManifestHook> = {
      'on-prompt': {
        script: 'on-prompt.sh',
        events: ['UserPromptSubmit'],
        timeout: 30,
      },
    };

    const result = registerHooksToSettings('codex', versionHome, manifest, agentsDir);

    expect(result.errors).toHaveLength(0);
    expect(result.registered).toContain('on-prompt -> UserPromptSubmit');

    const hooksJson = JSON.parse(
      fs.readFileSync(path.join(versionHome, '.codex', 'hooks.json'), 'utf-8')
    );

    expect(hooksJson).toHaveProperty('hooks');

    const groups = hooksJson.hooks.UserPromptSubmit;
    expect(groups).toHaveLength(1);

    expect(groups[0]).not.toHaveProperty('matcher');

    expect(groups[0].hooks).toHaveLength(1);
    expect(resolvedCommand(groups[0].hooks[0].command)).toBe(toPosix(scriptPath));
    expect(groups[0].hooks[0].timeout).toBe(30);
    expect(groups[0].hooks[0].type).toBe('command');
  });

  it('writes PreToolUse hook with matcher field', () => {
    const versionHome = makeVersionHome();
    makeScript('bash-tool-hook.sh');

    const manifest: Record<string, ManifestHook> = {
      'bash-hook': {
        script: 'bash-tool-hook.sh',
        events: ['PreToolUse'],
        matcher: 'Bash',
        timeout: 600,
      },
    };

    const result = registerHooksToSettings('codex', versionHome, manifest, agentsDir);

    expect(result.errors).toHaveLength(0);
    const hooksJson = JSON.parse(
      fs.readFileSync(path.join(versionHome, '.codex', 'hooks.json'), 'utf-8')
    );

    const groups = hooksJson.hooks.PreToolUse;
    expect(groups).toHaveLength(1);
    expect(groups[0].matcher).toBe('Bash');
    expect(resolvedCommand(groups[0].hooks[0].command)).toBe(resolvedCommand(getHookShimPath('bash-hook')));
  });

  it('writes [features] hooks = true to config.toml', () => {
    const versionHome = makeVersionHome();
    makeScript('on-prompt.sh');

    const manifest: Record<string, ManifestHook> = {
      'on-prompt': { script: 'on-prompt.sh', events: ['UserPromptSubmit'] },
    };

    registerHooksToSettings('codex', versionHome, manifest, agentsDir);

    const configPath = path.join(versionHome, '.codex', 'config.toml');
    expect(fs.existsSync(configPath)).toBe(true);

    const content = fs.readFileSync(configPath, 'utf-8');
    expect(content).toContain('hooks = true');
    expect(content).not.toContain('codex_hooks');
  });

  it('preserves existing config.toml entries when enabling feature flag', () => {
    const versionHome = makeVersionHome();
    makeScript('on-prompt.sh');

    const configPath = path.join(versionHome, '.codex', 'config.toml');
    fs.writeFileSync(configPath, 'approval_policy = "suggest"\n', 'utf-8');

    const manifest: Record<string, ManifestHook> = {
      'on-prompt': { script: 'on-prompt.sh', events: ['UserPromptSubmit'] },
    };

    registerHooksToSettings('codex', versionHome, manifest, agentsDir);

    const content = fs.readFileSync(configPath, 'utf-8');
    expect(content).toContain('hooks = true');
    expect(content).toContain('approval_policy');
  });

  it('migrates a stale [features] codex_hooks flag to hooks', () => {
    const versionHome = makeVersionHome();
    makeScript('on-prompt.sh');

    const configPath = path.join(versionHome, '.codex', 'config.toml');
    fs.writeFileSync(configPath, '[features]\ncodex_hooks = true\n', 'utf-8');

    const manifest: Record<string, ManifestHook> = {
      'on-prompt': { script: 'on-prompt.sh', events: ['UserPromptSubmit'] },
    };

    registerHooksToSettings('codex', versionHome, manifest, agentsDir);

    const content = fs.readFileSync(configPath, 'utf-8');
    expect(content).toContain('hooks = true');
    expect(content).not.toContain('codex_hooks');
  });

  it('caps Codex SessionEnd hook timeout at 3 seconds', () => {
    const versionHome = makeVersionHome();
    makeScript('on-session-end.sh');

    const manifest: Record<string, ManifestHook> = {
      'on-session-end': {
        script: 'on-session-end.sh',
        events: ['SessionEnd'],
        timeout: 5,
      },
    };

    const result = registerHooksToSettings('codex', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);

    const hooksJson = JSON.parse(
      fs.readFileSync(path.join(versionHome, '.codex', 'hooks.json'), 'utf-8')
    );
    expect(hooksJson.hooks.SessionEnd[0].hooks[0].timeout).toBe(3);
  });

  it('does not duplicate managed hook entries on repeated calls', () => {
    const versionHome = makeVersionHome();
    makeScript('on-prompt.sh');

    const manifest: Record<string, ManifestHook> = {
      'on-prompt': { script: 'on-prompt.sh', events: ['UserPromptSubmit'] },
    };

    registerHooksToSettings('codex', versionHome, manifest, agentsDir);
    registerHooksToSettings('codex', versionHome, manifest, agentsDir);

    const hooksJson = JSON.parse(
      fs.readFileSync(path.join(versionHome, '.codex', 'hooks.json'), 'utf-8')
    );
    expect(hooksJson.hooks.UserPromptSubmit[0].hooks).toHaveLength(1);
  });

  it('never touches user-authored entries (managed-prefix guard)', () => {
    const versionHome = makeVersionHome();
    makeScript('on-prompt.sh');

    const hooksPath = path.join(versionHome, '.codex', 'hooks.json');
    const userHook = { type: 'command', command: '/usr/local/bin/my-hook.sh', timeout: 10 };
    fs.writeFileSync(
      hooksPath,
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [userHook] }] } }, null, 2)
    );

    const manifest: Record<string, ManifestHook> = {
      'on-prompt': { script: 'on-prompt.sh', events: ['UserPromptSubmit'] },
    };

    registerHooksToSettings('codex', versionHome, manifest, agentsDir);

    const hooksJson = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
    const group = hooksJson.hooks.UserPromptSubmit[0];
    expect(group.hooks).toHaveLength(2);
    expect(group.hooks[0]).toEqual(userHook);
  });

  it('keeps one registration per hook in hooks.json: no sibling-version or direct copies', () => {
    const versionHome = path.join(
      tmpDir,
      '.agents',
      '.history',
      'versions',
      'codex',
      '0.146.0',
      'home'
    );
    const hooksPath = path.join(versionHome, '.codex', 'hooks.json');
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });

    const oldVersionHook = {
      type: 'command',
      command: path.join(
        tmpDir,
        '.agents',
        '.history',
        'versions',
        'codex',
        '0.142.0',
        'home',
        '.codex',
        'hooks',
        'git-guard.sh'
      ),
      timeout: 5,
    };
    const currentVersionHook = {
      type: 'command',
      command: path.join(versionHome, '.codex', 'hooks', 'git-guard.sh'),
      timeout: 5,
    };
    const customHook = {
      type: 'command',
      command: '/usr/local/bin/my-hook.sh',
      timeout: 10,
    };
    fs.writeFileSync(hooksPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [oldVersionHook, currentVersionHook, customHook],
          },
        ],
      },
    }, null, 2));

    makeScript('git-guard.sh');
    const manifest: Record<string, ManifestHook> = {
      'git-guard': {
        script: 'git-guard.sh',
        events: ['PreToolUse'],
        matcher: 'Bash',
        timeout: 5,
      },
    };

    const result = registerHooksToSettings('codex', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);

    const hooksJson = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
    const commands = hooksJson.hooks.PreToolUse[0].hooks.map((h: { command: string }) => h.command);
    // The manifest runs git-guard through its shim; a direct copy beside it would run it twice.
    expect(commands).not.toContain(oldVersionHook.command);
    expect(commands).not.toContain(currentVersionHook.command);
    expect(commands).toContain(customHook.command);
    expect(commands.map((c: string) => resolvedCommand(c))).toEqual([
      customHook.command,
      resolvedCommand(getHookShimPath('git-guard')),
    ]);
  });

  it('ignores the deprecated agents: field — capability table decides registration', () => {
    const versionHome = makeVersionHome();
    makeScript('claude-only.sh');

    const manifest: Record<string, ManifestHook> = {
      'claude-only': {
        script: 'claude-only.sh',
        events: ['UserPromptSubmit'],
        agents: ['claude'],
      },
    };

    const result = registerHooksToSettings('codex', versionHome, manifest, agentsDir);

    expect(result.registered).toHaveLength(1);
    expect(fs.existsSync(path.join(versionHome, '.codex', 'hooks.json'))).toBe(true);
  });

  it('UserPromptSubmit group has no matcher even when manifest defines one', () => {
    const versionHome = makeVersionHome();
    makeScript('on-prompt.sh');

    const manifest: Record<string, ManifestHook> = {
      'on-prompt': {
        script: 'on-prompt.sh',
        events: ['UserPromptSubmit'],
        matcher: 'some-pattern',
      },
    };

    const result = registerHooksToSettings('codex', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);
    expect(result.registered).toContain('on-prompt -> UserPromptSubmit');

    const hooksJson = JSON.parse(
      fs.readFileSync(path.join(versionHome, '.codex', 'hooks.json'), 'utf-8')
    );
    expect(hooksJson.hooks.UserPromptSubmit[0]).not.toHaveProperty('matcher');
  });

  it('returns error when script file does not exist', () => {
    const versionHome = makeVersionHome();

    const manifest: Record<string, ManifestHook> = {
      'missing-hook': { script: 'does-not-exist.sh', events: ['UserPromptSubmit'] },
    };

    const result = registerHooksToSettings('codex', versionHome, manifest, agentsDir);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('missing-hook');
  });

  it('rejects hook scripts that resolve outside the hooks directory', () => {
    const versionHome = makeVersionHome();
    fs.writeFileSync(path.join(agentsDir, 'outside.sh'), '#!/bin/sh\necho outside\n', 'utf-8');

    const manifest: Record<string, ManifestHook> = {
      traversal: { script: '../outside.sh', events: ['UserPromptSubmit'] },
    };

    const result = registerHooksToSettings('codex', versionHome, manifest, agentsDir);

    expect(result.registered).toHaveLength(0);
    expect(result.errors[0]).toContain('script not found');
    expect(fs.existsSync(path.join(versionHome, '.codex', 'hooks.json'))).toBe(false);
  });

  it('resolves benign relative hook script names inside the hooks directory', () => {
    const versionHome = makeVersionHome();
    const scriptPath = makeScript('nested/on-prompt.sh');

    const manifest: Record<string, ManifestHook> = {
      benign: { script: 'nested/on-prompt.sh', events: ['UserPromptSubmit'] },
    };

    const result = registerHooksToSettings('codex', versionHome, manifest, agentsDir);

    expect(result.errors).toHaveLength(0);
    expect(result.registered).toContain('benign -> UserPromptSubmit');
    const hooksJson = JSON.parse(
      fs.readFileSync(path.join(versionHome, '.codex', 'hooks.json'), 'utf-8')
    );
    expect(resolvedCommand(hooksJson.hooks.UserPromptSubmit[0].hooks[0].command)).toBe(toPosix(scriptPath));
  });

  it('writes a [hooks.state] trusted_hash for each registered hook', () => {
    const versionHome = makeVersionHome();
    const scriptPath = makeScript('bash-tool-hook.sh');

    const manifest: Record<string, ManifestHook> = {
      'bash-hook': {
        script: 'bash-tool-hook.sh',
        events: ['PreToolUse'],
        matcher: 'Bash',
        timeout: 5,
      },
    };

    registerHooksToSettings('codex', versionHome, manifest, agentsDir);

    const hooksJsonPath = path.join(versionHome, '.codex', 'hooks.json');
    const configPath = path.join(versionHome, '.codex', 'config.toml');
    const config = TOML.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const state = (config.hooks as Record<string, unknown>).state as Record<
      string,
      { trusted_hash?: string; enabled?: boolean }
    >;

    const key = `${hooksJsonPath}:pre_tool_use:0:0`;
    expect(state[key]).toBeDefined();
    const hooksJson = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8'));
    const registeredCommand = hooksJson.hooks.PreToolUse[0].hooks[0].command;
    expect(state[key].trusted_hash).toBe(
      computeCodexHookTrustHash('pre_tool_use', registeredCommand, 5, 'Bash')
    );
    expect(state[key].enabled).toBeUndefined();
  });

  it('preserves a user-set enabled = false when rewriting the trust hash', () => {
    const versionHome = makeVersionHome();
    const scriptPath = makeScript('on-prompt.sh');

    const manifest: Record<string, ManifestHook> = {
      'on-prompt': { script: 'on-prompt.sh', events: ['UserPromptSubmit'] },
    };

    registerHooksToSettings('codex', versionHome, manifest, agentsDir);
    const configPath = path.join(versionHome, '.codex', 'config.toml');
    const hooksJsonPath = path.join(versionHome, '.codex', 'hooks.json');
    const key = `${hooksJsonPath}:user_prompt_submit:0:0`;

    const config = TOML.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const state = (config.hooks as Record<string, unknown>).state as Record<
      string,
      { trusted_hash?: string; enabled?: boolean }
    >;
    state[key].enabled = false;
    fs.writeFileSync(configPath, TOML.stringify(config as Parameters<typeof TOML.stringify>[0]), 'utf-8');

    registerHooksToSettings('codex', versionHome, manifest, agentsDir);
    const after = TOML.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const afterState = (after.hooks as Record<string, unknown>).state as Record<
      string,
      { trusted_hash?: string; enabled?: boolean }
    >;
    expect(afterState[key].enabled).toBe(false);
    const hooksJson = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8'));
    const registeredCommand = hooksJson.hooks.UserPromptSubmit[0].hooks[0].command;
    expect(afterState[key].trusted_hash).toBe(
      computeCodexHookTrustHash('user_prompt_submit', registeredCommand, 600, undefined)
    );
  });

  describe('computeCodexHookTrustHash — Codex 0.134.0 ground truth', () => {
    const HOOK_DIR = '~/.agents/.history/versions/codex/0.134.0/home/.codex/hooks';

    it('SessionStart metadata hook, no matcher', () => {
      expect(
        computeCodexHookTrustHash('session_start', `${HOOK_DIR}/04-capture-session-start-metadata.sh`, 5, undefined)
      ).toBe('sha256:03b77fe0c51d19ec5438fd556ea783c70843f7ae24c1c640a190d3bfce70ea56');
    });

    it('PreToolUse git-guard, matcher "Bash"', () => {
      expect(computeCodexHookTrustHash('pre_tool_use', `${HOOK_DIR}/git-guard.sh`, 5, 'Bash')).toBe(
        'sha256:a5996ca377f7bd87d23d062ab6b7a8aef4745b9400c8da6a475009ec8096c6f1'
      );
    });

    it('PreToolUse rm-guard, matcher "Bash"', () => {
      expect(computeCodexHookTrustHash('pre_tool_use', `${HOOK_DIR}/rm-guard.sh`, 5, 'Bash')).toBe(
        'sha256:f840a97db8c64eb46d0eef3d37ebc98a409c12e6bdbf73f19442d02543223d34'
      );
    });

    it('PreToolUse large-file-add-guard, matcher "Bash"', () => {
      expect(
        computeCodexHookTrustHash('pre_tool_use', `${HOOK_DIR}/large-file-add-guard.sh`, 5, 'Bash')
      ).toBe('sha256:a5c51bb0d1ad496a102de8ea2b88a9a4f5fed80ddab8f388691e9f45529d38d0');
    });

    it('treats an empty-string matcher the same as no matcher (TOML null-drop)', () => {
      expect(computeCodexHookTrustHash('session_start', `${HOOK_DIR}/x.sh`, 5, '')).toBe(
        computeCodexHookTrustHash('session_start', `${HOOK_DIR}/x.sh`, 5, undefined)
      );
    });

    it('is matcher-sensitive', () => {
      expect(computeCodexHookTrustHash('pre_tool_use', `${HOOK_DIR}/git-guard.sh`, 5, 'Bash')).not.toBe(
        computeCodexHookTrustHash('pre_tool_use', `${HOOK_DIR}/git-guard.sh`, 5, 'Read')
      );
    });

    it('normalizes a sub-1 timeout to 1 (Codex: unwrap_or(600).max(1))', () => {
      expect(computeCodexHookTrustHash('session_start', `${HOOK_DIR}/x.sh`, 0, undefined)).toBe(
        computeCodexHookTrustHash('session_start', `${HOOK_DIR}/x.sh`, 1, undefined)
      );
    });
  });
});

describe('CODEX_HOOKS_MIN_VERSION constant', () => {
  it('is set to 0.116.0', () => {
    expect(CODEX_HOOKS_MIN_VERSION).toBe('0.116.0');
  });

  it('correctly gates versions below floor', () => {
    expect(compareVersions('0.113.0', CODEX_HOOKS_MIN_VERSION)).toBeLessThan(0);
    expect(compareVersions('0.115.9', CODEX_HOOKS_MIN_VERSION)).toBeLessThan(0);
  });

  it('correctly passes versions at or above floor', () => {
    expect(compareVersions('0.116.0', CODEX_HOOKS_MIN_VERSION)).toBe(0);
    expect(compareVersions('0.117.0', CODEX_HOOKS_MIN_VERSION)).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', CODEX_HOOKS_MIN_VERSION)).toBeGreaterThan(0);
  });
});

describe('registerHooksToSettings - OpenCode', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
    agentsDir = path.join(tmpDir, '.agents');
    fs.mkdirSync(path.join(agentsDir, 'hooks'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('generates a plugin that maps canonical events and executes scripts through Bun shell', () => {
    makeScript('lifecycle.sh');
    const manifest: Record<string, ManifestHook> = {
      lifecycle: {
        script: 'lifecycle.sh',
        events: ['PreToolUse', 'PostToolUse', 'SessionStart', 'Stop'],
        matcher: 'Bash|bash',
      },
    };
    const versionHome = path.join(tmpDir, 'home');
    const result = registerHooksToSettings('opencode', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);
    expect(result.registered).toEqual([
      'lifecycle -> tool.execute.before',
      'lifecycle -> tool.execute.after',
      'lifecycle -> session.created',
      'lifecycle -> session.idle',
      'lifecycle -> session.error',
    ]);

    const pluginPath = path.join(
      versionHome, '.config', 'opencode', 'plugins', 'agents-cli-hooks.ts'
    );
    const plugin = fs.readFileSync(pluginPath, 'utf-8');
    expect(plugin).toContain('export const AgentsCliHooks = async ({ $ })');
    expect(plugin).toContain('"tool.execute.before": async (input, output)');
    expect(plugin).toContain('"tool.execute.after": async (input, output)');
    expect(plugin).toContain('"session.created"');
    expect(plugin).toContain('"session.idle"');
    expect(plugin).toContain('"session.error"');
    expect(plugin).toContain('const input = JSON.stringify(payload)');
    expect(plugin).toContain('await $`${shell} -c ${\'exec "$1"\'} ${"agents-hook"} ${command} < ${new Response(input)}`.nothrow().quiet()');
    expect(plugin).toContain('"matcher": "Bash|bash"');
  });

  it('derives the timeout-sample spool dir with path.dirname (Windows-safe)', () => {
    makeScript('slow.sh');
    const versionHome = path.join(tmpDir, 'home');
    const result = registerHooksToSettings(
      'opencode',
      versionHome,
      { slow: { script: 'slow.sh', events: ['SessionStart'], timeout: 1 } },
      agentsDir,
    );
    expect(result.errors).toHaveLength(0);

    const plugin = fs.readFileSync(
      path.join(versionHome, '.config', 'opencode', 'plugins', 'agents-cli-hooks.ts'),
      'utf-8',
    );
    expect(plugin).toContain('import path from "node:path"');
    expect(plugin).toContain('path.dirname(PERF_SPOOL)');
    expect(plugin).not.toContain("PERF_SPOOL.lastIndexOf(\"/\")");
    expect(plugin).not.toContain("PERF_SPOOL.lastIndexOf('/')");
    expect(plugin).not.toMatch(/PERF_SPOOL\.slice\(0,\s*PERF_SPOOL\.lastIndexOf\(/);

    const winSpool = 'C:\\Users\\me\\.agents\\.cache\\perf\\spool.jsonl';
    expect(path.win32.dirname(winSpool)).toBe('C:\\Users\\me\\.agents\\.cache\\perf');
    expect(winSpool.lastIndexOf('/')).toBe(-1);
    expect(winSpool.slice(0, winSpool.lastIndexOf('/'))).toBe(
      'C:\\Users\\me\\.agents\\.cache\\perf\\spool.json',
    );
    expect(winSpool.slice(0, winSpool.lastIndexOf('/'))).not.toBe(path.win32.dirname(winSpool));
  });

  it('compiles only the explicitly selected hook script', () => {
    const selected = selectHookManifest({
      first: { script: 'first.sh', events: ['SessionStart'] },
      differentlyNamed: { script: 'second.sh', events: ['SessionStart'] },
    }, ['second.sh']);

    expect(selected).toEqual({
      differentlyNamed: { script: 'second.sh', events: ['SessionStart'] },
    });
  });

  it('removes its generated plugin when the selected manifest becomes empty', () => {
    makeScript('lifecycle.sh');
    const versionHome = path.join(tmpDir, 'home');
    registerHooksToSettings('opencode', versionHome, {
      lifecycle: { script: 'lifecycle.sh', events: ['SessionStart'] },
    }, agentsDir);
    const pluginPath = path.join(
      versionHome, '.config', 'opencode', 'plugins', 'agents-cli-hooks.ts'
    );
    expect(fs.existsSync(pluginPath)).toBe(true);

    const result = registerHooksToSettings('opencode', versionHome, {}, agentsDir);
    expect(result).toEqual({ registered: [], errors: [] });
    expect(fs.existsSync(pluginPath)).toBe(false);
  });

  it('executes matching hooks, skips non-matches, and surfaces nonzero exits', async () => {
    const outputPath = path.join(tmpDir, 'hook-input.json');
    const scriptPath = path.join(agentsDir, 'hooks', 'capture.js');
    fs.writeFileSync(scriptPath, `#!/usr/bin/env node\nrequire("fs").writeFileSync(${JSON.stringify(outputPath)}, require("fs").readFileSync(0))\n`, 'utf-8');
    fs.chmodSync(scriptPath, 0o755);
    const versionHome = path.join(tmpDir, 'home');
    registerHooksToSettings('opencode', versionHome, {
      capture: { script: 'capture.js', events: ['PreToolUse'], matcher: '^bash$' },
    }, agentsDir);
    const pluginPath = path.join(
      versionHome, '.config', 'opencode', 'plugins', 'agents-cli-hooks.ts'
    );
    const runnerPath = path.join(tmpDir, 'run-plugin.ts');
    fs.writeFileSync(runnerPath, `
      import { $ } from "bun"
      import { AgentsCliHooks } from ${JSON.stringify(pluginPath)}
      const plugin = await AgentsCliHooks({ $ })
      try {
        await plugin["tool.execute.before"]({ tool: "read", sessionID: "skip" }, { args: {} })
        await plugin["tool.execute.before"]({ tool: "bash", sessionID: "run" }, { args: { command: "true" } })
      } catch (error) {
        console.error(error.message)
        process.exit(1)
      }
      process.exit(0)
    `, 'utf-8');
    execFileSync('bun', [runnerPath]);
    expect(JSON.parse(fs.readFileSync(outputPath, 'utf-8'))).toMatchObject({
      hook_event_name: 'PreToolUse',
      tool_name: 'bash',
      sessionID: 'run',
    });

    fs.writeFileSync(scriptPath, '#!/usr/bin/env node\nconsole.error("rejected")\nprocess.exit(7)\n', 'utf-8');
    expect(() => execFileSync('bun', [runnerPath], { encoding: 'utf-8', stdio: 'pipe' }))
      .toThrow('capture failed with exit code 7: rejected');
  });

  it('executes lifecycle hooks even when the manifest entry also has a tool matcher', () => {
    const outputPath = path.join(tmpDir, 'lifecycle-input.json');
    const scriptPath = path.join(agentsDir, 'hooks', 'capture-lifecycle.js');
    fs.writeFileSync(scriptPath, `#!/usr/bin/env node\nrequire("fs").writeFileSync(${JSON.stringify(outputPath)}, require("fs").readFileSync(0))\n`, 'utf-8');
    fs.chmodSync(scriptPath, 0o755);
    const versionHome = path.join(tmpDir, 'home');
    registerHooksToSettings('opencode', versionHome, {
      captureLifecycle: {
        script: 'capture-lifecycle.js',
        events: ['SessionStart', 'Stop'],
        matcher: 'Bash|bash',
      },
    }, agentsDir);
    const pluginPath = path.join(
      versionHome, '.config', 'opencode', 'plugins', 'agents-cli-hooks.ts'
    );
    const runnerPath = path.join(tmpDir, 'run-lifecycle-plugin.ts');
    fs.writeFileSync(runnerPath, `
      import { $ } from "bun"
      import { AgentsCliHooks } from ${JSON.stringify(pluginPath)}
      const plugin = await AgentsCliHooks({ $ })
      await plugin.event({ event: { type: "session.created", properties: { info: { id: "lifecycle" } } } })
    `, 'utf-8');

    execFileSync('bun', [runnerPath]);

    expect(JSON.parse(fs.readFileSync(outputPath, 'utf-8'))).toMatchObject({
      hook_event_name: 'session.created',
      type: 'session.created',
      properties: { info: { id: 'lifecycle' } },
    });
  });

  it('enforces the manifest timeout', async () => {
    const homeScopedDir = fs.mkdtempSync(path.join(os.homedir(), '.opencode-hook-test-'));
    const homeAgentsDir = path.join(homeScopedDir, '.agents');
    fs.mkdirSync(path.join(homeAgentsDir, 'hooks'), { recursive: true });
    const scriptPath = path.join(homeAgentsDir, 'hooks', 'slow.js');
    const sideEffectPath = path.join(tmpDir, 'too-late');
    fs.writeFileSync(scriptPath, `#!/usr/bin/env node\nsetTimeout(() => require("fs").writeFileSync(${JSON.stringify(sideEffectPath)}, ""), 2500)\n`, 'utf-8');
    fs.chmodSync(scriptPath, 0o755);
    const versionHome = path.join(tmpDir, 'home');
    registerHooksToSettings('opencode', versionHome, {
      slow: { script: 'slow.js', events: ['SessionStart'], timeout: 0.15 },
    }, homeAgentsDir);
    const pluginPath = path.join(
      versionHome, '.config', 'opencode', 'plugins', 'agents-cli-hooks.ts'
    );
    expect(fs.readFileSync(pluginPath, 'utf-8')).toContain(
      `"command": "~/${path.relative(os.homedir(), scriptPath).split(path.sep).join('/')}"`
    );
    const resultPath = path.join(tmpDir, 'timeout-result.json');
    const runnerPath = path.join(tmpDir, 'timeout-plugin.ts');
    fs.writeFileSync(runnerPath, `
      import { $ } from "bun"
      import { AgentsCliHooks } from ${JSON.stringify(pluginPath)}
      const plugin = await AgentsCliHooks({ $ })
      let error = ""
      try {
        await plugin.event({ event: { type: "session.created", properties: { info: { id: "timeout" } } } })
      } catch (caught) {
        error = caught.message
      }
      await Bun.sleep(400)
      await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({ error, sideEffect: await Bun.file(${JSON.stringify(sideEffectPath)}).exists() }))
      process.exit(0)
    `, 'utf-8');
    execFileSync('bun', [runnerPath]);
    expect(JSON.parse(fs.readFileSync(resultPath, 'utf-8'))).toEqual({
      error: 'slow timed out after 0.15 seconds',
      sideEffect: false,
    });
    fs.rmSync(homeScopedDir, { recursive: true, force: true });
  });

  it('reports missing scripts without registering an event', () => {
    const manifest: Record<string, ManifestHook> = {
      missing: { script: 'missing.sh', events: ['SessionStart'] },
    };
    const result = registerHooksToSettings('opencode', path.join(tmpDir, 'home'), manifest, agentsDir);
    expect(result.registered).toEqual([]);
    expect(result.errors).toEqual(['missing: script not found']);
  });
});

describe('registerHooksToSettings - Grok', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
    agentsDir = path.join(tmpDir, '.agents');
    fs.mkdirSync(path.join(agentsDir, 'hooks'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes grok hook JSON files for PreToolUse events', () => {
    fs.writeFileSync(path.join(agentsDir, 'hooks', 'on-prompt.sh'), '#!/bin/sh\necho hi\n');
    const manifest: Record<string, ManifestHook> = {
      'on-prompt': { script: 'on-prompt.sh', events: ['PreToolUse'] },
    };
    const versionHome = path.join(tmpDir, 'home');
    const result = registerHooksToSettings('grok', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);
    expect(result.registered).toContain('on-prompt -> PreToolUse');
    const mainPath = path.join(versionHome, '.grok', 'hooks', 'hooks.json');
    expect(fs.existsSync(mainPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(mainPath, 'utf-8'));
    expect(parsed.hooks.PreToolUse).toBeDefined();
    expect(parsed.hooks.PreToolUse[0].hooks[0].type).toBe('command');
  });

  function grokHooksDir(versionHome: string): string {
    return path.join(versionHome, '.grok', 'hooks');
  }

  function readGrokHooks(versionHome: string): Record<string, any> {
    return JSON.parse(fs.readFileSync(path.join(grokHooksDir(versionHome), 'hooks.json'), 'utf-8'));
  }

  it('emits the matcher on PreToolUse', () => {
    makeScript('gate.sh');
    const manifest: Record<string, ManifestHook> = {
      gate: { script: 'gate.sh', events: ['PreToolUse'], matcher: 'Bash' },
    };
    const versionHome = path.join(tmpDir, 'home');
    const result = registerHooksToSettings('grok', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);
    const parsed = readGrokHooks(versionHome);
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
    expect(parsed.hooks.PreToolUse[0].matcher).toBe('Bash');
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toBe(
      resolvedCommand(parsed.hooks.PreToolUse[0].hooks[0].command)
    );
  });

  it('omits the matcher on SessionStart / Stop / UserPromptSubmit (lifecycle events reject it)', () => {
    makeScript('life.sh');
    const manifest: Record<string, ManifestHook> = {
      life: {
        script: 'life.sh',
        events: ['SessionStart', 'Stop', 'UserPromptSubmit'],
        matcher: 'Bash',
      },
    };
    const versionHome = path.join(tmpDir, 'home');
    const result = registerHooksToSettings('grok', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);
    const parsed = readGrokHooks(versionHome);
    for (const ev of ['SessionStart', 'Stop', 'UserPromptSubmit']) {
      expect(parsed.hooks[ev]).toHaveLength(1);
      expect(parsed.hooks[ev][0]).not.toHaveProperty('matcher');
    }
  });

  it('translates the ExitPlanMode matcher to also match Grok exit_plan_mode', () => {
    makeScript('plan.sh');
    const manifest: Record<string, ManifestHook> = {
      plan: { script: 'plan.sh', events: ['PreToolUse'], matcher: 'ExitPlanMode' },
    };
    const versionHome = path.join(tmpDir, 'home');
    const result = registerHooksToSettings('grok', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);
    const parsed = readGrokHooks(versionHome);
    expect(parsed.hooks.PreToolUse[0].matcher).toBe('ExitPlanMode|exit_plan_mode');
  });

  it('groups multiple hooks with the same matcher into one group', () => {
    makeScript('a.sh');
    makeScript('b.sh');
    const manifest: Record<string, ManifestHook> = {
      a: { script: 'a.sh', events: ['PreToolUse'], matcher: 'Bash' },
      b: { script: 'b.sh', events: ['PreToolUse'], matcher: 'Bash' },
    };
    const versionHome = path.join(tmpDir, 'home');
    const result = registerHooksToSettings('grok', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);
    const parsed = readGrokHooks(versionHome);
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
    expect(parsed.hooks.PreToolUse[0].matcher).toBe('Bash');
    expect(parsed.hooks.PreToolUse[0].hooks).toHaveLength(2);
  });

  it('writes a single file — no per-event files alongside hooks.json', () => {
    makeScript('gate.sh');
    const manifest: Record<string, ManifestHook> = {
      gate: { script: 'gate.sh', events: ['PreToolUse'], matcher: 'Bash' },
    };
    const versionHome = path.join(tmpDir, 'home');
    registerHooksToSettings('grok', versionHome, manifest, agentsDir);
    const files = fs.readdirSync(grokHooksDir(versionHome)).filter((f) => f.endsWith('.json'));
    expect(files).toEqual(['hooks.json']);
  });

  it('prunes stale managed per-event files left by an older build on re-sync', () => {
    const scriptPath = makeScript('gate.sh');
    const manifest: Record<string, ManifestHook> = {
      gate: { script: 'gate.sh', events: ['PreToolUse'], matcher: 'Bash' },
    };
    const versionHome = path.join(tmpDir, 'home');
    const dir = grokHooksDir(versionHome);
    fs.mkdirSync(dir, { recursive: true });

    const stale = { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: scriptPath, timeout: 30 }] }] } };
    fs.writeFileSync(path.join(dir, 'pretooluse.json'), JSON.stringify(stale));
    const userFile = { hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: '/usr/local/bin/mine.sh', timeout: 5 }] }] } };
    fs.writeFileSync(path.join(dir, 'user-custom.json'), JSON.stringify(userFile));

    const result = registerHooksToSettings('grok', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    expect(files).toEqual(['hooks.json', 'user-custom.json']);
    expect(fs.existsSync(path.join(dir, 'pretooluse.json'))).toBe(false);
  });
});

describe('registerHooksToSettings - Copilot', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
    agentsDir = path.join(tmpDir, '.agents');
    fs.mkdirSync(path.join(agentsDir, 'hooks'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeCopilotScript(name: string): string {
    const scriptPath = path.join(agentsDir, 'hooks', name);
    fs.writeFileSync(scriptPath, '#!/bin/sh\necho hello\n', 'utf-8');
    fs.chmodSync(scriptPath, 0o755);
    return scriptPath;
  }

  it('writes agents-cli-hooks.json with version 1 and camelCase events', () => {
    makeCopilotScript('on-prompt.sh');
    const versionHome = path.join(tmpDir, 'home');
    const manifest: Record<string, ManifestHook> = {
      'on-prompt': {
        script: 'on-prompt.sh',
        events: ['UserPromptSubmit', 'SessionStart'],
        timeout: 45,
      },
    };

    const result = registerHooksToSettings('copilot', versionHome, manifest, agentsDir);

    expect(result.errors).toHaveLength(0);
    expect(result.registered).toContain('on-prompt -> userPromptSubmitted');
    expect(result.registered).toContain('on-prompt -> sessionStart');

    const outPath = path.join(versionHome, '.copilot', 'hooks', 'agents-cli-hooks.json');
    expect(fs.existsSync(outPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    expect(parsed.version).toBe(1);
    expect(parsed.hooks.userPromptSubmitted).toHaveLength(1);
    expect(parsed.hooks.sessionStart).toHaveLength(1);
    expect(parsed.hooks.userPromptSubmitted[0].type).toBe('command');
    expect(parsed.hooks.userPromptSubmitted[0].timeoutSec).toBe(45);
    expect(resolvedCommand(parsed.hooks.userPromptSubmitted[0].command)).toContain('on-prompt.sh');
  });

  it('maps PreToolUse → preToolUse and emits matcher for matcher-capable events', () => {
    makeCopilotScript('guard.sh');
    const versionHome = path.join(tmpDir, 'home');
    const manifest: Record<string, ManifestHook> = {
      guard: {
        script: 'guard.sh',
        events: ['PreToolUse', 'SessionStart'],
        matcher: 'bash|edit',
      },
    };

    const result = registerHooksToSettings('copilot', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);

    const parsed = JSON.parse(
      fs.readFileSync(path.join(versionHome, '.copilot', 'hooks', 'agents-cli-hooks.json'), 'utf-8')
    );
    expect(parsed.hooks.preToolUse[0].matcher).toBe('bash|edit');
    expect(parsed.hooks.sessionStart[0].matcher).toBeUndefined();
  });

  it('does not duplicate entries on repeated sync', () => {
    makeCopilotScript('on-prompt.sh');
    const versionHome = path.join(tmpDir, 'home');
    const manifest: Record<string, ManifestHook> = {
      'on-prompt': { script: 'on-prompt.sh', events: ['PreToolUse'] },
    };

    registerHooksToSettings('copilot', versionHome, manifest, agentsDir);
    registerHooksToSettings('copilot', versionHome, manifest, agentsDir);

    const parsed = JSON.parse(
      fs.readFileSync(path.join(versionHome, '.copilot', 'hooks', 'agents-cli-hooks.json'), 'utf-8')
    );
    expect(parsed.hooks.preToolUse).toHaveLength(1);
  });

  it('rewrites managed file to empty hooks when manifest has no events', () => {
    makeCopilotScript('on-prompt.sh');
    const versionHome = path.join(tmpDir, 'home');
    const withHook: Record<string, ManifestHook> = {
      'on-prompt': { script: 'on-prompt.sh', events: ['PreToolUse'] },
    };
    registerHooksToSettings('copilot', versionHome, withHook, agentsDir);

    const empty: Record<string, ManifestHook> = {
      'on-prompt': { script: 'on-prompt.sh', events: [] },
    };
    registerHooksToSettings('copilot', versionHome, empty, agentsDir);

    const parsed = JSON.parse(
      fs.readFileSync(path.join(versionHome, '.copilot', 'hooks', 'agents-cli-hooks.json'), 'utf-8')
    );
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.hooks)).toHaveLength(0);
  });

  it('never touches a user-authored sibling hooks JSON file', () => {
    makeCopilotScript('on-prompt.sh');
    const versionHome = path.join(tmpDir, 'home');
    const userFile = path.join(versionHome, '.copilot', 'hooks', 'my-custom.json');
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    const userBody = { version: 1, hooks: { sessionStart: [{ type: 'command', command: 'echo user' }] } };
    fs.writeFileSync(userFile, JSON.stringify(userBody), 'utf-8');

    const manifest: Record<string, ManifestHook> = {
      'on-prompt': { script: 'on-prompt.sh', events: ['PreToolUse'] },
    };
    registerHooksToSettings('copilot', versionHome, manifest, agentsDir);

    expect(JSON.parse(fs.readFileSync(userFile, 'utf-8'))).toEqual(userBody);
  });

  it('skips unmapped events silently', () => {
    makeCopilotScript('on-prompt.sh');
    const versionHome = path.join(tmpDir, 'home');
    const manifest: Record<string, ManifestHook> = {
      'on-prompt': { script: 'on-prompt.sh', events: ['BeforeAgent' as never, 'SessionStart'] },
    };
    const result = registerHooksToSettings('copilot', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);
    expect(result.registered).toEqual(['on-prompt -> sessionStart']);
  });
});

describe('registerHooksToSettings - Goose', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
    agentsDir = path.join(tmpDir, '.agents');
    fs.mkdirSync(path.join(agentsDir, 'hooks'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeGooseScript(name: string): string {
    const scriptPath = path.join(agentsDir, 'hooks', name);
    fs.writeFileSync(scriptPath, '#!/bin/sh\necho hello\n', 'utf-8');
    fs.chmodSync(scriptPath, 0o755);
    return scriptPath;
  }

  function gooseHooksPath(versionHome: string): string {
    return path.join(versionHome, '.agents', 'plugins', 'agents-cli-hooks', 'hooks', 'hooks.json');
  }

  it('writes Open Plugins hooks.json under versionHome/.agents/plugins/agents-cli-hooks/', () => {
    makeGooseScript('on-prompt.sh');
    const versionHome = path.join(tmpDir, 'home');
    const manifest: Record<string, ManifestHook> = {
      'on-prompt': {
        script: 'on-prompt.sh',
        events: ['UserPromptSubmit', 'SessionStart'],
        timeout: 45,
      },
    };

    const result = registerHooksToSettings('goose', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);
    expect(result.registered).toContain('on-prompt -> UserPromptSubmit');
    expect(result.registered).toContain('on-prompt -> SessionStart');

    const outPath = gooseHooksPath(versionHome);
    expect(fs.existsSync(outPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
    expect(parsed.hooks.SessionStart).toHaveLength(1);
    expect(parsed.hooks.UserPromptSubmit[0].hooks[0].type).toBe('command');
    expect(parsed.hooks.UserPromptSubmit[0].hooks[0].timeout).toBe(45);
    expect(resolvedCommand(parsed.hooks.UserPromptSubmit[0].hooks[0].command)).toContain('on-prompt.sh');
  });

  it('groups by matcher for PreToolUse', () => {
    makeGooseScript('guard.sh');
    const versionHome = path.join(tmpDir, 'home');
    const manifest: Record<string, ManifestHook> = {
      guard: {
        script: 'guard.sh',
        events: ['PreToolUse'],
        matcher: 'developer__shell',
      },
    };

    registerHooksToSettings('goose', versionHome, manifest, agentsDir);
    const parsed = JSON.parse(fs.readFileSync(gooseHooksPath(versionHome), 'utf-8'));
    expect(parsed.hooks.PreToolUse[0].matcher).toBe('developer__shell');
    expect(parsed.hooks.PreToolUse[0].hooks).toHaveLength(1);
  });

  it('does not duplicate entries on repeated sync', () => {
    makeGooseScript('on-prompt.sh');
    const versionHome = path.join(tmpDir, 'home');
    const manifest: Record<string, ManifestHook> = {
      'on-prompt': { script: 'on-prompt.sh', events: ['PreToolUse'] },
    };
    registerHooksToSettings('goose', versionHome, manifest, agentsDir);
    registerHooksToSettings('goose', versionHome, manifest, agentsDir);
    const parsed = JSON.parse(fs.readFileSync(gooseHooksPath(versionHome), 'utf-8'));
    expect(parsed.hooks.PreToolUse[0].hooks).toHaveLength(1);
  });

  it('writes managed marker file', () => {
    makeGooseScript('on-prompt.sh');
    const versionHome = path.join(tmpDir, 'home');
    registerHooksToSettings(
      'goose',
      versionHome,
      { 'on-prompt': { script: 'on-prompt.sh', events: ['SessionStart'] } },
      agentsDir
    );
    const marker = path.join(versionHome, '.agents', 'plugins', 'agents-cli-hooks', '.agents-cli-managed');
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('skips SubagentStart/SubagentStop (Goose never emits them) (RUSH-1613)', () => {
    makeGooseScript('on-subagent.sh');
    const versionHome = path.join(tmpDir, 'home');
    const result = registerHooksToSettings(
      'goose',
      versionHome,
      {
        'on-subagent': {
          script: 'on-subagent.sh',
          events: ['SubagentStart', 'SubagentStop', 'SessionStart'],
        },
      },
      agentsDir,
    );
    expect(result.registered).toEqual(['on-subagent -> SessionStart']);
    const parsed = JSON.parse(fs.readFileSync(gooseHooksPath(versionHome), 'utf-8'));
    expect(parsed.hooks.SubagentStart).toBeUndefined();
    expect(parsed.hooks.SubagentStop).toBeUndefined();
    expect(parsed.hooks.SessionStart).toHaveLength(1);
  });
});

describe('registerHooksToSettings - Cursor', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
    agentsDir = path.join(tmpDir, '.agents');
    fs.mkdirSync(path.join(agentsDir, 'hooks'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeCursorScript(name: string): string {
    const scriptPath = path.join(agentsDir, 'hooks', name);
    fs.writeFileSync(scriptPath, '#!/bin/sh\necho hello\n', 'utf-8');
    fs.chmodSync(scriptPath, 0o755);
    return scriptPath;
  }

  it('writes ~/.cursor/hooks.json with version 1 and camelCase events', () => {
    makeCursorScript('on-prompt.sh');
    const versionHome = path.join(tmpDir, 'home');
    const manifest: Record<string, ManifestHook> = {
      'on-prompt': {
        script: 'on-prompt.sh',
        events: ['UserPromptSubmit', 'SessionStart', 'Stop'],
        timeout: 45,
      },
    };

    const result = registerHooksToSettings('cursor', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);
    expect(result.registered).toContain('on-prompt -> beforeSubmitPrompt');
    expect(result.registered).toContain('on-prompt -> sessionStart');
    expect(result.registered).toContain('on-prompt -> stop');

    const outPath = path.join(versionHome, '.cursor', 'hooks.json');
    expect(fs.existsSync(outPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    expect(parsed.version).toBe(1);
    expect(parsed.hooks.sessionStart).toHaveLength(1);
    expect(parsed.hooks.beforeSubmitPrompt[0].timeout).toBe(45);
    expect(parsed.hooks.stop[0].command).toBeTruthy();
    expect(resolvedCommand(parsed.hooks.sessionStart[0].command)).toContain('on-prompt.sh');
  });

  it('emits matcher for preToolUse', () => {
    makeCursorScript('guard.sh');
    const versionHome = path.join(tmpDir, 'home');
    registerHooksToSettings(
      'cursor',
      versionHome,
      { guard: { script: 'guard.sh', events: ['PreToolUse'], matcher: 'Shell|Write' } },
      agentsDir
    );
    const parsed = JSON.parse(fs.readFileSync(path.join(versionHome, '.cursor', 'hooks.json'), 'utf-8'));
    expect(parsed.hooks.preToolUse[0].matcher).toBe('Shell|Write');
  });

  it('preserves user-authored entries outside managed prefixes', () => {
    makeCursorScript('on-prompt.sh');
    const versionHome = path.join(tmpDir, 'home');
    const outPath = path.join(versionHome, '.cursor', 'hooks.json');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(
      outPath,
      JSON.stringify({
        version: 1,
        hooks: { sessionStart: [{ command: '/usr/local/bin/my-custom-hook' }] },
      }),
      'utf-8'
    );

    registerHooksToSettings(
      'cursor',
      versionHome,
      { 'on-prompt': { script: 'on-prompt.sh', events: ['SessionStart'] } },
      agentsDir
    );

    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    const cmds = parsed.hooks.sessionStart.map((h: { command: string }) => h.command);
    expect(cmds).toContain('/usr/local/bin/my-custom-hook');
    expect(cmds.some((c: string) => c.includes('on-prompt') || resolvedCommand(c).includes('on-prompt'))).toBe(true);
  });

  it('does not duplicate on repeated sync', () => {
    makeCursorScript('on-prompt.sh');
    const versionHome = path.join(tmpDir, 'home');
    const manifest: Record<string, ManifestHook> = {
      'on-prompt': { script: 'on-prompt.sh', events: ['PreToolUse'] },
    };
    registerHooksToSettings('cursor', versionHome, manifest, agentsDir);
    registerHooksToSettings('cursor', versionHome, manifest, agentsDir);
    const parsed = JSON.parse(fs.readFileSync(path.join(versionHome, '.cursor', 'hooks.json'), 'utf-8'));
    expect(parsed.hooks.preToolUse).toHaveLength(1);
  });

  it('drops managed entries when matcher or event changes (RUSH-1615)', () => {
    makeCursorScript('guard.sh');
    const versionHome = path.join(tmpDir, 'home');
    const outPath = path.join(versionHome, '.cursor', 'hooks.json');

    registerHooksToSettings(
      'cursor',
      versionHome,
      { guard: { script: 'guard.sh', events: ['PreToolUse'], matcher: 'Shell' } },
      agentsDir,
    );
    let parsed = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    expect(parsed.hooks.preToolUse).toHaveLength(1);
    expect(parsed.hooks.preToolUse[0].matcher).toBe('Shell');

    registerHooksToSettings(
      'cursor',
      versionHome,
      { guard: { script: 'guard.sh', events: ['PreToolUse'], matcher: 'Write' } },
      agentsDir,
    );
    parsed = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    expect(parsed.hooks.preToolUse).toHaveLength(1);
    expect(parsed.hooks.preToolUse[0].matcher).toBe('Write');

    registerHooksToSettings(
      'cursor',
      versionHome,
      { guard: { script: 'guard.sh', events: ['PostToolUse'], matcher: 'Write' } },
      agentsDir,
    );
    parsed = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    expect(parsed.hooks.preToolUse).toBeUndefined();
    expect(parsed.hooks.postToolUse).toHaveLength(1);
  });
});

describe('registerHooksToSettings - Hermes', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
    agentsDir = path.join(tmpDir, '.agents');
    fs.mkdirSync(path.join(agentsDir, 'hooks'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeHermesScript(name: string): string {
    const scriptPath = path.join(agentsDir, 'hooks', name);
    fs.writeFileSync(scriptPath, '#!/bin/sh\necho hello\n', 'utf-8');
    fs.chmodSync(scriptPath, 0o755);
    return scriptPath;
  }

  function readConfig(versionHome: string): Record<string, unknown> {
    return yaml.parse(
      fs.readFileSync(path.join(versionHome, '.hermes', 'config.yaml'), 'utf-8')
    );
  }

  it('writes ~/.hermes/config.yaml with snake_case events and no version wrapper', () => {
    makeHermesScript('on-prompt.sh');
    const versionHome = path.join(tmpDir, 'home');
    const manifest: Record<string, ManifestHook> = {
      'on-prompt': {
        script: 'on-prompt.sh',
        events: ['UserPromptSubmit', 'SessionStart', 'Stop'],
        timeout: 45,
      },
    };

    const result = registerHooksToSettings('hermes', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);
    expect(result.registered).toContain('on-prompt -> pre_llm_call');
    expect(result.registered).toContain('on-prompt -> on_session_start');
    expect(result.registered).toContain('on-prompt -> on_session_finalize');

    const parsed = readConfig(versionHome);
    expect(parsed.version).toBeUndefined();
    const hooks = parsed.hooks as Record<string, Array<{ command: string; timeout: number }>>;
    expect(hooks.on_session_start).toHaveLength(1);
    expect(hooks.pre_llm_call[0].timeout).toBe(45);
    expect(resolvedCommand(hooks.on_session_finalize[0].command)).toContain('on-prompt.sh');
  });

  it('maps tool events and clamps timeout at 300s', () => {
    makeHermesScript('guard.sh');
    const versionHome = path.join(tmpDir, 'home');
    registerHooksToSettings(
      'hermes',
      versionHome,
      { guard: { script: 'guard.sh', events: ['PreToolUse', 'PostToolUse'], matcher: 'Shell|Write', timeout: 999 } },
      agentsDir
    );
    const hooks = readConfig(versionHome).hooks as Record<
      string,
      Array<{ matcher?: string; timeout: number }>
    >;
    expect(hooks.pre_tool_call[0].matcher).toBe('Shell|Write');
    expect(hooks.pre_tool_call[0].timeout).toBe(300);
    expect(hooks.post_tool_call[0].matcher).toBe('Shell|Write');
  });

  it('does not duplicate on repeated sync', () => {
    makeHermesScript('on-prompt.sh');
    const versionHome = path.join(tmpDir, 'home');
    const manifest: Record<string, ManifestHook> = {
      'on-prompt': { script: 'on-prompt.sh', events: ['PreToolUse'] },
    };
    registerHooksToSettings('hermes', versionHome, manifest, agentsDir);
    registerHooksToSettings('hermes', versionHome, manifest, agentsDir);
    const hooks = readConfig(versionHome).hooks as Record<string, unknown[]>;
    expect(hooks.pre_tool_call).toHaveLength(1);
  });

  it('preserves existing mcp_servers key (shared config.yaml)', () => {
    makeHermesScript('on-prompt.sh');
    const versionHome = path.join(tmpDir, 'home');
    const configPath = path.join(versionHome, '.hermes', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      yaml.stringify({
        mcp_servers: { fs: { command: 'mcp-fs', args: ['--root', '/tmp'] } },
        model: 'hermes-4',
      }),
      'utf-8'
    );

    registerHooksToSettings(
      'hermes',
      versionHome,
      { 'on-prompt': { script: 'on-prompt.sh', events: ['SessionStart'] } },
      agentsDir
    );

    const parsed = readConfig(versionHome) as {
      mcp_servers?: Record<string, unknown>;
      model?: string;
      hooks?: Record<string, unknown>;
    };
    expect(parsed.mcp_servers).toBeDefined();
    expect((parsed.mcp_servers as { fs: { command: string } }).fs.command).toBe('mcp-fs');
    expect(parsed.model).toBe('hermes-4');
    expect(parsed.hooks?.on_session_start).toBeDefined();
  });

  it('preserves user-authored entries outside managed prefixes', () => {
    makeHermesScript('on-prompt.sh');
    const versionHome = path.join(tmpDir, 'home');
    const configPath = path.join(versionHome, '.hermes', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      yaml.stringify({
        hooks: { on_session_start: [{ command: '/usr/local/bin/my-custom-hook', timeout: 60 }] },
      }),
      'utf-8'
    );

    registerHooksToSettings(
      'hermes',
      versionHome,
      { 'on-prompt': { script: 'on-prompt.sh', events: ['SessionStart'] } },
      agentsDir
    );

    const hooks = readConfig(versionHome).hooks as Record<string, Array<{ command: string }>>;
    const cmds = hooks.on_session_start.map((h) => h.command);
    expect(cmds).toContain('/usr/local/bin/my-custom-hook');
    expect(cmds.some((c) => c.includes('on-prompt') || resolvedCommand(c).includes('on-prompt'))).toBe(true);
  });
});

describe('registerHooksToSettings - Antigravity', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
    agentsDir = path.join(tmpDir, '.agents');
    fs.mkdirSync(path.join(agentsDir, 'hooks'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeAgyVersionHome(): string {
    const home = path.join(tmpDir, 'agy-home');
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    return home;
  }

  function readAgySettings(home: string): Record<string, any> {
    return JSON.parse(
      fs.readFileSync(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf-8')
    );
  }

  it('writes settings.json at ~/.gemini/antigravity-cli/ with flat hooks arrays', () => {
    const versionHome = makeAgyVersionHome();
    const scriptPath = makeScript('pre-tool.sh');

    const manifest: Record<string, ManifestHook> = {
      'pre-tool': {
        script: 'pre-tool.sh',
        events: ['PreToolUse'],
      },
    };

    const result = registerHooksToSettings('antigravity', versionHome, manifest, agentsDir);

    expect(result.errors).toHaveLength(0);
    expect(result.registered).toContain('pre-tool -> before_tool_call');

    const settings = readAgySettings(versionHome);
    expect(settings.hooks).toBeDefined();
    expect(Array.isArray(settings.hooks.before_tool_call)).toBe(true);
    expect(settings.hooks.before_tool_call).toHaveLength(1);
    expect(Object.keys(settings.hooks.before_tool_call[0])).toEqual(['command']);
    expect(resolvedCommand(settings.hooks.before_tool_call[0].command)).toBe(toPosix(scriptPath));
  });

  it('maps all four supported events: PreToolUse, PostToolUse, Stop, OnError', () => {
    const versionHome = makeAgyVersionHome();
    makeScript('a.sh');
    makeScript('b.sh');
    makeScript('c.sh');
    makeScript('d.sh');

    const manifest: Record<string, ManifestHook> = {
      a: { script: 'a.sh', events: ['PreToolUse'] },
      b: { script: 'b.sh', events: ['PostToolUse'] },
      c: { script: 'c.sh', events: ['Stop'] },
      d: { script: 'd.sh', events: ['OnError'] },
    };

    const result = registerHooksToSettings('antigravity', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);

    const settings = readAgySettings(versionHome);
    expect(settings.hooks.before_tool_call).toHaveLength(1);
    expect(settings.hooks.after_model_call).toHaveLength(1);
    expect(settings.hooks.on_loop_stop).toHaveLength(1);
    expect(settings.hooks.on_error).toHaveLength(1);
  });

  it('expands a hook with multiple events into one entry per agy event', () => {
    const versionHome = makeAgyVersionHome();
    const scriptPath = makeScript('multi.sh');

    const manifest: Record<string, ManifestHook> = {
      multi: { script: 'multi.sh', events: ['PreToolUse', 'PostToolUse', 'Stop'] },
    };

    const result = registerHooksToSettings('antigravity', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);
    expect(result.registered).toHaveLength(3);

    const settings = readAgySettings(versionHome);
    expect(resolvedCommand(settings.hooks.before_tool_call[0].command)).toBe(toPosix(scriptPath));
    expect(resolvedCommand(settings.hooks.after_model_call[0].command)).toBe(toPosix(scriptPath));
    expect(resolvedCommand(settings.hooks.on_loop_stop[0].command)).toBe(toPosix(scriptPath));
  });

  it('silently skips unmapped events (e.g. UserPromptSubmit)', () => {
    const versionHome = makeAgyVersionHome();
    makeScript('prompt.sh');
    makeScript('tool.sh');

    const manifest: Record<string, ManifestHook> = {
      prompt: { script: 'prompt.sh', events: ['UserPromptSubmit'] },
      tool: { script: 'tool.sh', events: ['PreToolUse'] },
    };

    const result = registerHooksToSettings('antigravity', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);
    expect(result.registered).toEqual(['tool -> before_tool_call']);

    const settings = readAgySettings(versionHome);
    expect(settings.hooks.before_tool_call).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit).toBeUndefined();
  });

  it('preserves existing non-hooks settings.json content', () => {
    const versionHome = makeAgyVersionHome();
    const settingsPath = path.join(versionHome, '.gemini', 'antigravity-cli', 'settings.json');

    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        theme: 'dark',
        permissions: { allow: ['Bash(ls:*)'] },
      }, null, 2)
    );

    makeScript('pre-tool.sh');
    const manifest: Record<string, ManifestHook> = {
      'pre-tool': { script: 'pre-tool.sh', events: ['PreToolUse'] },
    };

    registerHooksToSettings('antigravity', versionHome, manifest, agentsDir);

    const settings = readAgySettings(versionHome);
    expect(settings.theme).toBe('dark');
    expect(settings.permissions).toEqual({ allow: ['Bash(ls:*)'] });
    expect(settings.hooks.before_tool_call).toHaveLength(1);
  });

  it('prunes removed managed entries on subsequent sync (GC invariant)', () => {
    const versionHome = makeAgyVersionHome();
    makeScript('a.sh');
    makeScript('b.sh');

    const firstManifest: Record<string, ManifestHook> = {
      a: { script: 'a.sh', events: ['PreToolUse'] },
      b: { script: 'b.sh', events: ['PreToolUse'] },
    };
    registerHooksToSettings('antigravity', versionHome, firstManifest, agentsDir);

    let settings = readAgySettings(versionHome);
    expect(settings.hooks.before_tool_call).toHaveLength(2);

    const secondManifest: Record<string, ManifestHook> = {
      a: { script: 'a.sh', events: ['PreToolUse'] },
    };
    registerHooksToSettings('antigravity', versionHome, secondManifest, agentsDir);

    settings = readAgySettings(versionHome);
    expect(settings.hooks.before_tool_call).toHaveLength(1);
    expect(settings.hooks.before_tool_call[0].command).toContain('a.sh');
  });

  it('prunes managed entries when the hooks root is reached through a symlink (GC realpath invariant)', () => {
    const realRoot = path.join(tmpDir, 'real-agents');
    fs.mkdirSync(path.join(realRoot, 'hooks'), { recursive: true });
    for (const n of ['a.sh', 'b.sh']) {
      const p = path.join(realRoot, 'hooks', n);
      fs.writeFileSync(p, '#!/bin/sh\necho hi\n', 'utf-8');
      fs.chmodSync(p, 0o755);
    }
    const linkRoot = path.join(tmpDir, 'link-agents');
    fs.symlinkSync(realRoot, linkRoot);

    const versionHome = makeAgyVersionHome();
    const firstManifest: Record<string, ManifestHook> = {
      a: { script: 'a.sh', events: ['PreToolUse'] },
      b: { script: 'b.sh', events: ['PreToolUse'] },
    };
    registerHooksToSettings('antigravity', versionHome, firstManifest, linkRoot);
    let settings = readAgySettings(versionHome);
    expect(settings.hooks.before_tool_call).toHaveLength(2);

    const secondManifest: Record<string, ManifestHook> = {
      a: { script: 'a.sh', events: ['PreToolUse'] },
    };
    registerHooksToSettings('antigravity', versionHome, secondManifest, linkRoot);
    settings = readAgySettings(versionHome);
    expect(settings.hooks.before_tool_call).toHaveLength(1);
    expect(settings.hooks.before_tool_call[0].command).toContain('a.sh');
  });

  it('never touches user-authored entries outside managedPrefixes', () => {
    const versionHome = makeAgyVersionHome();
    const settingsPath = path.join(versionHome, '.gemini', 'antigravity-cli', 'settings.json');

    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          before_tool_call: [{ command: '/usr/local/bin/my-user-hook.sh' }],
        },
      }, null, 2)
    );

    makeScript('managed.sh');
    const manifest: Record<string, ManifestHook> = {
      managed: { script: 'managed.sh', events: ['PreToolUse'] },
    };
    registerHooksToSettings('antigravity', versionHome, manifest, agentsDir);

    const settings = readAgySettings(versionHome);
    expect(settings.hooks.before_tool_call).toHaveLength(2);
    expect(settings.hooks.before_tool_call[0].command).toBe('/usr/local/bin/my-user-hook.sh');
  });

  it('does not duplicate entries on repeated calls', () => {
    const versionHome = makeAgyVersionHome();
    makeScript('pre-tool.sh');

    const manifest: Record<string, ManifestHook> = {
      'pre-tool': { script: 'pre-tool.sh', events: ['PreToolUse'] },
    };

    registerHooksToSettings('antigravity', versionHome, manifest, agentsDir);
    registerHooksToSettings('antigravity', versionHome, manifest, agentsDir);

    const settings = readAgySettings(versionHome);
    expect(settings.hooks.before_tool_call).toHaveLength(1);
  });

  it('returns error when script file does not exist', () => {
    const versionHome = makeAgyVersionHome();
    const manifest: Record<string, ManifestHook> = {
      missing: { script: 'does-not-exist.sh', events: ['PreToolUse'] },
    };

    const result = registerHooksToSettings('antigravity', versionHome, manifest, agentsDir);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('missing');
  });
});

describe('registerHooksToSettings - Claude', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
    agentsDir = path.join(tmpDir, '.agents');
    fs.mkdirSync(path.join(agentsDir, 'hooks'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeClaudeVersionHome(): string {
    const home = path.join(tmpDir, 'claude-home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    return home;
  }

  function readClaudeSettings(home: string): Record<string, any> {
    return JSON.parse(
      fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf-8')
    );
  }

  it('preserves env, mcpServers, permissions, and custom top-level keys (regression #137)', () => {
    const versionHome = makeClaudeVersionHome();
    const settingsPath = path.join(versionHome, '.claude', 'settings.json');

    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        env: { FOO: 'bar', DEBUG: 'true' },
        mcpServers: {
          fooServer: { command: '/bin/foo', args: ['--bar'] },
        },
        permissions: { allow: ['Bash(ls:*)'], deny: [] },
        customKey: { nested: 'preserved' },
      }, null, 2)
    );

    makeScript('pre-tool.sh');
    const manifest: Record<string, ManifestHook> = {
      'pre-tool': { script: 'pre-tool.sh', events: ['PreToolUse'], matcher: 'Bash' },
    };

    const result = registerHooksToSettings('claude', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);
    expect(result.registered).toContain('pre-tool -> PreToolUse');

    const settings = readClaudeSettings(versionHome);

    expect(settings.env).toEqual({ FOO: 'bar', DEBUG: 'true' });
    expect(settings.mcpServers).toEqual({
      fooServer: { command: '/bin/foo', args: ['--bar'] },
    });
    expect(settings.permissions).toEqual({ allow: ['Bash(ls:*)'], deny: [] });
    expect(settings.customKey).toEqual({ nested: 'preserved' });

    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].matcher).toBe('Bash');
    expect(settings.hooks.PreToolUse[0].hooks).toHaveLength(1);
    expect(resolvedCommand(settings.hooks.PreToolUse[0].hooks[0].command)).toBe(resolvedCommand(getHookShimPath('pre-tool')));
    expect(settings.hooks.PreToolUse[0].hooks[0].type).toBe('command');
  });

  it('writes hooks alongside an empty pre-existing settings.json', () => {
    const versionHome = makeClaudeVersionHome();
    const scriptPath = makeScript('on-prompt.sh');

    const manifest: Record<string, ManifestHook> = {
      'on-prompt': { script: 'on-prompt.sh', events: ['UserPromptSubmit'] },
    };

    const result = registerHooksToSettings('claude', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);

    const settings = readClaudeSettings(versionHome);
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(resolvedCommand(settings.hooks.UserPromptSubmit[0].hooks[0].command)).toBe(toPosix(scriptPath));
  });

  it('does not rewrite settings.json when registration is already current', () => {
    const versionHome = makeClaudeVersionHome();
    makeScript('stable.sh');
    const manifest: Record<string, ManifestHook> = {
      stable: { script: 'stable.sh', events: ['PreToolUse'], matcher: 'Bash' },
    };

    expect(registerHooksToSettings('claude', versionHome, manifest, agentsDir).errors).toHaveLength(0);
    const settingsPath = path.join(versionHome, '.claude', 'settings.json');
    const fixedTime = new Date('2020-01-02T03:04:05.000Z');
    fs.utimesSync(settingsPath, fixedTime, fixedTime);

    expect(registerHooksToSettings('claude', versionHome, manifest, agentsDir).errors).toHaveLength(0);
    expect(fs.statSync(settingsPath).mtimeMs).toBe(fixedTime.getTime());
  });
});

describe('registerHooksToSettings - Droid', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
    agentsDir = path.join(tmpDir, '.agents');
    fs.mkdirSync(path.join(agentsDir, 'hooks'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeDroidVersionHome(): string {
    const home = path.join(tmpDir, 'droid-home');
    fs.mkdirSync(path.join(home, '.factory'), { recursive: true });
    return home;
  }

  function readDroidSettings(home: string): Record<string, any> {
    return JSON.parse(
      fs.readFileSync(path.join(home, '.factory', 'settings.json'), 'utf-8')
    );
  }

  it('writes Claude-shaped matcher groups into .factory/settings.json', () => {
    const versionHome = makeDroidVersionHome();
    makeScript('pre-tool.sh');

    const manifest: Record<string, ManifestHook> = {
      'pre-tool': { script: 'pre-tool.sh', events: ['PreToolUse'], matcher: 'Bash', timeout: 45 },
    };

    const result = registerHooksToSettings('droid', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);
    expect(result.registered).toContain('pre-tool -> PreToolUse');

    const settings = readDroidSettings(versionHome);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].matcher).toBe('Bash');
    expect(settings.hooks.PreToolUse[0].hooks).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].hooks[0].type).toBe('command');
    expect(settings.hooks.PreToolUse[0].hooks[0].timeout).toBe(45);
    expect(resolvedCommand(settings.hooks.PreToolUse[0].hooks[0].command)).toBe(resolvedCommand(getHookShimPath('pre-tool')));
  });

  it('registers the events droid supports natively (SessionStart, UserPromptSubmit, Stop)', () => {
    const versionHome = makeDroidVersionHome();
    makeScript('start.sh');
    makeScript('prompt.sh');
    makeScript('stop.sh');

    const manifest: Record<string, ManifestHook> = {
      start: { script: 'start.sh', events: ['SessionStart'] },
      prompt: { script: 'prompt.sh', events: ['UserPromptSubmit'] },
      stop: { script: 'stop.sh', events: ['Stop'] },
    };

    const result = registerHooksToSettings('droid', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);

    const settings = readDroidSettings(versionHome);
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  it('preserves pre-existing non-hooks settings.json content', () => {
    const versionHome = makeDroidVersionHome();
    const settingsPath = path.join(versionHome, '.factory', 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ logoAnimation: 'off' }, null, 2));

    makeScript('pre-tool.sh');
    const manifest: Record<string, ManifestHook> = {
      'pre-tool': { script: 'pre-tool.sh', events: ['PreToolUse'] },
    };

    const result = registerHooksToSettings('droid', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);

    const settings = readDroidSettings(versionHome);
    expect(settings.logoAnimation).toBe('off');
    expect(settings.hooks.PreToolUse).toHaveLength(1);
  });
});

describe('registerHooksToSettings - Muse Code', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
    agentsDir = path.join(tmpDir, '.agents');
    fs.mkdirSync(path.join(agentsDir, 'hooks'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeMuseVersionHome(): string {
    const home = path.join(tmpDir, 'muse-home');
    fs.mkdirSync(path.join(home, '.config', 'muse'), { recursive: true });
    return home;
  }

  function readMuseSettings(home: string): Record<string, any> {
    return JSON.parse(
      fs.readFileSync(path.join(home, '.config', 'muse', 'settings.json'), 'utf-8')
    );
  }

  it('writes Claude-shaped hooks into ~/.config/muse/settings.json with schema_version: 1', () => {
    const versionHome = makeMuseVersionHome();
    makeScript('pre-tool.sh');

    const manifest: Record<string, ManifestHook> = {
      'pre-tool': { script: 'pre-tool.sh', events: ['PreToolUse'], matcher: 'Bash', timeout: 45 },
    };

    const result = registerHooksToSettings('muse', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);
    expect(result.registered).toContain('pre-tool -> PreToolUse');

    const settings = readMuseSettings(versionHome);
    expect(settings.schema_version).toBe(1);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].matcher).toBe('Bash');
    expect(settings.hooks.PreToolUse[0].hooks[0].type).toBe('command');
    expect(settings.hooks.PreToolUse[0].hooks[0].timeout).toBe(45);
  });

  it('registers Muse native lifecycle events (SessionStart, PreToolUse, Stop)', () => {
    const versionHome = makeMuseVersionHome();
    makeScript('start.sh');
    makeScript('pre.sh');
    makeScript('stop.sh');

    const manifest: Record<string, ManifestHook> = {
      start: { script: 'start.sh', events: ['SessionStart'] },
      pre: { script: 'pre.sh', events: ['PreToolUse'] },
      stop: { script: 'stop.sh', events: ['Stop'] },
    };

    const result = registerHooksToSettings('muse', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);

    const settings = readMuseSettings(versionHome);
    expect(settings.schema_version).toBe(1);
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  it('preserves existing settings keys and backfills schema_version', () => {
    const versionHome = makeMuseVersionHome();
    const settingsPath = path.join(versionHome, '.config', 'muse', 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ tui: { voice_enabled: true } }, null, 2));

    makeScript('pre-tool.sh');
    const manifest: Record<string, ManifestHook> = {
      'pre-tool': { script: 'pre-tool.sh', events: ['PreToolUse'] },
    };

    const result = registerHooksToSettings('muse', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);

    const settings = readMuseSettings(versionHome);
    expect(settings.schema_version).toBe(1);
    expect(settings.tui?.voice_enabled).toBe(true);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
  });
});

describe('toPortableCommand — portable hook commands (Windows path regression)', () => {
  const WIN_SEP = '\\';
  const winHome = 'C:\\Users\\me';
  const winHook =
    'C:\\Users\\me\\.agents\\.history\\versions\\claude\\2.1.201\\home\\.claude\\hooks\\06-attention-sentinel.sh';

  it('folds a Windows abs path under HOME to ~/ with forward slashes', () => {
    const out = toPortableCommand(winHook, winHome, WIN_SEP);
    expect(out).toBe(
      '~/.agents/.history/versions/claude/2.1.201/home/.claude/hooks/06-attention-sentinel.sh'
    );
  });

  it('never emits a backslash or drive-letter for a Windows path under HOME', () => {
    const out = toPortableCommand(winHook, winHome, WIN_SEP);
    expect(out).not.toContain('\\');
    expect(out).not.toMatch(/^[a-zA-Z]:/);
    expect(out.startsWith('~/')).toBe(true);
  });

  it('forward-slashes a Windows path OUTSIDE HOME (no verbatim backslashes)', () => {
    const out = toPortableCommand('D:\\tools\\hooks\\g.sh', winHome, WIN_SEP);
    expect(out).toBe('D:/tools/hooks/g.sh');
    expect(out).not.toContain('\\');
  });

  it('folds a POSIX abs path under HOME to ~/ (macOS/Linux behavior unchanged)', () => {
    const out = toPortableCommand('/home/me/.agents/hooks/g.sh', '/home/me', '/');
    expect(out).toBe('~/.agents/hooks/g.sh');
  });
});

describe('per-version hook entry pruning (settings accumulation regression)', () => {
  function guardCmd(version: string): string {
    return `~/.agents/.history/versions/claude/${version}/home/.claude/hooks/git-guard.sh`;
  }
  const SYSTEM_HOOK = '~/.agents/.system/hooks/00-agent-verify-work-complete.sh';
  const CUSTOM_HOOK = '~/dotfiles/hooks/my-personal-guard.sh';

  function preToolUseGroup(commands: string[]) {
    return {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: commands.map((command) => ({ type: 'command', command, timeout: 600 })),
        },
      ],
    };
  }

  function collectCommands(settings: Record<string, any>): string[] {
    const out: string[] = [];
    for (const groups of Object.values(settings.hooks ?? {})) {
      for (const group of groups as Array<{ hooks?: Array<{ command: string }> }>) {
        for (const h of group.hooks ?? []) out.push(h.command);
      }
    }
    return out;
  }

  describe('sync (registerHooksToSettings)', () => {
    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-prune-test-'));
      agentsDir = path.join(tmpDir, '.agents');
      fs.mkdirSync(path.join(agentsDir, 'hooks'), { recursive: true });
    });
    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('drops every other home\'s copy of a hook, keeps .system + custom hooks', () => {
      const versionHome = path.join(
        tmpDir, '.agents', '.history', 'versions', 'claude', '2.1.201', 'home'
      );
      const settingsPath = path.join(versionHome, '.claude', 'settings.json');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

      fs.writeFileSync(settingsPath, JSON.stringify({
        hooks: preToolUseGroup([
          guardCmd('2.1.186'),
          guardCmd('2.1.191'),
          guardCmd('2.1.201'),
          SYSTEM_HOOK,
          CUSTOM_HOOK,
        ]),
      }, null, 2));

      makeScript('git-guard.sh');
      const manifest: Record<string, ManifestHook> = {
        'git-guard': { script: 'git-guard.sh', events: ['PreToolUse'], matcher: 'Bash' },
      };

      const result = registerHooksToSettings('claude', versionHome, manifest, agentsDir);
      expect(result.errors).toHaveLength(0);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      const commands = collectCommands(settings);

      expect(commands.filter((c) => c.includes('.history/versions/claude/'))).toEqual([]);
      expect(commands.filter((c) => c.endsWith('git-guard.sh'))).toHaveLength(1);
      expect(commands).toContain(SYSTEM_HOOK);
      expect(commands).toContain(CUSTOM_HOOK);
    });

    it('collapses an exact-duplicate registration to a single hook', () => {
      const versionHome = path.join(
        tmpDir, '.agents', '.history', 'versions', 'claude', '2.1.201', 'home'
      );
      const settingsPath = path.join(versionHome, '.claude', 'settings.json');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      makeScript('git-guard.sh');
      const manifest: Record<string, ManifestHook> = {
        'git-guard': { script: 'git-guard.sh', events: ['PreToolUse'], matcher: 'Bash' },
      };
      registerHooksToSettings('claude', versionHome, manifest, agentsDir);
      const written = collectCommands(JSON.parse(fs.readFileSync(settingsPath, 'utf-8')));
      expect(written).toHaveLength(1);

      fs.writeFileSync(settingsPath, JSON.stringify({
        hooks: preToolUseGroup([written[0], written[0], CUSTOM_HOOK]),
      }, null, 2));
      const result = registerHooksToSettings('claude', versionHome, manifest, agentsDir);
      expect(result.errors).toHaveLength(0);

      const commands = collectCommands(JSON.parse(fs.readFileSync(settingsPath, 'utf-8')));
      expect(commands.filter((c) => c === written[0])).toEqual([written[0]]);
      expect(commands).toContain(CUSTOM_HOOK);
    });

    it('an account slot drops the version-home hook copies it carried forward', () => {
      // Observed 2026-10-06: every claude account slot ran each Stop hook twice, once from
      // its own hooks dir and once from a version home's (including a removed version).
      const slotHome = path.join(tmpDir, '.agents', '.history', 'accounts', 'claude', 'acct-1');
      const settingsPath = path.join(slotHome, '.claude', 'settings.json');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      const carried = '~/.agents/.history/versions/claude/2.1.219/home/.claude/hooks/stop-check.sh';
      const deleted = '~/.agents/.history/versions/claude/2.1.261/home/.claude/hooks/rabbit-hole-enforce.sh';
      fs.writeFileSync(settingsPath, JSON.stringify({
        hooks: { Stop: [{ hooks: [carried, deleted, CUSTOM_HOOK].map((command) => ({ type: 'command', command })) }] },
      }, null, 2));

      makeScript('stop-check.sh');
      const manifest: Record<string, ManifestHook> = {
        'stop-check': { script: 'stop-check.sh', events: ['Stop'] },
      };
      const result = registerHooksToSettings('claude', slotHome, manifest, agentsDir);
      expect(result.errors).toHaveLength(0);

      const commands = collectCommands(JSON.parse(fs.readFileSync(settingsPath, 'utf-8')));
      expect(commands).not.toContain(carried);
      expect(commands).not.toContain(deleted);
      expect(commands.filter((c) => c.endsWith('stop-check.sh'))).toHaveLength(1);
      expect(commands).toContain(CUSTOM_HOOK);
    });

    it('one script serving several events keeps exactly one command per event', () => {
      // feed-publish: the AskUserQuestion leg runs through a shim (it has a matcher), the Stop leg
      // runs the script directly. A direct registration left on PreToolUse ran it twice there.
      const versionHome = path.join(
        tmpDir, '.agents', '.history', 'versions', 'claude', '2.1.201', 'home'
      );
      const settingsPath = path.join(versionHome, '.claude', 'settings.json');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      const direct = makeScript('feed-publish.py');
      const manifest: Record<string, ManifestHook> = {
        'feed-publish': { script: 'feed-publish.py', events: ['PreToolUse'], matcher: 'AskUserQuestion' },
        'feed-clear-lifecycle': { script: 'feed-publish.py', events: ['Stop'] },
      };
      fs.writeFileSync(settingsPath, JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: direct }] }] },
      }, null, 2));

      const result = registerHooksToSettings('claude', versionHome, manifest, agentsDir);
      expect(result.errors).toHaveLength(0);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      const pre = settings.hooks.PreToolUse[0].hooks.map((h: { command: string }) => h.command);
      const stop = settings.hooks.Stop[0].hooks.map((h: { command: string }) => h.command);
      expect(pre).toHaveLength(1);
      expect(pre[0]).not.toBe(direct);
      expect(stop).toEqual([direct]);
    });
  });

  describe('remove (pruneVersionHomeHookEntriesFromSettings)', () => {
    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-remove-test-'));
    });
    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('removes only the removed version’s entries, keeping siblings + .system + custom', () => {
      const settingsPath = path.join(tmpDir, 'settings.json');
      fs.writeFileSync(settingsPath, JSON.stringify({
        hooks: preToolUseGroup([
          guardCmd('2.1.186'),
          guardCmd('2.1.191'),
          guardCmd('2.1.201'),
          SYSTEM_HOOK,
          CUSTOM_HOOK,
        ]),
      }, null, 2));

      const removed = pruneVersionHomeHookEntriesFromSettings(settingsPath, 'claude', '2.1.191');
      expect(removed).toBe(1);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      const commands = collectCommands(settings);
      expect(commands).not.toContain(guardCmd('2.1.191'));
      expect(commands).toContain(guardCmd('2.1.186'));
      expect(commands).toContain(guardCmd('2.1.201'));
      expect(commands).toContain(SYSTEM_HOOK);
      expect(commands).toContain(CUSTOM_HOOK);
    });

    it('never touches another agent’s version or non-version-home hooks', () => {
      const settingsPath = path.join(tmpDir, 'settings.json');
      fs.writeFileSync(settingsPath, JSON.stringify({
        hooks: preToolUseGroup([
          '~/.agents/.history/versions/droid/2.1.191/home/.factory/hooks/git-guard.sh',
          SYSTEM_HOOK,
          CUSTOM_HOOK,
        ]),
      }, null, 2));

      const removed = pruneVersionHomeHookEntriesFromSettings(settingsPath, 'claude', '2.1.191');
      expect(removed).toBe(0);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      const commands = collectCommands(settings);
      expect(commands).toHaveLength(3);
      expect(commands).toContain(SYSTEM_HOOK);
      expect(commands).toContain(CUSTOM_HOOK);
    });

    it('collapses a matcher group left empty after the prune', () => {
      const settingsPath = path.join(tmpDir, 'settings.json');
      fs.writeFileSync(settingsPath, JSON.stringify({
        hooks: preToolUseGroup([guardCmd('2.1.191')]),
      }, null, 2));

      const removed = pruneVersionHomeHookEntriesFromSettings(settingsPath, 'claude', '2.1.191');
      expect(removed).toBe(1);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(settings.hooks.PreToolUse).toEqual([]);
    });
  });
});

describe('registerHooksToSettings - grok + antigravity subrule hooks (RUSH-1353)', () => {
  let localTmp: string;
  let versionHome: string;
  let subruleScript: string;

  beforeEach(() => {
    localTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-subrule-'));
    versionHome = path.join(localTmp, 'version-home');
    fs.mkdirSync(versionHome, { recursive: true });
    const subruleDir = path.join(localTmp, 'rules', 'subrules', 'truly-agentic-git-workflow');
    fs.mkdirSync(subruleDir, { recursive: true });
    subruleScript = path.join(subruleDir, 'main-branch-guard.sh');
    fs.writeFileSync(subruleScript, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  });

  afterEach(() => {
    try { fs.rmSync(localTmp, { recursive: true, force: true }); } catch {  }
  });

  function subruleManifest(): Record<string, ManifestHook> {
    return {
      'truly-agentic-git-workflow__main-branch-guard': {
        events: ['PreToolUse'],
        matcher: 'Write|Edit',
        script: subruleScript,
        timeout: 10,
      },
    };
  }

  it('registers absolute subrule script into grok hooks.json with matcher', () => {
    const result = registerHooksToSettings('grok', versionHome, subruleManifest(), localTmp);
    expect(result.errors).toEqual([]);
    expect(result.registered.some((r) => r.includes('main-branch-guard'))).toBe(true);

    const hooksJson = path.join(versionHome, '.grok', 'hooks', 'hooks.json');
    expect(fs.existsSync(hooksJson)).toBe(true);
    const data = JSON.parse(fs.readFileSync(hooksJson, 'utf-8'));
    const groups = data.hooks?.PreToolUse ?? [];
    const flat = groups.flatMap((g: any) =>
      (g.hooks ?? []).map((h: any) => ({ command: h.command as string, matcher: g.matcher as string | undefined })),
    );
    expect(flat.some((e) => e.command.replace(/\\/g, '/').endsWith('main-branch-guard.sh'))).toBe(true);
    expect(flat.some((e) => e.matcher === 'Write|Edit')).toBe(true);
  });

  it('registers absolute subrule script into antigravity settings with matcher', () => {
    const result = registerHooksToSettings('antigravity', versionHome, subruleManifest(), localTmp);
    expect(result.errors).toEqual([]);
    expect(result.registered.some((r) => r.includes('main-branch-guard'))).toBe(true);

    const settingsPath = path.join(versionHome, '.gemini', 'antigravity-cli', 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const allEntries = Object.values(settings.hooks || {}).flat() as Array<{ command?: string; matcher?: string }>;
    expect(allEntries.some((e) => (e.command || '').replace(/\\/g, '/').endsWith('main-branch-guard.sh'))).toBe(true);
    expect(allEntries.some((e) => e.matcher === 'Write|Edit')).toBe(true);
  });
});
