import { describe, it, expect } from 'vitest';
import {
  TurnFinishTracker,
  buildBurstNotification,
  buildFinishNotification,
  FINISH_SETTLE_MS,
  type FinishRow,
  type TurnFinish,
} from './finished-banners.js';
import { buildMenubarNotifyArgs } from '../menubar/notify-desktop.js';

const MIN = 60_000;
const T0 = 1_792_380_000_000;

function row(status: string, extra: Partial<FinishRow> = {}): { scope: string; row: FinishRow } {
  return { scope: 'zion', row: { context: 'terminal', kind: 'claude', sessionId: 'sess-1', title: 'Ship the verdict', status: status as FinishRow['status'], ...extra } };
}

describe('TurnFinishTracker', () => {
  it('holds a running-to-idle turn of two minutes until it settles, then hands it over once', () => {
    const t = new TurnFinishTracker();
    t.observe([row('running', { userTurns: [{ atMs: T0, text: 'go', images: 0 }] })], T0 + 5_000);
    t.observe([row('idle')], T0 + 3 * MIN);
    expect(t.due(T0 + 3 * MIN)).toEqual([]);
    const due = t.due(T0 + 3 * MIN + FINISH_SETTLE_MS);
    expect(due.map((f) => [f.sessionId, f.turnStartMs, f.endedAtMs])).toEqual([['sess-1', T0, T0 + 3 * MIN]]);
    t.observe([row('idle')], T0 + 4 * MIN);
    expect(t.due(T0 + 5 * MIN)).toEqual([]);
  });

  it('posts nothing for a short turn, a flap back to running, a headless run or the Lead', () => {
    const t = new TurnFinishTracker();
    t.observe([row('running')], T0);
    t.observe([row('idle')], T0 + MIN);
    expect(t.due(T0 + 2 * MIN)).toEqual([]);

    t.observe([row('running')], T0 + 2 * MIN);
    t.observe([row('idle')], T0 + 5 * MIN);
    t.observe([row('running')], T0 + 5 * MIN + 5_000);
    expect(t.due(T0 + 6 * MIN)).toEqual([]);

    for (const extra of [{ context: 'headless' }, { lead: true }]) {
      const other = new TurnFinishTracker();
      other.observe([row('running', extra)], T0);
      other.observe([row('idle', extra)], T0 + 5 * MIN);
      expect(other.due(T0 + 6 * MIN)).toEqual([]);
    }
  });

  it('a user turn older than the last idle tick does not stretch a self-started turn', () => {
    const t = new TurnFinishTracker();
    const turns = [{ atMs: T0, text: 'go', images: 0 }];
    t.observe([row('idle', { userTurns: turns })], T0 + 10 * MIN);
    t.observe([row('running', { userTurns: turns })], T0 + 11 * MIN);
    t.observe([row('idle', { userTurns: turns })], T0 + 12 * MIN);
    expect(t.due(T0 + 13 * MIN)).toEqual([]);
  });
});

function finish(extra: Partial<FinishRow> = {}, sessionId = 'sess-1'): TurnFinish {
  return { scope: 'zion', sessionId, turnStartMs: T0, endedAtMs: T0 + 28 * MIN, row: { context: 'terminal', kind: 'claude', sessionId, title: 'Ship the verdict', project: 'agents-cli', ...extra } };
}

describe('buildFinishNotification', () => {
  it('an open verdict titles "Not done" and says its gaps in words, as AGI Menu argv', () => {
    const n = buildFinishNotification(finish({
      doneVerdict: { state: 'open', gaps: ['open-pr', 'delivery'], at: new Date(T0 + 28 * MIN).toISOString() },
      lastAgentLine: 'Opened the PR. Waiting on CI.',
      pr: { url: 'https://github.com/phnx-labs/agi-cli/pull/4001' },
    }));
    expect(buildMenubarNotifyArgs(n)).toEqual([
      '--notify', '--title', 'Not done · Ship the verdict',
      '--body', 'A pull request is still open; the delivery is not verified.',
      '--subtitle', 'zion · agents-cli · worked 28 min',
      '--action', 'url:https://github.com/phnx-labs/agi-cli/pull/4001',
      '--agent', 'claude', '--category', 'done', '--key', 'zion/sess-1/done-1792380000000', '--session', 'sess-1',
    ]);
  });

  it('a done verdict titles "✓ Done" with the first sentence of the last line; a stale or missing one says "Finished"', () => {
    const line = 'Merged #4001 and released 1.23.34. Zion is upgraded.';
    const done = buildFinishNotification(finish({ lastAgentLine: line, doneVerdict: { state: 'done', gaps: [], at: new Date(T0 + 27 * MIN).toISOString() } }));
    expect([done.title, done.body]).toEqual(['✓ Done · Ship the verdict', 'Merged #4001 and released 1.23.34.']);
    const stale = buildFinishNotification(finish({ lastAgentLine: line, doneVerdict: { state: 'done', gaps: [], at: new Date(T0 - 10 * MIN).toISOString() } }));
    expect(stale.title).toBe('Finished · Ship the verdict');
  });
});

describe('buildBurstNotification', () => {
  it('folds a burst into one banner with a count per verdict', () => {
    const at = new Date(T0 + 28 * MIN).toISOString();
    const n = buildBurstNotification([
      finish({ title: 'A', doneVerdict: { state: 'done', gaps: [], at } }, 's-a'),
      finish({ title: 'B', doneVerdict: { state: 'open', gaps: ['keep-moving'], at } }, 's-b'),
      finish({ title: 'C' }, 's-c'),
    ], 'zion/done-burst-1');
    expect(n).toEqual({ title: '3 sessions finished', body: 'A · B · C', subtitle: '1 done · 1 not done · 1 finished', category: 'done', key: 'zion/done-burst-1' });
  });
});
