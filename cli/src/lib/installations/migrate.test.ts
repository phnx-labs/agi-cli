import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'url';

import { detrackUserChangelog, migrateCliDirToClis, migrateExtrasExtrasToAgentsExtras, migrateKimiSubagentsToMarkdown, migrateMachineLocalBrowserProfileOutOfCentral, migrateMenubarSentinelToConfig, migrateWatchdogSentinelToConfig, repairSelfReferentialBinShims, seedActiveCursorLoginPerVersion } from './migrate.js';
import { execFileSync } from 'child_process';
import { toPosix } from '../platform/index.js';
import * as yaml from 'yaml';

const tempDirs: string[] = [];

function makeTempHistoryDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-migrate-ee-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {  }
  }
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function seedVersionHome(historyDir: string, agentId: string, ver: string): {
  pluginsDir: string;
  configDir: string;
  marketplacesDir: string;
} {
  const configDir = path.join(historyDir, 'versions', agentId, ver, 'home', `.${agentId}`);
  const pluginsDir = path.join(configDir, 'plugins');
  const marketplacesDir = path.join(pluginsDir, 'marketplaces');
  fs.mkdirSync(marketplacesDir, { recursive: true });
  return { pluginsDir, configDir, marketplacesDir };
}

function seedExtrasExtras(marketplacesDir: string, pluginsDir: string, agentId: string, ver: string, historyDir: string): void {
  const ee = path.join(marketplacesDir, 'extras-extras');
  fs.mkdirSync(path.join(ee, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(ee, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      $schema: 'https://anthropic.com/claude-code/marketplace.schema.json',
      name: 'extras-extras',
      description: 'Plugins from extras repo "extras"',
      owner: { name: 'agents-cli' },
      plugins: [{ name: 'code', source: './plugins/code' }],
    }, null, 2),
  );
  const eePath = path.join(historyDir, 'versions', agentId, ver, 'home', `.${agentId}`, 'plugins', 'marketplaces', 'extras-extras');
  fs.writeFileSync(
    path.join(pluginsDir, 'known_marketplaces.json'),
    JSON.stringify({
      'extras-extras': {
        source: { source: 'directory', path: eePath },
        installLocation: eePath,
        lastUpdated: '2026-06-08T05:27:15.261Z',
      },
      'agents-cli': {
        source: { source: 'directory', path: '/some/other/path' },
        installLocation: '/some/other/path',
        lastUpdated: '2026-06-08T20:07:38.485Z',
      },
    }, null, 2),
  );
  const configDir = path.dirname(pluginsDir);
  fs.writeFileSync(
    path.join(configDir, 'settings.json'),
    JSON.stringify({
      permissions: { allow: ['Bash(ls:*)'] },
      enabledPlugins: {
        'code@extras-extras': true,
        'creative@extras-extras': true,
        'git@extras-extras': false,
        'unrelated@agents-cli': true,
      },
    }, null, 2),
  );
}

describe('migrateExtrasExtrasToAgentsExtras', () => {
  it('is a no-op when nothing extras-extras exists', () => {
    const historyDir = makeTempHistoryDir();
    const { pluginsDir, configDir } = seedVersionHome(historyDir, 'claude', '2.1.143');
    fs.writeFileSync(
      path.join(pluginsDir, 'known_marketplaces.json'),
      JSON.stringify({ 'agents-cli': { source: { source: 'directory', path: '/x' } } }, null, 2),
    );
    fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'foo@agents-cli': true } }, null, 2));

    expect(() => migrateExtrasExtrasToAgentsExtras(historyDir)).not.toThrow();

    const known = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'known_marketplaces.json'), 'utf-8'));
    expect(known['agents-cli']).toBeDefined();
    expect(Object.keys(known)).not.toContain('extras-extras');
  });

  it('renames the marketplace dir, key, paths, and settings keys', () => {
    const historyDir = makeTempHistoryDir();
    const { pluginsDir, configDir, marketplacesDir } = seedVersionHome(historyDir, 'claude', '2.1.143');
    seedExtrasExtras(marketplacesDir, pluginsDir, 'claude', '2.1.143', historyDir);

    migrateExtrasExtrasToAgentsExtras(historyDir);

    expect(fs.existsSync(path.join(marketplacesDir, 'extras-extras'))).toBe(false);
    expect(fs.existsSync(path.join(marketplacesDir, 'agents-extras'))).toBe(true);

    const mj = JSON.parse(fs.readFileSync(path.join(marketplacesDir, 'agents-extras', '.claude-plugin', 'marketplace.json'), 'utf-8'));
    expect(mj.name).toBe('agents-extras');

    const known = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'known_marketplaces.json'), 'utf-8'));
    expect(Object.keys(known)).not.toContain('extras-extras');
    expect(known['agents-extras']).toBeDefined();
    expect(toPosix(known['agents-extras'].source.path)).toContain('/marketplaces/agents-extras');
    expect(known['agents-extras'].source.path).not.toContain('extras-extras');
    expect(toPosix(known['agents-extras'].installLocation)).toContain('/marketplaces/agents-extras');
    expect(known['agents-extras'].lastUpdated).toBe('2026-06-08T05:27:15.261Z');

    const settings = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf-8'));
    expect(settings.enabledPlugins['code@extras-extras']).toBeUndefined();
    expect(settings.enabledPlugins['creative@extras-extras']).toBeUndefined();
    expect(settings.enabledPlugins['git@extras-extras']).toBeUndefined();
    expect(settings.enabledPlugins['code@agents-extras']).toBe(true);
    expect(settings.enabledPlugins['creative@agents-extras']).toBe(true);
    expect(settings.enabledPlugins['git@agents-extras']).toBe(false);
    expect(settings.enabledPlugins['unrelated@agents-cli']).toBe(true);
    expect(settings.permissions.allow).toEqual(['Bash(ls:*)']);
  });

  it('is idempotent — running twice is a no-op the second time', () => {
    const historyDir = makeTempHistoryDir();
    const { pluginsDir, marketplacesDir } = seedVersionHome(historyDir, 'claude', '2.1.143');
    seedExtrasExtras(marketplacesDir, pluginsDir, 'claude', '2.1.143', historyDir);

    migrateExtrasExtrasToAgentsExtras(historyDir);
    const knownAfterFirst = fs.readFileSync(path.join(pluginsDir, 'known_marketplaces.json'), 'utf-8');
    migrateExtrasExtrasToAgentsExtras(historyDir);
    const knownAfterSecond = fs.readFileSync(path.join(pluginsDir, 'known_marketplaces.json'), 'utf-8');

    expect(knownAfterSecond).toBe(knownAfterFirst);
    expect(fs.existsSync(path.join(marketplacesDir, 'agents-extras'))).toBe(true);
    expect(fs.existsSync(path.join(marketplacesDir, 'extras-extras'))).toBe(false);
  });

  it('drops the stale extras-extras dir when agents-extras already exists', () => {
    const historyDir = makeTempHistoryDir();
    const { pluginsDir, marketplacesDir } = seedVersionHome(historyDir, 'claude', '2.1.143');
    seedExtrasExtras(marketplacesDir, pluginsDir, 'claude', '2.1.143', historyDir);

    const ae = path.join(marketplacesDir, 'agents-extras');
    fs.mkdirSync(path.join(ae, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(ae, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name: 'agents-extras', description: 'canonical', plugins: [] }, null, 2),
    );

    migrateExtrasExtrasToAgentsExtras(historyDir);

    expect(fs.existsSync(path.join(marketplacesDir, 'extras-extras'))).toBe(false);
    expect(fs.existsSync(ae)).toBe(true);
    const mj = JSON.parse(fs.readFileSync(path.join(ae, '.claude-plugin', 'marketplace.json'), 'utf-8'));
    expect(mj.description).toBe('canonical');
  });

  it('walks all agents and versions', () => {
    const historyDir = makeTempHistoryDir();
    for (const [agentId, ver] of [['claude', '2.1.143'], ['codex', '0.117.0'], ['grok', '0.26.0']] as const) {
      const { pluginsDir, marketplacesDir } = seedVersionHome(historyDir, agentId, ver);
      seedExtrasExtras(marketplacesDir, pluginsDir, agentId, ver, historyDir);
    }
    migrateExtrasExtrasToAgentsExtras(historyDir);
    for (const [agentId, ver] of [['claude', '2.1.143'], ['codex', '0.117.0'], ['grok', '0.26.0']] as const) {
      const marketplacesDir = path.join(historyDir, 'versions', agentId, ver, 'home', `.${agentId}`, 'plugins', 'marketplaces');
      expect(fs.existsSync(path.join(marketplacesDir, 'extras-extras'))).toBe(false);
      expect(fs.existsSync(path.join(marketplacesDir, 'agents-extras'))).toBe(true);
    }
  });
});

describe('repairSelfReferentialBinShims', () => {
  function makeTempRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-binshim-'));
    tempDirs.push(dir);
    return dir;
  }

  function seedSelfRefLoop(root: string, agent: string, cli: string): {
    versionsRoot: string;
    shimsDir: string;
    binLink: string;
  } {
    const versionsRoot = path.join(root, 'versions');
    const shimsDir = path.join(root, 'shims');
    fs.mkdirSync(shimsDir, { recursive: true });
    const shim = path.join(shimsDir, cli);
    fs.writeFileSync(shim, '#!/bin/sh\n# fake dispatcher\n');
    fs.chmodSync(shim, 0o755);

    const binDir = path.join(versionsRoot, agent, 'latest', 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    const binLink = path.join(binDir, cli);
    fs.symlinkSync(shim, binLink);
    return { versionsRoot, shimsDir, binLink };
  }

  function withPath<T>(dirs: string[], fn: () => T): T {
    const prev = process.env.PATH;
    process.env.PATH = dirs.join(path.delimiter);
    try {
      return fn();
    } finally {
      process.env.PATH = prev;
    }
  }

  it('re-points a self-referential .bin symlink at the real PATH binary', () => {
    const root = makeTempRoot();
    const { versionsRoot, shimsDir, binLink } = seedSelfRefLoop(root, 'droid', 'droid');

    const realBinDir = makeTempRoot();
    const exeExt = process.platform === 'win32' ? '.cmd' : '';
    const realBin = path.join(realBinDir, 'droid' + exeExt);
    fs.writeFileSync(realBin, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n# real droid\n');
    fs.chmodSync(realBin, 0o755);

    expect(fs.realpathSync(binLink)).toBe(fs.realpathSync(path.join(shimsDir, 'droid')));

    withPath([realBinDir], () => repairSelfReferentialBinShims(versionsRoot, shimsDir));

    expect(fs.readFileSync(binLink)).toEqual(fs.readFileSync(realBin));
    expect(fs.realpathSync(binLink).startsWith(fs.realpathSync(shimsDir) + path.sep)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('repairs an adopted Cursor launcher that reaches the shim through ~/.local/bin', () => {
    const root = makeTempRoot();
    const versionsRoot = path.join(root, '.history', 'versions');
    const historyDir = path.dirname(versionsRoot);
    const shimsDir = path.join(root, '.cache', 'shims');
    const localBinDir = path.join(root, '.local', 'bin');
    const nativeDir = path.join(root, '.local', 'share', 'cursor-agent', 'versions', 'current');
    fs.mkdirSync(shimsDir, { recursive: true });
    fs.mkdirSync(localBinDir, { recursive: true });
    fs.mkdirSync(nativeDir, { recursive: true });

    const shim = path.join(shimsDir, 'cursor-agent');
    const launcher = path.join(localBinDir, 'cursor-agent');
    const native = path.join(nativeDir, 'cursor-agent');
    fs.writeFileSync(shim, '#!/bin/sh\n# dispatcher\n');
    fs.writeFileSync(native, '#!/bin/sh\necho cursor\n');
    fs.chmodSync(shim, 0o755);
    fs.chmodSync(native, 0o755);
    fs.symlinkSync(shim, launcher);

    const binDir = path.join(versionsRoot, 'cursor', '2026.07.23', 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    const binLink = path.join(binDir, 'cursor-agent');
    fs.symlinkSync(launcher, binLink);

    const recordDir = path.join(historyDir, 'adopted-launchers');
    fs.mkdirSync(recordDir, { recursive: true });
    fs.writeFileSync(path.join(recordDir, 'cursor-agent'), `${native}\n${launcher}\n`);

    withPath([localBinDir, shimsDir], () => {
      repairSelfReferentialBinShims(versionsRoot, shimsDir, historyDir);
      repairSelfReferentialBinShims(versionsRoot, shimsDir, historyDir);
    });

    expect(fs.realpathSync(binLink)).toBe(fs.realpathSync(native));
  });

  it('removes the self-referential symlink when no real binary is on PATH', () => {
    const root = makeTempRoot();
    const cli = 'zzz-no-such-cli';
    const { versionsRoot, shimsDir, binLink } = seedSelfRefLoop(root, cli, cli);
    const emptyDir = makeTempRoot();

    withPath([emptyDir], () => repairSelfReferentialBinShims(versionsRoot, shimsDir));

    let exists = true;
    try { fs.lstatSync(binLink); } catch { exists = false; }
    expect(exists).toBe(false);
  });

  it('leaves a correctly-pointed symlink untouched', () => {
    const root = makeTempRoot();
    const versionsRoot = path.join(root, 'versions');
    const shimsDir = path.join(root, 'shims');
    fs.mkdirSync(shimsDir, { recursive: true });

    const realBinDir = makeTempRoot();
    const exeExt = process.platform === 'win32' ? '.cmd' : '';
    const realBin = path.join(realBinDir, 'droid' + exeExt);
    fs.writeFileSync(realBin, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n');
    fs.chmodSync(realBin, 0o755);

    const binDir = path.join(versionsRoot, 'droid', 'latest', 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    const binLink = path.join(binDir, 'droid');
    fs.symlinkSync(realBin, binLink);

    withPath([realBinDir], () => repairSelfReferentialBinShims(versionsRoot, shimsDir));

    expect(fs.readlinkSync(binLink)).toBe(realBin);
  });
});

describe('migrateWatchdogSentinelToConfig', () => {
  it('no sentinel on disk -> no-op (never sets the config)', () => {
    const dir = makeTempHistoryDir();
    const sentinel = path.join(dir, 'enabled');
    let called = false;
    migrateWatchdogSentinelToConfig(sentinel, () => { called = true; });
    expect(called).toBe(false);
  });

  it('sentinel present -> sets watchdog.enabled true and deletes the sentinel', () => {
    const dir = makeTempHistoryDir();
    const sentinel = path.join(dir, 'enabled');
    fs.writeFileSync(sentinel, 'enabled\n');
    const calls: boolean[] = [];
    migrateWatchdogSentinelToConfig(sentinel, (enabled) => { calls.push(enabled); });
    expect(calls).toEqual([true]);
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it('leaves the sentinel in place if setting the config throws (retry next run)', () => {
    const dir = makeTempHistoryDir();
    const sentinel = path.join(dir, 'enabled');
    fs.writeFileSync(sentinel, 'enabled\n');
    migrateWatchdogSentinelToConfig(sentinel, () => { throw new Error('config unwritable'); });
    expect(fs.existsSync(sentinel)).toBe(true);
  });
});

describe('migrateMenubarSentinelToConfig', () => {
  it('sentinel present -> sets menubar.enabled false and deletes the sentinel', () => {
    const dir = makeTempHistoryDir();
    const sentinel = path.join(dir, 'menubar.disabled');
    fs.writeFileSync(sentinel, 'disabled\n');
    let disabled = 0;
    migrateMenubarSentinelToConfig(sentinel, () => { disabled++; });
    expect(disabled).toBe(1);
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it('leaves the sentinel in place if setting the config throws (retry next run)', () => {
    const dir = makeTempHistoryDir();
    const sentinel = path.join(dir, 'menubar.disabled');
    fs.writeFileSync(sentinel, 'disabled\n');
    migrateMenubarSentinelToConfig(sentinel, () => { throw new Error('config unwritable'); });
    expect(fs.existsSync(sentinel)).toBe(true);
  });
});

describe('migrateCliDirToClis', () => {
  function makeTempAgentsDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-migrate-clis-'));
    tempDirs.push(dir);
    return dir;
  }

  it('renames cli/ to clis/ when only cli/ is present', () => {
    const agentsDir = makeTempAgentsDir();
    const cliDir = path.join(agentsDir, 'cli');
    fs.mkdirSync(cliDir, { recursive: true });
    fs.writeFileSync(path.join(cliDir, 'gh.yaml'), 'name: gh\n');

    migrateCliDirToClis([agentsDir]);

    expect(fs.existsSync(path.join(agentsDir, 'cli'))).toBe(false);
    expect(fs.existsSync(path.join(agentsDir, 'clis'))).toBe(true);
    expect(fs.existsSync(path.join(agentsDir, 'clis', 'gh.yaml'))).toBe(true);
  });

  it('is a no-op when cli/ is absent', () => {
    const agentsDir = makeTempAgentsDir();
    const clisDir = path.join(agentsDir, 'clis');
    fs.mkdirSync(clisDir, { recursive: true });

    migrateCliDirToClis([agentsDir]);

    expect(fs.existsSync(clisDir)).toBe(true);
  });

  it('is idempotent — safe to call twice when cli/ is already gone', () => {
    const agentsDir = makeTempAgentsDir();
    const cliDir = path.join(agentsDir, 'cli');
    fs.mkdirSync(cliDir, { recursive: true });

    migrateCliDirToClis([agentsDir]);
    expect(() => migrateCliDirToClis([agentsDir])).not.toThrow();
  });

  it('throws on conflict when both cli/ and clis/ exist', () => {
    const agentsDir = makeTempAgentsDir();
    fs.mkdirSync(path.join(agentsDir, 'cli'), { recursive: true });
    fs.mkdirSync(path.join(agentsDir, 'clis'), { recursive: true });

    expect(() => migrateCliDirToClis([agentsDir])).toThrow('Migration conflict');
    expect(fs.existsSync(path.join(agentsDir, 'cli'))).toBe(true);
    expect(fs.existsSync(path.join(agentsDir, 'clis'))).toBe(true);
  });

  it('processes multiple dirs independently', () => {
    const dir1 = makeTempAgentsDir();
    const dir2 = makeTempAgentsDir();
    fs.mkdirSync(path.join(dir1, 'cli'), { recursive: true });

    migrateCliDirToClis([dir1, dir2]);

    expect(fs.existsSync(path.join(dir1, 'clis'))).toBe(true);
    expect(fs.existsSync(path.join(dir1, 'cli'))).toBe(false);
    expect(fs.existsSync(path.join(dir2, 'clis'))).toBe(false);
  });
});

describe('seedActiveCursorLoginPerVersion', () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
    cleanup.length = 0;
    delete process.env.AGENTS_REAL_HOME;
  });

  function fakeHome(): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-cursor-seed-'));
    cleanup.push(home);
    return home;
  }

  it('copies the global Cursor token into the active version home, and is idempotent', () => {
    const home = fakeHome();
    fs.mkdirSync(path.join(home, '.config', 'cursor'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'cursor', 'auth.json'), JSON.stringify({ accessToken: 'global-tok' }));
    const versionHome = path.join(home, '.agents', '.history', 'versions', 'cursor', '2026.08.04', 'home');
    fs.mkdirSync(path.join(versionHome, '.cursor'), { recursive: true });
    fs.symlinkSync(path.join(versionHome, '.cursor'), path.join(home, '.cursor'));
    process.env.AGENTS_REAL_HOME = home;

    seedActiveCursorLoginPerVersion();
    const seeded = path.join(versionHome, '.cursor', 'auth.json');
    expect(fs.existsSync(seeded)).toBe(true);
    expect(JSON.parse(fs.readFileSync(seeded, 'utf-8')).accessToken).toBe('global-tok');

    fs.writeFileSync(seeded, JSON.stringify({ accessToken: 'own-tok' }));
    seedActiveCursorLoginPerVersion();
    expect(JSON.parse(fs.readFileSync(seeded, 'utf-8')).accessToken).toBe('own-tok');
  });

  it('is a no-op when ~/.cursor is a real dir (unmanaged install), not a symlink', () => {
    const home = fakeHome();
    fs.mkdirSync(path.join(home, '.config', 'cursor'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'cursor', 'auth.json'), JSON.stringify({ accessToken: 'tok' }));
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    process.env.AGENTS_REAL_HOME = home;
    expect(() => seedActiveCursorLoginPerVersion()).not.toThrow();
  });

  it('is a no-op when there is no global token to seed', () => {
    const home = fakeHome();
    const versionHome = path.join(home, '.agents', '.history', 'versions', 'cursor', '2026.08.04', 'home');
    fs.mkdirSync(path.join(versionHome, '.cursor'), { recursive: true });
    fs.symlinkSync(path.join(versionHome, '.cursor'), path.join(home, '.cursor'));
    process.env.AGENTS_REAL_HOME = home;
    seedActiveCursorLoginPerVersion();
    expect(fs.existsSync(path.join(versionHome, '.cursor', 'auth.json'))).toBe(false);
  });
});

describe('migrateKimiSubagentsToMarkdown', () => {
  function seedKimiHome(versionsDir: string, version: string, files: Record<string, string>): string {
    const dir = path.join(versionsDir, 'kimi', version, 'home', '.kimi-code', 'agents');
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
    return dir;
  }

  it('removes the legacy pair and the managed index, across every version home', () => {
    const versions = makeTempHistoryDir();
    const a = seedKimiHome(versions, '0.29.0', {
      'code-reviewer.yaml': 'version: 1\n',
      'code-reviewer.system.md': 'legacy prompt body',
      '_agents-cli.yaml': 'version: 1\n',
      'code-reviewer.md': '---\nname: code-reviewer\ndescription: x\n---\n\nbody',
    });
    const b = seedKimiHome(versions, '0.34.0', {
      'planner.yaml': 'version: 1\n',
      'planner.system.md': 'legacy prompt body',
    });

    migrateKimiSubagentsToMarkdown(versions);

    expect(fs.readdirSync(a)).toEqual(['code-reviewer.md']);
    expect(fs.readdirSync(b)).toEqual([]);
  });

  it('leaves a subagent legitimately named <x>.system alone (no sibling .yaml)', () => {
    const versions = makeTempHistoryDir();
    const dir = seedKimiHome(versions, '0.29.0', {
      'foo.system.md': '---\nname: foo.system\ndescription: mine\n---\n\nbody',
      'keeper.yaml': 'version: 1\n',
    });

    migrateKimiSubagentsToMarkdown(versions);

    expect(fs.readdirSync(dir).sort()).toEqual(['foo.system.md', 'keeper.yaml']);
  });

  it('is idempotent and a no-op with no kimi installed', () => {
    const versions = makeTempHistoryDir();
    expect(() => migrateKimiSubagentsToMarkdown(versions)).not.toThrow();
    const dir = seedKimiHome(versions, '0.29.0', { 'x.yaml': 'v: 1\n', 'x.system.md': 'p' });
    migrateKimiSubagentsToMarkdown(versions);
    migrateKimiSubagentsToMarkdown(versions);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('migrateMachineLocalBrowserProfileOutOfCentral', () => {
  function userDirWith(central: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-browser-default-'));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'agents.yaml'), central);
    return dir;
  }

  const CENTRAL_WITH_DEFAULT = `# agents-cli metadata
# hand-written comment that must survive
browser:
  # a named profile the user created — real fleet config
  comet-local:
    browser: comet
    binary: /Applications/Comet.app/Contents/MacOS/Comet
  default:
    browser: chrome
    description: Auto-detected chrome profile
    binary: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
    endpoints:
      - cdp://127.0.0.1:9227
notify:
  transports:
    alerts: slack
`;

  it('moves the machine-local default profile to the device file and out of central', () => {
    const dir = userDirWith(CENTRAL_WITH_DEFAULT);

    migrateMachineLocalBrowserProfileOutOfCentral(dir, 'zion');

    const central = yaml.parse(fs.readFileSync(path.join(dir, 'agents.yaml'), 'utf-8'));
    expect(central.browser.default).toBeUndefined();
    expect(central.browser['comet-local'].browser).toBe('comet');
    expect(central.notify.transports.alerts).toBe('slack');

    const device = yaml.parse(fs.readFileSync(path.join(dir, 'devices', 'zion', 'agents.yaml'), 'utf-8'));
    expect(device.browser.default.browser).toBe('chrome');
    expect(device.browser.default.binary).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(device.browser.default.endpoints).toEqual(['cdp://127.0.0.1:9227']);
  });

  it('preserves hand-written comments in the synced file', () => {
    const dir = userDirWith(CENTRAL_WITH_DEFAULT);

    migrateMachineLocalBrowserProfileOutOfCentral(dir, 'zion');

    const raw = fs.readFileSync(path.join(dir, 'agents.yaml'), 'utf-8');
    expect(raw).toContain('# hand-written comment that must survive');
    expect(raw).toContain('# a named profile the user created');
  });

  it('drops the browser key entirely when default was its only entry', () => {
    const dir = userDirWith(`browser:
  default:
    browser: chromium
    binary: /usr/bin/chromium-browser
`);

    migrateMachineLocalBrowserProfileOutOfCentral(dir, 'yosemite-s1');

    const central = yaml.parse(fs.readFileSync(path.join(dir, 'agents.yaml'), 'utf-8')) ?? {};
    expect(central.browser).toBeUndefined();
  });

  it('keeps a comment glued directly above browser: when the key itself is dropped', () => {
    const dir = userDirWith(`# agents-cli metadata
# hand-written comment that must survive
browser:
  default:
    browser: chromium
    binary: /usr/bin/chromium-browser
notify:
  owner:
    channel: imessage
`);

    migrateMachineLocalBrowserProfileOutOfCentral(dir, 'zion');

    const raw = fs.readFileSync(path.join(dir, 'agents.yaml'), 'utf-8');
    expect(raw).toContain('# agents-cli metadata');
    expect(raw).toContain('# hand-written comment that must survive');
    expect(raw).toContain('channel: imessage');
    expect(raw).not.toMatch(/^browser:/m);
  });

  it('writes the header, never a flow {} root, when browser was central\'s only key', () => {
    const dir = userDirWith(`browser:
  default:
    browser: chromium
    binary: /usr/bin/chromium-browser
`);

    migrateMachineLocalBrowserProfileOutOfCentral(dir, 'zion');

    const raw = fs.readFileSync(path.join(dir, 'agents.yaml'), 'utf-8');
    expect(raw.trim()).not.toBe('{}');
    expect(raw).toContain('# agents-cli metadata');
    expect(yaml.parse(raw) ?? {}).toEqual({});
  });

  it('writes the device file with the canonical four-line META_HEADER', () => {
    const dir = userDirWith(CENTRAL_WITH_DEFAULT);

    migrateMachineLocalBrowserProfileOutOfCentral(dir, 'zion');

    const raw = fs.readFileSync(path.join(dir, 'devices', 'zion', 'agents.yaml'), 'utf-8');
    expect(raw).toContain('# agents-cli metadata');
    expect(raw).toContain('# Auto-generated - do not edit manually');
    expect(raw).toContain('# https://github.com/phnx-labs/agi-cli');
    expect(raw).toContain('# yaml-language-server: $schema=');
  });

  it('is idempotent and leaves a clean central file untouched', () => {
    const dir = userDirWith(CENTRAL_WITH_DEFAULT);

    migrateMachineLocalBrowserProfileOutOfCentral(dir, 'zion');
    const afterFirst = fs.readFileSync(path.join(dir, 'agents.yaml'), 'utf-8');
    migrateMachineLocalBrowserProfileOutOfCentral(dir, 'zion');
    const afterSecond = fs.readFileSync(path.join(dir, 'agents.yaml'), 'utf-8');

    expect(afterSecond).toBe(afterFirst);
  });

  it('keeps this machine\'s live device entry when central still holds a stale copy', () => {
    const dir = userDirWith(CENTRAL_WITH_DEFAULT);
    const devicePath = path.join(dir, 'devices', 'mark-1', 'agents.yaml');
    fs.mkdirSync(path.dirname(devicePath), { recursive: true });
    fs.writeFileSync(devicePath, yaml.stringify({
      browser: { default: { browser: 'brave', binary: '/opt/brave.com/brave/brave' } },
    }));

    migrateMachineLocalBrowserProfileOutOfCentral(dir, 'mark-1');

    const device = yaml.parse(fs.readFileSync(devicePath, 'utf-8'));
    expect(device.browser.default.browser).toBe('brave');
    const central = yaml.parse(fs.readFileSync(path.join(dir, 'agents.yaml'), 'utf-8'));
    expect(central.browser.default).toBeUndefined();
  });

  it('no-ops when there is no central file and when browser is absent', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-browser-default-'));
    tempDirs.push(empty);
    expect(() => migrateMachineLocalBrowserProfileOutOfCentral(empty, 'zion')).not.toThrow();
    expect(fs.existsSync(path.join(empty, 'devices'))).toBe(false);

    const noBrowser = userDirWith('notify:\n  owner:\n    channel: imessage\n');
    migrateMachineLocalBrowserProfileOutOfCentral(noBrowser, 'zion');
    expect(fs.existsSync(path.join(noBrowser, 'devices'))).toBe(false);
  });
});

describe('removeHomeCompiledProjectRules (RUSH-2725)', () => {
  it('removes the compiled ~/AGENTS.md, its symlinks, and header-carrying copies; keeps user-authored files', async () => {
    const { removeHomeCompiledProjectRules } = await import('./migrate.js');
    const { COMPILED_HEADER_PROJECT } = await import('../rules/compile.js');
    const home = makeTempHistoryDir();
    const compiled = COMPILED_HEADER_PROJECT + '# Composed ruleset\n';
    fs.writeFileSync(path.join(home, 'AGENTS.md'), compiled);
    fs.symlinkSync('AGENTS.md', path.join(home, 'CLAUDE.md'));
    fs.writeFileSync(path.join(home, '.cursorrules'), compiled);
    fs.writeFileSync(path.join(home, 'MEMORY.md'), '# my own notes\n');

    removeHomeCompiledProjectRules(home);

    expect(fs.existsSync(path.join(home, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'CLAUDE.md'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.cursorrules'))).toBe(false);
    expect(fs.readFileSync(path.join(home, 'MEMORY.md'), 'utf8')).toBe('# my own notes\n');
  });

  it('leaves a hand-authored ~/AGENTS.md and its symlinks alone', async () => {
    const { removeHomeCompiledProjectRules } = await import('./migrate.js');
    const home = makeTempHistoryDir();
    fs.writeFileSync(path.join(home, 'AGENTS.md'), '# authored by the user\n');
    fs.symlinkSync('AGENTS.md', path.join(home, 'CLAUDE.md'));

    removeHomeCompiledProjectRules(home);

    expect(fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8')).toBe('# authored by the user\n');
    expect(fs.existsSync(path.join(home, 'CLAUDE.md'))).toBe(true);
  });

  it('is a no-op when ~/AGENTS.md does not exist', async () => {
    const { removeHomeCompiledProjectRules } = await import('./migrate.js');
    const home = makeTempHistoryDir();
    fs.symlinkSync('AGENTS.md', path.join(home, 'CLAUDE.md'));

    removeHomeCompiledProjectRules(home);

    expect(fs.lstatSync(path.join(home, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
  });
});


describe('detrackUserChangelog', () => {
  function initUserRepo(): { userDir: string; git: (...a: string[]) => string } {
    const home = makeTempHistoryDir();
    const userDir = path.join(home, '.agents');
    fs.mkdirSync(userDir, { recursive: true });
    const git = (...a: string[]) => execFileSync('git', ['-C', userDir, ...a], { encoding: 'utf-8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'demo@x.co');
    git('config', 'user.name', 'demo');
    git('config', 'commit.gpgsign', 'false');
    return { userDir, git };
  }

  it('untracks + commits the removal, ignores via info/exclude, and leaves a clean tree', () => {
    const { userDir, git } = initUserRepo();
    fs.writeFileSync(path.join(userDir, 'CHANGELOG.md'), '# changelog\n');
    git('add', 'CHANGELOG.md');
    git('commit', '-q', '-m', 'add changelog');

    detrackUserChangelog(userDir);

    expect(() => git('ls-files', '--error-unmatch', '--', 'CHANGELOG.md')).toThrow();
    expect(fs.existsSync(path.join(userDir, 'CHANGELOG.md'))).toBe(true);
    expect(git('status', '--porcelain').trim()).toBe('');
    expect(git('log', '-1', '--pretty=%s').trim()).toBe('chore(config): stop tracking CHANGELOG.md');
    expect(fs.readFileSync(path.join(userDir, '.git', 'info', 'exclude'), 'utf-8')).toContain('/CHANGELOG.md');
    expect(fs.existsSync(path.join(userDir, '.gitignore'))).toBe(false);
  });

  it('is a no-op on a repo that never tracked CHANGELOG.md, and on a plain (non-git) dir', () => {
    const { userDir, git } = initUserRepo();
    fs.writeFileSync(path.join(userDir, 'README.md'), 'x\n');
    git('add', 'README.md');
    git('commit', '-q', '-m', 'init');
    const before = git('rev-list', '--count', 'HEAD').trim();

    detrackUserChangelog(userDir);
    expect(git('rev-list', '--count', 'HEAD').trim()).toBe(before);

    const plain = path.join(makeTempHistoryDir(), '.agents');
    fs.mkdirSync(plain, { recursive: true });
    expect(() => detrackUserChangelog(plain)).not.toThrow();
  });
});
