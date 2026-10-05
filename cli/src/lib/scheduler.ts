/** Cron-based job scheduler for routines: wraps croner to hold scheduled jobs in memory. The daemon
 * creates a single JobScheduler that loads enabled jobs on startup and reloads on SIGHUP. */

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

/** A job config paired with its active cron instance. */
interface ScheduledJob {
  config: JobConfig;
  cron: Cron;
}

/** How a fire was triggered, carrying the scheduler's intended UTC slot time. */
interface TriggerContext {
  /** The ALIGNED cron slot this callback fires for, for the single-fire claim
   *  keyed on (routine, scheduledFor). Derived by {@link fireSlot} — NOT croner's
   *  raw `currentRun()`, which carries wall-clock jitter. */
  scheduledFor?: Date;
}

/** The aligned occurrence boundary the single-fire `(routine, scheduledFor)` claim keys on. croner's
 * `currentRun()` is the JITTERED trigger instant, so keying on it minted a run id per delivery and
 * a live fire never collided with its catch-up twin (SING-15). */
export function fireSlot(cron: Cron): Date {
  const fire = cron.currentRun() ?? new Date();
  return alignedSlotForFire(cron, fire) ?? fire;
}

/** In-memory cron scheduler that triggers a callback when jobs fire. */
export class JobScheduler {
  private jobs = new Map<string, ScheduledJob>();
  private onTrigger: (config: JobConfig, ctx?: TriggerContext) => Promise<void>;

  constructor(onTrigger: (config: JobConfig, ctx?: TriggerContext) => Promise<void>) {
    this.onTrigger = onTrigger;
  }

  loadAll(): void {
    const configs = listJobs();
    for (const config of configs) {
      // Trigger-only jobs (no cron schedule) fire via the webhook receiver,
      // not the cron loop — skip them here. Jobs pinned to another device
      // (routines are fleet-synced) never enter this machine's cron loop.
      if (!config.enabled || !config.schedule) continue;
      // A multi-device pin is a misconfiguration: it used to fire the routine
      // once per listed device. It now fires only on the owner, but say so —
      // silently reinterpreting someone's config is how this went unnoticed.
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
    // A schedule-less (trigger-only) job has nothing to hand to croner.
    if (!config.schedule) return;
    this.unschedule(config.name);
    if (shouldPurgeCompletedOneShotRoutine(config)) {
      deleteJob(config.name);
      return;
    }
    if (isPastOneShotRoutine(config)) return;

    // catch: true: a synchronous throw before the await in one job's callback would bubble up and
    // kill the whole cron loop; onTrigger is already try/catch-wrapped, so this is defense in
    // depth.
    const cronOptions: Record<string, unknown> = { catch: true };
    if (config.timezone) cronOptions.timezone = config.timezone;

    const cron = new Cron(config.schedule, cronOptions, async (self: Cron) => {
      // endAt: once the configured end time has passed, auto-disable and stop
      // firing. We persist enabled=false to disk so the next daemon reload
      // doesn't re-schedule, and unschedule in-memory so this cron stops.
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
        // scheduledFor is the ALIGNED occurrence boundary (fireSlot), not croner's jittered
        // currentRun(): the single-fire claim keys on it, so a live fire and its catch-up twin
        // (missedRunId) must share it (SING-15).
        await this.onTrigger(config, { scheduledFor: fireSlot(self) });
      } catch (err) {
        console.error(`Job '${config.name}' failed:`, (err as Error).message);
      }

      // One-shot jobs: remove after first execution
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
