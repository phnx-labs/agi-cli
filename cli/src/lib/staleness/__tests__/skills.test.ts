import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  newFixture, writeFile,
  build, isStale, list,
  type Fixture,
} from './_fixtures.js';
import * as fs from 'fs';
import * as path from 'path';

function writeSkill(fx: Fixture, layer: 'project'|'user'|'system', name: string, extraFiles: Record<string, string> = {}, skillMd = 'skill body'): string {
  const p = writeFile(fx, layer, `skills/${name}/SKILL.md`, skillMd);
  const dir = path.dirname(p);
  for (const [rel, content] of Object.entries(extraFiles)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

describe('staleness e2e: skills', () => {
  let fx: Fixture;
  beforeEach(() => { fx = newFixture('skill'); });
  afterEach(()  => fx.cleanup());

  it('empty -> empty list, clean manifest', () => {
    expect(list(fx, 'skills')).toEqual([]);
    build(fx);
    expect(isStale(fx)).toBe(false);
  });

  it('lists across all layers, first-wins on name', () => {
    writeSkill(fx, 'system',  'sys');
    writeSkill(fx, 'user',    'usr');
    writeSkill(fx, 'project', 'proj');
    expect(new Set(list(fx, 'skills'))).toEqual(new Set(['sys', 'usr', 'proj']));
  });

  it('clean -> not stale', () => {
    writeSkill(fx, 'user', 'one', { 'helper.md': 'helper' });
    build(fx);
    expect(isStale(fx)).toBe(false);
  });

  it('skill added -> stale', () => {
    writeSkill(fx, 'user', 'one');
    build(fx);
    writeSkill(fx, 'system', 'two');
    expect(isStale(fx)).toBe(true);
  });

  it('skill removed -> stale', () => {
    writeSkill(fx, 'user', 'one');
    writeSkill(fx, 'user', 'two');
    build(fx);
    fs.rmSync(path.join(fx.userDir, 'skills/two'), { recursive: true });
    expect(isStale(fx)).toBe(true);
  });

  it('SKILL.md content changed -> stale', () => {
    writeSkill(fx, 'user', 'one', {}, 'original');
    build(fx);
    fs.writeFileSync(path.join(fx.userDir, 'skills/one/SKILL.md'), 'modified content');
    expect(isStale(fx)).toBe(true);
  });

  it('file added inside skill dir -> stale', () => {
    writeSkill(fx, 'user', 'one');
    build(fx);
    fs.writeFileSync(path.join(fx.userDir, 'skills/one/new-helper.md'), 'new');
    expect(isStale(fx)).toBe(true);
  });

  it('file removed inside skill dir -> stale', () => {
    writeSkill(fx, 'user', 'one', { 'helper.md': 'helper' });
    build(fx);
    fs.unlinkSync(path.join(fx.userDir, 'skills/one/helper.md'));
    expect(isStale(fx)).toBe(true);
  });

  it('layer swap (user -> project) -> stale (different dirPath)', () => {
    writeSkill(fx, 'user', 'same');
    build(fx);
    writeSkill(fx, 'project', 'same');
    expect(isStale(fx)).toBe(true);
  });

  it('layer fallback (project removed, user remains) -> stale', () => {
    writeSkill(fx, 'user',    'same');
    writeSkill(fx, 'project', 'same');
    build(fx);
    fs.rmSync(path.join(fx.projectAgents, 'skills/same'), { recursive: true });
    expect(isStale(fx)).toBe(true);
  });

  it('directories without SKILL.md are not skills', () => {
    fs.mkdirSync(path.join(fx.userDir, 'skills/not-a-skill'), { recursive: true });
    fs.writeFileSync(path.join(fx.userDir, 'skills/not-a-skill/README.md'), 'docs');
    expect(list(fx, 'skills')).toEqual([]);
  });
});
