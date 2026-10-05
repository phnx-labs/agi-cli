/** Catch-up: run a routine whose scheduled fire this device missed. croner only schedules forward,
 * so a down daemon loses the fire. claimMissedFire records a `missed` run stamped at the due time
 * via an atomic non-recursive mkdir; only the claimant runs it late, across processes. */

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
  /** `ran`: re-run late. `recorded`: miss logged, not re-run (`catchup: false` or dry run).
   * `claimed-elsewhere`: another pass owns this fire. `error`: late run failed to start. */
  result: 'ran' | 'recorded' | 'claimed-elsewhere' | 'error';
  /** Run id of the late run, when one was started. */
  runId?: string;
  /** Why the late run could not be started. */
  error?: string;
}

/** Whether a routine may run late. Defaults to true; `catchup: false` opts out a routine whose
 * worth expires with its slot. */
export function shouldCatchUp(job: Pick<JobConfig, 'catchup'>): boolean {
  return job.catchup !== false;
}

/** The run id a missed fire is recorded under — derived from when it was DUE. */
export function missedRunId(expectedAt: Date): string {
  return expectedAt.toISOString().replace(/[:.]/g, '-');
}

/** Atomically claim a missed fire; returns the run, or null if another caller already claimed this
 * (routine, expected-fire) pair. Atomicity is the non-recursive mkdir of the run dir, named from
 * `expectedAt`. At-most-once by design: a crash between claim and spawn leaves the miss on record. */
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

/** Record, and unless opted out re-run, every routine this device missed. Device scoping is
 * enforced upstream: `detectOverdueJobs` skips jobs pinned elsewhere (overdue.ts). */
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
