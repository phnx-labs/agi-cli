import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  newFixture, writeFile,
  build, isStale, list,
  type Fixture,
} from './_fixtures.js';

const yaml = (name: string, body = `command: echo ${name}`) =>
  `name: ${name}\ntransport: stdio\n${body}\n`;

describe('staleness e2e: mcp', () => {
  let fx: Fixture;
  beforeEach(() => { fx = newFixture('mcp'); });
  afterEach(()  => fx.cleanup());

  it('empty -> empty list, clean', () => {
    expect(list(fx, 'mcp')).toEqual([]);
    build(fx);
    expect(isStale(fx)).toBe(false);
  });

  it('lists name from inside the yaml, not the filename', () => {
    writeFile(fx, 'user', 'mcp/server-config.yaml', yaml('actual-name'));
    expect(list(fx, 'mcp')).toEqual(['actual-name']);
  });

  it('lists across layers (project + user + system)', () => {
    writeFile(fx, 'system',  'mcp/a.yaml',     yaml('sys-mcp'));
    writeFile(fx, 'user',    'mcp/b.yaml',     yaml('user-mcp'));
    writeFile(fx, 'project', 'mcp/c.yaml',     yaml('proj-mcp'));
    expect(new Set(list(fx, 'mcp'))).toEqual(new Set(['sys-mcp', 'user-mcp', 'proj-mcp']));
  });

  it('clean -> not stale', () => {
    writeFile(fx, 'user', 'mcp/x.yaml', yaml('mcp-x'));
    build(fx);
    expect(isStale(fx)).toBe(false);
  });

  it('server added -> stale', () => {
    writeFile(fx, 'user', 'mcp/x.yaml', yaml('mcp-x'));
    build(fx);
    writeFile(fx, 'user', 'mcp/y.yaml', yaml('mcp-y'));
    expect(isStale(fx)).toBe(true);
  });

  it('server removed -> stale', () => {
    writeFile(fx, 'user', 'mcp/x.yaml', yaml('mcp-x'));
    writeFile(fx, 'user', 'mcp/y.yaml', yaml('mcp-y'));
    build(fx);
    const fs = require('fs');
    const path = require('path');
    fs.unlinkSync(path.join(fx.userDir, 'mcp/y.yaml'));
    expect(isStale(fx)).toBe(true);
  });

  it('yaml content changed -> stale', () => {
    writeFile(fx, 'user', 'mcp/x.yaml', yaml('mcp-x', 'command: echo old'));
    build(fx);
    writeFile(fx, 'user', 'mcp/x.yaml', yaml('mcp-x', 'command: echo new --flag'));
    expect(isStale(fx)).toBe(true);
  });

  it('layer swap (system -> user of same internal name) -> stale', () => {
    writeFile(fx, 'system', 'mcp/from-sys.yaml', yaml('shared'));
    build(fx);
    writeFile(fx, 'user',   'mcp/from-user.yaml', yaml('shared'));
    expect(isStale(fx)).toBe(true);
  });

  it('two yamls with same name: first-wins (project > user > system)', () => {
    writeFile(fx, 'system',  'mcp/a.yaml', yaml('dup', 'command: sys'));
    writeFile(fx, 'user',    'mcp/b.yaml', yaml('dup', 'command: user'));
    writeFile(fx, 'project', 'mcp/c.yaml', yaml('dup', 'command: project'));
    expect(list(fx, 'mcp')).toEqual(['dup']);
    build(fx);
    writeFile(fx, 'user', 'mcp/b.yaml', yaml('dup', 'command: user-v2'));
    expect(isStale(fx)).toBe(false);
  });

  it('non-yaml files ignored', () => {
    writeFile(fx, 'user', 'mcp/foo.yaml', yaml('ok'));
    writeFile(fx, 'user', 'mcp/notes.txt', 'no');
    expect(list(fx, 'mcp')).toEqual(['ok']);
  });
});
