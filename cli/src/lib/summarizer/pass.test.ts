import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-summ-pass-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { getSessionsDir } = await import('../state.js');
fs.mkdirSync(getSessionsDir(), { recursive: true });

const { runSummarizerPass } = await import('./pass.js');
const { readSessionSummaryAny } = await import('../session/db.js');

const RUNNABLE = { enabled: true, baseUrl: 'http://localhost:11434', model: 'qwen2.5:3b' };

function session(over: Record<string, any> = {}): any {
  return {
    sessionId: over.sessionId ?? 's1',
    sessionFile: over.sessionFile ?? '/tmp/s1.jsonl',
    firstUserMessage: 'Ship the feature end to end',
    topic: 'ship it',
    ...over,
  };
}

function stubSummarize(result: any) {
  const calls: any[] = [];
  const impl = (async (prompt: string, progress: any) => {
    calls.push({ prompt, progress });
    return result;
  }) as any;
  return { impl, calls };
}

describe('runSummarizerPass', () => {
  it('does nothing when the summarizer is disabled/unconfigured', async () => {
    const stub = stubSummarize({ goal: 'g', checkpoints: [], checklist: [] });
    const r = await runSummarizerPass({
      config: { enabled: false },
      sessions: [session({ sessionId: 'disabled-1' })],
      summarizeImpl: stub.impl,
      statFile: () => ({ mtimeMs: 1, size: 1 }),
    });
    expect(r.disabled).toBe(true);
    expect(stub.calls.length).toBe(0);
    expect(readSessionSummaryAny('disabled-1')).toBeUndefined();
  });

  it('computes and writes a ready summary, stamping checkpoint times', async () => {
    const stub = stubSummarize({ goal: 'Ship it', checkpoints: ['did A', 'did B'], checklist: [{ text: 'step', done: false }] });
    const now = Date.parse('2026-09-05T12:00:00.000Z');
    const r = await runSummarizerPass({
      now,
      config: RUNNABLE,
      sessions: [session({ sessionId: 'ready-1' })],
      summarizeImpl: stub.impl,
      statFile: () => ({ mtimeMs: 500, size: 900 }),
    });
    expect(r.computed).toBe(1);
    const stored = readSessionSummaryAny('ready-1');
    expect(stored?.summaryState).toBe('ready');
    expect(stored?.goal).toBe('Ship it');
    expect(stored?.checkpoints).toEqual([
      { text: 'did A', at: '2026-09-05T12:00:00.000Z' },
      { text: 'did B', at: '2026-09-05T12:00:00.000Z' },
    ]);
    expect(stored?.summaryChecklist).toEqual([{ text: 'step', done: false }]);
    expect(stub.calls[0].prompt).toBe('Ship the feature end to end');
  });

  it('reuses the cached row on unchanged bytes — no second model call', async () => {
    const stub = stubSummarize({ goal: 'Ship it', checkpoints: ['x'], checklist: [] });
    const statFile = () => ({ mtimeMs: 42, size: 42 });
    const s = [session({ sessionId: 'reuse-1' })];
    const first = await runSummarizerPass({ config: RUNNABLE, sessions: s, summarizeImpl: stub.impl, statFile });
    expect(first.computed).toBe(1);
    const second = await runSummarizerPass({ config: RUNNABLE, sessions: s, summarizeImpl: stub.impl, statFile });
    expect(second.reused).toBe(1);
    expect(second.computed).toBe(0);
    expect(stub.calls.length).toBe(1);
  });

  it('keeps the goal stable across a transcript delta (goal computed once)', async () => {
    const s = [session({ sessionId: 'goal-1' })];
    const t1 = Date.parse('2026-09-05T10:00:00.000Z');
    const t2 = Date.parse('2026-09-05T11:00:00.000Z');
    const first = stubSummarize({ goal: 'Original goal', checkpoints: ['a'], checklist: [] });
    await runSummarizerPass({ now: t1, config: RUNNABLE, sessions: s, summarizeImpl: first.impl, statFile: () => ({ mtimeMs: 1, size: 1 }) });

    const second = stubSummarize({ goal: 'Drifted goal', checkpoints: ['a', 'b'], checklist: [] });
    await runSummarizerPass({ now: t2, config: RUNNABLE, sessions: s, summarizeImpl: second.impl, statFile: () => ({ mtimeMs: 2, size: 5 }) });

    const stored = readSessionSummaryAny('goal-1');
    expect(stored?.goal).toBe('Original goal');
    expect(stored?.checkpoints?.map((c) => c.text)).toEqual(['a', 'b']);
    const a = stored?.checkpoints?.find((c) => c.text === 'a');
    const b = stored?.checkpoints?.find((c) => c.text === 'b');
    expect(a && b && a.at !== b.at).toBe(true);
  });

  it('records a skipped state (cached) when the model fails', async () => {
    const stub = stubSummarize(undefined);
    const r = await runSummarizerPass({
      config: RUNNABLE,
      sessions: [session({ sessionId: 'skip-1' })],
      summarizeImpl: stub.impl,
      statFile: () => ({ mtimeMs: 1, size: 1 }),
    });
    expect(r.skipped).toBe(1);
    expect(readSessionSummaryAny('skip-1')?.summaryState).toBe('skipped');
  });

  it('skips a session with no extractable intent without calling the model', async () => {
    const stub = stubSummarize({ goal: 'g', checkpoints: [], checklist: [] });
    const r = await runSummarizerPass({
      config: RUNNABLE,
      sessions: [session({ sessionId: 'noprompt-1', firstUserMessage: undefined, topic: undefined })],
      summarizeImpl: stub.impl,
      statFile: () => ({ mtimeMs: 1, size: 1 }),
    });
    expect(r.skipped).toBe(1);
    expect(stub.calls.length).toBe(0);
    expect(readSessionSummaryAny('noprompt-1')?.summaryState).toBe('skipped');
  });

  it('honours the per-tick budget', async () => {
    const stub = stubSummarize({ goal: 'g', checkpoints: [], checklist: [] });
    const sessions = Array.from({ length: 5 }, (_, i) =>
      session({ sessionId: `budget-${i}`, sessionFile: `/tmp/budget-${i}.jsonl` }));
    const r = await runSummarizerPass({
      config: RUNNABLE,
      sessions,
      summarizeImpl: stub.impl,
      statFile: (p) => ({ mtimeMs: p.length, size: p.length }),
      maxPerTick: 2,
    });
    expect(r.computed).toBe(2);
    expect(stub.calls.length).toBe(2);
  });
});
