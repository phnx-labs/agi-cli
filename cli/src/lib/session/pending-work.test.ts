import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ActiveSession, WatchSubagent } from './active.js';
import { readSessionLiveWork, resetPendingWorkFolds } from './pending-work.js';
import {
  loadLocalActiveSessions,
  setActiveSessionsSnapshotPathForTest,
  setImmutableMemoPathForTest,
} from './session-cache.js';

const FIXTURE = path.join(__dirname, 'testdata', 'claude-pending-work.jsonl');
const CODEX_FIXTURE = path.join(__dirname, 'testdata', 'codex-turn-effort.jsonl');
const RESUMED_FIXTURE = path.join(__dirname, 'testdata', 'claude-pending-resumed.jsonl');
const AT1 = (minute: number) => Date.parse(`2026-10-13T01:${String(minute).padStart(2, '0')}:00.000Z`);
const AT = (minute: number) => Date.parse(`2026-10-13T00:${String(minute).padStart(2, '0')}:00.000Z`);

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-work-'));
  resetPendingWorkFolds();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  resetPendingWorkFolds();
});

function copyFixture(source = FIXTURE, name = 'session.jsonl'): string {
  const file = path.join(dir, name);
  fs.copyFileSync(source, file);
  return file;
}

function subagent(id: string, status: WatchSubagent['status'], startedAtMs?: number): WatchSubagent {
  return { id, agentType: 'general-purpose', description: `agent ${id}`, status, toolCount: 1, transcriptPath: `/x/agent-${id}.jsonl`, ...(startedAtMs ? { startedAtMs } : {}) };
}

function row(sessionFile: string, extra: Partial<ActiveSession> = {}): ActiveSession {
  return { context: 'terminal', kind: 'claude', status: 'idle', sessionId: 'pending-fixture', sessionFile, pidAlive: true, ...extra };
}

describe('pending work from a Claude transcript', () => {
  it('reports an idle session waiting on its own background shell while every subagent is done', () => {
    // The 2026-10-13 case: status idle, seven subagents all finished, a background shell still polling.
    const done = Array.from({ length: 7 }, (_, i) => subagent(`a${i}`, 'done'));
    const work = readSessionLiveWork(row(copyFixture(), { subagents: done, subAgentCount: 7 }), AT(12));
    expect(work.pending?.subagents).toEqual([]);
    expect(work.pending?.shells.map((s) => s.id)).toContain('bshellA');
  });

  it('lists only work running now: live shells, armed monitors, running subagents', () => {
    const work = readSessionLiveWork(row(copyFixture(), {
      subagents: [subagent('a1', 'done'), subagent('a2', 'running', AT(9))],
    }), AT(12));
    expect(work.pending).toEqual({
      subagents: [{ id: 'a2', description: 'agent a2', startedAtMs: AT(9) }],
      shells: [
        { id: 'bshellA', description: 'Poll prod health', startedAtMs: AT(1) },
        { id: 'bshellD', description: 'Long build', startedAtMs: AT(8) },
      ],
      monitors: [{ id: 'bmon1', description: 'CI checks', startedAtMs: AT(4) }],
    });
  });

  it('drops a monitor once its timeout has passed even without an expiry notice', () => {
    const work = readSessionLiveWork(row(copyFixture()), AT(4) + 30 * 60_000 + 1);
    expect(work.pending?.monitors).toEqual([]);
    expect(work.pending?.shells.map((s) => s.id)).toEqual(['bshellA', 'bshellD']);
  });

  it('reports no shells or monitors once the harness process is gone', () => {
    const work = readSessionLiveWork(row(copyFixture(), { pidAlive: false }), AT(12));
    expect(work.pending).toBeUndefined();
  });

  it('reads the effort and fast mode the latest turn ran with', () => {
    const work = readSessionLiveWork(row(copyFixture()), AT(12));
    expect(work.effort).toBe('max');
    expect(work.fast).toBe(true);
  });

  it('folds appended bytes onto the prior read and ends a shell when its notification lands', () => {
    const lines = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean);
    const file = path.join(dir, 'growing.jsonl');
    fs.writeFileSync(file, lines.slice(0, 3).join('\n') + '\n' + lines[3].slice(0, 40));
    const early = readSessionLiveWork(row(file), AT(2));
    expect(early.pending?.shells.map((s) => s.id)).toEqual(['bshellA']);

    fs.appendFileSync(file, lines[3].slice(40) + '\n' + lines.slice(4).join('\n') + '\n');
    const whole = readSessionLiveWork(row(copyFixture(FIXTURE, 'whole.jsonl')), AT(12));
    expect(readSessionLiveWork(row(file), AT(12))).toEqual(whole);

    fs.appendFileSync(file, JSON.stringify({
      type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-13T00:13:00.000Z',
      content: '<task-notification>\n<task-id>bshellA</task-id>\n<tool-use-id>toolu_A</tool-use-id>\n<status>failed</status>\n</task-notification>',
    }) + '\n');
    expect(readSessionLiveWork(row(file), AT(13)).pending?.shells.map((s) => s.id)).toEqual(['bshellD']);
  });

  it('keeps a shell running when its TaskStop fails, and ends it when a retry succeeds', () => {
    const file = copyFixture();
    const stop = (id: string, minute: number) => JSON.stringify({ type: 'assistant', timestamp: `2026-10-13T00:${minute}:00.000Z`, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'TaskStop', input: { task_id: 'bshellA' } }] } });
    const result = (id: string, minute: number, isError: boolean) => JSON.stringify({ type: 'user', timestamp: `2026-10-13T00:${minute}:00.000Z`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: isError ? 'No task found' : 'stopped', is_error: isError }] } });
    fs.appendFileSync(file, `${stop('toolu_X1', 20)}\n${result('toolu_X1', 20, true)}\n`);
    expect(readSessionLiveWork(row(file), AT(21)).pending?.shells.map((s) => s.id)).toEqual(['bshellA', 'bshellD']);
    fs.appendFileSync(file, `${stop('toolu_X2', 22)}\n`);
    expect(readSessionLiveWork(row(file), AT(22)).pending?.shells.map((s) => s.id)).toEqual(['bshellA', 'bshellD']);
    fs.appendFileSync(file, `${result('toolu_X2', 23, false)}\n`);
    expect(readSessionLiveWork(row(file), AT(23)).pending?.shells.map((s) => s.id)).toEqual(['bshellD']);
  });

  it('does not keep a dead row waiting on a subagent', () => {
    const work = readSessionLiveWork(row(copyFixture(), { pidAlive: false, subagents: [subagent('a2', 'running', AT(9))] }), AT(12));
    expect(work.pending).toBeUndefined();
  });

  it('is absent when nothing is pending', () => {
    const file = path.join(dir, 'quiet.jsonl');
    fs.writeFileSync(file, fs.readFileSync(FIXTURE, 'utf8').split('\n')[0] + '\n');
    expect(readSessionLiveWork(row(file), AT(12)).pending).toBeUndefined();
  });
});

describe('work from an earlier harness process is not pending', () => {
  it('drops shells from before an exit record or a startup/resume marker, but not across clear or compact', () => {
    const work = readSessionLiveWork(row(copyFixture(RESUMED_FIXTURE, 'resumed.jsonl')), AT1(30));
    expect(work.pending).toEqual({ subagents: [], shells: [{ id: 'blive', description: 'Poll deploy', startedAtMs: AT1(21) }], monitors: [] });
  });

  it('drops work started before the live process started, with no marker in the file', () => {
    const file = copyFixture();
    const work = readSessionLiveWork(row(file, {
      processStartedAtMs: AT(5),
      subagents: [subagent('old', 'running', AT(2)), subagent('new', 'running', AT(9))],
    }), AT(12));
    expect(work.pending?.shells.map((s) => s.id)).toEqual(['bshellD']);
    expect(work.pending?.monitors).toEqual([]);
    expect(work.pending?.subagents.map((s) => s.id)).toEqual(['new']);
  });
});

describe('run settings from a Codex rollout', () => {
  it('reads effort from the latest turn context and leaves fast absent', () => {
    const work = readSessionLiveWork(row(copyFixture(CODEX_FIXTURE, 'rollout.jsonl'), { kind: 'codex' }), AT(12));
    expect(work.effort).toBe('high');
    expect('fast' in work).toBe(false);
    expect(work.pending).toBeUndefined();
  });
});

describe('the local row builder stamps pending, effort and fast', () => {
  it('carries them on rows from loadLocalActiveSessions', async () => {
    const prevSnap = setActiveSessionsSnapshotPathForTest(path.join(dir, 'snap.json'));
    const prevImm = setImmutableMemoPathForTest(path.join(dir, 'imm.json'));
    try {
      const sessionFile = copyFixture();
      const res = await loadLocalActiveSessions({
        forceRefresh: true,
        nowMs: AT(12),
        gather: async () => [row(sessionFile, { machine: 'this-box' })],
      });
      const [live] = res.sessions;
      expect(live.status).toBe('idle');
      expect(live.pending?.shells.map((s) => s.id)).toEqual(['bshellA', 'bshellD']);
      expect(live.pending?.monitors.map((m) => m.id)).toEqual(['bmon1']);
      expect(live.effort).toBe('max');
      expect(live.fast).toBe(true);
    } finally {
      setActiveSessionsSnapshotPathForTest(prevSnap);
      setImmutableMemoPathForTest(prevImm);
    }
  });
});
