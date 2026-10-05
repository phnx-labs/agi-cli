// Report only stored schedule facts: declared human health wins, then overdue, due-soon, untracked, no-dates, scheduled.

import type { LinearMilestone } from './linear-project-counts.js';

export const DUE_SOON_DAYS = 14;

type ProjectVerdict =
  | { kind: 'declared'; health: string }
  | { kind: 'overdue'; milestone: string; days: number }
  | { kind: 'due-soon'; milestone: string; days: number }
  | { kind: 'untracked'; milestones: number }
  | { kind: 'scheduled'; milestone: string; days: number }
  | { kind: 'no-dates'; milestones: number }
  | { kind: 'none' };

export function daysUntil(targetDate: string, nowMs: number): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(targetDate.trim());
  if (!m) return undefined;
  const due = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(due.getTime())) return undefined;
  const now = new Date(nowMs);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due.getTime() - today.getTime()) / 86_400_000);
}

const unfinished = (m: LinearMilestone) => m.total === 0 || m.done < m.total;

export function scheduleVerdict(
  milestones: LinearMilestone[],
  nowMs: number,
  declaredHealth?: string | null,
): ProjectVerdict {
  if (declaredHealth) return { kind: 'declared', health: declaredHealth };
  if (milestones.length === 0) return { kind: 'none' };

  const open = milestones.filter(unfinished);
  const dated = open
    .map((m) => ({ m, days: m.targetDate ? daysUntil(m.targetDate, nowMs) : undefined }))
    .filter((x): x is { m: LinearMilestone; days: number } => x.days !== undefined)
    .sort((a, b) => a.days - b.days);

  const worst = dated[0];
  if (worst && worst.days < 0) return { kind: 'overdue', milestone: worst.m.name, days: -worst.days };

  if (worst && worst.days <= DUE_SOON_DAYS) return { kind: 'due-soon', milestone: worst.m.name, days: worst.days };

  if (milestones.every((m) => m.total === 0)) return { kind: 'untracked', milestones: milestones.length };

  if (!worst) return { kind: 'no-dates', milestones: open.length };
  return { kind: 'scheduled', milestone: worst.m.name, days: worst.days };
}

export function formatVerdict(v: ProjectVerdict): { text: string; warn: boolean } | undefined {
  switch (v.kind) {
    case 'declared':
      return { text: `per Linear: ${v.health}`, warn: v.health.toLowerCase() !== 'ontrack' };
    case 'overdue':
      return { text: `${v.milestone} overdue by ${v.days} day${v.days === 1 ? '' : 's'}`, warn: true };
    case 'due-soon':
      return {
        text: `${v.milestone} due ${v.days === 0 ? 'today' : v.days === 1 ? 'tomorrow' : `in ${v.days} days`}`,
        warn: false,
      };
    case 'untracked':
      return {
        text: `${v.milestones} milestone${v.milestones === 1 ? '' : 's'}, no issues filed against any — progress is not measurable`,
        warn: true,
      };
    case 'scheduled':
      return { text: `${v.milestone} in ${v.days} days`, warn: false };
    case 'no-dates':
      return { text: `${v.milestones} open milestone${v.milestones === 1 ? '' : 's'}, none dated`, warn: false };
    case 'none':
      return undefined;
  }
}
