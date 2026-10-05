
import { Cron } from 'croner';
import type { JobConfig } from './scheduling/routines.js';
import {
  alignedSlotForFire,
  listJobs,
  deleteJob,
  isPastEndAt,
  isPastOneShotRoutine,
  isOneShotRoutine,
  setJobEnabled,
  shouldPurgeCompletedOneShotRoutine,
  jobRunsOnThisDevice,
  hasAmbiguousDevicePin,
  routineOwnerDevice,
} from './scheduling/routines.js';

interface ScheduledJob {
  config: JobConfig;
  cron: Cron;
}

interface TriggerContext {
  scheduledFor?: Date;
}

export function fireSlot(cron: Cron): Date {
  // Claims key on the aligned occurrence boundary, never Croner's jittered currentRun, or catch-up deliveries double-fire.
  const fire = cron.currentRun() ?? new Date();
  return alignedSlotForFire(cron, fire) ?? fire;
}

export class JobScheduler {
  private jobs = new Map<string, ScheduledJob>();
  private onTrigger: (config: JobConfig, ctx?: TriggerContext) => Promise<void>;

  constructor(onTrigger: (config: JobConfig, ctx?: TriggerContext) => Promise<void>) {
    this.onTrigger = onTrigger;
  }

  loadAll(): void {
    const configs = listJobs();
    for (const config of configs) {
      // Schedule-less jobs are trigger-only; other-device pins stay out, and ambiguous pins execute only on the owner.
      if (!config.enabled || !config.schedule) continue;
      if (hasAmbiguousDevicePin(config)) {
        const owner = routineOwnerDevice(config);
        console.warn(
          `Job '${config.name}' pins ${config.devices!.length} devices; a routine runs on exactly one. ` +
          `Firing only on '${owner}'. Fix with: agents routines devices ${config.name} --set ${owner}`,
        );
      }
      if (!jobRunsOnThisDevice(config)) continue;
      if (shouldPurgeCompletedOneShotRoutine(config)) {
        deleteJob(config.name);
        continue;
      }
      if (isPastOneShotRoutine(config)) continue;
      this.schedule(config);
    }
  }

  schedule(config: JobConfig): void {
    if (!config.schedule) return;
    this.unschedule(config.name);
    if (shouldPurgeCompletedOneShotRoutine(config)) {
      deleteJob(config.name);
      return;
    }
    if (isPastOneShotRoutine(config)) return;

    // catch:true keeps one callback failure from terminating the cron loop.
    const cronOptions: Record<string, unknown> = { catch: true };
    if (config.timezone) cronOptions.timezone = config.timezone;

    const cron = new Cron(config.schedule, cronOptions, async (self: Cron) => {
      // Persist endAt disablement; remove one-shots after their first execution below.
      if (isPastEndAt(config)) {
        this.unschedule(config.name);
        try {
          setJobEnabled(config.name, false);
        } catch (err) {
          console.error(`Job '${config.name}' endAt auto-disable failed:`, (err as Error).message);
        }
        console.log(`Job '${config.name}' reached endAt (${config.endAt}); auto-disabled.`);
        return;
      }

      try {
        await this.onTrigger(config, { scheduledFor: fireSlot(self) });
      } catch (err) {
        console.error(`Job '${config.name}' failed:`, (err as Error).message);
      }

      if (isOneShotRoutine(config)) {
        this.unschedule(config.name);
        deleteJob(config.name);
      }
    });

    this.jobs.set(config.name, { config, cron });
  }

  unschedule(name: string): void {
    const existing = this.jobs.get(name);
    if (existing) {
      existing.cron.stop();
      this.jobs.delete(name);
    }
  }

  reloadAll(): void {
    this.stopAll();
    this.loadAll();
  }

  stopAll(): void {
    for (const [, job] of this.jobs) {
      job.cron.stop();
    }
    this.jobs.clear();
  }

  getNextRun(name: string): Date | null {
    const job = this.jobs.get(name);
    if (!job) return null;
    return job.cron.nextRun() || null;
  }

  listScheduled(): Array<{ name: string; nextRun: Date | null; enabled: boolean }> {
    const result: Array<{ name: string; nextRun: Date | null; enabled: boolean }> = [];
    for (const [name, job] of this.jobs) {
      result.push({
        name,
        nextRun: job.cron.nextRun() || null,
        enabled: job.config.enabled,
      });
    }
    return result;
  }
}
