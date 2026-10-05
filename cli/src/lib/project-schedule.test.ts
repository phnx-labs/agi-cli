import { describe, it, expect } from 'vitest';
import { DUE_SOON_DAYS, daysUntil, formatVerdict, scheduleVerdict } from './project-schedule.js';
import type { LinearMilestone } from './linear-project-counts.js';

const NOW = new Date(2026, 7, 3, 12, 0, 0).getTime();
const ms = (over: Partial<LinearMilestone> = {}): LinearMilestone => ({ name: 'M', done: 0, total: 0, ...over });

describe('daysUntil', () => {
  it('counts whole days at LOCAL midnight', () => {
    expect(daysUntil('2026-08-03', NOW)).toBe(0);
    expect(daysUntil('2026-08-10', NOW)).toBe(7);
    expect(daysUntil('2026-07-27', NOW)).toBe(-7);
  });

  it('does not shift a day for anyone west of Greenwich', () => {
    expect(daysUntil('2026-08-03', new Date(2026, 7, 3, 23, 59).getTime())).toBe(0);
    expect(daysUntil('2026-08-03', new Date(2026, 7, 3, 0, 1).getTime())).toBe(0);
  });

  it('rejects anything that is not a calendar date', () => {
    expect(daysUntil('', NOW)).toBeUndefined();
    expect(daysUntil('someday', NOW)).toBeUndefined();
    expect(daysUntil('2026-08-03T00:00:00Z', NOW)).toBeUndefined();
  });
});

describe('scheduleVerdict', () => {
  it('never invents on-track: a healthy dated project reads as scheduled, not "on track"', () => {
    const v = scheduleVerdict([ms({ name: 'GA', targetDate: '2026-10-01', done: 2, total: 8 })], NOW);
    expect(v).toEqual({ kind: 'scheduled', milestone: 'GA', days: 59 });
    expect(['declared', 'overdue', 'due-soon', 'untracked', 'scheduled', 'no-dates', 'none']).toContain(v.kind);
  });

  it('reports overdue ahead of everything derived', () => {
    const v = scheduleVerdict(
      [ms({ name: 'Beta', targetDate: '2026-07-28', done: 1, total: 4 }), ms({ name: 'GA', targetDate: '2026-09-01', done: 0, total: 2 })],
      NOW,
    );
    expect(v).toEqual({ kind: 'overdue', milestone: 'Beta', days: 6 });
  });

  it('flags due-soon inside the window and not outside it', () => {
    const soon = scheduleVerdict([ms({ name: 'Cut', targetDate: '2026-08-10', done: 1, total: 3 })], NOW);
    expect(soon).toEqual({ kind: 'due-soon', milestone: 'Cut', days: 7 });
    const later = scheduleVerdict([ms({ name: 'Cut', targetDate: '2026-09-30', done: 1, total: 3 })], NOW);
    expect(later.kind).toBe('scheduled');
    const edge = scheduleVerdict([ms({ name: 'Cut', targetDate: '2026-08-17', done: 1, total: 3 })], NOW);
    expect(edge).toEqual({ kind: 'due-soon', milestone: 'Cut', days: DUE_SOON_DAYS });
  });

  it('does NOT let untracked hide an approaching deadline', () => {
    const v = scheduleVerdict(
      [ms({ name: 'Beta', targetDate: '2026-08-05' }), ms({ name: 'Alpha', targetDate: '2026-08-10' })],
      NOW,
    );
    expect(v).toEqual({ kind: 'due-soon', milestone: 'Beta', days: 2 });
  });

  it('a completed milestone means the project is not untracked', () => {
    const v = scheduleVerdict(
      [ms({ name: 'Done', targetDate: '2026-07-01', done: 2, total: 2 }), ms({ name: 'Far', targetDate: '2026-12-01' })],
      NOW,
    );
    expect(v.kind).not.toBe('untracked');
    expect(v).toEqual({ kind: 'scheduled', milestone: 'Far', days: 120 });
  });

  it('says untracked when nothing is filed against any milestone', () => {
    const v = scheduleVerdict(
      [
        ms({ name: 'A', targetDate: '2026-09-15' }),
        ms({ name: 'B', targetDate: '2026-09-30' }),
        ms({ name: 'C', targetDate: '2026-10-15' }),
      ],
      NOW,
    );
    expect(v).toEqual({ kind: 'untracked', milestones: 3 });
  });

  it('still reports overdue even when nothing is filed', () => {
    const v = scheduleVerdict([ms({ name: 'A', targetDate: '2026-07-01' })], NOW);
    expect(v).toEqual({ kind: 'overdue', milestone: 'A', days: 33 });
  });

  it('handles no milestones and undated milestones distinctly', () => {
    expect(scheduleVerdict([], NOW)).toEqual({ kind: 'none' });
    expect(scheduleVerdict([ms({ name: 'A', done: 1, total: 3 })], NOW)).toEqual({ kind: 'no-dates', milestones: 1 });
  });

  it('ignores finished milestones when picking the worst news', () => {
    const v = scheduleVerdict(
      [ms({ name: 'Done', targetDate: '2026-07-01', done: 3, total: 3 }), ms({ name: 'Next', targetDate: '2026-09-01', done: 0, total: 2 })],
      NOW,
    );
    expect(v).toEqual({ kind: 'scheduled', milestone: 'Next', days: 29 });
  });

  it("relays Linear's own health over anything derived, when a human posted one", () => {
    const v = scheduleVerdict([ms({ name: 'A', targetDate: '2026-07-01' })], NOW, 'atRisk');
    expect(v).toEqual({ kind: 'declared', health: 'atRisk' });
  });
});

describe('formatVerdict', () => {
  const f = (v: Parameters<typeof formatVerdict>[0]) => formatVerdict(v);

  it('phrases each verdict for a human, and marks which are warnings', () => {
    expect(f({ kind: 'overdue', milestone: 'Beta', days: 1 })).toEqual({ text: 'Beta overdue by 1 day', warn: true });
    expect(f({ kind: 'overdue', milestone: 'Beta', days: 6 })?.text).toBe('Beta overdue by 6 days');
    expect(f({ kind: 'due-soon', milestone: 'Cut', days: 0 })?.text).toBe('Cut due today');
    expect(f({ kind: 'due-soon', milestone: 'Cut', days: 1 })?.text).toBe('Cut due tomorrow');
    expect(f({ kind: 'due-soon', milestone: 'Cut', days: 7 })).toEqual({ text: 'Cut due in 7 days', warn: false });
    expect(f({ kind: 'untracked', milestones: 3 })).toEqual({
      text: '3 milestones, no issues filed against any — progress is not measurable',
      warn: true,
    });
    expect(f({ kind: 'no-dates', milestones: 1 })?.text).toBe('1 open milestone, none dated');
    expect(f({ kind: 'scheduled', milestone: 'GA', days: 59 })?.text).toBe('GA in 59 days');
  });

  it("attributes Linear's health rather than presenting it as ours", () => {
    expect(f({ kind: 'declared', health: 'atRisk' })).toEqual({ text: 'per Linear: atRisk', warn: true });
    expect(f({ kind: 'declared', health: 'onTrack' })?.warn).toBe(false);
  });

  it('renders nothing when there are no milestones', () => {
    expect(f({ kind: 'none' })).toBeUndefined();
  });
});
