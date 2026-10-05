import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TASK_TYPE_RULES,
  classifyTaskType,
  computeLatency,
  deriveAgent,
  deriveDimensions,
  failureTiming,
  type SegmentSession,
  type TaskType,
} from './segments.js';

const FIXTURES = path.join(import.meta.dirname, 'testdata');
const TRACES_REAL = '/tmp/traces-real';
const TRACES_REAL_SESSIONS = path.join(TRACES_REAL, 'sessions');
const hasTracesReal =
  fs.existsSync(path.join(TRACES_REAL, 'index.json')) &&
  fs.existsSync(TRACES_REAL_SESSIONS);

function loadFixture(name: string): SegmentSession {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as SegmentSession;
}

function loadTracesReal(): SegmentSession[] {
  return fs
    .readdirSync(TRACES_REAL_SESSIONS)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(fs.readFileSync(path.join(TRACES_REAL_SESSIONS, file), 'utf8')) as SegmentSession);
}

const early = loadFixture('early-failure.json');
const mid = loadFixture('mid-failure.json');
const late = loadFixture('late-failure.json');

describe('deriveAgent', () => {
  it('reads model × harness from a real SessionDetail fixture', () => {
    expect(deriveAgent(early)).toEqual({ model: 'claude-opus-4-8', harness: 'claude' });
    expect(deriveAgent(mid)).toEqual({ model: 'claude-sonnet-4-6', harness: 'claude' });
    expect(deriveAgent(late)).toEqual({ model: 'claude-sonnet-5', harness: 'claude' });
  });

  it('prefers meta over top-level fields and falls back to unknown', () => {
    expect(deriveAgent({ agent: 'codex', model: 'gpt-5.4' })).toEqual({
      model: 'gpt-5.4',
      harness: 'codex',
    });
    expect(deriveAgent({
      agent: 'claude',
      model: 'ignored',
      meta: { agent: 'droid', model: 'gpt-test' },
    })).toEqual({ model: 'gpt-test', harness: 'droid' });
    expect(deriveAgent({})).toEqual({ model: 'unknown', harness: 'unknown' });
  });
});

describe('classifyTaskType', () => {
  it('covers every named bucket from the keyword/shape table', () => {
    const covered = new Set(TASK_TYPE_RULES.map((rule) => rule.type));
    expect(covered).toEqual(new Set(['bugfix', 'feature', 'refactor', 'test', 'chore']));
  });

  it('classifies from opening prompt + diff shape via the rules table', () => {
    const cases: Array<{ type: TaskType; session: SegmentSession }> = [
      { type: 'bugfix', session: { prompt: 'Fix the git-guard crash on push' } },
      { type: 'bugfix', session: { gitBranch: 'fix/session-cache' } },
      { type: 'feature', session: { prompt: 'Implement the group-by bar for traces' } },
      { type: 'feature', session: { gitBranch: 'feat/traces-insight' } },
      {
        type: 'feature',
        session: { files: [{ path: 'cli/src/lib/traces/segments.ts', action: 'new' }] },
      },
      { type: 'refactor', session: { prompt: 'Extract percentile helper from sync' } },
      {
        type: 'test',
        session: { prompt: 'Add tests for failure timing buckets' },
      },
      {
        type: 'test',
        session: {
          files: [
            { path: 'cli/src/lib/traces/segments.test.ts', action: 'edit' },
            { path: 'cli/src/lib/traces/testdata/early-failure.json', action: 'new' },
          ],
        },
      },
      { type: 'chore', session: { prompt: 'chore: bump the helper floor' } },
      {
        type: 'chore',
        session: { files: [{ path: 'cli/package.json', action: 'edit' }] },
      },
      { type: 'other', session: { prompt: 'look at the live console' } },
      { type: 'other', session: {} },
    ];
    for (const { type, session } of cases) {
      expect(classifyTaskType(session), JSON.stringify(session)).toBe(type);
    }
  });

  it('classifies a real fixture session when SyncRow prompt/branch ride along', () => {
    expect(classifyTaskType({ ...early, gitBranch: 'fix/trace-sync' })).toBe('bugfix');
    expect(classifyTaskType({ ...mid, prompt: 'Implement traces hosted sync' })).toBe('feature');
    expect(classifyTaskType({ ...late, prompt: 'Refactor the traces worker template' })).toBe('refactor');
  });
});

describe('failureTiming', () => {
  it('buckets a real fixture by firstFailure.startMs / spanMs', () => {
    expect(failureTiming(early)).toBe('early');
    expect(failureTiming(mid)).toBe('mid');
    expect(failureTiming(late)).toBe('late');
  });

  it('returns null when no step failed', () => {
    expect(failureTiming({
      meta: { spanMs: 10_000 },
      steps: [{ startMs: 100, outcome: 'ok' }],
    })).toBeNull();
  });

  it('uses the first error, not a later one', () => {
    expect(failureTiming({
      meta: { spanMs: 100 },
      steps: [
        { startMs: 10, outcome: 'error' },
        { startMs: 90, outcome: 'error' },
      ],
    })).toBe('early');
  });
});

describe('deriveDimensions', () => {
  it('joins the three group-by axes for a real fixture', () => {
    expect(deriveDimensions({ ...early, gitBranch: 'fix/trace-sync' })).toEqual({
      agent: { model: 'claude-opus-4-8', harness: 'claude' },
      taskType: 'bugfix',
      failureTiming: 'early',
    });
  });
});

describe('computeLatency', () => {
  it('uses steps[0].startMs on the committed real fixtures', () => {
    const latency = computeLatency([early, mid, late]);
    const starts = [early.steps![0]!.startMs, mid.steps![0]!.startMs, late.steps![0]!.startMs];
    expect(latency.firstToolMs.max).toBe(Math.max(...starts));
    expect(latency.firstToolMs.p50).toBeGreaterThanOrEqual(0);
  });

  it('skips sessions with no steps and returns zeros on an empty set', () => {
    expect(computeLatency([{ steps: [] }, {}])).toEqual({
      firstToolMs: { p50: 0, p90: 0, p99: 0, max: 0 },
    });
  });
});

describe.skipIf(!hasTracesReal)('/tmp/traces-real corpus', () => {
  it('loads 738 real SessionDetail files', () => {
    const sessions = loadTracesReal();
    expect(sessions.length).toBe(738);
  });

  it('computeLatency firstToolMs.p99 is ~128s (2m 8s)', () => {
    const { firstToolMs } = computeLatency(loadTracesReal());
    expect(firstToolMs.p99).toBeGreaterThan(120_000);
    expect(firstToolMs.p99).toBeLessThan(140_000);
    expect(firstToolMs.p90).toBeGreaterThan(10_000);
    expect(firstToolMs.p90).toBeLessThan(20_000);
    expect(firstToolMs.max).toBeGreaterThan(7 * 60_000);
    expect(firstToolMs.max).toBeLessThan(8 * 60_000);
  });

  it('deriveAgent, classifyTaskType, and failureTiming produce sensible buckets', () => {
    const sessions = loadTracesReal();
    const harnesses = new Set(sessions.map((session) => deriveAgent(session).harness));
    const models = new Set(sessions.map((session) => deriveAgent(session).model));
    expect(harnesses.has('unknown')).toBe(false);
    expect(harnesses.has('claude')).toBe(true);
    expect(models.size).toBeGreaterThan(1);

    const taskCounts = new Map<TaskType, number>();
    const timingCounts = { early: 0, mid: 0, late: 0, none: 0 };
    for (const session of sessions) {
      const type = classifyTaskType(session);
      taskCounts.set(type, (taskCounts.get(type) ?? 0) + 1);
      const timing = failureTiming(session);
      if (timing === null) timingCounts.none++;
      else timingCounts[timing]++;
    }
    expect(taskCounts.get('other') ?? 0).toBeLessThan(sessions.length);
    expect(timingCounts.early + timingCounts.mid + timingCounts.late).toBeGreaterThan(0);
    expect(timingCounts.early).toBeGreaterThan(timingCounts.late);
    expect(timingCounts.none).toBeGreaterThan(0);
  });

  it('pins each classifier on a real corpus session', () => {
    const byId = new Map(loadTracesReal().map((session) => [session.id, session]));
    const earlyReal = byId.get('6ca7a541-0cbb-4844-989e-e2568b9af84e');
    const midReal = byId.get('5d19f846-5212-4138-9bbc-cad894a7d5c2');
    const lateReal = byId.get('6242aa3f-5cae-406a-bcdd-5df3e137cb34');
    expect(earlyReal).toBeDefined();
    expect(deriveAgent(earlyReal!)).toEqual({ model: 'claude-opus-4-8', harness: 'claude' });
    expect(failureTiming(earlyReal!)).toBe('early');
    expect(failureTiming(midReal!)).toBe('mid');
    expect(failureTiming(lateReal!)).toBe('late');
  });
});
