import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  buildMap,
  groupByBasename,
  moduleOf,
  parseArgs,
  resolveTs,
  tarjan,
  writeReport,
  type CodeMap,
} from './code-map.ts';

const temps: string[] = [];

afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: 'map@test',
      GIT_AUTHOR_NAME: 'map',
      GIT_COMMITTER_EMAIL: 'map@test',
      GIT_COMMITTER_NAME: 'map',
    },
  });
}

test('parseArgs defaults and flags', () => {
  expect(parseArgs([])).toEqual({
    scope: 'cli/src',
    outDir: null,
    days: 90,
    depth: 2,
  });
  expect(parseArgs(['native/computer-mac', '--days', '30', '--depth', '1'])).toEqual({
    scope: 'native/computer-mac',
    outDir: null,
    days: 30,
    depth: 1,
  });
  expect(parseArgs(['--out', 'reports/custom', '--days', '7']).outDir).toBe('reports/custom');
});

test('moduleOf cuts at depth', () => {
  expect(moduleOf('commands/sessions.ts', 1)).toBe('commands');
  expect(moduleOf('lib/session/store.ts', 2)).toBe('lib/session');
  expect(moduleOf('index.ts', 2)).toBe('(root)');
});

test('resolveTs follows .js specifiers onto .ts files', () => {
  const files = new Set(['a.ts', 'b.ts', 'lib/foo.ts', 'commands/bar.ts']);
  expect(resolveTs('a.ts', './b.js', files)).toBe('b.ts');
  expect(resolveTs('lib/foo.ts', '../commands/bar.ts', files)).toBe('commands/bar.ts');
  expect(resolveTs('a.ts', 'lodash', files)).toBeNull();
});

test('tarjan reports a 2-cycle and leaves a singleton out', () => {
  const sccs = tarjan(['a', 'b', 'c'], new Map([['a', ['b']], ['b', ['a']], ['c', []]]));
  expect(sccs).toHaveLength(1);
  expect(sccs[0].sort()).toEqual(['a', 'b']);
});

test('groupByBasename collects same-name families', () => {
  const fam = groupByBasename(['cli/src/a.ts', 'pkg/src/a.ts', 'cli/src/b.ts']);
  expect(fam).toEqual([{ name: 'a.ts', paths: ['cli/src/a.ts', 'pkg/src/a.ts'] }]);
});

test('buildMap measures loc, same-name clones, and a real import cycle', () => {
  const root = tmp('code-map-');
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'map@test');
  git(root, 'config', 'user.name', 'map');
  mkdirSync(join(root, 'src/other'), { recursive: true });
  writeFileSync(
    join(root, 'src/a.ts'),
    'import { b } from "./b.js";\nexport const a = 1;\nexport { b };\n',
  );
  writeFileSync(join(root, 'src/b.ts'), 'import { a } from "./a.js";\nexport const b = a;\n');
  writeFileSync(join(root, 'src/c.ts'), 'export const c = 3;\n');
  writeFileSync(join(root, 'src/other/a.ts'), 'export const otherA = 4;\n');
  git(root, 'add', 'src');
  git(root, 'commit', '-qm', 'seed');

  const map = buildMap({
    repoRoot: root,
    scope: 'src',
    days: 90,
    depth: 1,
  });
  expect(map.files.length).toBe(4);
  expect(map.loc).toBeGreaterThan(4);
  expect(map.cycles.some((c) => c.includes('a.ts') && c.includes('b.ts'))).toBe(true);
  expect(map.similar.some((f) => f.name === 'a.ts' && f.paths.length === 2)).toBe(true);
  expect(map.files.filter((f) => f.module === '(root)').length).toBe(3);
});

test('writeReport emits index.html and map.json', () => {
  const out = tmp('code-map-out-');
  const map: CodeMap = {
    repoRoot: out,
    scope: 'src',
    date: '2026-09-06',
    days: 90,
    depth: 1,
    files: [{ path: 'a.ts', loc: 10, commits: 1, module: '(root)' }],
    loc: 10,
    edges: [],
    cycles: [],
    similar: [],
    treemap: [{ path: 'a.ts', x: 0, y: 0, w: 10, h: 10, loc: 10, commits: 1, leaf: true }],
    maxCommits: 1,
  };
  const paths = writeReport(map, out);
  const html = readFileSync(paths.html, 'utf8');
  const json = JSON.parse(readFileSync(paths.json, 'utf8'));
  expect(html).toContain('code-map');
  expect(html).toContain('a.ts');
  expect(json.loc).toBe(10);
});
