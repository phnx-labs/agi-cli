import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  newFixture, writeFile, removeFile,
  build, isStale, list,
  tickMtime,
  type Fixture,
} from './_fixtures.js';

describe('staleness e2e: commands', () => {
  let fx: Fixture;
  beforeEach(() => { fx = newFixture('cmd'); });
  afterEach(()  => fx.cleanup());

  it('empty repos -> empty list, clean manifest', () => {
    expect(list(fx, 'commands')).toEqual([]);
    build(fx);
    expect(isStale(fx)).toBe(false);
  });

  it('listNames unions across layers (system + user + project)', () => {
    writeFile(fx, 'system',  'commands/sys.md',  'system');
    writeFile(fx, 'user',    'commands/usr.md',  'user');
    writeFile(fx, 'project', 'commands/proj.md', 'project');
    expect(new Set(list(fx, 'commands'))).toEqual(new Set(['sys', 'usr', 'proj']));
  });

  it('clean: build then check returns not stale', () => {
    writeFile(fx, 'user',   'commands/foo.md', 'foo');
    writeFile(fx, 'system', 'commands/bar.md', 'bar');
    build(fx);
    expect(isStale(fx)).toBe(false);
  });

  it('name added (user) -> stale', () => {
    writeFile(fx, 'system', 'commands/foo.md', 'foo');
    build(fx);
    writeFile(fx, 'user',   'commands/bar.md', 'bar');
    expect(isStale(fx)).toBe(true);
  });

  it('name added (project) -> stale', () => {
    writeFile(fx, 'user', 'commands/foo.md', 'foo');
    build(fx);
    writeFile(fx, 'project', 'commands/bar.md', 'bar');
    expect(isStale(fx)).toBe(true);
  });

  it('name removed -> stale', () => {
    writeFile(fx, 'user', 'commands/foo.md', 'foo');
    writeFile(fx, 'user', 'commands/bar.md', 'bar');
    build(fx);
    removeFile(fx, 'user', 'commands/bar.md');
    expect(isStale(fx)).toBe(true);
  });

  it('content changed (sha256 catches it even when mtime stays) -> stale', () => {
    writeFile(fx, 'user', 'commands/foo.md', 'original content');
    build(fx);
    writeFile(fx, 'user', 'commands/foo.md', 'changed content longer');
    expect(isStale(fx)).toBe(true);
  });

  it('content untouched but mtime ticked forward -> NOT stale (sha256 fallback)', () => {
    writeFile(fx, 'user', 'commands/foo.md', 'same content');
    build(fx);
    tickMtime();
    writeFile(fx, 'user', 'commands/foo.md', 'same content');
    expect(isStale(fx)).toBe(false);
  });

  it('layer swap (user -> project of the same name) -> stale (winning path changed)', () => {
    writeFile(fx, 'user', 'commands/foo.md', 'user version');
    build(fx);
    writeFile(fx, 'project', 'commands/foo.md', 'project version');
    expect(isStale(fx)).toBe(true);
  });

  it('layer fallback (project removed, user still present) -> stale (winning path changed)', () => {
    writeFile(fx, 'user',    'commands/foo.md', 'user version');
    writeFile(fx, 'project', 'commands/foo.md', 'project version');
    build(fx);
    removeFile(fx, 'project', 'commands/foo.md');
    expect(isStale(fx)).toBe(true);
  });

  it('non-md files in commands/ ignored', () => {
    writeFile(fx, 'user', 'commands/foo.md', 'cmd');
    writeFile(fx, 'user', 'commands/README.txt', 'readme');
    writeFile(fx, 'user', 'commands/.hidden.md', 'hidden');
    expect(list(fx, 'commands').sort()).toEqual(['foo']);
  });
});
