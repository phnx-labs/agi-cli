import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  newFixture, writeFile,
  build, isStale, list,
  type Fixture,
} from './_fixtures.js';
import * as fs from 'fs';
import * as path from 'path';

function writeSubagent(fx: Fixture, layer: 'project'|'user'|'system', name: string, body = '---\nname: x\n---\nbody'): string {
  return path.dirname(writeFile(fx, layer, `subagents/${name}/AGENT.md`, body));
}

describe('staleness e2e: subagents', () => {
  let fx: Fixture;
  beforeEach(() => { fx = newFixture('sub'); });
  afterEach(()  => fx.cleanup());

  it('empty -> empty list, clean', () => {
    expect(list(fx, 'subagents')).toEqual([]);
    build(fx);
    expect(isStale(fx)).toBe(false);
  });

  it('PROJECT subagents are listed (regression test for the v1 bug)', () => {
    writeSubagent(fx, 'project', 'proj-only');
    writeSubagent(fx, 'user',    'usr');
    writeSubagent(fx, 'system',  'sys');
    expect(new Set(list(fx, 'subagents'))).toEqual(new Set(['proj-only', 'usr', 'sys']));
  });

  it('project-only subagent: clean manifest stays clean (not permanently stale)', () => {
    writeSubagent(fx, 'project', 'p');
    build(fx);
    expect(isStale(fx)).toBe(false);
  });

  it('subagent added -> stale', () => {
    writeSubagent(fx, 'user', 'one');
    build(fx);
    writeSubagent(fx, 'system', 'two');
    expect(isStale(fx)).toBe(true);
  });

  it('subagent removed -> stale', () => {
    writeSubagent(fx, 'user', 'one');
    writeSubagent(fx, 'user', 'two');
    build(fx);
    fs.rmSync(path.join(fx.userDir, 'subagents/two'), { recursive: true });
    expect(isStale(fx)).toBe(true);
  });

  it('AGENT.md content changed -> stale', () => {
    writeSubagent(fx, 'user', 'one', '---\nname: one\n---\noriginal');
    build(fx);
    writeSubagent(fx, 'user', 'one', '---\nname: one\n---\nmodified');
    expect(isStale(fx)).toBe(true);
  });

  it('file added inside subagent dir -> stale', () => {
    writeSubagent(fx, 'user', 'one');
    build(fx);
    fs.writeFileSync(path.join(fx.userDir, 'subagents/one/extra.md'), 'extra');
    expect(isStale(fx)).toBe(true);
  });

  it('layer swap (user -> project of same name) -> stale (different dirPath)', () => {
    writeSubagent(fx, 'user', 'same');
    build(fx);
    writeSubagent(fx, 'project', 'same');
    expect(isStale(fx)).toBe(true);
  });

  it('directories without AGENT.md are not subagents', () => {
    fs.mkdirSync(path.join(fx.userDir, 'subagents/not-a-sub'), { recursive: true });
    fs.writeFileSync(path.join(fx.userDir, 'subagents/not-a-sub/README.md'), 'docs');
    expect(list(fx, 'subagents')).toEqual([]);
  });
});
