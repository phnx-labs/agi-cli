import { describe, it, expect } from 'vitest';
import { dedupeBySession } from './active.js';
import type { ActiveSession } from './active.js';

// Regression for "Fleet flooded with identical .openclaw rows": an OpenClaw gateway spawns N
// `codex` workers with no session id, transcript or cloud handle, so each skipped dedupe and
// rendered as its own row (~40 at the time).

const worker = (pid: number, cwd = '/Users/muqsit/.agents/openclaw/home/.openclaw'): ActiveSession => ({
  context: 'headless',
  kind: 'codex',
  pid,
  cwd,
  status: 'idle',
} as ActiveSession);

describe('dedupeBySession', () => {
  it('collapses indistinguishable worker processes into one row with a pidCount', () => {
    const out = dedupeBySession([worker(1), worker(2), worker(3), worker(4)]);

    expect(out).toHaveLength(1);
    expect(out[0].pidCount).toBe(4);
    expect(out[0].pid).toBe(1); // first row wins
  });

  it('keeps workers in different working directories apart', () => {
    const out = dedupeBySession([
      worker(1, '/Users/muqsit/.agents/openclaw/home/.openclaw'),
      worker(2, '/Users/muqsit/src/github.com/muqsitnawaz'),
    ]);

    expect(out).toHaveLength(2);
    expect(out.map((s) => s.pidCount)).toEqual([1, 1]);
  });

  it('keeps different agent binaries in one directory apart', () => {
    const a = worker(1);
    const b = { ...worker(2), kind: 'claude' };
    expect(dedupeBySession([a, b])).toHaveLength(2);
  });

  it('still folds fork pids of one real session onto its session id', () => {
    const forks = [1, 2, 3].map((pid) => ({
      context: 'terminal',
      kind: 'claude',
      pid,
      sessionId: 'abc-123',
      cwd: '/repo',
    })) as ActiveSession[];

    const out = dedupeBySession(forks);
    expect(out).toHaveLength(1);
    expect(out[0].pidCount).toBe(3);
  });

  it('never folds two distinct cloud tasks that share a working directory', () => {
    const cloud = (id: string): ActiveSession => ({
      context: 'cloud',
      kind: 'claude',
      cwd: '/repo',
      cloudTaskId: id,
    } as ActiveSession);

    expect(dedupeBySession([cloud('task-a'), cloud('task-b')])).toHaveLength(2);
  });

  it('passes through a row with no identity at all rather than folding it', () => {
    const bare = { context: 'headless', kind: 'codex', pid: 9 } as ActiveSession;
    const out = dedupeBySession([bare, { ...bare, pid: 10 }]);
    expect(out).toHaveLength(2);
  });

  it('keeps two id-less tmux panes in the same cwd DISTINCT via paneId (the anti-collapse fix)', () => {
    // Two born-unidentifiable non-Claude panes sharing a cwd. Without paneId they
    // would fold under anonymousWorkerKey (kind+context+cwd) into one ×2 row —
    // exactly the misattribution we are fixing. paneId keeps them two rows.
    const pane = (paneId: string): ActiveSession => ({
      context: 'terminal', kind: 'codex', cwd: '/repo', paneId,
    } as ActiveSession);
    const out = dedupeBySession([pane('%1'), pane('%2')]);
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.pidCount)).toEqual([1, 1]);
  });

  it('still folds by sessionId when the id resolved (paneId is ignored once identified)', () => {
    const withId = (paneId: string): ActiveSession => ({
      context: 'terminal', kind: 'claude', cwd: '/repo', sessionId: 's1', paneId,
    } as ActiveSession);
    const out = dedupeBySession([withId('%1'), withId('%2')]);
    expect(out).toHaveLength(1);
    expect(out[0].pidCount).toBe(2);
  });
});
