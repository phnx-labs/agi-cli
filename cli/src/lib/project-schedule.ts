/** What a project's milestone dates prove, and nothing more. Linear gives no health, dates or scope
 * history, so on-track/at-risk would be invented. Verdicts are arithmetic on dates and counts; a
 * human-posted `declared` health is relayed, never synthesized. */

import type { LinearMilestone } from './linear-project-counts.js';

/** How far ahead counts as "due soon" — one sprint's notice. */
export const DUE_SOON_DAYS = 14;

/** A verdict about the schedule, as a tagged union so `--json` stays stable. */
type ProjectVerdict =
  | { kind: 'declared'; health: string }
  | { kind: 'overdue'; milestone: string; days: number }
  | { kind: 'due-soon'; milestone: string; days: number }
  | { kind: 'untracked'; milestones: number }
  | { kind: 'scheduled'; milestone: string; days: number }
  | { kind: 'no-dates'; milestones: number }
  | { kind: 'none' };

/** Whole days from `nowMs` to a `YYYY-MM-DD` date, compared at LOCAL midnight. */
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

/** Decide what the dates prove. Precedence is time-sensitivity first: declared > overdue > due-soon
 * > untracked > no-dates > scheduled. A deadline moves and "nothing is filed" does not; `declared`
 * overrides everything because a human said it. */
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

  // An approaching date is time-sensitive while "nothing is filed" is a standing condition, so
  // due-soon is reported even for a milestone with no issues; reversing these hid a milestone due
  // in two days behind "3 milestones, no issues filed".
  if (worst && worst.days <= DUE_SOON_DAYS) return { kind: 'due-soon', milestone: worst.m.name, days: worst.days };

  // Nothing is filed against ANY milestone, so no progress is computable (typical when milestones
  // predate issues). Checked against the full list, not just open ones: a COMPLETED milestone has
  // issues, so such a project can't honestly be called untracked.
  if (milestones.every((m) => m.total === 0)) return { kind: 'untracked', milestones: milestones.length };

  if (!worst) return { kind: 'no-dates', milestones: open.length };
  return { kind: 'scheduled', milestone: worst.m.name, days: worst.days };
}

/** One line for the card. Returns undefined for `none` — an empty row says nothing. */
export function formatVerdict(v: ProjectVerdict): { text: string; warn: boolean } | undefined {
  switch (v.kind) {
    case 'declared':
      // Attributed, so nobody mistakes a human's call for a derived one.
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
