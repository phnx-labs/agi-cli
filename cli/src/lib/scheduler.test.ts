import * as fs from 'fs';
import * as path from 'path';
import { Cron } from 'croner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobScheduler, fireSlot } from './scheduler.js';
import { writeJob, deleteJob, slotRunId, type JobConfig } from './scheduling/routines.js';
import { missedRunId } from './catchup.js';
import * as activation from './routine-activation.js';
import { getUserAgentsDir } from './state.js';

// Reload rereads device activation instead of retaining stale constructor state.
describe('JobScheduler.reloadAll — device activation refresh', () => {
  const name = 'rush1980-scheduler-test';
  const SELF = 'rush1980-self';
  let prevMachineId: string | undefined;
  let active = true;

  beforeEach(() => {
    prevMachineId = process.env.AGENTS_SYNC_MACHINE_ID;
    process.env.AGENTS_SYNC_MACHINE_ID = SELF;
    active = true;
    vi.spyOn(activation, 'routineEnabledOnThisDevice').mockImplementation(() => active);
  });

  // This suite writes real ~/.agents; remove its deterministic device directory so test state cannot leak into the operator's tracked configuration.
  afterEach(() => {
    vi.restoreAllMocks();
    try { deleteJob(name); } catch {  }
    try {
      fs.rmSync(path.join(getUserAgentsDir(), 'devices', SELF), { recursive: true, force: true });
    } catch {  }
    if (prevMachineId === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
    else process.env.AGENTS_SYNC_MACHINE_ID = prevMachineId;
  });

  function routine(): JobConfig {
    return {
      name,
      agent: 'claude',
      prompt: 'do it',
      schedule: '0 9 * * 1-5',
      mode: 'plan',
      effort: 'auto',
      timeout: '10m',
      enabled: true,
    } as JobConfig;
  }

  it('picks up enable and disable changes from this device manifest', () => {
    writeJob(routine());
    const scheduler = new JobScheduler(async () => {});
    scheduler.loadAll();
    expect(scheduler.listScheduled().some((j) => j.name === name)).toBe(true);

    active = false;
    scheduler.reloadAll();
    expect(scheduler.listScheduled().some((j) => j.name === name)).toBe(false);

    active = true;
    scheduler.reloadAll();
    expect(scheduler.listScheduled().some((j) => j.name === name)).toBe(true);

    scheduler.stopAll();
  });
});

// Pin cron UTC and floor jitter so forward scheduling and catch-up derive the same occurrence key.
describe('fireSlot — aligned, unconditional occurrence key (SING-15)', () => {
  it('floors a jittered fire instant to the aligned schedule boundary', () => {
    const cron = new Cron('0 9 * * 1-5', { paused: true, timezone: 'UTC' });
    const boundary = new Date('2026-08-28T09:00:00.000Z');
    vi.spyOn(cron, 'currentRun').mockReturnValue(new Date(boundary.getTime() + 4));

    const slot = fireSlot(cron);
    expect(slot.toISOString()).toBe(boundary.toISOString());
    expect(slot.getMilliseconds()).toBe(0);
    expect(slotRunId(slot)).toBe(missedRunId(boundary));
  });

  it('returns a concrete aligned slot even when currentRun() is null', () => {
    const cron = new Cron('0 9 * * 1-5', { paused: true });
    vi.spyOn(cron, 'currentRun').mockReturnValue(null);
    const slot = fireSlot(cron);
    expect(slot).toBeInstanceOf(Date);
  });
});
