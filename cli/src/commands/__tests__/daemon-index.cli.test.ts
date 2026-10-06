import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const repoRoot = process.cwd();
const cliEntry = path.join(repoRoot, 'src', 'index.ts');
const tsxBin = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-index-cli-'));
fs.mkdirSync(path.join(home, '.agents', '.system', '.git'), { recursive: true });
process.env.HOME = home;

const { closeDB, getDB } = await import('../../lib/session/db.js');
const { getSessionsDbPath } = await import('../../lib/state.js');

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [tsxBin, cliEntry, ...args], {
    cwd: home,
    env: { ...process.env, HOME: home, NODE_NO_WARNINGS: '1', ...env },
    encoding: 'utf-8',
  });
}

function json<T>(args: string[]): T {
  const res = run(args);
  expect(res.stderr).toBe('');
  expect(res.status).toBe(0);
  return JSON.parse(res.stdout) as T;
}

const codexDir = path.join(home, '.codex', 'sessions', '2026', '10', '06');
const routineDir = path.join(home, '.agents', '.history', 'runs', 'nightly', '2026-10-06T00-00', 'sessions', 'claude', 'projects');

beforeAll(() => {
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, 'rollout-daemon-index.jsonl'), [
    { timestamp: '2026-10-06T00:00:00Z', type: 'session_meta', payload: { id: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001', cwd: home, cli_version: '0.120.0' } },
    { timestamp: '2026-10-06T00:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'check the repo status' }] } },
    { timestamp: '2026-10-06T00:00:02Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: JSON.stringify({ cmd: 'git status; git diff' }) } },
    { timestamp: '2026-10-06T00:00:03Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'clean' } },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');
  fs.mkdirSync(routineDir, { recursive: true });
});

afterAll(() => {
  closeDB();
  fs.rmSync(home, { recursive: true, force: true });
});

interface ToolsEnvelope {
  kind: string;
  complete: boolean;
  machines: Array<{ indexedFiles: number; indexedCalls: number; coverage: { indexedFiles: number; complete: boolean } }>;
}

describe('agents daemon index (real CLI parse, disposable HOME)', () => {
  it('rejects invalid filters before the index is created', () => {
    for (const args of [
      ['--agent', 'nope'],
      ['--since', 'bogus'],
      ['--local', '--fleet'],
      ['--local', '--device', 'some-box'],
      ['--device', 'some-box', '--since', 'bogus'],
      ['--fleet', '--agent', 'nope'],
    ]) {
      const res = run(['daemon', 'index', 'backfill', 'tools', ...args]);
      expect(res.status, args.join(' ')).toBe(1);
      expect(res.stderr).not.toContain('does not support --device');
      expect(res.stderr).not.toContain('some-box:');
    }
    const resources = run(['daemon', 'index', 'backfill', 'resources', '--until', 'later']);
    expect(resources.status).toBe(1);
    expect(resources.stderr).toContain('--until must be');
    const titles = run(['daemon', 'index', 'backfill', 'titles', '--limit', '0']);
    expect(titles.status).toBe(1);
    expect(titles.stderr).toContain('--limit must be a positive integer');
    expect(fs.existsSync(getSessionsDbPath())).toBe(false);
  });

  it('prints the same roots as `sessions --roots`, including routine archives', () => {
    const roots = json<Array<{ agent: string; dirs: string[] }>>(['daemon', 'index', 'roots']);
    expect(roots).toEqual([
      { agent: 'claude', dirs: [routineDir] },
      { agent: 'codex', dirs: [path.join(home, '.codex', 'sessions')] },
    ]);
    expect(json(['sessions', '--roots', '--json'])).toEqual(roots);
  });

  it('backfills tools under the agent/unmanaged filters and reruns as a no-op', () => {
    json<ToolsEnvelope>(['daemon', 'index', 'backfill', 'tools', '--local', '--unmanaged', '--json']);
    getDB().exec(`
      DELETE FROM tool_program_occurrences;
      DELETE FROM tool_call_programs;
      DELETE FROM tool_call_text;
      DELETE FROM tool_calls;
      DELETE FROM tool_scan_ledger;
    `);

    const outsideWindow = json<ToolsEnvelope>(['daemon', 'index', 'backfill', 'tools', '--local', '--unmanaged', '--until', '2000-01-01', '--json']);
    expect(outsideWindow.machines[0]).toMatchObject({ indexedFiles: 0, coverage: { indexedFiles: 0 } });
    const otherAgent = json<ToolsEnvelope>(['daemon', 'index', 'backfill', 'tools', '--local', '--unmanaged', '--agent', 'claude', '--json']);
    expect(otherAgent.machines[0].indexedFiles).toBe(0);

    const first = json<ToolsEnvelope>(['daemon', 'index', 'backfill', 'tools', '--local', '--unmanaged', '--agent', 'codex', '--json']);
    expect(first).toMatchObject({ kind: 'tools-backfill', complete: true, machines: [{ indexedFiles: 1, indexedCalls: 1 }] });
    expect(getDB().prepare(`SELECT program FROM tool_program_occurrences ORDER BY occurrence_ordinal`).all())
      .toEqual([{ program: 'git' }, { program: 'git' }]);

    const again = json<ToolsEnvelope>(['daemon', 'index', 'backfill', 'tools', '--local', '--unmanaged', '--agent', 'codex', '--json']);
    expect(again.machines[0]).toMatchObject({ indexedFiles: 0, indexedCalls: 0, coverage: { indexedFiles: 1, complete: true } });

    // The exact argv shape a fleet peer receives from `peerArgs`, every filter set.
    const peer = json<ToolsEnvelope>([
      'daemon', 'index', 'backfill', 'tools', '--json', '--local', '--agent', 'codex', '--project', path.basename(home),
      '--since', '2026-10-01', '--until', '2099-01-01', '--unmanaged', '--teams',
    ]);
    expect(peer).toMatchObject({ kind: 'tools-backfill', complete: true, machines: [{ indexedFiles: 0 }] });
  });

  it('optimizes the FTS index without losing searchable rows', () => {
    const db = getDB();
    const hits = () => (db.prepare(`SELECT count(*) AS n FROM tool_call_text WHERE tool_call_text MATCH 'git'`).get() as { n: number }).n;
    const before = hits();
    expect(before).toBeGreaterThan(0);
    const results = json<Array<{ table: string; segmentsBefore: number; segmentsAfter: number }>>(['daemon', 'index', 'optimize', '--json']);
    expect(results.map((r) => r.table).sort()).toEqual(['session_text', 'tool_call_text']);
    for (const r of results) expect(r.segmentsAfter).toBeLessThanOrEqual(r.segmentsBefore);
    expect(hits()).toBe(before);
  });

  it('derives resource usage once and skips current transcripts on rerun', () => {
    const first = json<{ kind: string; scanned: number; updated: number; skipped: number }>(
      ['daemon', 'index', 'backfill', 'resources', '--agent', 'codex', '--json'],
    );
    expect(first).toMatchObject({ kind: 'resources-backfill', scanned: 1, updated: 1, skipped: 0 });
    const second = json<{ updated: number; skipped: number }>(['daemon', 'index', 'backfill', 'resources', '--agent', 'codex', '--json']);
    expect(second).toMatchObject({ updated: 0, skipped: 1 });
  });

  it('titles best-effort with no signed-in harness: nothing generated, still exits 0', () => {
    const res = json<{ kind: string; scanned: number; generated: number; failed: number; titles: unknown[] }>(['daemon', 'index', 'backfill', 'titles', '--json']);
    expect(res).toMatchObject({ kind: 'titles-backfill', scanned: 1, generated: 0, failed: 1, titles: [] });
  });
});
