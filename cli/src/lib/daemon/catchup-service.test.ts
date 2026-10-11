import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ServiceSupervisor } from './supervisor.js';
import { CatchupService } from './catchup-service.js';
import type { DaemonContext } from './service.js';

let testDaemonDir = '';
const originalDaemonDir = process.env.AGENTS_DAEMON_DIR;

beforeEach(() => {
  testDaemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-catchup-'));
  process.env.AGENTS_DAEMON_DIR = testDaemonDir;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  if (originalDaemonDir === undefined) delete process.env.AGENTS_DAEMON_DIR;
  else process.env.AGENTS_DAEMON_DIR = originalDaemonDir;
  fs.rmSync(testDaemonDir, { recursive: true, force: true });
});

function makeCtx(): DaemonContext {
  return { log: () => {} };
}

describe('CatchupService', () => {
  it('no-ops while the scheduler is not booted, and runs the pass once it is', async () => {
    let booted = false;
    const runPass = vi.fn(async () => {});
    const supervisor = new ServiceSupervisor();
    supervisor.register(new CatchupService({ isSchedulerBooted: () => booted, runPass }));

    await supervisor.startAll(makeCtx());
    await vi.advanceTimersByTimeAsync(0);
    expect(runPass).not.toHaveBeenCalled();

    booted = true;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(runPass).toHaveBeenCalledTimes(1);

    await supervisor.stopAll();
  });

  it('a hung pass exits the daemon for a supervised restart once it is a hang, not at its deadline (PHNX-4116, PHNX-4225)', async () => {
    const exit = vi.fn();
    const runPass = vi.fn(async () => new Promise<void>(() => {}));
    const supervisor = new ServiceSupervisor({ exit: exit as unknown as (code: number) => never });
    supervisor.register(new CatchupService({ isSchedulerBooted: () => true, runPass }));

    await supervisor.startAll(makeCtx());
    await vi.advanceTimersByTimeAsync(0);
    expect(runPass).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(9 * 4 * 60_000);
    expect(exit).toHaveBeenCalledWith(70);

    await supervisor.stopAll();
  });

  it('passes an AbortSignal that aborts at the deadline', async () => {
    const exit = vi.fn();
    let seen: AbortSignal | undefined;
    const runPass = vi.fn(async (signal: AbortSignal) => {
      seen = signal;
      await new Promise<void>((resolve) => {
        if (signal.aborted) { resolve(); return; }
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    const supervisor = new ServiceSupervisor({ exit: exit as unknown as (code: number) => never });
    supervisor.register(new CatchupService({ isSchedulerBooted: () => true, runPass }));

    await supervisor.startAll(makeCtx());
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toBeDefined();
    expect(seen!.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(seen!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * 4 * 60_000);
    expect(exit).not.toHaveBeenCalled();

    await supervisor.stopAll();
  });
});
