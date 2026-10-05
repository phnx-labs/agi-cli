import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AGENTS, ALL_AGENT_IDS, MANAGED_AGENT_IDS, getAccountEmail, getMcpConfigPathForHome, isSelfUpdatingAgent, parseMcpConfig, resolveAgentName } from '../src/lib/agents.js';
import { writeMcpConfig } from '../src/lib/mcp.js';
import { convertToOpenCodeFormat, convertToCursorFormat, applyPermissionsToVersion } from '../src/lib/permissions.js';
import { capableAgents, supports } from '../src/lib/capabilities.js';
import {
  transformSubagentForDroid,
  transformSubagentForCodex,
  installSubagentToAgent,
  listSubagentsForAgent,
  transformSubagentForOpenCode,
} from '../src/lib/subagents.js';

describe('capableAgents("commands")', () => {
  it('excludes openclaw since it uses Gateway-based slash commands', () => {
    expect(capableAgents('commands')).not.toContain('openclaw');
  });

  it('includes all other agents that support file-based commands', () => {
    const expected = ['claude', 'codex', 'cursor', 'opencode'];
    const agents = capableAgents('commands');
    for (const agent of expected) {
      expect(agents).toContain(agent);
    }
  });

  it('is derived from capabilities.commands', () => {
    const fromCapabilities = MANAGED_AGENT_IDS.filter(id => AGENTS[id].capabilities.commands);
    expect(capableAgents('commands')).toEqual(fromCapabilities);
  });

  it('openclaw has empty commandsDir and commands:false', () => {
    expect(AGENTS['openclaw'].commandsDir).toBe('');
    expect(AGENTS['openclaw'].capabilities.commands).toBe(false);
  });

  it('agents with capabilities.commands have non-empty commandsDir', () => {
    for (const id of ALL_AGENT_IDS) {
      if (!AGENTS[id].capabilities.commands) continue;
      expect(AGENTS[id].commandsDir).not.toBe('');
    }
  });
});

describe('droid (Factory AI)', () => {
  it('is registered with its supported resource capabilities', () => {
    expect(ALL_AGENT_IDS).toContain('droid');
    expect(capableAgents('mcp')).toContain('droid');
    expect(capableAgents('commands')).toContain('droid');
    expect(capableAgents('subagents')).toContain('droid');
    expect(capableAgents('hooks')).toContain('droid');
    expect(capableAgents('plugins')).toContain('droid');
    expect(capableAgents('skills')).toContain('droid');
    expect(capableAgents('workflows')).not.toContain('droid');
    expect(AGENTS.droid.capabilities.workflows).toBe(false);
  });

  it('resolves MCP config to ~/.factory/mcp.json and parses the written shape back', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-droid-mcp-'));
    try {
      const configPath = getMcpConfigPathForHome('droid', home);
      expect(configPath).toBe(path.join(home, '.factory', 'mcp.json'));

      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(
        configPath,
        JSON.stringify({ mcpServers: { ctx: { command: 'ctx-server', args: ['--stdio'], env: {} } } })
      );

      const parsed = parseMcpConfig('droid', configPath);
      expect(Object.keys(parsed)).toContain('ctx');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('transformSubagentForDroid keeps name/description/model and drops color', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-droid-sub-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'AGENT.md'),
        `---\nname: reviewer\ndescription: Reviews diffs\nmodel: inherit\ncolor: red\n---\n\nYou review code.\n`
      );
      const out = transformSubagentForDroid(dir);
      expect(out).toContain('name: reviewer');
      expect(out).toContain('description: Reviews diffs');
      expect(out).toContain('model: inherit');
      expect(out).not.toContain('color');
      expect(out).toContain('You review code.');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});


describe('warp (Warp Agent CLI)', () => {
  it('is registered with a truthful capability set', () => {
    expect(ALL_AGENT_IDS).toContain('warp');
    expect(capableAgents('mcp')).toContain('warp');
    expect(capableAgents('skills')).toContain('warp');
    expect(capableAgents('mcpHttp')).toContain('warp');
    expect(capableAgents('mcpHeaders')).toContain('warp');
    expect(capableAgents('hooks')).not.toContain('warp');
    expect(capableAgents('allowlist')).not.toContain('warp');
    expect(capableAgents('commands')).not.toContain('warp');
    expect(capableAgents('plugins')).not.toContain('warp');
    expect(capableAgents('subagents')).not.toContain('warp');
    expect(capableAgents('workflows')).not.toContain('warp');
    expect(capableAgents('memory')).not.toContain('warp');
    expect(AGENTS.warp.cliCommand).toBe('warp');
    expect(AGENTS.warp.supportsHooks).toBe(false);
    expect(AGENTS.warp.instructionsFile).toBe('AGENTS.md');
    expect(AGENTS.warp.capabilities.rules).toEqual({ file: 'AGENTS.md' });
    expect(AGENTS.warp.capabilities.modes).toEqual(['edit']);
  });

  it('is a self-updating agent (curl install, no pinnable semver)', () => {
    expect(AGENTS.warp.npmPackage).toBe('');
    expect(AGENTS.warp.installScript).toContain('agent-cli');
    expect(isSelfUpdatingAgent('warp')).toBe(true);
  });

  it('resolves MCP config to ~/.warp/.mcp.json and round-trips the mcpServers shape', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-warp-mcp-'));
    try {
      const configPath = getMcpConfigPathForHome('warp', home);
      expect(configPath).toBe(path.join(home, '.warp', '.mcp.json'));

      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      writeMcpConfig('warp', configPath, [
        { name: 'ctx', command: 'ctx-server', args: ['--stdio'], env: {}, transport: 'stdio', scope: 'user' },
        { name: 'remote', url: 'https://mcp.example.com', headers: { Authorization: 'Bearer x' }, transport: 'http', scope: 'user' },
      ]);

      const parsed = parseMcpConfig('warp', configPath);
      expect(Object.keys(parsed)).toContain('ctx');
      expect(Object.keys(parsed)).toContain('remote');
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(raw.mcpServers.remote.headers).toEqual({ Authorization: 'Bearer x' });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('Muse Code install targets', () => {
  it('registers Muse with hooks, plugins, MCP, skills, AGENTS.md rules; no tool allowlist', () => {
    expect(ALL_AGENT_IDS).toContain('muse');
    expect(capableAgents('mcp')).toContain('muse');
    expect(capableAgents('skills')).toContain('muse');
    expect(capableAgents('memory')).toContain('muse');
    expect(capableAgents('hooks')).toContain('muse');
    expect(capableAgents('plugins')).toContain('muse');
    expect(capableAgents('allowlist')).not.toContain('muse');
    expect(capableAgents('commands')).not.toContain('muse');
    expect(capableAgents('subagents')).not.toContain('muse');
    expect(AGENTS.muse.cliCommand).toBe('muse');
    expect(AGENTS.muse.supportsHooks).toBe(true);
    expect(AGENTS.muse.pluginManifestDir).toBe('.muse-plugin');
    expect(AGENTS.muse.instructionsFile).toBe('AGENTS.md');
    expect(AGENTS.muse.capabilities.rules).toEqual({ file: 'AGENTS.md' });
    expect(AGENTS.muse.capabilities.modes).toEqual(['plan', 'edit', 'auto', 'skip']);
    expect(AGENTS.muse.installScript).toContain('dev.meta.ai/install.sh');
  });

  it('resolves Muse MCP config to ~/.config/muse/settings.json with mcp_servers + schema_version', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-muse-mcp-'));
    try {
      const configPath = getMcpConfigPathForHome('muse', home);
      expect(configPath).toBe(path.join(home, '.config', 'muse', 'settings.json'));

      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      writeMcpConfig(
        'muse',
        configPath,
        [{ name: 'ctx', transport: 'stdio', command: 'ctx-server', args: ['--stdio'] }],
        'overwrite',
      );

      const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(written.schema_version).toBe(1);
      expect(written.mcp_servers.ctx.transport).toBe('stdio');
      expect(written.mcp_servers.ctx.command).toBe('ctx-server');
      expect(written.mcp_servers.ctx.args).toEqual(['--stdio']);

      const parsed = parseMcpConfig('muse', configPath);
      expect(parsed.ctx.command).toBe('ctx-server');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('resolves muse aliases', () => {
    expect(resolveAgentName('muse')).toBe('muse');
    expect(resolveAgentName('muse-code')).toBe('muse');
    expect(resolveAgentName('meta-muse')).toBe('muse');
  });
});

describe('Hermes install targets', () => {
  it('registers Hermes with skills, MCP, plugins, and MEMORY.md rules', () => {
    expect(ALL_AGENT_IDS).toContain('hermes');
    expect(capableAgents('mcp')).toContain('hermes');
    expect(capableAgents('skills')).toContain('hermes');
    expect(capableAgents('plugins')).toContain('hermes');
    expect(capableAgents('commands')).not.toContain('hermes');
    expect(capableAgents('hooks')).toContain('hermes');
    expect(AGENTS.hermes.instructionsFile).toBe('MEMORY.md');
    expect(AGENTS.hermes.capabilities.rules).toEqual({ file: 'MEMORY.md' });
  });

  it('resolves Hermes MCP config to ~/.hermes/config.yaml and parses mcp_servers YAML', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-hermes-mcp-'));
    try {
      const configPath = getMcpConfigPathForHome('hermes', home);
      expect(configPath).toBe(path.join(home, '.hermes', 'config.yaml'));

      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(
        configPath,
        [
          'model: openrouter/anthropic/claude-sonnet-4',
          'mcp_servers:',
          '  ctx:',
          '    command: ctx-server',
          '    args:',
          '      - --stdio',
          '',
        ].join('\n')
      );

      const parsed = parseMcpConfig('hermes', configPath);
      expect(parsed.ctx.command).toBe('ctx-server');
      expect(parsed.ctx.args).toEqual(['--stdio']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('codex subagents (TOML custom agents)', () => {
  it('is capable of subagents since 0.117.0', () => {
    expect(capableAgents('subagents')).toContain('codex');
    expect(supports('codex', 'subagents', '0.116.0').ok).toBe(false);
    expect(supports('codex', 'subagents', '0.117.0').ok).toBe(true);
  });

  it('transformSubagentForCodex emits required TOML fields', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-codex-sub-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'AGENT.md'),
        `---\nname: reviewer\ndescription: Reviews diffs\nmodel: gpt-5.4\n---\n\nYou review code.\n`
      );
      const out = transformSubagentForCodex(dir);
      expect(out).toContain('name = "reviewer"');
      expect(out).toContain('description = "Reviews diffs"');
      expect(out).toContain('model = "gpt-5.4"');
      expect(out).toContain('developer_instructions = """');
      expect(out).toContain('You review code.');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('installSubagentToAgent writes ~/.codex/agents/<name>.toml', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-codex-inst-'));
    try {
      const subDir = path.join(root, 'sub');
      fs.mkdirSync(subDir);
      fs.writeFileSync(
        path.join(subDir, 'AGENT.md'),
        `---\nname: explorer\ndescription: Explores code\n---\n\nExplore.\n`
      );
      const home = path.join(root, 'home');
      const r = installSubagentToAgent(subDir, 'explorer', 'codex', home);
      expect(r.success).toBe(true);
      const dest = path.join(home, '.codex', 'agents', 'explorer.toml');
      expect(fs.existsSync(dest)).toBe(true);
      expect(fs.readFileSync(dest, 'utf-8')).toContain('name = "explorer"');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('kimi subagents (Claude-shaped agent markdown)', () => {
  it('is capable of subagents only from 0.29.0', () => {
    expect(capableAgents('subagents')).toContain('kimi');
    expect(supports('kimi', 'subagents', '0.29.0').ok).toBe(true);
    expect(supports('kimi', 'subagents', '0.34.0').ok).toBe(true);
    expect(supports('kimi', 'subagents', '0.28.0').ok).toBe(false);
    expect(supports('kimi', 'subagents', '0.19.2').ok).toBe(false);
  });

  it('installSubagentToAgent writes one <name>.md, no yaml pair or parent index', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-kimi-inst-'));
    try {
      const subDir = path.join(root, 'sub');
      fs.mkdirSync(subDir);
      fs.writeFileSync(
        path.join(subDir, 'AGENT.md'),
        `---\nname: explorer\ndescription: Explores code\n---\n\nExplore.\n`
      );
      const home = path.join(root, 'home');
      const r = installSubagentToAgent(subDir, 'explorer', 'kimi', home);
      expect(r.success).toBe(true);

      const agentsDir = path.join(home, '.kimi-code', 'agents');
      const dest = path.join(agentsDir, 'explorer.md');
      expect(fs.existsSync(dest)).toBe(true);
      expect(fs.existsSync(path.join(agentsDir, 'explorer.yaml'))).toBe(false);
      expect(fs.existsSync(path.join(agentsDir, 'explorer.system.md'))).toBe(false);
      expect(fs.existsSync(path.join(agentsDir, '_agents-cli.yaml'))).toBe(false);

      const body = fs.readFileSync(dest, 'utf-8');
      expect(body.startsWith('---\n')).toBe(true);
      expect(body).toContain('name: explorer');
      expect(body).toContain('description: Explores code');
      expect(body).toContain('Explore.');
      expect(body).not.toContain('system_prompt_path');
      expect(body).not.toContain('extend: default');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('listSubagentsForAgent finds the installed kimi markdown', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-kimi-list-'));
    try {
      const subDir = path.join(root, 'sub');
      fs.mkdirSync(subDir);
      fs.writeFileSync(
        path.join(subDir, 'AGENT.md'),
        `---\nname: explorer\ndescription: Explores code\n---\n\nExplore.\n`
      );
      const home = path.join(root, 'home');
      expect(installSubagentToAgent(subDir, 'explorer', 'kimi', home).success).toBe(true);

      const listed = listSubagentsForAgent('kimi', home);
      expect(listed.map(s => s.name)).toEqual(['explorer']);
      expect(listed[0].files).toContain('explorer.md');
      expect(listed[0].frontmatter.description).toBe('Explores code');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});


describe('grok subagents (Claude-compatible agent defs)', () => {
  it('is capable of subagents', () => {
    expect(capableAgents('subagents')).toContain('grok');
    expect(supports('grok', 'subagents').ok).toBe(true);
  });

  it('installSubagentToAgent writes ~/.grok/agents/<name>.md', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-grok-inst-'));
    try {
      const subDir = path.join(root, 'sub');
      fs.mkdirSync(subDir);
      fs.writeFileSync(
        path.join(subDir, 'AGENT.md'),
        `---\nname: explorer\ndescription: Explores code\n---\n\nExplore.\n`
      );
      const home = path.join(root, 'home');
      const r = installSubagentToAgent(subDir, 'explorer', 'grok', home);
      expect(r.success).toBe(true);
      const dest = path.join(home, '.grok', 'agents', 'explorer.md');
      expect(fs.existsSync(dest)).toBe(true);
      expect(fs.readFileSync(dest, 'utf-8')).toContain('name: explorer');
      expect(fs.readFileSync(dest, 'utf-8')).toContain('Explore.');
      const listed = listSubagentsForAgent('grok', home);
      expect(listed.map(s => s.name)).toEqual(['explorer']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});


describe('opencode capabilities', () => {
  it('advertises shell hooks through generated plugin modules since 0.3.130', () => {
    expect(capableAgents('hooks')).toContain('opencode');
    expect(AGENTS.opencode.supportsHooks).toBe(true);
    expect(AGENTS.opencode.capabilities.hooks).toEqual({ since: '0.3.130' });
  });

  it('is capable of allowlist since 1.1.1', () => {
    expect(capableAgents('allowlist')).toContain('opencode');
    expect(supports('opencode', 'allowlist', '1.1.0').ok).toBe(false);
    expect(supports('opencode', 'allowlist', '1.1.1').ok).toBe(true);
  });

  it('convertToOpenCodeFormat maps Bash patterns into permission.bash', () => {
    const out = convertToOpenCodeFormat({ name: 't', allow: ['Bash(git *)', 'Bash(*)'], deny: ['Bash(rm *)'] });
    expect(out.permission.bash['git *']).toBe('allow');
    expect(out.permission.bash['*']).toBe('allow');
    expect(out.permission.bash['rm *']).toBe('deny');
  });

  it('applyPermissionsToVersion writes permission.bash into opencode.jsonc', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-oc-perm-'));
    try {
      const home = path.join(root, 'home');
      const r = applyPermissionsToVersion(
        'opencode',
        { name: 't', allow: ['Bash(git *)'], deny: ['Bash(rm *)'] },
        home,
        false,
      );
      expect(r.success).toBe(true);
      const dest = path.join(home, '.config', 'opencode', 'opencode.jsonc');
      expect(fs.existsSync(dest)).toBe(true);
      const cfg = JSON.parse(fs.readFileSync(dest, 'utf-8'));
      expect(cfg.permission.bash['git *']).toBe('allow');
      expect(cfg.permission.bash['rm *']).toBe('deny');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});


describe('cursor allowlist (cli-config.json)', () => {
  it('is capable of allowlist', () => {
    expect(capableAgents('allowlist')).toContain('cursor');
    expect(supports('cursor', 'allowlist').ok).toBe(true);
  });

  it('convertToCursorFormat maps Bash to Shell', () => {
    const out = convertToCursorFormat({ name: 't', allow: ['Bash(git *)', 'Read(src/**)'], deny: ['Bash(rm *)'] });
    expect(out.permissions.allow).toContain('Shell(git *)');
    expect(out.permissions.allow).toContain('Read(src/**)');
    expect(out.permissions.deny).toContain('Shell(rm *)');
  });

  it('applyPermissionsToVersion writes ~/.cursor/cli-config.json', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cur-perm-'));
    try {
      const home = path.join(root, 'home');
      const r = applyPermissionsToVersion(
        'cursor',
        { name: 't', allow: ['Bash(ls)'], deny: ['Bash(rm)'] },
        home,
        false,
      );
      expect(r.success).toBe(true);
      const dest = path.join(home, '.cursor', 'cli-config.json');
      expect(fs.existsSync(dest)).toBe(true);
      const cfg = JSON.parse(fs.readFileSync(dest, 'utf-8'));
      expect(cfg.permissions.allow).toContain('Shell(ls)');
      expect(cfg.permissions.deny).toContain('Shell(rm)');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('opencode subagents (markdown mode: subagent)', () => {
  it('is capable of subagents', () => {
    expect(capableAgents('subagents')).toContain('opencode');
    expect(supports('opencode', 'subagents').ok).toBe(true);
  });

  it('transformSubagentForOpenCode emits mode subagent frontmatter', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-oc-sub-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'AGENT.md'),
        `---\nname: reviewer\ndescription: Reviews diffs\nmodel: anthropic/claude-sonnet-4\n---\n\nYou review code.\n`
      );
      const out = transformSubagentForOpenCode(dir);
      expect(out).toContain('mode: subagent');
      expect(out).toContain('description: Reviews diffs');
      expect(out).toContain('model: anthropic/claude-sonnet-4');
      expect(out).toContain('You review code.');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('installSubagentToAgent writes ~/.config/opencode/agents/<name>.md', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-oc-inst-'));
    try {
      const subDir = path.join(root, 'sub');
      fs.mkdirSync(subDir);
      fs.writeFileSync(
        path.join(subDir, 'AGENT.md'),
        `---\nname: explorer\ndescription: Explores code\n---\n\nExplore.\n`
      );
      const home = path.join(root, 'home');
      const r = installSubagentToAgent(subDir, 'explorer', 'opencode', home);
      expect(r.success).toBe(true);
      const dest = path.join(home, '.config', 'opencode', 'agents', 'explorer.md');
      expect(fs.existsSync(dest)).toBe(true);
      expect(fs.readFileSync(dest, 'utf-8')).toContain('mode: subagent');
      expect(listSubagentsForAgent('opencode', home).map(s => s.name)).toEqual(['explorer']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('getAccountEmail', () => {
  it('returns null for a Claude version home without oauthAccount even when real home is logged in', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-claude-auth-'));
    const realHome = path.join(tempRoot, 'real-home');
    const versionHome = path.join(tempRoot, 'version-home');
    fs.mkdirSync(realHome, { recursive: true });
    fs.mkdirSync(versionHome, { recursive: true });

    fs.writeFileSync(
      path.join(realHome, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'global@example.com' } })
    );
    fs.writeFileSync(
      path.join(versionHome, '.claude.json'),
      JSON.stringify({ mcpServers: {} })
    );

    const originalHome = process.env.HOME;
    process.env.HOME = realHome;

    try {
      await expect(getAccountEmail('claude', versionHome)).resolves.toBeNull();
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('uses the Claude version home when oauthAccount exists there', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-claude-auth-'));
    const realHome = path.join(tempRoot, 'real-home');
    const versionHome = path.join(tempRoot, 'version-home');
    fs.mkdirSync(realHome, { recursive: true });
    fs.mkdirSync(versionHome, { recursive: true });

    fs.writeFileSync(
      path.join(realHome, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'global@example.com' } })
    );
    fs.writeFileSync(
      path.join(versionHome, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'version@example.com' } })
    );
    fs.mkdirSync(path.join(versionHome, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(versionHome, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'at-test', refreshToken: 'rt-test', expiresAt: 1 } }),
      'utf-8',
    );

    const originalHome = process.env.HOME;
    process.env.HOME = realHome;

    try {
      await expect(getAccountEmail('claude', versionHome)).resolves.toBe('version@example.com');
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
