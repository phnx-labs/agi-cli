import * as fs from 'fs';
import * as path from 'path';
import { Cron } from 'croner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobScheduler, fireSlot } from './scheduler.js';
import { writeJob, deleteJob, slotRunId, type JobConfig } from './scheduling/routines.js';
import { missedRunId } from './catchup.js';
import * as activation from './routine-activation.js';
import { getUserAgentsDir } from './state.js';

/** reloadAll() must re-read device activation after a manifest change so the daemon doesn't keep
 * firing a routine disabled on this host. */
describe('JobScheduler.reloadAll — device activation refresh', () => {
  const name = 'rush1980-scheduler-test';
  const SELF = 'rush1980-self';
  let prevMachineId: string | undefined;
  let active = true;

  beforeEach(() => {
    prevMachineId = process.env.AGENTS_SYNC_MACHINE_ID;
    // Deterministic self-id so the pin comparison never depends on the CI host.
    process.env.AGENTS_SYNC_MACHINE_ID = SELF;
    active = true;
    vi.spyOn(activation, 'routineEnabledOnThisDevice').mockImplementation(() => active);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { deleteJob(name); } catch { /* best effort */ }
    // deleteJob drops the routine but not the device dir writing it created, and this suite uses
    // the REAL ~/.agents, leaving `devices/rush1980-self/` on every box. Now that `devices/` is
    // tracked, remove our artifact (cf. RUSH-2639).
    try {
      fs.rmSync(path.join(getUserAgentsDir(), 'devices', SELF), { recursive: true, force: true });
    } catch { /* best effort */ }
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

describe('fireSlot — aligned, unconditional occurrence key (SING-15)', () => {
  it('floors a jittered fire instant to the aligned schedule boundary', () => {
    // Pin the schedule to UTC: without it, croner uses the worker's LOCAL zone,
    // so "0 9" fires at 09:00 local (16:00 UTC on a PDT box) and the floored
    // boundary lands on the previous day — the source of the flake (PHNX-3436).
    const cron = new Cron('0 9 * * 1-5', { paused: true, timezone: 'UTC' });
    const boundary = new Date('2026-08-28T09:00:00.000Z');
    // croner's currentRun() carries wall-clock jitter — simulate a fire 4 ms late.
    vi.spyOn(cron, 'currentRun').mockReturnValue(new Date(boundary.getTime() + 4));

    const slot = fireSlot(cron);
    expect(slot.toISOString()).toBe(boundary.toISOString());
    expect(slot.getMilliseconds()).toBe(0);
    // The forward-dispatch key and the catch-up key for one occurrence collide.
    expect(slotRunId(slot)).toBe(missedRunId(boundary));
  });

  it('returns a concrete aligned slot even when currentRun() is null', () => {
    const cron = new Cron('0 9 * * 1-5', { paused: true });
    vi.spyOn(cron, 'currentRun').mockReturnValue(null);
    const slot = fireSlot(cron);
    // Never undefined: the forward path always carries a durable claim key.
    expect(slot).toBeInstanceOf(Date);
  });
});
