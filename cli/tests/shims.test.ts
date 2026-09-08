import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { generateShimScript, generateVersionedAliasScript } from '../src/lib/installations/shims.js';

// We need to mock the versions directory, so we'll test the logic directly
// by creating temp directories that mimic the version structure

describe('shims - resource comparison', () => {
  let tempDir: string;
  let versionsDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-shims-test-'));
    versionsDir = path.join(tempDir, 'versions', 'claude');
    fs.mkdirSync(versionsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // Helper to create a version directory structure
  function createVersionDir(version: string, resources: {
    commands?: string[];
    skills?: string[];
    hooks?: string[];
    memory?: { file: string; content: string }[];
    mcp?: string[];
  }) {
    const versionPath = path.join(versionsDir, version, 'home', '.claude');
    fs.mkdirSync(versionPath, { recursive: true });

    // Create commands
    if (resources.commands?.length) {
      const commandsDir = path.join(versionPath, 'commands');
      fs.mkdirSync(commandsDir, { recursive: true });
      for (const cmd of resources.commands) {
        fs.writeFileSync(path.join(commandsDir, `${cmd}.md`), `# ${cmd}`);
      }
    }

    // Create skills
    if (resources.skills?.length) {
      const skillsDir = path.join(versionPath, 'skills');
      fs.mkdirSync(skillsDir, { recursive: true });
      for (const skill of resources.skills) {
        const skillPath = path.join(skillsDir, skill);
        fs.mkdirSync(skillPath, { recursive: true });
        fs.writeFileSync(path.join(skillPath, 'SKILL.md'), `# ${skill}`);
      }
    }

    // Create hooks
    if (resources.hooks?.length) {
      const hooksDir = path.join(versionPath, 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      for (const hook of resources.hooks) {
        fs.writeFileSync(path.join(hooksDir, hook), `#!/bin/bash\n# ${hook}`);
      }
    }

    // Create memory files
    if (resources.memory?.length) {
      for (const mem of resources.memory) {
        fs.writeFileSync(path.join(versionPath, mem.file), mem.content);
      }
    }

    // Create settings.json with MCP servers
    if (resources.mcp?.length) {
      const mcpServers: Record<string, { command: string }> = {};
      for (const server of resources.mcp) {
        mcpServers[server] = { command: `run-${server}` };
      }
      fs.writeFileSync(
        path.join(versionPath, 'settings.json'),
        JSON.stringify({ mcpServers }, null, 2)
      );
    }

    return versionPath;
  }

  // Helper to compare resources (mirrors the logic in shims.ts)
  function compareResources(currentPath: string, targetPath: string) {
    const listDir = (dir: string): string[] => {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter(f => !f.startsWith('.'));
    };

    const countLines = (filePath: string): number => {
      if (!fs.existsSync(filePath)) return 0;
      return fs.readFileSync(filePath, 'utf-8').split('\n').length;
    };

    const readMcpServers = (configPath: string): string[] => {
      const settingsPath = path.join(configPath, 'settings.json');
      if (!fs.existsSync(settingsPath)) return [];
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        return Object.keys(settings.mcpServers || {});
      } catch {
        return [];
      }
    };

    // Commands
    const currentCommands = listDir(path.join(currentPath, 'commands'));
    const targetCommands = new Set(listDir(path.join(targetPath, 'commands')));
    const commandsDiff = currentCommands.filter(c => !targetCommands.has(c)).map(c => c.replace(/\.md$/, ''));

    // Skills
    const currentSkills = listDir(path.join(currentPath, 'skills'));
    const targetSkills = new Set(listDir(path.join(targetPath, 'skills')));
    const skillsDiff = currentSkills.filter(s => !targetSkills.has(s));

    // Hooks
    const currentHooks = listDir(path.join(currentPath, 'hooks'));
    const targetHooks = new Set(listDir(path.join(targetPath, 'hooks')));
    const hooksDiff = currentHooks.filter(h => !targetHooks.has(h));

    // Memory
    const memoryFile = 'CLAUDE.md';
    const currentLines = countLines(path.join(currentPath, memoryFile));
    const targetLines = countLines(path.join(targetPath, memoryFile));
    const memoryDiff = currentLines > 0 && currentLines !== targetLines
      ? [{ file: memoryFile, currentLines, targetLines }]
      : [];

    // MCP
    const currentMcp = readMcpServers(currentPath);
    const targetMcp = new Set(readMcpServers(targetPath));
    const mcpDiff = currentMcp.filter(m => !targetMcp.has(m));

    return {
      commands: commandsDiff,
      skills: skillsDiff,
      hooks: hooksDiff,
      memory: memoryDiff,
      mcp: mcpDiff,
    };
  }

  test('detects missing commands in target', () => {
    const v1Path = createVersionDir('1.0.0', {
      commands: ['deploy', 'test', 'lint'],
    });
    const v2Path = createVersionDir('2.0.0', {
      commands: ['deploy'],
    });

    const diff = compareResources(v1Path, v2Path);

    expect(diff.commands).toContain('test');
    expect(diff.commands).toContain('lint');
    expect(diff.commands).not.toContain('deploy');
    expect(diff.commands.length).toBe(2);
  });

  test('detects missing skills in target', () => {
    const v1Path = createVersionDir('1.0.0', {
      skills: ['code-review', 'testing', 'docs'],
    });
    const v2Path = createVersionDir('2.0.0', {
      skills: ['code-review'],
    });

    const diff = compareResources(v1Path, v2Path);

    expect(diff.skills).toContain('testing');
    expect(diff.skills).toContain('docs');
    expect(diff.skills).not.toContain('code-review');
  });

  test('detects missing hooks in target', () => {
    const v1Path = createVersionDir('1.0.0', {
      hooks: ['pre-commit.sh', 'post-push.sh'],
    });
    const v2Path = createVersionDir('2.0.0', {
      hooks: [],
    });

    const diff = compareResources(v1Path, v2Path);

    expect(diff.hooks).toContain('pre-commit.sh');
    expect(diff.hooks).toContain('post-push.sh');
    expect(diff.hooks.length).toBe(2);
  });

  test('detects memory file differences', () => {
    const v1Path = createVersionDir('1.0.0', {
      memory: [{ file: 'CLAUDE.md', content: 'line1\nline2\nline3\nline4\nline5' }],
    });
    const v2Path = createVersionDir('2.0.0', {
      memory: [{ file: 'CLAUDE.md', content: '' }],
    });

    const diff = compareResources(v1Path, v2Path);

    expect(diff.memory.length).toBe(1);
    expect(diff.memory[0].file).toBe('CLAUDE.md');
    expect(diff.memory[0].currentLines).toBe(5);
    expect(diff.memory[0].targetLines).toBe(1); // empty file has 1 line
  });

  test('detects missing MCP servers in target', () => {
    const v1Path = createVersionDir('1.0.0', {
      mcp: ['github', 'slack', 'notion'],
    });
    const v2Path = createVersionDir('2.0.0', {
      mcp: ['github'],
    });

    const diff = compareResources(v1Path, v2Path);

    expect(diff.mcp).toContain('slack');
    expect(diff.mcp).toContain('notion');
    expect(diff.mcp).not.toContain('github');
  });

  test('returns empty diff when versions are identical', () => {
    const resources = {
      commands: ['deploy', 'test'],
      skills: ['review'],
      hooks: ['pre-commit.sh'],
      memory: [{ file: 'CLAUDE.md', content: 'same content' }],
      mcp: ['github'],
    };
    const v1Path = createVersionDir('1.0.0', resources);
    const v2Path = createVersionDir('2.0.0', resources);

    const diff = compareResources(v1Path, v2Path);

    expect(diff.commands.length).toBe(0);
    expect(diff.skills.length).toBe(0);
    expect(diff.hooks.length).toBe(0);
    expect(diff.memory.length).toBe(0);
    expect(diff.mcp.length).toBe(0);
  });

  test('handles missing directories gracefully', () => {
    const v1Path = createVersionDir('1.0.0', {
      commands: ['deploy'],
    });
    // v2 has no resources at all
    const v2Path = path.join(versionsDir, '2.0.0', 'home', '.claude');
    fs.mkdirSync(v2Path, { recursive: true });

    const diff = compareResources(v1Path, v2Path);

    expect(diff.commands).toContain('deploy');
    expect(diff.skills.length).toBe(0);
    expect(diff.hooks.length).toBe(0);
  });

  test('detects all resource types at once', () => {
    const v1Path = createVersionDir('1.0.0', {
      commands: ['deploy', 'test', 'lint'],
      skills: ['code-review', 'testing'],
      hooks: ['pre-commit.sh'],
      memory: [{ file: 'CLAUDE.md', content: 'lots\nof\nlines\nhere' }],
      mcp: ['github', 'slack'],
    });
    const v2Path = createVersionDir('2.0.0', {
      commands: ['deploy'],
      skills: [],
      hooks: [],
      memory: [{ file: 'CLAUDE.md', content: '' }],
      mcp: [],
    });

    const diff = compareResources(v1Path, v2Path);

    expect(diff.commands.length).toBe(2); // test, lint
    expect(diff.skills.length).toBe(2); // code-review, testing
    expect(diff.hooks.length).toBe(1); // pre-commit.sh
    expect(diff.memory.length).toBe(1); // CLAUDE.md differs
    expect(diff.mcp.length).toBe(2); // github, slack
  });
});

describe('codex shim launch flags', () => {
  test('injects update-check disable flag into the codex shim', () => {
    const script = generateShimScript('codex');
    expect(script).toContain("'check_for_update_on_startup=false'");
  });

  test('injects update-check disable flag into codex versioned aliases', () => {
    const script = generateVersionedAliasScript('codex', '0.116.0');
    expect(script).toContain("'check_for_update_on_startup=false'");
  });

  test('does not add the codex-only flag to other shims', () => {
    const claudeScript = generateShimScript('claude');
    const geminiScript = generateShimScript('gemini');
    expect(claudeScript).not.toContain('check_for_update_on_startup=false');
    expect(geminiScript).not.toContain('check_for_update_on_startup=false');
  });
});

describe('shims - hasResourceDiff', () => {
  const emptyDiff = { commands: [], skills: [], hooks: [], memory: [], mcp: [] };

  test('returns false for empty diff', () => {
    const hasDiff = (diff: typeof emptyDiff) =>
      diff.commands.length > 0 ||
      diff.skills.length > 0 ||
      diff.hooks.length > 0 ||
      diff.memory.length > 0 ||
      diff.mcp.length > 0;

    expect(hasDiff(emptyDiff)).toBe(false);
  });

  test('returns true when commands differ', () => {
    const hasDiff = (diff: typeof emptyDiff) =>
      diff.commands.length > 0 ||
      diff.skills.length > 0 ||
      diff.hooks.length > 0 ||
      diff.memory.length > 0 ||
      diff.mcp.length > 0;

    expect(hasDiff({ ...emptyDiff, commands: ['test'] })).toBe(true);
  });

  test('returns true when any resource type differs', () => {
    const hasDiff = (diff: typeof emptyDiff & { memory: { file: string }[] }) =>
      diff.commands.length > 0 ||
      diff.skills.length > 0 ||
      diff.hooks.length > 0 ||
      diff.memory.length > 0 ||
      diff.mcp.length > 0;

    expect(hasDiff({ ...emptyDiff, skills: ['review'] })).toBe(true);
    expect(hasDiff({ ...emptyDiff, hooks: ['pre.sh'] })).toBe(true);
    expect(hasDiff({ ...emptyDiff, memory: [{ file: 'CLAUDE.md' }] })).toBe(true);
    expect(hasDiff({ ...emptyDiff, mcp: ['github'] })).toBe(true);
  });
});

describe('shims - generateShimScript', () => {
  test('reads agents.yaml not meta.yaml', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('agents.yaml');
    expect(script).not.toContain('meta.yaml');
  });

  test('parses flat agents format', () => {
    const script = generateShimScript('claude');
    // Should look for ^agents: section, not ^versions:
    expect(script).toContain('^agents:');
    expect(script).not.toContain('^versions:');
    // Should not look for nested default: key
    expect(script).not.toContain('default:');
  });

  test('includes agent name and CLI command', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('AGENT="claude"');
    expect(script).toContain('CLI_COMMAND="claude"');
    expect(script).toContain('#!/bin/bash');
  });

  test('generates correct script for codex agent', () => {
    const script = generateShimScript('codex');
    expect(script).toContain('AGENT="codex"');
    expect(script).toContain('agents.yaml');
    expect(script).not.toContain('meta.yaml');
  });

  test('does not include foreground project sync in shim', () => {
    const script = generateShimScript('claude');
    expect(script).not.toContain('find_project_agents_dir');
    // sync IS called on the hot path, but only with --launch (filesystem-only,
    // sub-50ms, non-blocking). A foreground sync without --launch is forbidden.
    expect(script).not.toMatch(/"\$AGENTS_BIN" sync\b(?![^\n]*--launch)/);
  });

  test('non-@-capable agents do not refresh rules on the launch hot path', () => {
    const script = generateShimScript('codex');
    expect(script).not.toContain('"$AGENTS_BIN" refresh-rules --agent "$AGENT"');
  });

  test('shim does not use --version flag, which collides with the top-level CLI version flag', () => {
    // Commander's `.version()` on the top-level program intercepts any
    // `--version <value>` before subcommands see it — passing --version to
    // `sync` or `refresh-rules` would silently print the CLI version and
    // exit 0 instead of running the subcommand. Guard against regression.
    for (const agent of ['claude', 'codex', 'gemini', 'cursor', 'opencode', 'openclaw'] as const) {
      const script = generateShimScript(agent);
      expect(script, `${agent} shim must not pass --version to subcommands`).not.toMatch(/--version[ =]"?\$VERSION/);
    }
  });

  test('@-capable agents do NOT get a refresh-rules shim hook', () => {
    const claudeScript = generateShimScript('claude');
    expect(claudeScript).not.toContain('refresh-rules');
    const geminiScript = generateShimScript('gemini');
    expect(geminiScript).not.toContain('refresh-rules');
  });

  test('scopes Claude keychain auth to the selected version config dir', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('export CLAUDE_CONFIG_DIR="$VERSION_DIR/home/.claude"');
  });

  test('does not inject Claude keychain scoping for non-Claude agents', () => {
    const script = generateShimScript('codex');
    expect(script).not.toContain('CLAUDE_CONFIG_DIR');
  });
});

describe('shims - generateVersionedAliasScript', () => {
  test('scopes Claude version aliases to their config dir', () => {
    const script = generateVersionedAliasScript('claude', '2.1.110');
    // The alias now reuses the main shim's adapter block, keyed off VERSION_DIR, so
    // CLAUDE_CONFIG_DIR resolves to the same per-version config dir as before.
    expect(script).toContain('VERSION_DIR="$AGENTS_REAL_HOME/.agents/.history/versions/claude/2.1.110"');
    expect(script).toContain('export CLAUDE_CONFIG_DIR="$VERSION_DIR/home/.claude"');
  });

  test('does not inject Claude keychain scoping for non-Claude aliases', () => {
    const script = generateVersionedAliasScript('codex', '0.98.0');
    expect(script).not.toContain('CLAUDE_CONFIG_DIR');
  });
});
