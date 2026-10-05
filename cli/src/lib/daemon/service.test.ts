import { describe, it, expect } from 'vitest';
import { BasePeriodicService, isPeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';

function makeCtx(): DaemonContext {
  return { log: () => {} };
}

class RecordingService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'account-state';
  readonly intervalMs = 1_000;
  readonly deadlineMs = 500;

  startCalls = 0;
  stopCalls = 0;
  tickCalls = 0;
  shouldFailTick = false;

  protected async onStart(_ctx: DaemonContext): Promise<void> {
    this.startCalls += 1;
  }
  protected async onStop(): Promise<void> {
    this.stopCalls += 1;
  }
  protected async onTick(_ctx: DaemonContext): Promise<void> {
    this.tickCalls += 1;
    if (this.shouldFailTick) throw new Error(`tick failure #${this.tickCalls}`);
  }
}

describe('BasePeriodicService', () => {
  it('starts idle, transitions to running on start(), and caches ctx for restart()', async () => {
    const svc = new RecordingService();
    expect(svc.health().state).toBe('idle');

    await svc.start(makeCtx());
    expect(svc.startCalls).toBe(1);
    expect(svc.health().state).toBe('running');
  });

  it('stop() transitions to stopped and calls onStop()', async () => {
    const svc = new RecordingService();
    await svc.start(makeCtx());
    await svc.stop();
    expect(svc.stopCalls).toBe(1);
    expect(svc.health().state).toBe('stopped');
  });

  it('restart() is stop() then start() against the context passed to the original start()', async () => {
    const svc = new RecordingService();
    await svc.start(makeCtx());
    await svc.restart();
    expect(svc.stopCalls).toBe(1);
    expect(svc.startCalls).toBe(2);
    expect(svc.health().state).toBe('running');
  });

  it('restart() before any start() throws — there is no cached context to restart against', async () => {
    const svc = new RecordingService();
    await expect(svc.restart()).rejects.toThrow(/cannot restart before it has started once/);
  });

  it('a successful tick() clears the failure streak and stamps lastRunMs', async () => {
    const svc = new RecordingService();
    await svc.start(makeCtx());
    await svc.tick(makeCtx());
    const health = svc.health();
    expect(health.consecutiveFailures).toBe(0);
    expect(health.lastError).toBeUndefined();
    expect(health.lastRunMs).toBeGreaterThan(0);
  });

  it('a failing tick() records the error and accumulates the failure streak, then re-throws', async () => {
    const svc = new RecordingService();
    svc.shouldFailTick = true;
    await svc.start(makeCtx());

    await expect(svc.tick(makeCtx())).rejects.toThrow('tick failure #1');
    expect(svc.health().consecutiveFailures).toBe(1);
    expect(svc.health().lastError).toBe('tick failure #1');

    await expect(svc.tick(makeCtx())).rejects.toThrow('tick failure #2');
    expect(svc.health().consecutiveFailures).toBe(2);
  });

  it('a success after failures resets the streak', async () => {
    const svc = new RecordingService();
    svc.shouldFailTick = true;
    await svc.start(makeCtx());
    await expect(svc.tick(makeCtx())).rejects.toThrow();
    expect(svc.health().consecutiveFailures).toBe(1);

    svc.shouldFailTick = false;
    await svc.tick(makeCtx());
    expect(svc.health().consecutiveFailures).toBe(0);
    expect(svc.health().lastError).toBeUndefined();
  });

  it('health() returns a snapshot copy, not a live reference', async () => {
    const svc = new RecordingService();
    await svc.start(makeCtx());
    const snapshot = svc.health();
    await svc.stop();
    expect(snapshot.state).toBe('running');
    expect(svc.health().state).toBe('stopped');
  });
});

describe('isPeriodicService', () => {
  it('recognizes a service exposing tick/intervalMs/deadlineMs', async () => {
    const svc = new RecordingService();
    expect(isPeriodicService(svc)).toBe(true);
  });

  it('rejects a plain DaemonService with no periodic fields', () => {
    const bare = {
      id: 'watchdog' as DaemonServiceId,
      start: async () => {},
      stop: async () => {},
      restart: async () => {},
      health: () => ({ state: 'idle' as const, lastRunMs: 0, consecutiveFailures: 0 }),
    };
    expect(isPeriodicService(bare)).toBe(false);
  });
});
