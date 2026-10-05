import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pickSessionFile, pickClaudeSessionFileAcrossRoots } from './active.js';


let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickfile-'));
  fs.writeFileSync(path.join(dir, 'a.jsonl'), '{"a":1}\n');
  fs.writeFileSync(path.join(dir, 'b.jsonl'), '{"b":1}\n');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(dir, 'a.jsonl'), old, old);
});

afterAll(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {  }
});

describe('pickSessionFile', () => {
  it('a concrete id returns its own file', () => {
    expect(pickSessionFile(dir, 'a')).toBe(path.join(dir, 'a.jsonl'));
    expect(pickSessionFile(dir, 'b')).toBe(path.join(dir, 'b.jsonl'));
  });

  it('a supplied-but-missing id returns undefined — NOT the newest sibling', () => {
    expect(pickSessionFile(dir, 'does-not-exist')).toBeUndefined();
  });

  it('two distinct missing ids do NOT collapse onto the same file', () => {
    expect(pickSessionFile(dir, 'ghost-1')).toBeUndefined();
    expect(pickSessionFile(dir, 'ghost-2')).toBeUndefined();
  });

  it('no id falls back to the newest file (legitimate single-session heuristic)', () => {
    expect(pickSessionFile(dir, undefined)).toBe(path.join(dir, 'b.jsonl'));
  });

  it('an unreadable project dir returns undefined', () => {
    expect(pickSessionFile(path.join(dir, 'nope'), undefined)).toBeUndefined();
  });
});

describe('pickClaudeSessionFileAcrossRoots', () => {
  let base: string;
  const cwd = '/work/proj';
  const enc = cwd.replace(/[/.]/g, '-');
  const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  const projectsRoot = (name: string) => path.join(base, name);
  const projDir = (name: string) => path.join(projectsRoot(name), enc);
  const roots = () => [projectsRoot('live'), projectsRoot('old')];

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'roots-'));
    fs.mkdirSync(projDir('live'), { recursive: true });
    fs.mkdirSync(projDir('old'), { recursive: true });
  });

  afterAll(() => {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {  }
  });

  it('finds a session whose transcript lives ONLY in an older version home', () => {
    fs.writeFileSync(path.join(projDir('old'), `${sid}.jsonl`), '{"x":1}\n');
    expect(pickClaudeSessionFileAcrossRoots(roots(), cwd, sid)).toBe(
      path.join(projDir('old'), `${sid}.jsonl`),
    );
  });

  it('newest mtime wins when the id resolves in more than one root', () => {
    const liveHit = path.join(projDir('live'), `${sid}.jsonl`);
    const oldHit = path.join(projDir('old'), `${sid}.jsonl`);
    fs.writeFileSync(liveHit, '{"x":2}\n');
    const stale = new Date(Date.now() - 120_000);
    fs.utimesSync(oldHit, stale, stale);
    expect(pickClaudeSessionFileAcrossRoots(roots(), cwd, sid)).toBe(liveHit);
  });

  it('a supplied-but-missing id returns undefined across all roots', () => {
    expect(
      pickClaudeSessionFileAcrossRoots(roots(), cwd, 'ffffffff-0000-0000-0000-000000000000'),
    ).toBeUndefined();
  });
});
