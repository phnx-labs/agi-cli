/** Tests for per-DotAgents-repo marketplaces: naming, discovery, catalog synthesis, registration.
 * Real tmp filesystem; only state.js path getters are redirected (as in plugins.test.ts). */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  MARKETPLACE_NAME,
  PROJECT_MARKETPLACE_NAME,
  marketplaceNameFor,
  marketplaceRoot,
  marketplaceManifestPath,
  knownMarketplacesPath,
  copyPluginToMarketplace,
  syncMarketplaceManifest,
  registerMarketplace,
  unregisterMarketplace,
  addPluginToSettings,
  removePluginFromSettings,
  registerCopilotInstalledPlugin,
  unregisterCopilotInstalledPlugin,
  validateClaudePluginManifest,
} from './plugin-marketplace.js';
import type { DiscoveredPlugin, MarketplaceSpec } from '../types.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Write a real plugin source tree (dir + .claude-plugin/plugin.json). */
function writePluginSource(parent: string, name: string, extra: Record<string, unknown> = {}): string {
  const root = path.join(parent, name);
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, version: '1.0.0', description: `desc-${name}`, ...extra })
  );
  return root;
}

function discoveredPlugin(root: string, name: string): DiscoveredPlugin {
  return {
    name, root,
    manifest: { name, version: '1.0.0', description: `desc-${name}` },
    skills: [], hooks: [], scripts: [], commands: [], agentDefs: [], workflows: [], bin: [],
    mcpServers: [], lspServers: [], monitors: [],
    hasMcp: false, hasSettings: false,
  };
}

/** Copy a plugin into a marketplace dest (the version-home side) for synth tests. */
function installInto(spec: MarketplaceSpec, plugin: DiscoveredPlugin, versionHome: string): void {
  copyPluginToMarketplace(plugin, spec, 'claude', versionHome);
}

const SPECS = {
  user: { kind: 'user' } as MarketplaceSpec,
  project: (root: string) => ({ kind: 'project', root } as MarketplaceSpec),
  extra: (alias: string, root: string) => ({ kind: 'extra', alias, root } as MarketplaceSpec),
};

// ─── marketplaceNameFor ─────────────────────────────────────────────────────

describe('marketplaceNameFor', () => {
  it('maps user → agents-cli', () => {
    expect(marketplaceNameFor(SPECS.user)).toBe('agents-cli');
    expect(MARKETPLACE_NAME).toBe('agents-cli');
  });

  it('maps extra alias=extras → agents-extras', () => {
    expect(marketplaceNameFor(SPECS.extra('extras', '/x/plugins'))).toBe('agents-extras');
  });

  it('maps project → agents-project', () => {
    expect(marketplaceNameFor(SPECS.project('/p/plugins'))).toBe('agents-project');
    expect(PROJECT_MARKETPLACE_NAME).toBe('agents-project');
  });
});

// ─── discoverMarketplaces ───────────────────────────────────────────────────

describe('discoverMarketplaces', () => {
  let tmpDir: string;
  let userPlugins: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-mkt-'));
    userPlugins = path.join(tmpDir, 'user', 'plugins');
    fs.mkdirSync(userPlugins, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function withState(
    overrides: {
      pluginsDir?: string;
      extras?: Array<{ alias: string; dir: string; url: string }>;
      projectPlugins?: string | null;
      systemPlugins?: string | null;
    },
    fn: (mod: typeof import('./plugin-marketplace.js')) => void | Promise<void>
  ): Promise<void> {
    const { vi } = await import('vitest');
    vi.resetModules();
    vi.doMock('../state.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../state.js')>();
      return {
        ...actual,
        getPluginsDir: () => overrides.pluginsDir ?? userPlugins,
        getEnabledExtraRepos: () => overrides.extras ?? [],
        getProjectPluginsDir: () => overrides.projectPlugins ?? null,
        // Default to a non-existent path so tests that don't opt into a system
        // repo see no agents-system marketplace (deterministic across machines
        // that may have a real ~/.agents/.system/plugins on disk).
        getSystemPluginsDir: () => overrides.systemPlugins ?? path.join(tmpDir, 'no-system', 'plugins'),
      };
    });
    try {
      const mod = await import('./plugin-marketplace.js');
      await fn(mod);
    } finally {
      vi.doUnmock('../state.js');
      vi.resetModules();
    }
  }

  it('finds only the user marketplace when no extras/project exist', async () => {
    await withState({}, ({ discoverMarketplaces }) => {
      const found = discoverMarketplaces();
      expect(found.map(m => m.name)).toEqual(['agents-cli']);
      expect(found[0].pluginsRoot).toBe(userPlugins);
      expect(found[0].spec.kind).toBe('user');
    });
  });

  it('returns user + each enabled extra repo, skipping disabled (filtered upstream)', async () => {
    const extraDir = path.join(tmpDir, 'extra-extras');
    fs.mkdirSync(path.join(extraDir, 'plugins'), { recursive: true });
    // getEnabledExtraRepos already filters disabled repos — we feed only enabled ones.
    await withState(
      { extras: [{ alias: 'extras', dir: extraDir, url: 'gh:x/y' }] },
      ({ discoverMarketplaces }) => {
        const found = discoverMarketplaces();
        expect(found.map(m => m.name)).toEqual(['agents-cli', 'agents-extras']);
        const extra = found[1];
        expect(extra.spec).toMatchObject({ kind: 'extra', alias: 'extras' });
        expect(extra.pluginsRoot).toBe(path.join(extraDir, 'plugins'));
      }
    );
  });

  it('skips an extra repo whose plugins/ dir does not exist on disk', async () => {
    const extraDir = path.join(tmpDir, 'extra-empty'); // no plugins/ subdir
    fs.mkdirSync(extraDir, { recursive: true });
    await withState(
      { extras: [{ alias: 'empty', dir: extraDir, url: 'gh:x/y' }] },
      ({ discoverMarketplaces }) => {
        expect(discoverMarketplaces().map(m => m.name)).toEqual(['agents-cli']);
      }
    );
  });

  it('includes the project marketplace when cwd has .agents/plugins/', async () => {
    const projectPlugins = path.join(tmpDir, 'proj', '.agents', 'plugins');
    fs.mkdirSync(projectPlugins, { recursive: true });
    await withState({ projectPlugins }, ({ discoverMarketplaces }) => {
      const found = discoverMarketplaces({ cwd: '/whatever' });
      expect(found.map(m => m.name)).toEqual(['agents-cli', 'agents-project']);
      expect(found[1].spec).toMatchObject({ kind: 'project', root: projectPlugins });
    });
  });

  it('includes the system marketplace FIRST when ~/.agents/.system/plugins/ exists', async () => {
    const systemPlugins = path.join(tmpDir, 'system', 'plugins');
    fs.mkdirSync(systemPlugins, { recursive: true });
    await withState({ systemPlugins }, ({ discoverMarketplaces }) => {
      const found = discoverMarketplaces();
      // System listed first (lowest precedence), then the user repo.
      expect(found.map(m => m.name)).toEqual(['agents-system', 'agents-cli']);
      expect(found[0].spec).toMatchObject({ kind: 'system', root: systemPlugins });
      expect(found[0].pluginsRoot).toBe(systemPlugins);
    });
  });

  it('skips the system marketplace when its plugins/ dir does not exist', async () => {
    await withState({ systemPlugins: path.join(tmpDir, 'absent', 'plugins') }, ({ discoverMarketplaces }) => {
      expect(discoverMarketplaces().map(m => m.name)).toEqual(['agents-cli']);
    });
  });

  it('orders marketplaces low→high precedence so name-dedupe keeps the highest scope', async () => {
    const systemPlugins = path.join(tmpDir, 'system', 'plugins');
    const extraDir = path.join(tmpDir, 'extra-extras');
    const projectPlugins = path.join(tmpDir, 'proj', '.agents', 'plugins');
    fs.mkdirSync(systemPlugins, { recursive: true });
    fs.mkdirSync(path.join(extraDir, 'plugins'), { recursive: true });
    fs.mkdirSync(projectPlugins, { recursive: true });
    await withState(
      { systemPlugins, extras: [{ alias: 'extras', dir: extraDir, url: 'gh:x/y' }], projectPlugins },
      ({ discoverMarketplaces }) => {
        // Order is the dedupe order consumers rely on (Map/last-wins): a plugin
        // present in multiple repos resolves to project > extra > user > system.
        expect(discoverMarketplaces({ cwd: '/whatever' }).map(m => m.name)).toEqual([
          'agents-system',
          'agents-cli',
          'agents-extras',
          'agents-project',
        ]);
      }
    );
  });
});

// ─── syncMarketplaceManifest ─────────────────────────────────────────────────

describe('syncMarketplaceManifest', () => {
  let tmpDir: string;
  let versionHome: string;
  let srcDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-mkt-'));
    versionHome = path.join(tmpDir, 'home');
    fs.mkdirSync(path.join(versionHome, '.claude'), { recursive: true });
    srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when the marketplace plugins dir does not exist', () => {
    expect(syncMarketplaceManifest(SPECS.user, 'claude', versionHome)).toBeNull();
  });

  it.each([
    ['user', SPECS.user, 'agents-cli'],
    ['extra', SPECS.extra('extras', '/x/plugins'), 'agents-extras'],
    ['project', SPECS.project('/p/plugins'), 'agents-project'],
  ] as Array<[string, MarketplaceSpec, string]>)(
    'synthesizes a marketplace.json named %s with the copied plugin list',
    (_label, spec, expectedName) => {
      const root = writePluginSource(srcDir, 'alpha');
      installInto(spec, discoveredPlugin(root, 'alpha'), versionHome);

      const manifest = syncMarketplaceManifest(spec, 'claude', versionHome);
      expect(manifest).not.toBeNull();
      expect(manifest!.name).toBe(expectedName);
      expect(manifest!.plugins.map(p => p.name)).toEqual(['alpha']);
      expect(manifest!.plugins[0]).toMatchObject({ name: 'alpha', source: './plugins/alpha', version: '1.0.0' });

      // Manifest is written to disk at the expected path.
      const onDisk = JSON.parse(fs.readFileSync(marketplaceManifestPath(spec, 'claude', versionHome), 'utf-8'));
      expect(onDisk.name).toBe(expectedName);
    }
  );

  it('FOLLOWS SYMLINKS — a plugin symlinked into the marketplace plugins dir is catalogued', () => {
    // Reproduces the phoenix/prix/rush case: plugins that are symlinks-to-dirs.
    // The old code used Dirent.isDirectory() which is false for a symlink and
    // silently dropped them. statSync follows the link.
    const realPlugin = writePluginSource(srcDir, 'linked');
    const mktPluginsDir = path.join(marketplaceRoot(SPECS.user, 'claude', versionHome), 'plugins');
    fs.mkdirSync(mktPluginsDir, { recursive: true });
    fs.symlinkSync(realPlugin, path.join(mktPluginsDir, 'linked'), 'dir');

    const manifest = syncMarketplaceManifest(SPECS.user, 'claude', versionHome);
    expect(manifest!.plugins.map(p => p.name)).toEqual(['linked']);
  });

  it('sorts plugins by name and skips dirs without a plugin.json', () => {
    installInto(SPECS.user, discoveredPlugin(writePluginSource(srcDir, 'zeta'), 'zeta'), versionHome);
    installInto(SPECS.user, discoveredPlugin(writePluginSource(srcDir, 'beta'), 'beta'), versionHome);
    // A stray dir with no manifest must be ignored.
    fs.mkdirSync(path.join(marketplaceRoot(SPECS.user, 'claude', versionHome), 'plugins', 'not-a-plugin'), { recursive: true });

    const manifest = syncMarketplaceManifest(SPECS.user, 'claude', versionHome);
    expect(manifest!.plugins.map(p => p.name)).toEqual(['beta', 'zeta']);
  });

  it('WIRING: warns to stderr when a synced plugin ships a Claude-invalid manifest', () => {
    // The real bug: a plugin.json with bare-name skills syncs "successfully" but
    // Claude rejects the whole plugin. The sync path must surface it loudly.
    installInto(SPECS.user, discoveredPlugin(writePluginSource(srcDir, 'badplug', { skills: ['loop'] }), 'badplug'), versionHome);
    // A valid neighbour must NOT warn.
    installInto(SPECS.user, discoveredPlugin(writePluginSource(srcDir, 'goodplug'), 'goodplug'), versionHome);

    const origWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    process.stderr.write = ((chunk: unknown) => { captured.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      const manifest = syncMarketplaceManifest(SPECS.user, 'claude', versionHome);
      // Sync still completes and catalogues both plugins — the warning is advisory, not fatal.
      expect(manifest!.plugins.map(p => p.name)).toEqual(['badplug', 'goodplug']);
    } finally {
      process.stderr.write = origWrite;
    }

    const out = captured.join('');
    expect(out).toContain("plugin 'badplug'");
    expect(out).toContain('"skills"');
    expect(out).toContain('"./');
    // Carries actionable fix text, not just a complaint.
    expect(out).toContain('Fix:');
    expect(out).toContain('delete the "skills" field');
    // The valid neighbour never warns.
    expect(out).not.toContain('goodplug');
  });
});

// ─── registerMarketplace / unregisterMarketplace ─────────────────────────────

describe('register/unregister marketplace', () => {
  let tmpDir: string;
  let versionHome: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-mkt-'));
    versionHome = path.join(tmpDir, 'home');
    fs.mkdirSync(path.join(versionHome, '.claude'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function readKnown(): Record<string, { source: { path: string }; installLocation: string }> {
    return JSON.parse(fs.readFileSync(knownMarketplacesPath('claude', versionHome), 'utf-8'));
  }

  it('writes its own entry without clobbering other entries', () => {
    registerMarketplace(SPECS.user, 'claude', versionHome);
    registerMarketplace(SPECS.project('/p/plugins'), 'claude', versionHome);

    const known = readKnown();
    expect(Object.keys(known).sort()).toEqual(['agents-cli', 'agents-project']);
    expect(known['agents-cli'].source.path).toBe(marketplaceRoot(SPECS.user, 'claude', versionHome));
    expect(known['agents-project'].installLocation).toBe(marketplaceRoot(SPECS.project('/p/plugins'), 'claude', versionHome));
  });

  it('unregisterMarketplace removes only its own entry', () => {
    registerMarketplace(SPECS.user, 'claude', versionHome);
    registerMarketplace(SPECS.extra('extras', '/x/plugins'), 'claude', versionHome);

    unregisterMarketplace(SPECS.extra('extras', '/x/plugins'), 'claude', versionHome);
    expect(Object.keys(readKnown())).toEqual(['agents-cli']);
  });

  it('unregister accepts a bare name string and deletes the file when last entry goes', () => {
    registerMarketplace(SPECS.user, 'claude', versionHome);
    unregisterMarketplace('agents-cli', 'claude', versionHome);
    expect(fs.existsSync(knownMarketplacesPath('claude', versionHome))).toBe(false);
  });
});

// ─── Copilot plugin registration ─────────────────────────────────────────────

describe('copilot plugin registration', () => {
  let tmpDir: string;
  let versionHome: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cp-'));
    versionHome = path.join(tmpDir, 'home');
    fs.mkdirSync(path.join(versionHome, '.copilot'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const settingsPath = () => path.join(versionHome, '.copilot', 'settings.json');
  const configPath = () => path.join(versionHome, '.copilot', 'config.json');
  const readSettings = () => JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
  const readConfig = () => JSON.parse(fs.readFileSync(configPath(), 'utf-8'));

  it('marketplace manifest for copilot lives at the marketplace ROOT (not .claude-plugin/)', () => {
    const p = marketplaceManifestPath(SPECS.user, 'copilot', versionHome);
    expect(p).toBe(path.join(marketplaceRoot(SPECS.user, 'copilot', versionHome), 'marketplace.json'));
    // Claude keeps the canonical .claude-plugin/ location.
    expect(marketplaceManifestPath(SPECS.user, 'claude', versionHome)).toContain(
      path.join('.claude-plugin', 'marketplace.json')
    );
  });

  it('registerMarketplace writes settings.json#extraKnownMarketplaces, not known_marketplaces.json', () => {
    registerMarketplace(SPECS.user, 'copilot', versionHome);
    const settings = readSettings();
    expect(settings.extraKnownMarketplaces['agents-cli']).toEqual({
      source: { source: 'directory', path: marketplaceRoot(SPECS.user, 'copilot', versionHome) },
    });
    expect(fs.existsSync(knownMarketplacesPath('copilot', versionHome))).toBe(false);
  });

  it('registerMarketplace preserves unrelated settings and other marketplaces', () => {
    fs.writeFileSync(settingsPath(), JSON.stringify({ theme: 'dark', enabledPlugins: { 'x@y': true } }));
    registerMarketplace(SPECS.user, 'copilot', versionHome);
    registerMarketplace(SPECS.project('/p/plugins'), 'copilot', versionHome);
    const settings = readSettings();
    expect(settings.theme).toBe('dark');
    expect(settings.enabledPlugins).toEqual({ 'x@y': true });
    expect(Object.keys(settings.extraKnownMarketplaces).sort()).toEqual(['agents-cli', 'agents-project']);
  });

  it('unregisterMarketplace drops only its own extraKnownMarketplaces entry', () => {
    registerMarketplace(SPECS.user, 'copilot', versionHome);
    registerMarketplace(SPECS.extra('extras', '/x/plugins'), 'copilot', versionHome);
    unregisterMarketplace(SPECS.extra('extras', '/x/plugins'), 'copilot', versionHome);
    expect(Object.keys(readSettings().extraKnownMarketplaces)).toEqual(['agents-cli']);
  });

  it('unregisterMarketplace prunes the empty key when the last marketplace goes', () => {
    registerMarketplace(SPECS.user, 'copilot', versionHome);
    unregisterMarketplace('agents-cli', 'copilot', versionHome);
    expect(readSettings().extraKnownMarketplaces).toBeUndefined();
  });

  it('registerCopilotInstalledPlugin records config.json#installedPlugins with a cache_path', () => {
    const installDir = marketplaceRoot(SPECS.user, 'copilot', versionHome) + '/plugins/demo';
    registerCopilotInstalledPlugin('demo', 'agents-cli', installDir, '2.0.0', true, 'copilot', versionHome);
    const config = readConfig();
    expect(config.installedPlugins).toHaveLength(1);
    expect(config.installedPlugins[0]).toMatchObject({
      name: 'demo', marketplace: 'agents-cli', version: '2.0.0', enabled: true, cache_path: installDir,
    });
    expect(typeof config.installedPlugins[0].installed_at).toBe('string');
  });

  it('registerCopilotInstalledPlugin is idempotent and preserves installed_at + other keys', () => {
    fs.writeFileSync(configPath(), '// managed\n' + JSON.stringify({ someKey: 1, installedPlugins: [] }));
    registerCopilotInstalledPlugin('demo', 'agents-cli', '/i/demo', '1.0.0', true, 'copilot', versionHome);
    const first = readConfig().installedPlugins[0].installed_at;
    registerCopilotInstalledPlugin('demo', 'agents-cli', '/i/demo', '1.1.0', false, 'copilot', versionHome);
    const config = readConfig();
    expect(config.someKey).toBe(1);
    expect(config.installedPlugins).toHaveLength(1);
    expect(config.installedPlugins[0].version).toBe('1.1.0');
    expect(config.installedPlugins[0].enabled).toBe(false);
    expect(config.installedPlugins[0].installed_at).toBe(first);
  });

  it('unregisterCopilotInstalledPlugin removes only the matching entry', () => {
    registerCopilotInstalledPlugin('a', 'agents-cli', '/i/a', '1.0.0', true, 'copilot', versionHome);
    registerCopilotInstalledPlugin('b', 'agents-cli', '/i/b', '1.0.0', true, 'copilot', versionHome);
    unregisterCopilotInstalledPlugin('a', 'agents-cli', 'copilot', versionHome);
    const names = readConfig().installedPlugins.map((e: { name: string }) => e.name);
    expect(names).toEqual(['b']);
  });
});

// ─── syncAllMarketplaces ─────────────────────────────────────────────────────

describe('syncAllMarketplaces', () => {
  let tmpDir: string;
  let versionHome: string;
  let userPlugins: string;
  let projectPlugins: string;
  let srcDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-mkt-'));
    versionHome = path.join(tmpDir, 'home');
    fs.mkdirSync(path.join(versionHome, '.claude'), { recursive: true });
    userPlugins = path.join(tmpDir, 'user', 'plugins');
    projectPlugins = path.join(tmpDir, 'proj', '.agents', 'plugins');
    fs.mkdirSync(userPlugins, { recursive: true });
    fs.mkdirSync(projectPlugins, { recursive: true });
    srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('produces one entry per discovered marketplace that has copied plugins', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    vi.doMock('../state.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../state.js')>();
      return {
        ...actual,
        getPluginsDir: () => userPlugins,
        getEnabledExtraRepos: () => [],
        getProjectPluginsDir: () => projectPlugins,
      };
    });
    try {
      const mod = await import('./plugin-marketplace.js');
      const userSpec: MarketplaceSpec = { kind: 'user' };
      const projSpec: MarketplaceSpec = { kind: 'project', root: projectPlugins };

      // Copy a plugin into each marketplace's version-home dest (the work a
      // per-plugin sync would do) before reconciling.
      mod.copyPluginToMarketplace(discoveredPlugin(writePluginSource(srcDir, 'u1'), 'u1'), userSpec, 'claude', versionHome);
      mod.copyPluginToMarketplace(discoveredPlugin(writePluginSource(srcDir, 'p1'), 'p1'), projSpec, 'claude', versionHome);
      mod.copyPluginToMarketplace(discoveredPlugin(writePluginSource(srcDir, 'p2'), 'p2'), projSpec, 'claude', versionHome);

      const results = mod.syncAllMarketplaces('claude', versionHome);
      const byName = Object.fromEntries(results.map(r => [r.name, r.plugins]));
      expect(byName).toEqual({ 'agents-cli': 1, 'agents-project': 2 });

      // Both got registered in known_marketplaces.json.
      const known = JSON.parse(fs.readFileSync(mod.knownMarketplacesPath('claude', versionHome), 'utf-8'));
      expect(Object.keys(known).sort()).toEqual(['agents-cli', 'agents-project']);
    } finally {
      vi.doUnmock('../state.js');
      vi.resetModules();
    }
  });

  it('skips discovered marketplaces with no copied plugins (no empty registration)', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    vi.doMock('../state.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../state.js')>();
      return {
        ...actual,
        getPluginsDir: () => userPlugins,
        getEnabledExtraRepos: () => [],
        getProjectPluginsDir: () => projectPlugins, // discovered, but nothing copied
      };
    });
    try {
      const mod = await import('./plugin-marketplace.js');
      mod.copyPluginToMarketplace(discoveredPlugin(writePluginSource(srcDir, 'u1'), 'u1'), { kind: 'user' }, 'claude', versionHome);

      const results = mod.syncAllMarketplaces('claude', versionHome);
      expect(results.map(r => r.name)).toEqual(['agents-cli']);
    } finally {
      vi.doUnmock('../state.js');
      vi.resetModules();
    }
  });
});

// ─── add/removePluginFromSettings ────────────────────────────────────────────

describe('add/removePluginFromSettings', () => {
  let tmpDir: string;
  let versionHome: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-mkt-'));
    versionHome = path.join(tmpDir, 'home');
    fs.mkdirSync(path.join(versionHome, '.claude'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const settingsFile = () => path.join(versionHome, '.claude', 'settings.json');

  it('adds <plugin>@<marketplace> preserving other settings keys', () => {
    fs.writeFileSync(settingsFile(), JSON.stringify({ theme: 'dark' }));
    addPluginToSettings('alpha', 'agents-project', 'claude', versionHome);

    const s = JSON.parse(fs.readFileSync(settingsFile(), 'utf-8'));
    expect(s.theme).toBe('dark');
    expect(s.enabledPlugins).toEqual({ 'alpha@agents-project': true });
  });

  it('keys are namespaced per marketplace so the same plugin can live in two repos', () => {
    addPluginToSettings('alpha', 'agents-cli', 'claude', versionHome);
    addPluginToSettings('alpha', 'agents-project', 'claude', versionHome);
    const s = JSON.parse(fs.readFileSync(settingsFile(), 'utf-8'));
    expect(s.enabledPlugins).toEqual({ 'alpha@agents-cli': true, 'alpha@agents-project': true });
  });

  it('removePluginFromSettings drops only the matching key', () => {
    addPluginToSettings('alpha', 'agents-cli', 'claude', versionHome);
    addPluginToSettings('beta', 'agents-cli', 'claude', versionHome);
    removePluginFromSettings('alpha', 'agents-cli', 'claude', versionHome);

    const s = JSON.parse(fs.readFileSync(settingsFile(), 'utf-8'));
    expect(s.enabledPlugins).toEqual({ 'beta@agents-cli': true });
  });

  it('removePluginFromSettings clears enabledPlugins entirely when last key goes', () => {
    addPluginToSettings('alpha', 'agents-cli', 'claude', versionHome);
    removePluginFromSettings('alpha', 'agents-cli', 'claude', versionHome);
    const s = JSON.parse(fs.readFileSync(settingsFile(), 'utf-8'));
    expect(s.enabledPlugins).toBeUndefined();
  });
});

describe('validateClaudePluginManifest', () => {
  it('passes a manifest with no resource fields (the common case — skills auto-discover)', () => {
    expect(validateClaudePluginManifest({ name: 'code', version: '1.0.0', description: 'x' })).toEqual([]);
  });

  it('flags skills declared as bare names — the real bug that breaks Claude plugin loading', () => {
    const warnings = validateClaudePluginManifest({
      name: 'code',
      skills: ['dispatch', 'loop', 'review'],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"skills"');
    expect(warnings[0]).toContain('"dispatch"');
    expect(warnings[0]).toContain('"./');
    // Must tell the reader (human or agent) exactly how to fix it.
    expect(warnings[0]).toContain('Fix:');
    expect(warnings[0]).toContain('delete the "skills" field');
  });

  it('passes skills given as proper relative "./" paths', () => {
    expect(
      validateClaudePluginManifest({ name: 'code', skills: ['./skills/loop', './skills/review'] })
    ).toEqual([]);
  });

  it('passes a single-string resource field that starts with "./"', () => {
    expect(validateClaudePluginManifest({ name: 'c', commands: './commands/commit' })).toEqual([]);
  });

  it('flags commands and agents with the same "./" rule', () => {
    expect(validateClaudePluginManifest({ name: 'c', commands: ['commit'] })[0]).toContain('"commands"');
    expect(validateClaudePluginManifest({ name: 'c', agents: ['reviewer'] })[0]).toContain('"agents"');
  });

  it('flags non-string entries', () => {
    const warnings = validateClaudePluginManifest({ name: 'c', skills: [{ path: './skills/loop' }] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('non-string');
  });

  it('does NOT touch hooks/mcpServers (they legitimately accept inline objects)', () => {
    expect(
      validateClaudePluginManifest({ name: 'c', hooks: { PreToolUse: [] }, mcpServers: { x: {} } })
    ).toEqual([]);
  });

  it('is null/garbage safe', () => {
    expect(validateClaudePluginManifest(null)).toEqual([]);
    expect(validateClaudePluginManifest('nope')).toEqual([]);
  });
});
