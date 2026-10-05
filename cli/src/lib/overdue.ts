// Compare aligned occurrences to recorded starts with 60-second tolerance; floor by creation/mtime and exclude one-shots, ended, trigger-only, other-device, and pre-creation fires.

import * as fs from 'fs';
import { Cron } from 'croner';
import { alignedSlotForFire, listJobs, getLatestRun, resolveJobFilePath, isPastEndAt, isOneShotRoutine, jobRunsOnThisDevice, type JobConfig } from './scheduling/routines.js';
import { notifyDesktop } from './menubar/notify-desktop.js';

export interface OverdueJob {
  name: string;
  expectedAt: Date;
  lastRanAt: Date | null;
}

const GRACE_MS = 60_000;

function previousExpectedFire(cron: Cron, now: Date): Date | null {
  return alignedSlotForFire(cron, now);
}

export function routineEffectiveStart(job: JobConfig, now: Date = new Date()): Date | null {
  if (job.createdAt) {
    const stamped = new Date(job.createdAt);
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

export function detectOverdueJobs(now: Date = new Date()): OverdueJob[] {
  const overdue: OverdueJob[] = [];

  for (const job of listJobs()) {
    if (!job.enabled) continue;
    if (isOneShotRoutine(job)) continue;
    if (isPastEndAt(job, now)) continue;
    if (!job.schedule) continue;
    if (!jobRunsOnThisDevice(job)) continue;

    let expected: Date | null = null;
    try {
      const cronOptions: Record<string, unknown> = { paused: true };
      if (job.timezone) cronOptions.timezone = job.timezone;
      const cron = new Cron(job.schedule, cronOptions);
      expected = previousExpectedFire(cron, now);
      cron.stop();
    } catch {
      continue;
    }

    if (!expected) continue;

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
