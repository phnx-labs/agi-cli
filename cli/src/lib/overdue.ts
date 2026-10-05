/** Overdue routine detection. If the daemon wasn't running when a job should fire, the miss is lost
 * (croner schedules forward only). This flags jobs whose latest run predates their latest expected
 * fire; surfaced at daemon startup and by `agents routines catchup`. */

import * as fs from 'fs';
import { Cron } from 'croner';
import { alignedSlotForFire, listJobs, getLatestRun, resolveJobFilePath, isPastEndAt, isOneShotRoutine, jobRunsOnThisDevice, type JobConfig } from './scheduling/routines.js';
import { notifyDesktop } from './menubar/notify-desktop.js';

export interface OverdueJob {
  name: string;
  /** Most recent expected fire time per the cron expression. */
  expectedAt: Date;
  /** Start time of the most recent recorded run, or null if never run. */
  lastRanAt: Date | null;
}

// Tolerance between "expected fire" and "recorded run start" — accounts for
// the small gap between the cron tick and when the runner writes meta.json.
const GRACE_MS = 60_000;

/** Computes the most recent fire of `pattern` at or before `now`, via {@link alignedSlotForFire},
 * so overdue detection (`missedRunId`) and live dispatch (`slotRunId`) share one occurrence
 * identity: a missed fire and its live twin collide by construction (SING-15). */
function previousExpectedFire(cron: Cron, now: Date): Date | null {
  return alignedSlotForFire(cron, now);
}

/** When a routine started existing, the earliest fire it can be judged against. `createdAt` is
 * stamped by `writeJob`; older routines use file mtime, which only moves the floor later so can't
 * manufacture a false "overdue". Null when neither exists (unfloored, not skipped). */
export function routineEffectiveStart(job: JobConfig, now: Date = new Date()): Date | null {
  if (job.createdAt) {
    const stamped = new Date(job.createdAt);
    // Clamp a future stamp (clock skew, a hand-edited year) to now. Left
    // unclamped it sits after every possible expected fire, so the routine can
    // never be flagged overdue until wall-clock time catches up.
    if (!isNaN(stamped.getTime())) {
      return stamped.getTime() > now.getTime() ? now : stamped;
    }
  }
  const path = resolveJobFilePath(job.name);
  if (!path) return null;
  try {
    return new Date(fs.statSync(path).mtimeMs);
  } catch {
    return null;
  }
}

/** Return every enabled, recurring job whose most recent expected fire was
 *  missed. One-shot jobs are excluded — they fire at most once. */
export function detectOverdueJobs(now: Date = new Date()): OverdueJob[] {
  const overdue: OverdueJob[] = [];

  for (const job of listJobs()) {
    if (!job.enabled) continue;
    // One-shot: fires at most once, so a missed slot isn't a backlog. Use the scheduler's own
    // predicate: the raw `runOnce` flag alone missed one-shot-LIKE schedules (a fixed
    // minute/hour/day/month) that never carried it.
    if (isOneShotRoutine(job)) continue;
    // Past its configured end: catch-up must not resurrect a retired routine. The scheduler only
    // auto-disables lazily in a live cron tick, so a routine whose endAt elapsed while the daemon
    // was down is still enabled on disk.
    if (isPastEndAt(job, now)) continue;
    // Trigger-only jobs (no cron schedule) never have an expected fire time.
    if (!job.schedule) continue;
    // A job pinned to another device is that device's to run, notify, and
    // catch up — flagging it here would make every machine in the fleet nag
    // (and `catchup` fire) for a job that must not run locally.
    if (!jobRunsOnThisDevice(job)) continue;

    let expected: Date | null = null;
    try {
      const cronOptions: Record<string, unknown> = { paused: true };
      if (job.timezone) cronOptions.timezone = job.timezone;
      const cron = new Cron(job.schedule, cronOptions);
      expected = previousExpectedFire(cron, now);
      cron.stop();
    } catch {
      // Invalid cron expression — skip rather than crash the daemon.
      continue;
    }

    if (!expected) continue;

    // A fire that predates the routine never could have happened, so it isn't a miss. Otherwise
    // any new daily/weekly routine is instantly "overdue" and, with auto-catchup, `agents routines
    // add` would run it once immediately.
    const start = routineEffectiveStart(job, now);
    if (start && expected.getTime() < start.getTime()) continue;

    const latest = getLatestRun(job.name);
    const lastRanAt = latest ? new Date(latest.startedAt) : null;

    const isOverdue =
      !lastRanAt || lastRanAt.getTime() < expected.getTime() - GRACE_MS;

    if (isOverdue) {
      overdue.push({ name: job.name, expectedAt: expected, lastRanAt });
    }
  }

  return overdue;
}

/** Fires a branded desktop notification listing overdue jobs, via the MenubarHelper companion
 * (notify-desktop.ts); clicking opens ~/.agents/.history/runs. Best-effort: a missing notifier or
 * display is swallowed and never crashes the daemon. */
export function notifyOverdue(jobs: OverdueJob[]): void {
  if (jobs.length === 0) return;

  const title =
    jobs.length === 1 ? 'Routine overdue' : `${jobs.length} routines overdue`;
  const subtitle = jobs.length === 1 ? jobs[0].name : undefined;
  const body =
    jobs.length === 1
      ? `Missed ${jobs[0].expectedAt.toLocaleString()}. Run: agents routines catchup`
      : `${jobs.map((j) => j.name).join(', ')} — agents routines catchup`;

  notifyDesktop({ title, subtitle, body, action: 'routines:list' });
}
