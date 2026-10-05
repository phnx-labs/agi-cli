import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  newFixture, writeFile,
  build, isStale, list,
  type Fixture,
} from './_fixtures.js';
import * as fs from 'fs';
import * as path from 'path';

function writePlugin(fx: Fixture, layer: 'project'|'user'|'system', name: string, manifest: object = { name, version: '1.0.0' }): string {
  return path.dirname(path.dirname(
    writeFile(fx, layer, `plugins/${name}/.claude-plugin/plugin.json`, JSON.stringify(manifest))
  ));
}

describe('staleness e2e: plugins', () => {
  let fx: Fixture;
  beforeEach(() => { fx = newFixture('plg'); });
  afterEach(()  => fx.cleanup());

  it('empty -> empty list, clean', () => {
    expect(list(fx, 'plugins')).toEqual([]);
    build(fx);
    expect(isStale(fx)).toBe(false);
  });

  it('lists across all layers', () => {
    writePlugin(fx, 'system',  'sys-plg');
    writePlugin(fx, 'user',    'usr-plg');
    writePlugin(fx, 'project', 'proj-plg');
    expect(new Set(list(fx, 'plugins'))).toEqual(new Set(['sys-plg', 'usr-plg', 'proj-plg']));
  });

  it('plugin added -> stale', () => {
    writePlugin(fx, 'user', 'one');
    build(fx);
    writePlugin(fx, 'system', 'two');
    expect(isStale(fx)).toBe(true);
  });

  it('plugin removed -> stale', () => {
    writePlugin(fx, 'user', 'one');
    writePlugin(fx, 'user', 'two');
    build(fx);
    fs.rmSync(path.join(fx.userDir, 'plugins/two'), { recursive: true });
    expect(isStale(fx)).toBe(true);
  });

  it('plugin manifest changed -> stale (covers files inside .claude-plugin/)', () => {
    writePlugin(fx, 'user', 'one', { name: 'one', version: '1.0.0' });
    build(fx);
    writePlugin(fx, 'user', 'one', { name: 'one', version: '2.5.99-rc1' });
    expect(isStale(fx)).toBe(true);
  });

  it('recursive: skill bundled inside plugin tracked (plugin.skills/<name>/SKILL.md)', () => {
    writePlugin(fx, 'user', 'one');
    fs.mkdirSync(path.join(fx.userDir, 'plugins/one/skills/inner'), { recursive: true });
    fs.writeFileSync(path.join(fx.userDir, 'plugins/one/skills/inner/SKILL.md'), 'inner-v1');
    build(fx);
    fs.writeFileSync(path.join(fx.userDir, 'plugins/one/skills/inner/SKILL.md'), 'inner-v2-different-len');
    expect(isStale(fx)).toBe(true);
  });

  it('recursive: command bundled inside plugin tracked (plugin.commands/<name>.md)', () => {
    writePlugin(fx, 'user', 'one');
    fs.mkdirSync(path.join(fx.userDir, 'plugins/one/commands'), { recursive: true });
    fs.writeFileSync(path.join(fx.userDir, 'plugins/one/commands/inner-cmd.md'), 'cmd');
    build(fx);
    fs.unlinkSync(path.join(fx.userDir, 'plugins/one/commands/inner-cmd.md'));
    expect(isStale(fx)).toBe(true);
  });

  it('recursive: hook bundled inside plugin tracked (plugin.hooks/*)', () => {
    writePlugin(fx, 'user', 'one');
    fs.mkdirSync(path.join(fx.userDir, 'plugins/one/hooks'), { recursive: true });
    const h = path.join(fx.userDir, 'plugins/one/hooks/inner-hook.sh');
    fs.writeFileSync(h, '#!/bin/bash');
    fs.chmodSync(h, 0o755);
    build(fx);
    fs.writeFileSync(h, '#!/bin/bash\necho changed');
    expect(isStale(fx)).toBe(true);
  });

  it('plugin-internal resources do NOT pollute top-level checkers', () => {
    writePlugin(fx, 'user', 'one');
    fs.mkdirSync(path.join(fx.userDir, 'plugins/one/skills/inner'), { recursive: true });
    fs.writeFileSync(path.join(fx.userDir, 'plugins/one/skills/inner/SKILL.md'), 'inner');
    expect(list(fx, 'skills')).toEqual([]);
    expect(list(fx, 'plugins')).toEqual(['one']);
  });

  it('file added inside plugin (e.g., new skill bundled in plugin) -> stale', () => {
    writePlugin(fx, 'user', 'one');
    build(fx);
    const skillDir = path.join(fx.userDir, 'plugins/one/skills/new-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'new');
    expect(isStale(fx)).toBe(true);
  });

  it('layer swap (user -> project of same name) -> stale', () => {
    writePlugin(fx, 'user', 'same');
    build(fx);
    writePlugin(fx, 'project', 'same');
    expect(isStale(fx)).toBe(true);
  });

  it('directories without .claude-plugin/plugin.json are not plugins', () => {
    fs.mkdirSync(path.join(fx.userDir, 'plugins/not-a-plugin'), { recursive: true });
    fs.writeFileSync(path.join(fx.userDir, 'plugins/not-a-plugin/README.md'), 'docs');
    expect(list(fx, 'plugins')).toEqual([]);
  });

  it('v1 manifests with no plugins field: plugin appears -> stale, then clean after rebuild', () => {
    build(fx);
    expect(isStale(fx)).toBe(false);
    writePlugin(fx, 'user', 'fresh');
    expect(isStale(fx)).toBe(true);
    build(fx);
    expect(isStale(fx)).toBe(false);
  });
});
