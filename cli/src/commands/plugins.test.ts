import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectPluginCapabilities } from '../lib/plugins/plugins.js';
import { shouldRefusePluginInstall, collectMarketplaceRows } from './plugins.js';
import { discoverMarketplaces } from '../lib/plugins/plugin-marketplace.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');
const tempDirs: string[] = [];

function makePluginRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-plugin-cmd-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'risky-plugin', version: '1.0.0', description: 'test' })
  );
  return dir;
}

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-plugin-home-'));
  tempDirs.push(home);
  const systemDir = path.join(home, '.agents', '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: 4102444800000, latestVersion: '0.0.0' }),
  );
  return home;
}

function runCli(home: string, args: string[]): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('bun', [INDEX, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: home, AGENTS_NO_UPDATE_CHECK: '1' },
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('plugins install trust gate', () => {
  it('refuses hook-bearing plugins unless --allow-exec-surfaces is set', () => {
    const root = makePluginRoot();
    fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'hooks', 'foo.sh'), '#!/bin/sh\nexit 0\n');
    const capabilities = inspectPluginCapabilities(root);

    expect(shouldRefusePluginInstall(capabilities, false)).toBe(true);
    expect(shouldRefusePluginInstall(capabilities, true)).toBe(false);
  });

  it('installs a plugin with no exec surfaces without the flag', () => {
    const root = makePluginRoot();
    fs.mkdirSync(path.join(root, 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(root, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\n');
    const capabilities = inspectPluginCapabilities(root);

    expect(shouldRefusePluginInstall(capabilities, false)).toBe(false);
    expect(shouldRefusePluginInstall(capabilities, true)).toBe(false);
  });
});

describe('plugins add alias', () => {
  it('installs through the add alias', () => {
    const home = makeHome();
    const root = makePluginRoot();

    const { stdout, stderr, status } = runCli(home, ['plugins', 'add', root]);

    expect(status).toBe(0);
    expect(stdout + stderr).toContain('Installed risky-plugin v1.0.0');
    expect(fs.existsSync(path.join(home, '.agents', 'plugins', 'risky-plugin', '.claude-plugin', 'plugin.json'))).toBe(true);
  });
});

describe('plugins marketplaces subcommand', () => {
  it('collectMarketplaceRows returns an array with the documented shape', () => {
    const rows = collectMarketplaceRows();
    expect(Array.isArray(rows)).toBe(true);
    for (const r of rows) {
      expect(typeof r.name).toBe('string');
      expect(typeof r.source).toBe('string');
      expect(typeof r.plugins).toBe('number');
      expect(typeof r.enabled).toBe('number');
    }
  });

  it('row counts match discoverMarketplaces() for the user repo', () => {
    const rows = collectMarketplaceRows();
    const discovered = discoverMarketplaces();
    expect(rows.map((r) => r.name).sort()).toEqual(discovered.map((d) => d.name).sort());
  });
});

describe('discoverMarketplaces with project cwd', () => {
  let savedCwd: string;
  let projectDir: string;

  beforeEach(() => {
    savedCwd = process.cwd();
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-mkt-proj-'));
    tempDirs.push(projectDir);
  });

  afterEach(() => {
    try { process.chdir(savedCwd); } catch {  }
  });

  it('exposes a project marketplace when <cwd>/.agents/plugins/ exists', () => {
    fs.mkdirSync(path.join(projectDir, '.agents', 'plugins', 'sample', '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, '.agents', 'plugins', 'sample', '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'sample', version: '0.0.1', description: 'd' })
    );

    const discovered = discoverMarketplaces({ cwd: projectDir });
    const names = discovered.map((d) => d.name);
    expect(names).toContain('agents-project');
  });
});
