import { it, expect } from 'vitest';
import * as fs from 'fs';
import {
  describeRoutines,
  makeHome,
  run,
  baseJob,
  registry,
  writeRunMeta,
} from './routines.test-fixture.js';

// `routines status --json` (PHNX-3215): the daemon-owned status view with each routine's single
// owner device, last-fire outcome and error, any in-flight spawn, and the scheduler block.
// Distinct from the definition-shaped `list --json`; real CLI subprocess, no mocking.

describeRoutines('routines status --json', () => {
  it('emits a scheduler block plus per-routine owner device, last fire, and last error', () => {
    const job = { ...baseJob, devices: ['yosemite-s0'] };
    const home = makeHome({
      jobs: [job],
      registry,
      deviceRoutines: { 'yosemite-s0': ['test-job'] },
    });
    try {
      // A failed last fire on THIS device.
      writeRunMeta(home, 'test-job', '2026-07-21T10-00-00-000Z', {
        jobName: 'test-job',
        runId: '2026-07-21T10-00-00-000Z',
        agent: 'claude',
        pid: null,
        status: 'failed',
        startedAt: '2026-07-21T10:00:00.000Z',
        completedAt: '2026-07-21T10:01:00.000Z',
        exitCode: 1,
        errorMessage: 'agent exited non-zero',
      });

      const res = run(home, ['status', '--json'], { AGENTS_SYNC_MACHINE_ID: 'yosemite-s0' });
      expect(res.status).toBe(0);

      const parsed = JSON.parse(res.stdout.trim());
      expect(parsed.device).toBe('yosemite-s0');
      expect(parsed.scheduler).toBeDefined();
      expect(['running', 'wedged', 'stopped']).toContain(parsed.scheduler.state);
      expect(parsed.scheduler.total).toBe(1);
      expect(parsed.scheduler.enabled).toBe(1);

      const entry = parsed.routines.find((r: Record<string, unknown>) => r.name === 'test-job');
      expect(entry).toBeDefined();
      expect(entry.ownerDevice).toBe('yosemite-s0');
      expect(entry.ambiguousDevicePin).toBe(false);
      expect(entry.enabledDevices).toEqual(['yosemite-s0']);
      expect(entry.runsHere).toBe(true);
      expect(entry.lastStatus).toBe('failed');
      expect(entry.failureReason).toBe('agent exited non-zero');
      expect(entry.lastRunCompletedAt).toBe('2026-07-21T10:01:00.000Z');
      expect(entry.inFlight).toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('surfaces an in-flight run (live pid, status running) as inFlight', () => {
    const job = { ...baseJob, devices: ['yosemite-s0'] };
    const home = makeHome({
      jobs: [job],
      registry,
      deviceRoutines: { 'yosemite-s0': ['test-job'] },
    });
    try {
      // A genuinely in-flight run: status 'running', a live pid (this test process), no spawnedAt
      // so the reaper's liveness check passes on pid alone, and startedAt=now.
      // monitorRunningJobs() must therefore leave it running.
      writeRunMeta(home, 'test-job', '2026-07-21T12-00-00-000Z', {
        jobName: 'test-job',
        runId: '2026-07-21T12-00-00-000Z',
        agent: 'claude',
        pid: process.pid,
        status: 'running',
        triggerKind: 'schedule',
        startedAt: new Date().toISOString(),
        completedAt: null,
        exitCode: null,
      });

      const res = run(home, ['status', '--json'], { AGENTS_SYNC_MACHINE_ID: 'yosemite-s0' });
      expect(res.status).toBe(0);

      const parsed = JSON.parse(res.stdout.trim());
      const entry = parsed.routines.find((r: Record<string, unknown>) => r.name === 'test-job');
      expect(entry).toBeDefined();
      expect(entry.lastStatus).toBe('running');
      expect(entry.inFlight).not.toBeNull();
      expect(entry.inFlight.runId).toBe('2026-07-21T12-00-00-000Z');
      expect(entry.inFlight.pid).toBe(process.pid);
      expect(entry.inFlight.triggerKind).toBe('schedule');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('does NOT report a provisional pre-spawn claim (status running, pid null) as in-flight', () => {
    const job = { ...baseJob, devices: ['yosemite-s0'] };
    const home = makeHome({
      jobs: [job],
      registry,
      deviceRoutines: { 'yosemite-s0': ['test-job'] },
    });
    try {
      // The window writeActiveClaim opens before the child spawns: status 'running', pid null, no
      // hostTaskId. monitorRunningJobs() doesn't reap it, so a daemon crash here would surface a
      // phantom in-flight run (RUSH-2640); it must read as running-but-not-in-flight.
      writeRunMeta(home, 'test-job', '2026-07-21T13-00-00-000Z', {
        jobName: 'test-job',
        runId: '2026-07-21T13-00-00-000Z',
        agent: 'claude',
        pid: null,
        status: 'running',
        startedAt: new Date().toISOString(),
        completedAt: null,
        exitCode: null,
      });

      const res = run(home, ['status', '--json'], { AGENTS_SYNC_MACHINE_ID: 'yosemite-s0' });
      expect(res.status).toBe(0);

      const parsed = JSON.parse(res.stdout.trim());
      const entry = parsed.routines.find((r: Record<string, unknown>) => r.name === 'test-job');
      expect(entry).toBeDefined();
      expect(entry.lastStatus).toBe('running');
      expect(entry.inFlight).toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('reports null last status and no in-flight for a routine pinned away from this device', () => {
    const job = { ...baseJob, devices: ['zion'] };
    const home = makeHome({
      jobs: [job],
      registry,
      deviceRoutines: { zion: ['test-job'], 'yosemite-s0': [] },
    });
    try {
      // A run recorded elsewhere must not read as this device's last fire.
      writeRunMeta(home, 'test-job', '2026-07-25T10-00-00-000Z', {
        jobName: 'test-job',
        runId: '2026-07-25T10-00-00-000Z',
        agent: 'claude',
        pid: null,
        status: 'completed',
        startedAt: '2026-07-25T10:00:00.000Z',
        completedAt: '2026-07-25T10:01:00.000Z',
        exitCode: 0,
      });

      const res = run(home, ['status', '--json'], { AGENTS_SYNC_MACHINE_ID: 'yosemite-s0' });
      expect(res.status).toBe(0);

      const parsed = JSON.parse(res.stdout.trim());
      const entry = parsed.routines.find((r: Record<string, unknown>) => r.name === 'test-job');
      expect(entry).toBeDefined();
      expect(entry.ownerDevice).toBe('zion');
      expect(entry.runsHere).toBe(false);
      expect(entry.lastStatus).toBeNull();
      expect(entry.inFlight).toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
