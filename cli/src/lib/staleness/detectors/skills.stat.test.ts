import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { skillDirsMatch } from './skills.js';

function makeTree(): { home: string; src: string; dest: string; cleanup: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-stat-'));
  const src = path.join(home, 'src-skill');
  const dest = path.join(home, 'dest-skill');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(src, 'SKILL.md'), 'hello skill\n');
  fs.writeFileSync(path.join(src, 'extra.md'), 'extra body\n');
  fs.writeFileSync(path.join(dest, 'SKILL.md'), 'hello skill\n');
  fs.writeFileSync(path.join(dest, 'extra.md'), 'extra body\n');
  return {
    home,
    src,
    dest,
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

describe('skillDirsMatch stat-first (RUSH-2320 #2)', () => {
  let tree: ReturnType<typeof makeTree>;
  beforeEach(() => { tree = makeTree(); });
  afterEach(() => tree.cleanup());

  it('matches identical content even when mtimes differ', () => {
    expect(skillDirsMatch(tree.src, tree.dest)).toBe(true);
  });

  it('rejects on size mismatch', () => {
    fs.writeFileSync(path.join(tree.dest, 'extra.md'), 'x');
    expect(skillDirsMatch(tree.src, tree.dest)).toBe(false);
  });

  it('rejects when same size but different content', () => {
    fs.writeFileSync(path.join(tree.dest, 'extra.md'), 'EXTRA BODY\n');
    expect(skillDirsMatch(tree.src, tree.dest)).toBe(false);
  });

  it('rejects when dest is missing a file', () => {
    fs.unlinkSync(path.join(tree.dest, 'extra.md'));
    expect(skillDirsMatch(tree.src, tree.dest)).toBe(false);
  });
});
