import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REAL_HOME = process.env.HOME;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-filter-parity-'));

type Discover = typeof import('./discover.js');
type DB = typeof import('./db.js');
type Walk = typeof import('../fs-walk.js');

let discover: Discover;
let db: DB;
let walk: Walk;

const tempTrees: string[] = [];

function makeTempTree(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-filter-tree-'));
  tempTrees.push(dir);
  return dir;
}

function writeFileAt(filePath: string, contents: string, mtimeSec: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf-8');
  fs.utimesSync(filePath, mtimeSec, mtimeSec);
}

function normalize(changed: Array<{ filePath: string; scan: { fileMtimeMs: number; fileSize: number } }>) {
  return changed
    .map((c) => ({ filePath: c.filePath, fileMtimeMs: c.scan.fileMtimeMs, fileSize: c.scan.fileSize }))
    .sort((a, b) => a.filePath.localeCompare(b.filePath));
}

beforeAll(async () => {
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  db = await import('./db.js');
  discover = await import('./discover.js');
  walk = await import('../fs-walk.js');
});

afterAll(() => {
  db.closeDB();
  if (REAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = REAL_HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  for (const dir of tempTrees.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('filterChangedFiles vs filterChangedEntries parity', () => {
  it('returns the identical changed-set for the same tree and empty ledger', () => {
    const dir = makeTempTree();
    writeFileAt(path.join(dir, 'a', 'one.jsonl'), 'aaa', 1_000);
    writeFileAt(path.join(dir, 'b', 'two.jsonl'), 'bbbb', 2_000);
    writeFileAt(path.join(dir, 'three.jsonl'), 'c', 3_000);

    const withStat = walk.walkForFilesWithStat(dir, '.jsonl', 100_000);
    const paths = withStat.map((r) => r.path);
    const prestat = withStat.map((r) => ({ filePath: r.path, fileMtimeMs: r.mtimeMs, fileSize: r.size }));

    const viaStat = discover.filterChangedFiles(paths);
    const viaPreStat = discover.filterChangedEntries(prestat);

    expect(normalize(viaPreStat)).toEqual(normalize(viaStat));
    expect(viaStat.length).toBe(3);
  });

  it('floors mtime identically so a warm (unchanged) file is skipped by both', () => {
    const dir = makeTempTree();
    const warm = path.join(dir, 'warm.jsonl');
    writeFileAt(warm, 'hello', 1_500);

    const fresh = fs.statSync(warm);
    db.recordScans([
      { filePath: warm, scan: { fileMtimeMs: Math.floor(fresh.mtimeMs), fileSize: fresh.size } },
    ]);

    const withStat = walk.walkForFilesWithStat(dir, '.jsonl', 100_000);
    const paths = withStat.map((r) => r.path);
    const prestat = withStat.map((r) => ({ filePath: r.path, fileMtimeMs: r.mtimeMs, fileSize: r.size }));

    const viaStat = discover.filterChangedFiles(paths);
    const viaPreStat = discover.filterChangedEntries(prestat);

    expect(viaStat).toEqual([]);
    expect(normalize(viaPreStat)).toEqual(normalize(viaStat));
  });

  it('detects an append (grown file) identically on both paths', () => {
    const dir = makeTempTree();
    const grow = path.join(dir, 'grow.jsonl');
    writeFileAt(grow, 'start', 2_000);

    const before = fs.statSync(grow);
    db.recordScans([
      { filePath: grow, scan: { fileMtimeMs: Math.floor(before.mtimeMs), fileSize: before.size } },
    ]);
    db.getDB().prepare('UPDATE scan_ledger SET scanned_at = ?').run(0);

    fs.appendFileSync(grow, '-more-more', 'utf-8');
    fs.utimesSync(grow, 5_000, 5_000);

    const withStat = walk.walkForFilesWithStat(dir, '.jsonl', 100_000);
    const paths = withStat.map((r) => r.path);
    const prestat = withStat.map((r) => ({ filePath: r.path, fileMtimeMs: r.mtimeMs, fileSize: r.size }));

    const viaStat = discover.filterChangedFiles(paths);
    const viaPreStat = discover.filterChangedEntries(prestat);

    expect(viaStat.length).toBe(1);
    expect(viaStat[0].filePath).toBe(grow);
    expect(normalize(viaPreStat)).toEqual(normalize(viaStat));
  });
});
