import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';

const repoRoot = process.cwd();
const cliEntry = path.join(repoRoot, 'src', 'index.ts');
const tsxBin = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

let home: string;

function run(args: string[]) {
  return spawnSync(process.execPath, [tsxBin, cliEntry, ...args], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      AGENTS_SKIP_MIGRATION: '1',
      AGENTS_SESSIONS_FORCE_REFRESH: '1',
      NODE_NO_WARNINGS: '1',
    },
    encoding: 'utf-8',
  });
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bookmark-cli-' + crypto.randomBytes(4).toString('hex') + '-'));
  fs.mkdirSync(path.join(home, '.agents', '.system', '.git'), { recursive: true });
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('agents sessions bookmark (real CLI parse)', () => {
  it('honors --json even though the parent command also declares it', () => {
    const res = run(['sessions', 'bookmark', '--list', '--json']);
    expect(res.status).toBe(0);
    expect(() => JSON.parse(res.stdout)).not.toThrow();
    expect(JSON.parse(res.stdout)).toEqual({ bookmarks: [] });
  });

  it('defaults to listing when given no ids', () => {
    const res = run(['sessions', 'bookmark', '--json']);
    expect(JSON.parse(res.stdout)).toEqual({ bookmarks: [] });
  });

  it('exits non-zero on an id that resolves to nothing, so a script cannot read success', () => {
    const res = run(['sessions', 'bookmark', 'nosuchsession99']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('No session matches');
  });

  it('reports the failure in --json too, not just on stderr', () => {
    const res = run(['sessions', 'bookmark', 'nosuchsession99', '--json']);
    expect(res.status).toBe(1);
    const parsed = JSON.parse(res.stdout) as { results: { error?: string }[] };
    expect(parsed.results[0].error).toContain('No session matches');
  });

  it('narrows --active to bookmarked sessions, not just in the browser', () => {
    const registry = path.join(home, '.agents', '.cache', 'terminals', 'live-terminals.json');
    fs.mkdirSync(path.dirname(registry), { recursive: true });
    const bookmarked = 'aaaaaaaa-0000-0000-0000-000000000001';
    const other = 'bbbbbbbb-0000-0000-0000-000000000002';
    fs.writeFileSync(
      registry,
      JSON.stringify({
        w: {
          at: new Date().toISOString(),
          entries: [bookmarked, other].map((sessionId) => ({
            sessionId,
            pid: process.pid,
            kind: 'claude',
            cwd: home,
            startedAtMs: Date.now(),
          })),
        },
      }),
    );

    const all = JSON.parse(run(['sessions', '--active', '--local', '--json']).stdout) as { sessionId?: string }[];
    expect(all.filter((r) => r.sessionId === bookmarked || r.sessionId === other)).toHaveLength(2);

    expect(run(['sessions', 'bookmark', bookmarked]).status).toBe(0);
    const only = JSON.parse(run(['sessions', '--active', '--bookmarks', '--local', '--json']).stdout) as {
      sessionId?: string;
    }[];
    expect(only.map((r) => r.sessionId)).toEqual([bookmarked]);

    run(['sessions', 'bookmark', bookmarked, '--remove']);
    fs.rmSync(registry, { force: true });
  }, 90_000);

  it('narrows real --active JSON output to all or one named routine', () => {
    const routineName = 'nightly-review';
    const routineId = 'dddddddd-0000-0000-0000-000000000004';
    const manualId = 'eeeeeeee-0000-0000-0000-000000000005';
    const project = path.join(home, 'routine-project');
    fs.mkdirSync(project, { recursive: true });
    const archiveDir = path.join(
      home,
      '.agents',
      '.history',
      'runs',
      routineName,
      '2026-08-07T00-00-00-000Z',
      'sessions',
      'claude',
      'projects',
      '-routine-project',
    );
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(
      path.join(archiveDir, `${routineId}.jsonl`),
      [
        {
          type: 'user',
          timestamp: '2026-08-07T00:00:00.000Z',
          cwd: project,
          version: '2.1.0',
          entrypoint: 'cli',
          message: { role: 'user', content: 'run nightly review' },
        },
        {
          type: 'assistant',
          timestamp: '2026-08-07T00:01:00.000Z',
          uuid: `${routineId}-a1`,
          message: {
            id: `${routineId}-m1`,
            model: 'claude-sonnet-4-5',
            content: [{ type: 'text', text: 'done' }],
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        },
      ].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
      'utf-8',
    );

    const indexed = run(['sessions', '--routine', routineName, '--all', '--local', '--json']);
    expect(indexed.status, indexed.stderr).toBe(0);

    const registry = path.join(home, '.agents', '.cache', 'terminals', 'live-terminals.json');
    fs.mkdirSync(path.dirname(registry), { recursive: true });
    fs.writeFileSync(
      registry,
      JSON.stringify({
        w: {
          at: new Date().toISOString(),
          entries: [routineId, manualId].map((sessionId) => ({
            sessionId,
            pid: process.pid,
            kind: 'claude',
            cwd: project,
            startedAtMs: Date.now(),
          })),
        },
      }),
    );

    const all = JSON.parse(run(['sessions', '--active', '--local', '--json']).stdout) as {
      sessionId?: string;
    }[];
    expect(all.filter((row) => row.sessionId === routineId || row.sessionId === manualId)).toHaveLength(2);

    const routines = JSON.parse(run(['sessions', '--active', '--routine', '--local', '--json']).stdout) as {
      sessionId?: string;
      routineName?: string;
    }[];
    expect(routines.map((row) => row.sessionId)).toEqual([routineId]);
    expect(routines[0].routineName).toBe(routineName);

    const named = JSON.parse(run([
      'sessions', '--active', '--routine', 'nightly', '--local', '--json',
    ]).stdout) as { sessionId?: string }[];
    expect(named.map((row) => row.sessionId)).toEqual([routineId]);

    fs.rmSync(registry, { force: true });
  }, 90_000);

  it('bookmarks a complete id with no transcript row — a live session may not be indexed yet', () => {
    const fresh = 'cccccccc-0000-0000-0000-000000000003';
    expect(run(['sessions', 'bookmark', fresh]).status).toBe(0);
    expect(JSON.parse(run(['sessions', 'bookmark', '--list', '--json']).stdout)).toEqual({ bookmarks: [fresh] });
    run(['sessions', 'bookmark', fresh, '--remove']);
  });

  it('still refuses a partial id that resolves to nothing', () => {
    const res = run(['sessions', 'bookmark', 'ccccc']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('No session matches');
  });

  it('lists the bookmark command options on its own --help', () => {
    const res = run(['sessions', 'bookmark', '--help']);
    expect(res.stdout).toContain('--json');
    expect(res.stdout).toContain('--remove');
  });

  it('lists the bookmark filter on the parent sessions help', () => {
    const res = run(['sessions', '--help']);
    expect(res.stdout).toContain('--bookmarks');
  });

  it('rejects the retired favorite command surface instead of keeping an alias', () => {
    const res = run(['sessions', 'favorite', '--list']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('unknown option');
  });

  it('rejects the retired --favorites flag instead of keeping an alias', () => {
    const res = run(['sessions', '--favorites', '--json']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('unknown option');
  });
});
