import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let TMP_HOME: string;
let USER_DIR: string;
let SYSTEM_DIR: string;
let PROJECT_DIR: string;
let VERSION_HOME: string;

vi.mock('./state.js', () => ({
  get getPluginsDir() { return () => path.join(USER_DIR, 'plugins'); },
  get getSystemPluginsDir() { return () => path.join(SYSTEM_DIR, 'plugins'); },
  get getExtraPluginsDir() { return (_alias: string) => path.join(TMP_HOME, '.agents-extras', _alias, 'plugins'); },
  get getProjectPluginsDir() { return (cwd: string = process.cwd()) => {
    const p = path.join(cwd, '.agents', 'plugins');
    return fs.existsSync(path.join(cwd, '.agents')) ? p : null;
  }; },
  get getProjectAgentsDir() { return (cwd: string = process.cwd()) => {
    const p = path.join(cwd, '.agents');
    return fs.existsSync(p) ? p : null;
  }; },
  get getEnabledExtraRepos() { return () => []; },
  get getVersionsDir() { return () => path.join(USER_DIR, '.history', 'versions'); },
  get getCliVersionCachePath() { return () => path.join(os.tmpdir(), 'agents-cli-version.json'); },
  get getUserRulesDir() { return () => path.join(USER_DIR, 'rules'); },
  get getResolvedRulesDir() { return () => path.join(SYSTEM_DIR, 'rules'); },
  get isReservedAgentsDir() { return (agentsPath: string) =>
    path.resolve(agentsPath) === path.resolve(USER_DIR)
    || path.resolve(agentsPath) === path.resolve(SYSTEM_DIR); },
}));

import { runLaunchSync } from './project-launch.js';
import { toPortableKey } from './platform/index.js';
import {
  MARKETPLACE_NAME,
  PROJECT_MARKETPLACE_NAME,
  SYSTEM_MARKETPLACE_NAME,
  marketplaceManifestPath,
  marketplaceRoot,
} from './plugins/plugin-marketplace.js';

function writeFile(abs: string, content: string): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function writePluginManifest(pluginDir: string, name: string, opts: { withMcp?: boolean } = {}): void {
  writeFile(path.join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: '0.0.1', description: `Test ${name}` }));
  if (opts.withMcp) {
    writeFile(path.join(pluginDir, '.mcp.json'), JSON.stringify({ mcpServers: { evil: { command: 'echo' } } }));
  }
}

function readJson(p: string): unknown {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

beforeEach(() => {
  TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-sync-test-'));
  USER_DIR = path.join(TMP_HOME, '.agents');
  SYSTEM_DIR = path.join(USER_DIR, '.system');
  PROJECT_DIR = path.join(TMP_HOME, 'project');
  VERSION_HOME = path.join(USER_DIR, '.history', 'versions', 'claude', '1.0.0', 'home');
  fs.mkdirSync(path.join(VERSION_HOME, '.claude'), { recursive: true });
  fs.mkdirSync(PROJECT_DIR, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {  }
});

describe('runLaunchSync — workspace resource mirror', () => {
  it('writes .agents/subagents/<name>/AGENT.md -> cwd/.claude/agents/<name>.md (flattened, regular file)', () => {
    writeFile(
      path.join(PROJECT_DIR, '.agents', 'subagents', 'probe-agent', 'AGENT.md'),
      '---\nname: probe-agent\ndescription: Probes things\nmodel: sonnet\n---\n\nProbe the codebase carefully.',
    );

    const result = runLaunchSync({ agent: 'claude', version: '1.0.0', cwd: PROJECT_DIR });

    expect(result.workspaceLinks).toBeGreaterThanOrEqual(1);
    const dest = path.join(PROJECT_DIR, '.claude', 'agents', 'probe-agent.md');
    expect(fs.lstatSync(dest).isFile()).toBe(true);
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false);
    const written = fs.readFileSync(dest, 'utf-8');
    expect(written).toMatch(/^---\nname: probe-agent\ndescription: Probes things\nmodel: sonnet\n---/);
    expect(written).toContain('Probe the codebase carefully.');
  });

  it('flattens a multi-file subagent (AGENT.md + SOUL.md) into ## sections', () => {
    writeFile(
      path.join(PROJECT_DIR, '.agents', 'subagents', 'probe-agent', 'AGENT.md'),
      '---\nname: probe-agent\ndescription: Probes things\n---\n\nMain body.',
    );
    writeFile(
      path.join(PROJECT_DIR, '.agents', 'subagents', 'probe-agent', 'SOUL.md'),
      'The soul of the agent.',
    );

    runLaunchSync({ agent: 'claude', version: '1.0.0', cwd: PROJECT_DIR });

    const written = fs.readFileSync(path.join(PROJECT_DIR, '.claude', 'agents', 'probe-agent.md'), 'utf-8');
    expect(written).toContain('Main body.');
    expect(written).toContain('## Soul');
    expect(written).toContain('The soul of the agent.');
  });

  it('refreshes a previously-generated subagent file on a later launch', () => {
    const agentMd = path.join(PROJECT_DIR, '.agents', 'subagents', 'probe-agent', 'AGENT.md');
    writeFile(agentMd, '---\nname: probe-agent\ndescription: v1\n---\n\nVersion one.');
    runLaunchSync({ agent: 'claude', version: '1.0.0', cwd: PROJECT_DIR });

    const dest = path.join(PROJECT_DIR, '.claude', 'agents', 'probe-agent.md');
    expect(fs.readFileSync(dest, 'utf-8')).toContain('Version one.');

    writeFile(agentMd, '---\nname: probe-agent\ndescription: v2\n---\n\nVersion two.');
    const result = runLaunchSync({ agent: 'claude', version: '1.0.0', cwd: PROJECT_DIR });

    expect(result.workspaceLinks).toBeGreaterThanOrEqual(1);
    const refreshed = fs.readFileSync(dest, 'utf-8');
    expect(refreshed).toContain('Version two.');
    expect(refreshed).not.toContain('Version one.');
  });

  it('mirrors commands and skills under .claude/, but NOT mcp.json (supply-chain surface)', () => {
    writeFile(path.join(PROJECT_DIR, '.agents', 'commands', 'deploy.md'), '# deploy command');
    writeFile(path.join(PROJECT_DIR, '.agents', 'skills', 'auditor', 'SKILL.md'), '# auditor skill');
    writeFile(path.join(PROJECT_DIR, '.agents', 'mcp.json'), JSON.stringify({ mcpServers: { evil: { command: 'echo' } } }));

    runLaunchSync({ agent: 'claude', version: '1.0.0', cwd: PROJECT_DIR });

    expect(fs.lstatSync(path.join(PROJECT_DIR, '.claude', 'commands', 'deploy.md')).isFile()).toBe(true);
    expect(fs.lstatSync(path.join(PROJECT_DIR, '.claude', 'skills', 'auditor')).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(PROJECT_DIR, '.mcp.json'))).toBe(false);
    const manifest = readJson(path.join(PROJECT_DIR, '.claude', '.agents-managed.json')) as { paths: string[] };
    expect(manifest.paths.sort()).toEqual(['commands/deploy.md', 'skills/auditor'].sort());
  });

  it('does not clobber a hand-authored .claude/agents/foo.md', () => {
    writeFile(path.join(PROJECT_DIR, '.agents', 'subagents', 'foo', 'AGENT.md'), '---\nname: foo\ndescription: from project\n---\n\nGenerated body.');
    writeFile(path.join(PROJECT_DIR, '.claude', 'agents', 'foo.md'), '# hand-authored — keep me');

    const result = runLaunchSync({ agent: 'claude', version: '1.0.0', cwd: PROJECT_DIR });

    expect(result.workspaceSkipped).toContain(path.join('.claude', 'agents', 'foo.md'));
    const dest = path.join(PROJECT_DIR, '.claude', 'agents', 'foo.md');
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(dest, 'utf-8')).toBe('# hand-authored — keep me');
  });

  it('does not clobber a dangling user symlink at the dest path', () => {
    writeFile(path.join(PROJECT_DIR, '.agents', 'subagents', 'foo', 'AGENT.md'), '---\nname: foo\ndescription: from project\n---\n\nGenerated body.');
    fs.mkdirSync(path.join(PROJECT_DIR, '.claude', 'agents'), { recursive: true });
    const danglingTarget = path.join(TMP_HOME, 'does-not-exist-pls-keep-this-dangling');
    fs.symlinkSync(danglingTarget, path.join(PROJECT_DIR, '.claude', 'agents', 'foo.md'));

    const result = runLaunchSync({ agent: 'claude', version: '1.0.0', cwd: PROJECT_DIR });

    expect(result.workspaceSkipped).toContain(path.join('.claude', 'agents', 'foo.md'));
    const dest = path.join(PROJECT_DIR, '.claude', 'agents', 'foo.md');
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('syncs project resources to Codex project-local directories', () => {
    writeFile(path.join(PROJECT_DIR, '.agents', 'commands', 'ship.md'), 'Ship it.');
    writeFile(path.join(PROJECT_DIR, '.agents', 'subagents', 'reviewer', 'AGENT.md'), '---\nname: reviewer\ndescription: Review code\n---\n\nReview.');

    const result = runLaunchSync({ agent: 'codex', version: '0.117.0', cwd: PROJECT_DIR });

    expect(result.workspaceLinks).toBe(2);
    expect(fs.existsSync(path.join(PROJECT_DIR, '.codex', 'skills', 'ship', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(PROJECT_DIR, '.codex', 'agents', 'reviewer.toml'))).toBe(true);
    const manifest = readJson(path.join(PROJECT_DIR, '.codex', '.agents-managed.json')) as { paths: string[] };
    expect(manifest.paths.sort()).toEqual(['agents/reviewer.toml', 'skills/ship'].sort());
  });

  it('is idempotent: running twice does not duplicate links', () => {
    writeFile(path.join(PROJECT_DIR, '.agents', 'subagents', 'r', 'AGENT.md'), '---\nname: r\ndescription: r\n---\n\nBody.');

    const first = runLaunchSync({ agent: 'claude', version: '1.0.0', cwd: PROJECT_DIR });
    const second = runLaunchSync({ agent: 'claude', version: '1.0.0', cwd: PROJECT_DIR });

    expect(first.workspaceLinks).toBe(second.workspaceLinks);
    expect(fs.readdirSync(path.join(PROJECT_DIR, '.claude', 'agents'))).toEqual(['r.md']);
  });

  it('removes manifest-owned stale project resources before refreshing', () => {
    const agentMd = path.join(PROJECT_DIR, '.agents', 'subagents', 'r', 'AGENT.md');
    writeFile(agentMd, '---\nname: r\ndescription: r\n---\n\nBody.');
    runLaunchSync({ agent: 'claude', version: '1.0.0', cwd: PROJECT_DIR });
    expect(fs.existsSync(path.join(PROJECT_DIR, '.claude', 'agents', 'r.md'))).toBe(true);

    fs.rmSync(path.dirname(agentMd), { recursive: true, force: true });
    runLaunchSync({ agent: 'claude', version: '1.0.0', cwd: PROJECT_DIR });

    expect(fs.existsSync(path.join(PROJECT_DIR, '.claude', 'agents', 'r.md'))).toBe(false);
    const manifest = readJson(path.join(PROJECT_DIR, '.claude', '.agents-managed.json')) as { paths: string[] };
    expect(manifest.paths).toEqual([]);
  });
});

describe('runLaunchSync — scoped plugin marketplaces', () => {
  it('synthesizes agents-project marketplace from cwd/.agents/plugins/*', () => {
    writePluginManifest(path.join(PROJECT_DIR, '.agents', 'plugins', 'myproj'), 'myproj');

    const result = runLaunchSync({ agent: 'claude', version: '1.0.0', cwd: PROJECT_DIR });

    expect(result.marketplaces[PROJECT_MARKETPLACE_NAME]).toContain('myproj');
    const manifestPath = marketplaceManifestPath(PROJECT_MARKETPLACE_NAME, 'claude', VERSION_HOME);
    const manifest = readJson(manifestPath) as { name: string; plugins: Array<{ name: string }> };
    expect(manifest.name).toBe(PROJECT_MARKETPLACE_NAME);
    expect(manifest.plugins.map(p => p.name)).toEqual(['myproj']);
  });

  it('does NOT auto-enable a project plugin that ships an .mcp.json (supply-chain gate)', () => {
    writePluginManifest(path.join(PROJECT_DIR, '.agents', 'plugins', 'evil'), 'evil', { withMcp: true });

    runLaunchSync({ agent: 'claude', version: '1.0.0', cwd: PROJECT_DIR });

    const settingsPath = path.join(VERSION_HOME, '.claude', 'settings.json');
    const settings = fs.existsSync(settingsPath)
      ? readJson(settingsPath) as { enabledPlugins?: Record<string, boolean> }
      : { enabledPlugins: undefined };
    expect(settings.enabledPlugins?.[`evil@${PROJECT_MARKETPLACE_NAME}`]).toBeUndefined();
    expect(fs.existsSync(path.join(marketplaceRoot(PROJECT_MARKETPLACE_NAME, 'claude', VERSION_HOME), 'plugins', 'evil'))).toBe(true);
  });

  it('DOES auto-enable a user-scope plugin even when it ships exec surfaces', () => {
    writePluginManifest(path.join(USER_DIR, 'plugins', 'myhooks'), 'myhooks', { withMcp: true });

    runLaunchSync({ agent: 'claude', version: '1.0.0', cwd: PROJECT_DIR });

    const settings = readJson(path.join(VERSION_HOME, '.claude', 'settings.json')) as { enabledPlugins: Record<string, boolean> };
    expect(settings.enabledPlugins[`myhooks@${MARKETPLACE_NAME}`]).toBe(true);
  });

  it('resolves cross-scope name collisions by precedence (project > user)', () => {
    writePluginManifest(path.join(USER_DIR, 'plugins', 'foo'), 'foo');
    writePluginManifest(path.join(PROJECT_DIR, '.agents', 'plugins', 'foo'), 'foo');

    const result = runLaunchSync({ agent: 'claude', version: '1.0.0', cwd: PROJECT_DIR });

    expect(result.marketplaces[PROJECT_MARKETPLACE_NAME]).toEqual(['foo']);
    expect(result.marketplaces[MARKETPLACE_NAME]).toBeUndefined();

    const settings = readJson(path.join(VERSION_HOME, '.claude', 'settings.json')) as { enabledPlugins: Record<string, boolean> };
    expect(settings.enabledPlugins[`foo@${PROJECT_MARKETPLACE_NAME}`]).toBe(true);
    expect(settings.enabledPlugins[`foo@${MARKETPLACE_NAME}`]).toBeUndefined();
  });

  it('prunes stale enabledPlugins for a plugin that moved from user to project scope', () => {
    writeFile(path.join(VERSION_HOME, '.claude', 'settings.json'), JSON.stringify({
      enabledPlugins: { [`foo@${MARKETPLACE_NAME}`]: true },
    }));
    writePluginManifest(path.join(PROJECT_DIR, '.agents', 'plugins', 'foo'), 'foo');

    runLaunchSync({ agent: 'claude', version: '1.0.0', cwd: PROJECT_DIR });

    const settings = readJson(path.join(VERSION_HOME, '.claude', 'settings.json')) as { enabledPlugins: Record<string, boolean> };
    expect(settings.enabledPlugins[`foo@${MARKETPLACE_NAME}`]).toBeUndefined();
    expect(settings.enabledPlugins[`foo@${PROJECT_MARKETPLACE_NAME}`]).toBe(true);
  });

  it('synthesizes agents-system and agents-cli (user) marketplaces separately', () => {
    writePluginManifest(path.join(SYSTEM_DIR, 'plugins', 'sysplug'), 'sysplug');
    writePluginManifest(path.join(USER_DIR, 'plugins', 'userplug'), 'userplug');

    const result = runLaunchSync({ agent: 'claude', version: '1.0.0', cwd: PROJECT_DIR });

    expect(result.marketplaces[SYSTEM_MARKETPLACE_NAME]).toEqual(['sysplug']);
    expect(result.marketplaces[MARKETPLACE_NAME]).toEqual(['userplug']);

    expect(fs.existsSync(path.join(marketplaceRoot(SYSTEM_MARKETPLACE_NAME, 'claude', VERSION_HOME), 'plugins', 'sysplug'))).toBe(true);
    expect(fs.existsSync(path.join(marketplaceRoot(MARKETPLACE_NAME, 'claude', VERSION_HOME), 'plugins', 'userplug'))).toBe(true);

    const known = readJson(path.join(VERSION_HOME, '.claude', 'plugins', 'known_marketplaces.json')) as Record<string, unknown>;
    expect(Object.keys(known).sort()).toEqual([MARKETPLACE_NAME, SYSTEM_MARKETPLACE_NAME].sort());
  });

  it('returns an empty marketplaces map when no plugin sources exist', () => {
    const result = runLaunchSync({ agent: 'claude', version: '1.0.0', cwd: PROJECT_DIR });

    expect(result.marketplaces).toEqual({});
  });

  it('skip-fast: a second launch with unchanged inputs does not rewrite marketplace.json', () => {
    writePluginManifest(path.join(USER_DIR, 'plugins', 'fast'), 'fast');

    runLaunchSync({ agent: 'claude', version: '1.0.0', cwd: PROJECT_DIR });
    const manifestPath = marketplaceManifestPath(MARKETPLACE_NAME, 'claude', VERSION_HOME);
    const mtime1 = fs.statSync(manifestPath).mtimeMs;

    const target = Date.now() + 25;
    while (Date.now() < target) {  }
    runLaunchSync({ agent: 'claude', version: '1.0.0', cwd: PROJECT_DIR });
    const mtime2 = fs.statSync(manifestPath).mtimeMs;

    expect(mtime2).toBe(mtime1);
  });

  it('skips plugin synthesis for agents without plugins capability (e.g. gemini)', () => {
    writePluginManifest(path.join(USER_DIR, 'plugins', 'plug'), 'plug');

    const result = runLaunchSync({ agent: 'gemini', version: '0.30.0', cwd: PROJECT_DIR });

    expect(result.marketplaces).toEqual({});
  });
});

describe('runLaunchSync — project rules compile', () => {
  it('compiles rules.yaml + subrules into cwd/AGENTS.md', () => {
    writeFile(path.join(PROJECT_DIR, '.agents', 'rules', 'rules.yaml'), 'presets:\n  default:\n    subrules:\n      - hello\n');
    writeFile(path.join(PROJECT_DIR, '.agents', 'rules', 'subrules', 'hello.md'), 'Hello from project rules.\n');

    const result = runLaunchSync({ agent: 'claude', version: '1.0.0', cwd: PROJECT_DIR });

    expect(result.rulesCompiled).toBe(true);
    const agentsMd = fs.readFileSync(path.join(PROJECT_DIR, 'AGENTS.md'), 'utf-8');
    expect(agentsMd).toContain('Hello from project rules.');
  });
});

describe('runLaunchSync — shim skip-fast sentinel', () => {
  let originalHome: string | undefined;
  beforeEach(() => {
    originalHome = process.env.HOME;
    process.env.HOME = TMP_HOME;
  });
  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
  });

  it('writes the bash skip-fast sentinel at the shim-expected path', () => {
    runLaunchSync({ agent: 'claude', version: '1.0.0', cwd: PROJECT_DIR });

    const slug = toPortableKey(PROJECT_DIR);
    const sentinel = path.join(USER_DIR, '.cache', 'launch-sync', `claude@1.0.0@${slug}`);
    expect(fs.existsSync(sentinel)).toBe(true);
  });

  it('sentinel mtime advances on a second run after the first', () => {
    runLaunchSync({ agent: 'claude', version: '1.0.0', cwd: PROJECT_DIR });
    const slug = toPortableKey(PROJECT_DIR);
    const sentinel = path.join(USER_DIR, '.cache', 'launch-sync', `claude@1.0.0@${slug}`);
    const t1 = fs.statSync(sentinel).mtimeMs;
    const target = Date.now() + 25;
    while (Date.now() < target) {  }
    runLaunchSync({ agent: 'claude', version: '1.0.0', cwd: PROJECT_DIR });
    const t2 = fs.statSync(sentinel).mtimeMs;
    expect(t2).toBeGreaterThan(t1);
  });
});
