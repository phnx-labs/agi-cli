import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const repoRoot = process.cwd();
const cliEntry = path.join(repoRoot, 'src', 'index.ts');
const tsxBin = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const fixtures = path.join(repoRoot, 'src', 'commands', '__tests__', 'testdata', 'stats-plugin-names');

interface StatsRow { kind: string; name: string; plugin: string | null; sessions?: number; invocations?: number }
interface StatsJson { ranked: StatsRow[]; zeroInvoked: StatsRow[] }

let home: string;

function stats(): StatsJson {
  const res = spawnSync(process.execPath, [tsxBin, cliEntry, 'sessions', 'stats', '--json', '--top', '0'], {
    cwd: home,
    env: { ...process.env, HOME: home, NODE_NO_WARNINGS: '1', AGENTS_SESSIONS_DB: '' },
    encoding: 'utf-8',
  });
  expect(res.status, res.stderr).toBe(0);
  return JSON.parse(res.stdout) as StatsJson;
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-plugin-names-'));
  fs.mkdirSync(path.join(home, '.agents', '.system', '.git'), { recursive: true });
  fs.cpSync(path.join(fixtures, 'agents'), path.join(home, '.agents'), { recursive: true });
  fs.cpSync(path.join(fixtures, 'transcripts'), path.join(home, '.claude', 'projects', '-work-proj'), { recursive: true });
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('agents sessions stats — ranked and zero-invoked agree on plugin resource names', () => {
  it('records a bare plugin skill and a slash-typed skill under the inventory identity', () => {
    const out = stats();
    const ranked = out.ranked.map(r => ({ kind: r.kind, name: r.name, plugin: r.plugin, sessions: r.sessions, invocations: r.invocations }));
    expect(ranked).toEqual([
      { kind: 'skill', name: 'create:image', plugin: 'create', sessions: 2, invocations: 4 },
      { kind: 'skill', name: 'docs', plugin: null, sessions: 1, invocations: 1 },
    ]);
    expect(out.zeroInvoked.map(r => `${r.kind}:${r.name}`)).toEqual(['command:create:image']);
  });
});
