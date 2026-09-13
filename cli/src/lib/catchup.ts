/**
 * Catch-up: run a routine whose scheduled fire this device missed.
 *
 * Fires are in-process croner timers, and croner only ever schedules forward
 * from "now". A daemon that is down, asleep, or wedged when a routine comes due
 * therefore loses that fire outright — `loadAll()` rebuilds every Cron looking
 * only at the future (scheduler.ts), so nothing replays it. Detection has always
 * existed (`detectOverdueJobs`), but it ran once at daemon startup and only
 * logged plus popped a notification; the routine still never ran.
 *
 * This module closes that loop. A missed fire is:
 *
 *   1. CLAIMED — `claimMissedFire` writes a real run with status `missed`,
 *      stamped at the time the fire was DUE, so `agents routines runs <name>`
 *      shows the gap instead of the listing showing a weeks-old `completed` as
 *      though it were current. The write is an atomic claim (see below), and
 *      only the claimant proceeds to step 2.
 *   2. RUN — unless the routine sets `catchup: false`, it is executed late via
 *      the same `executeJobDetached` path `agents routines catchup` already used.
 *
 * The `missed` record is also what makes this idempotent, so there is no
 * separate ledger to keep in sync. `detectOverdueJobs` compares the most recent
 * expected fire against `getLatestRun(...).startedAt`; a `missed` record stamped
 * at `expectedAt` advances that comparison, so the same missed fire is never
 * reconsidered — across ticks, daemon restarts, or a restart storm. (A job that
 * is overdue by definition has no run later than `expectedAt`, so the
 * back-stamped record always sorts last in `listRuns`.)
 *
 * That comparison alone is not enough when two callers overlap, because both
 * can read the same overdue set before either writes. The claim in
 * `claimMissedFire` closes that: the record's directory is created with a
 * non-recursive `mkdir`, an atomic test-and-set, and only the caller that wins
 * it runs the routine. This holds across processes — the daemon's timer and a
 * human running `agents routines catchup` — which neither an in-process flag
 * nor `withFileLock` (synchronous; this pass awaits a spawn) can cover.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  readJob,
  writeRunMeta,
  getRunDir,
  type JobConfig,
  type RunMeta,
} from './scheduling/routines.js';
import { detectOverdueJobs, type OverdueJob } from './overdue.js';
import { executeJobDetached } from './daemon/runner.js';

/** What happened to one overdue routine on a catch-up pass. */
export interface CatchupOutcome {
  name: string;
  /** The fire that was missed. */
  expectedAt: Date;
  /**
   * `ran` — re-run late. `recorded` — miss logged, not re-run (`catchup: false`
   * or a dry run). `claimed-elsewhere` — a concurrent pass or process already
   * owns this fire. `error` — could not start the late run.
   */
  result: 'ran' | 'recorded' | 'claimed-elsewhere' | 'error';
  /** Run id of the late run, when one was started. */
  runId?: string;
  /** Why the late run could not be started. */
  error?: string;
}

/**
 * Is this routine allowed to run late? Default true — a routine you scheduled
 * is one you expect to have run, so losing a fire silently is never the helpful
 * default. `catchup: false` opts out a routine whose worth expires with its slot.
 */
export function shouldCatchUp(job: Pick<JobConfig, 'catchup'>): boolean {
  return job.catchup !== false;
}

/** The run id a missed fire is recorded under — derived from when it was DUE. */
export function missedRunId(expectedAt: Date): string {
  return expectedAt.toISOString().replace(/[:.]/g, '-');
}

/**
 * CLAIM a missed fire: atomically record that it never happened, and report
 * whether this caller is the one that recorded it.
 *
 * Returns the run on a successful claim, or `null` when another caller already
 * claimed the same (routine, expected-fire) pair. That return value is the
 * concurrency control for the whole module — only the claimant runs the routine
 * late, so a fire can never be spawned twice.
 *
 * The atomicity is the non-recursive `mkdir` of the run directory: on every
 * POSIX filesystem that is a single test-and-set, failing with EEXIST if the
 * directory is already there. It therefore holds between the daemon's timer and
 * a human running `agents routines catchup` in a separate process — which an
 * in-process re-entrancy flag cannot cover, and which a lock cannot cover either
 * (`withFileLock` is synchronous and this pass awaits a spawn).
 *
 * The run id is derived from `expectedAt` rather than "now" so the same missed
 * fire always maps to the same directory — that is what makes the claim
 * meaningful — and so the record sorts into `listRuns` (lexical over ISO run
 * ids) at the point the gap actually occurred.
 *
 * Deliberately at-most-once: a process that dies between claiming and spawning
 * leaves the fire un-run. That is the right trade for something that starts
 * agent processes — a double spawn costs real work and money, while the miss is
 * still on the record for a human to see and re-run.
 */
export function claimMissedFire(job: JobConfig, expectedAt: Date): RunMeta | null {
  const runId = missedRunId(expectedAt);
  const runDir = getRunDir(job.name, runId);
  fs.mkdirSync(path.dirname(runDir), { recursive: true });
  try {
    fs.mkdirSync(runDir); // non-recursive: throws EEXIST if already claimed
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw err;
  }
  const at = expectedAt.toISOString();
  const meta: RunMeta = {
    jobName: job.name,
    runId,
    agent: job.agent,
    workflow: job.workflow,
    command: job.command,
    pid: null,
    status: 'missed',
    startedAt: at,
    completedAt: at,
    exitCode: null,
    errorMessage: 'scheduled fire missed — the scheduler was not running when it came due',
    actor: job.actor,
  };
  writeRunMeta(meta);
  return meta;
}

interface CatchupOptions {
  /** Record misses but start no late runs. Powers `catchup --dry-run`. */
  dryRun?: boolean;
  /** Clock injection seam for tests. */
  now?: Date;
  /** Overdue set to act on. Defaults to detecting it. Lets a caller reuse a scan. */
  overdue?: OverdueJob[];
}

/**
 * Record — and, unless opted out, re-run — every routine this device missed.
 *
 * Device scoping is already enforced upstream: `detectOverdueJobs` skips a job
 * pinned elsewhere (overdue.ts), so a fleet of machines never all catch up the
 * same routine.
 */
export async function runCatchup(opts: CatchupOptions = {}): Promise<CatchupOutcome[]> {
  const overdue = opts.overdue ?? detectOverdueJobs(opts.now ?? new Date());
  const outcomes: CatchupOutcome[] = [];

  for (const entry of overdue) {
    const config = readJob(entry.name);
    if (!config) {
      outcomes.push({
        name: entry.name,
        expectedAt: entry.expectedAt,
        result: 'error',
        error: 'config not found',
      });
      continue;
    }

    // Claim first. Losing the claim means another pass (or another process)
    // already owns this fire — say so rather than running it a second time.
    if (claimMissedFire(config, entry.expectedAt) === null) {
      outcomes.push({ name: entry.name, expectedAt: entry.expectedAt, result: 'claimed-elsewhere' });
      continue;
    }

    if (!shouldCatchUp(config) || opts.dryRun) {
      outcomes.push({ name: entry.name, expectedAt: entry.expectedAt, result: 'recorded' });
      continue;
    }

    try {
      // No `scheduledFor` here on purpose: the missed slot is already claimed by
      // `claimMissedFire` above (its atomic mkdir IS the catch-up single-fire), so
      // the late run gets a fresh id rather than colliding with the missed record.
      const meta = await executeJobDetached(config, undefined, { kind: 'catchup' });
      outcomes.push({
        name: entry.name,
        expectedAt: entry.expectedAt,
        result: 'ran',
        runId: meta.runId,
      });
    } catch (err) {
      outcomes.push({
        name: entry.name,
        expectedAt: entry.expectedAt,
        result: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return outcomes;
}
