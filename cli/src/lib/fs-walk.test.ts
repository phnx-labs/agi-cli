import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { walkForFiles, walkForFilesWithStat, latestFileMtimeMs } from './fs-walk.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-fs-walk-'));
  tempDirs.push(dir);
  return dir;
}

function writeFileAt(filePath: string, mtimeSec: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'x', 'utf-8');
  fs.utimesSync(filePath, mtimeSec, mtimeSec);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('walkForFiles', () => {
  it('returns matching files newest first, honoring the limit', () => {
    const dir = makeTempDir();
    writeFileAt(path.join(dir, 'a', 'old.jsonl'), 1_000);
    writeFileAt(path.join(dir, 'b', 'newest.jsonl'), 3_000);
    writeFileAt(path.join(dir, 'mid.jsonl'), 2_000);
    writeFileAt(path.join(dir, 'ignored.txt'), 4_000);

    const all = walkForFiles(dir, '.jsonl', 10);
    expect(all.map((p) => path.basename(p))).toEqual(['newest.jsonl', 'mid.jsonl', 'old.jsonl']);

    const limited = walkForFiles(dir, '.jsonl', 1);
    expect(limited.map((p) => path.basename(p))).toEqual(['newest.jsonl']);
  });

  it('follows symlinked directories and matches symlinked files', () => {
    const dir = makeTempDir();
    const outside = makeTempDir();
    writeFileAt(path.join(outside, 'linked-dir', 'inside.jsonl'), 2_000);
    writeFileAt(path.join(outside, 'target.jsonl'), 1_000);

    fs.symlinkSync(path.join(outside, 'linked-dir'), path.join(dir, 'linked-dir'));
    fs.symlinkSync(path.join(outside, 'target.jsonl'), path.join(dir, 'link.jsonl'));
    fs.symlinkSync(path.join(outside, 'missing.jsonl'), path.join(dir, 'dangling.jsonl'));

    const found = walkForFiles(dir, '.jsonl', 10).map((p) => path.basename(p));
    expect(found).toEqual(['inside.jsonl', 'link.jsonl']);
  });

  it('stops descending beyond depth 5', () => {
    const dir = makeTempDir();
    const deep = path.join(dir, '1', '2', '3', '4', '5', '6');
    writeFileAt(path.join(deep, 'too-deep.jsonl'), 1_000);
    writeFileAt(path.join(dir, '1', '2', '3', '4', '5', 'reachable.jsonl'), 2_000);

    const found = walkForFiles(dir, '.jsonl', 10).map((p) => path.basename(p));
    expect(found).toEqual(['reachable.jsonl']);
  });
});

describe('walkForFilesWithStat', () => {
  it('returns the same paths in the same order as walkForFiles', () => {
    const dir = makeTempDir();
    writeFileAt(path.join(dir, 'a', 'old.jsonl'), 1_000);
    writeFileAt(path.join(dir, 'b', 'newest.jsonl'), 3_000);
    writeFileAt(path.join(dir, 'mid.jsonl'), 2_000);
    writeFileAt(path.join(dir, 'ignored.txt'), 4_000);

    const paths = walkForFiles(dir, '.jsonl', 10);
    const withStat = walkForFilesWithStat(dir, '.jsonl', 10);
    expect(withStat.map((r) => r.path)).toEqual(paths);

    const limitedPaths = walkForFiles(dir, '.jsonl', 2);
    const limitedWithStat = walkForFilesWithStat(dir, '.jsonl', 2);
    expect(limitedWithStat.map((r) => r.path)).toEqual(limitedPaths);
  });

  it('reports each entry mtime and size matching a fresh statSync', () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, 'p'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'p', 'one.jsonl'), 'hello world', 'utf-8');
    fs.utimesSync(path.join(dir, 'p', 'one.jsonl'), 1_000, 1_000);
    fs.writeFileSync(path.join(dir, 'two.jsonl'), 'x', 'utf-8');
    fs.utimesSync(path.join(dir, 'two.jsonl'), 2_000, 2_000);

    for (const entry of walkForFilesWithStat(dir, '.jsonl', 10)) {
      const fresh = fs.statSync(entry.path);
      expect(entry.mtimeMs).toBe(fresh.mtimeMs);
      expect(entry.size).toBe(fresh.size);
    }
  });
});

describe('latestFileMtimeMs', () => {
  it('returns the newest matching mtime across nested dirs', () => {
    const dir = makeTempDir();
    writeFileAt(path.join(dir, 'a', 'old.jsonl'), 1_000);
    writeFileAt(path.join(dir, 'b', 'c', 'newest.jsonl'), 3_000);
    writeFileAt(path.join(dir, 'newer-but-wrong-ext.txt'), 9_000);

    expect(latestFileMtimeMs(dir, '.jsonl')).toBe(3_000_000);
  });

  it('returns null when nothing matches or the dir is missing', () => {
    const dir = makeTempDir();
    writeFileAt(path.join(dir, 'other.txt'), 1_000);

    expect(latestFileMtimeMs(dir, '.jsonl')).toBeNull();
    expect(latestFileMtimeMs(path.join(dir, 'does-not-exist'), '.jsonl')).toBeNull();
  });

  it('agrees with walkForFiles on the same tree', () => {
    const dir = makeTempDir();
    writeFileAt(path.join(dir, 'p1', 's1.jsonl'), 1_500);
    writeFileAt(path.join(dir, 'p2', 's2.jsonl'), 2_500);

    const [newest] = walkForFiles(dir, '.jsonl', 1);
    expect(latestFileMtimeMs(dir, '.jsonl')).toBe(fs.statSync(newest).mtimeMs);
  });
});
