
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

export interface CatchupOutcome {
  name: string;
  expectedAt: Date;
  result: 'ran' | 'recorded' | 'claimed-elsewhere' | 'error';
  runId?: string;
  error?: string;
}

export function shouldCatchUp(job: Pick<JobConfig, 'catchup'>): boolean {
  return job.catchup !== false;
}

export function missedRunId(expectedAt: Date): string {
  return expectedAt.toISOString().replace(/[:.]/g, '-');
}

export function claimMissedFire(job: JobConfig, expectedAt: Date): RunMeta | null {
  // Use the live scheduler's id shape and a non-recursive mkdir claim.
  const runId = missedRunId(expectedAt);
  const runDir = getRunDir(job.name, runId);
  fs.mkdirSync(path.dirname(runDir), { recursive: true });
  try {
    fs.mkdirSync(runDir);
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
  dryRun?: boolean;
  now?: Date;
  overdue?: OverdueJob[];
}

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

    if (claimMissedFire(config, entry.expectedAt) === null) {
      outcomes.push({ name: entry.name, expectedAt: entry.expectedAt, result: 'claimed-elsewhere' });
      continue;
    }

    if (!shouldCatchUp(config) || opts.dryRun) {
      outcomes.push({ name: entry.name, expectedAt: entry.expectedAt, result: 'recorded' });
      continue;
    }

    try {
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
