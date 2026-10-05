import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { copyPluginToMarketplace } from '../plugins/plugin-marketplace.js';
import type { DiscoveredPlugin } from '../types.js';


let tmpDir = '';
let pluginSource = '';
let outsideTarget = '';
let versionHome = '';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-marketplace-test-'));
  pluginSource = path.join(tmpDir, 'plugins', 'sample');
  outsideTarget = path.join(tmpDir, 'sibling-monorepo');
  versionHome = path.join(tmpDir, 'versions', 'claude', '99.99.99');
  fs.mkdirSync(pluginSource, { recursive: true });
  fs.mkdirSync(outsideTarget, { recursive: true });
  fs.mkdirSync(versionHome, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makePlugin(name: string): DiscoveredPlugin {
  return { name, root: pluginSource } as unknown as DiscoveredPlugin;
}

describe('copyPluginToMarketplace', () => {
  it('skips symlinks whose target escapes the plugin root (the rush-app bug)', () => {
    fs.mkdirSync(path.join(pluginSource, '.claude-plugin'));
    fs.writeFileSync(
      path.join(pluginSource, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'sample', version: '1.0.0' }),
    );
    fs.mkdirSync(path.join(pluginSource, 'skills', 'helper'), { recursive: true });
    fs.writeFileSync(path.join(pluginSource, 'skills', 'helper', 'SKILL.md'), 'helper');
    fs.writeFileSync(path.join(outsideTarget, 'huge.bin'), Buffer.alloc(1024));
    fs.symlinkSync(outsideTarget, path.join(pluginSource, 'app'));

    const dest = copyPluginToMarketplace(makePlugin('sample'), { kind: 'user' }, 'claude', versionHome);

    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.existsSync(path.join(dest, 'app'))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'skills', 'helper', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(dest, '.claude-plugin', 'plugin.json'))).toBe(true);
  });

  it('preserves symlinks whose target stays inside the plugin root', () => {
    fs.mkdirSync(path.join(pluginSource, 'skills', 'real'), { recursive: true });
    fs.writeFileSync(path.join(pluginSource, 'skills', 'real', 'SKILL.md'), 'real skill');
    fs.symlinkSync('real', path.join(pluginSource, 'skills', 'alias'));

    const dest = copyPluginToMarketplace(makePlugin('sample'), { kind: 'user' }, 'claude', versionHome);

    const aliasPath = path.join(dest, 'skills', 'alias');
    const aliasStat = fs.lstatSync(aliasPath);
    expect(aliasStat.isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(aliasPath + '/SKILL.md', 'utf-8')).toBe('real skill');
  });

  it('copies regular files and directories untouched when no symlinks are present', () => {
    fs.mkdirSync(path.join(pluginSource, '.claude-plugin'));
    fs.writeFileSync(
      path.join(pluginSource, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'plain', version: '0.0.1' }),
    );
    fs.mkdirSync(path.join(pluginSource, 'commands'));
    fs.writeFileSync(path.join(pluginSource, 'commands', 'hello.md'), 'hello');
    fs.mkdirSync(path.join(pluginSource, 'hooks'));
    fs.writeFileSync(path.join(pluginSource, 'hooks', 'hooks.json'), '[]');

    const dest = copyPluginToMarketplace(makePlugin('plain'), { kind: 'user' }, 'claude', versionHome);

    expect(fs.readFileSync(path.join(dest, 'commands', 'hello.md'), 'utf-8')).toBe('hello');
    expect(fs.readFileSync(path.join(dest, 'hooks', 'hooks.json'), 'utf-8')).toBe('[]');
  });

  it('rush-shaped fixture (3 outside symlinks at top level) stays small', () => {
    for (const name of ['app', 'web', 'widgets']) {
      const dir = path.join(outsideTarget, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'large.bin'), Buffer.alloc(8 * 1024));
      fs.symlinkSync(dir, path.join(pluginSource, name));
    }
    fs.mkdirSync(path.join(pluginSource, '.claude-plugin'));
    fs.writeFileSync(
      path.join(pluginSource, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'rush-like', version: '1.0.0' }),
    );
    fs.writeFileSync(path.join(pluginSource, 'README.md'), '# rush-like');

    const dest = copyPluginToMarketplace(makePlugin('rush-like'), { kind: 'user' }, 'claude', versionHome);

    for (const name of ['app', 'web', 'widgets']) {
      expect(fs.existsSync(path.join(dest, name))).toBe(false);
    }
    expect(fs.existsSync(path.join(dest, '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(fs.readFileSync(path.join(dest, 'README.md'), 'utf-8')).toBe('# rush-like');
  });
});
