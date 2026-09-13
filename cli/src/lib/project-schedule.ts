/**
 * What a project's milestone dates prove about its schedule — and nothing more.
 *
 * The tempting version of this file computes "on track / at risk". It cannot be
 * written honestly against this data. Probed live against a real workspace:
 *
 *   health: null            projectUpdates: []
 *   startDate: null         targetDate: null
 *   scopeHistory: []        completedScopeHistory: []
 *
 * "Behind schedule" needs either start+target dates to interpolate an expected
 * progress line, or a history series to extrapolate a finish date. Both are
 * absent, so any on-track/at-risk chip would be invented — and a confident wrong
 * answer on a status card is worse than a blank one, because it is unfalsifiable
 * from the card itself.
 *
 * So every verdict here is arithmetic on a stored date or a count:
 *
 *   overdue        a milestone's targetDate has passed and it is unfinished
 *   due-soon       the next one lands within DUE_SOON_DAYS
 *   untracked      milestones exist but nothing is filed against any of them,
 *                  so their progress is not measurable
 *   scheduled      dated milestones ahead, none due soon, work is filed
 *   no-dates       milestones exist, none carries a date
 *   none           the project declares no milestones
 *
 * `declared` relays Linear's OWN health when a human has posted one. It is
 * passed through and attributed, never synthesized — if the user starts posting
 * project updates, their answer wins over anything derived here.
 */

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

/**
 * Decide what the dates prove. Precedence is time-sensitivity first:
 *
 *   declared > overdue > due-soon > untracked > no-dates > scheduled
 *
 * An overdue milestone outranks an approaching one, and both outrank the
 * observation that nothing is filed — a deadline moves, that observation does
 * not. `declared` overrides everything, because a human said it.
 */
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

  // A date bearing down is time-sensitive; "nothing is filed" is a standing
  // condition that will still be true tomorrow. So an approaching deadline is
  // reported even when the milestone has no issues against it — reversing these
  // hid a milestone due in two days behind "3 milestones, no issues filed".
  if (worst && worst.days <= DUE_SOON_DAYS) return { kind: 'due-soon', milestone: worst.m.name, days: worst.days };

  // Nothing is filed against ANY milestone, so no progress can be computed for
  // them — the useful thing to say, and the actual state of a project whose
  // milestones were created before its issues. Checked against the full list,
  // not just the open ones: a COMPLETED milestone necessarily has issues, so a
  // project with one cannot honestly be called untracked.
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
