/**
 * ServiceSupervisor (RUSH-3193 P1, PHNX-4116): per-service error boundary,
 * per-tick deadline, and exit-on-breach — exercised against fake
 * `DaemonService`/`PeriodicService` implementations, not the real daemon-hosted
 * services. A thrown tick is recorded and the service keeps ticking; a tick (or
 * a start()/restart() lifecycle call) that breaches its deadline exits the
 * process (via an injected `exit`) so systemd/launchd restart the daemon. There
 * is no `parked` state and no in-process backoff restart.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ServiceSupervisor } from './supervisor.js';
import type { DaemonContext, PeriodicService, ServiceHealth } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';

let testDaemonDir = '';
const originalDaemonDir = process.env.AGENTS_DAEMON_DIR;

beforeEach(() => {
  testDaemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-supervisor-'));
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

/** A supervisor `exit` stub typed to satisfy the never-returning signature. */
function makeExit(): ReturnType<typeof vi.fn> {
  return vi.fn();
}

/** A service that ticks successfully every time, counting how many ticks it ran. */
class HealthyService implements PeriodicService {
  readonly id: DaemonServiceId;
  readonly intervalMs = 1_000;
  readonly deadlineMs = 500;
  readonly startupDelayMs?: number;
  ticks = 0;
  started = false;
  stopped = false;

  constructor(id: DaemonServiceId, startupDelayMs?: number) {
    this.id = id;
    this.startupDelayMs = startupDelayMs;
  }

  async start(): Promise<void> {
    this.started = true;
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }
  async tick(): Promise<void> {
    this.ticks += 1;
  }
  health(): ServiceHealth {
    return { state: 'running', lastRunMs: 0, consecutiveFailures: 0 };
  }
}

/** A service whose tick always throws. */
class ThrowingService implements PeriodicService {
  readonly id: DaemonServiceId = 'watchdog';
  readonly intervalMs = 1_000;
  readonly deadlineMs = 500;
  ticks = 0;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async restart(): Promise<void> {}
  async tick(): Promise<void> {
    this.ticks += 1;
    throw new Error(`boom #${this.ticks}`);
  }
  health(): ServiceHealth {
    return { state: 'running', lastRunMs: 0, consecutiveFailures: 0 };
  }
}

/** A service whose tick never resolves — simulates an unbounded SSH/keychain await. */
class HangingService implements PeriodicService {
  readonly id: DaemonServiceId = 'device-probe';
  readonly intervalMs = 1_000;
  readonly deadlineMs = 500;
  ticksStarted = 0;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async restart(): Promise<void> {}
  async tick(): Promise<void> {
    this.ticksStarted += 1;
    return new Promise<void>(() => {}); // never settles
  }
  health(): ServiceHealth {
    return { state: 'running', lastRunMs: 0, consecutiveFailures: 0 };
  }
}

describe('ServiceSupervisor', () => {
  it('a never-settling tick breaches its deadline and exits the process ONCE with code 70 (PHNX-4116)', async () => {
    const exit = makeExit();
    const logs: string[] = [];
    const ctx: DaemonContext = { log: (level, msg) => { logs.push(`${level} ${msg}`); } };
    const supervisor = new ServiceSupervisor({ exit: exit as unknown as (code: number) => never });
    const hanging = new HangingService(); // id 'device-probe', deadlineMs 500
    supervisor.register(hanging);

    await supervisor.startAll(ctx);
    await vi.advanceTimersByTimeAsync(0); // first immediate tick starts, then hangs
    expect(hanging.ticksStarted).toBe(1);
    expect(exit).not.toHaveBeenCalled();

    // The 500ms deadline elapses -> the supervisor exits for a supervised restart.
    await vi.advanceTimersByTimeAsync(500);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(70);

    // The ERROR log line names the service id AND the deadline it breached.
    const errorLine = logs.find((l) => l.startsWith('ERROR'));
    expect(errorLine).toBeDefined();
    expect(errorLine).toContain('device-probe');
    expect(errorLine).toContain('deadline of 500ms');

    // The injected exit does not really terminate, but every timer was frozen, so
    // no further tick fires and exit is never called a second time.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('a throwing tick is recorded and the service keeps ticking — the process never exits (PHNX-4116)', async () => {
    const exit = makeExit();
    const supervisor = new ServiceSupervisor({ exit: exit as unknown as (code: number) => never });
    const bad = new ThrowingService(); // id 'watchdog'
    const good = new HealthyService('scheduler');
    supervisor.register(bad);
    supervisor.register(good);

    await supervisor.startAll(makeCtx());
    await vi.advanceTimersByTimeAsync(0); // tick #1 throws
    await vi.advanceTimersByTimeAsync(1_000); // tick #2 throws
    await vi.advanceTimersByTimeAsync(1_000); // tick #3 throws

    const health = supervisor.health();
    // The throwing service keeps ticking on its interval — never parked, never stopped.
    expect(bad.ticks).toBe(3);
    expect(health['watchdog'].state).toBe('running');
    expect(health['watchdog'].consecutiveFailures).toBeGreaterThanOrEqual(3);
    expect(health['watchdog'].lastError).toMatch(/boom/);
    // A throw is recoverable — the process is NEVER exited for it.
    expect(exit).not.toHaveBeenCalled();
    // The healthy sibling was undisturbed throughout.
    expect(good.ticks).toBeGreaterThanOrEqual(3);
    expect(health['scheduler'].state).toBe('running');

    await supervisor.stopAll();
  });

  it('a start() that exceeds lifecycleDeadlineMs exits the process for a supervised restart (PHNX-4116)', async () => {
    // Uses REAL timers with a tiny deadline: the point is that `await startAll`
    // returns on its own once the deadline fires and the injected exit is called.
    vi.useRealTimers();
    const exit = makeExit();
    class WedgedStartService implements PeriodicService {
      readonly id: DaemonServiceId = 'account-state';
      readonly intervalMs = 1_000;
      readonly deadlineMs = 500;
      async start(): Promise<void> { return new Promise<void>(() => {}); } // never resolves
      async stop(): Promise<void> {}
      async restart(): Promise<void> {}
      async tick(): Promise<void> {}
      health(): ServiceHealth { return { state: 'running', lastRunMs: 0, consecutiveFailures: 0 }; }
    }
    const supervisor = new ServiceSupervisor({ lifecycleDeadlineMs: 20, exit: exit as unknown as (code: number) => never });
    supervisor.register(new WedgedStartService());

    await supervisor.startAll(makeCtx());
    expect(exit).toHaveBeenCalledWith(70);
  });

  it('a cooperating tick receives a real deadline-driven AbortSignal, aborted before the exit (PHNX-4116)', async () => {
    // Proves the supervisor hands a real, deadline-driven AbortSignal into
    // `tick(ctx, signal)` and aborts it when the deadline wins, before exiting.
    const exit = makeExit();
    class AbortAwareService implements PeriodicService {
      readonly id: DaemonServiceId = 'device-probe';
      readonly intervalMs = 1_000;
      readonly deadlineMs = 500;
      ticks = 0;
      aborts = 0;
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      async restart(): Promise<void> {}
      async tick(_ctx: DaemonContext, signal: AbortSignal): Promise<void> {
        this.ticks += 1;
        await new Promise<void>((resolve) => {
          if (signal.aborted) { this.aborts += 1; resolve(); return; }
          signal.addEventListener('abort', () => { this.aborts += 1; resolve(); }, { once: true });
        });
      }
      health(): ServiceHealth {
        return { state: 'running', lastRunMs: 0, consecutiveFailures: 0 };
      }
    }

    const supervisor = new ServiceSupervisor({ exit: exit as unknown as (code: number) => never });
    const svc = new AbortAwareService();
    supervisor.register(svc);
    await supervisor.startAll(makeCtx());
    await vi.advanceTimersByTimeAsync(0);
    expect(svc.ticks).toBe(1);
    expect(svc.aborts).toBe(0);

    // The deadline fires -> the tick's signal aborts -> the supervisor exits.
    await vi.advanceTimersByTimeAsync(500);
    expect(svc.aborts).toBe(1);
    expect(exit).toHaveBeenCalledWith(70);
  });

  it('health() returns a record for every registered service', async () => {
    const supervisor = new ServiceSupervisor();
    const a = new HealthyService('scheduler');
    const b = new HealthyService('monitors');
    const c = new HealthyService('self-heal');
    supervisor.register(a);
    supervisor.register(b);
    supervisor.register(c);

    await supervisor.startAll(makeCtx());
    await vi.advanceTimersByTimeAsync(0);

    const health = supervisor.health();
    expect(Object.keys(health).sort()).toEqual(['monitors', 'scheduler', 'self-heal']);
    for (const id of ['scheduler', 'monitors', 'self-heal'] as const) {
      expect(health[id].state).toBe('running');
      expect(health[id].consecutiveFailures).toBe(0);
    }
    await supervisor.stopAll();
  });

  it('registers a boot-disabled service without starting it, then enables it live', async () => {
    const supervisor = new ServiceSupervisor();
    const service = new HealthyService('browser-ipc');
    supervisor.register(service, { enabled: false });

    await supervisor.startAll(makeCtx());
    await vi.advanceTimersByTimeAsync(0);
    expect(service.started).toBe(false);
    expect(service.ticks).toBe(0);
    expect(supervisor.health()['browser-ipc'].state).toBe('stopped');

    await supervisor.start('browser-ipc');
    await vi.advanceTimersByTimeAsync(0);
    expect(service.started).toBe(true);
    expect(service.ticks).toBe(1);
    expect(supervisor.health()['browser-ipc'].state).toBe('running');

    await supervisor.stopAll();
  });

  it('stopAll() stops every started service and clears timers (no further ticks)', async () => {
    const supervisor = new ServiceSupervisor();
    const svc = new HealthyService('scheduler');
    supervisor.register(svc);
    await supervisor.startAll(makeCtx());
    await vi.advanceTimersByTimeAsync(0);
    const ticksAtStop = svc.ticks;

    await supervisor.stopAll();
    expect(svc.stopped).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(svc.ticks).toBe(ticksAtStop);
    expect(supervisor.health()['scheduler'].state).toBe('stopped');
  });

  it('registering the same service id twice throws', () => {
    const supervisor = new ServiceSupervisor();
    supervisor.register(new HealthyService('scheduler'));
    expect(() => supervisor.register(new HealthyService('scheduler'))).toThrow(/already registered/);
  });

  it('a service with startupDelayMs defers its FIRST tick, then ticks on the normal interval — a service with no delay still ticks immediately (RUSH-3193 #17)', async () => {
    const supervisor = new ServiceSupervisor();
    const delayed = new HealthyService('self-heal', 30_000);
    const immediate = new HealthyService('scheduler');
    supervisor.register(delayed);
    supervisor.register(immediate);

    await supervisor.startAll(makeCtx());
    await vi.advanceTimersByTimeAsync(0);
    // Undelayed sibling still fires immediately at boot — startupDelayMs is opt-in per service.
    expect(immediate.ticks).toBe(1);
    // Delayed service must not have ticked yet.
    expect(delayed.ticks).toBe(0);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(delayed.ticks).toBe(0);

    await vi.advanceTimersByTimeAsync(1); // t=30_000: the staggered first tick fires
    expect(delayed.ticks).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000); // its normal 1s interval cadence resumes from here
    expect(delayed.ticks).toBe(2);

    await supervisor.stopAll();
  });

  it('stopAll() before the startup delay elapses cancels the pending first tick', async () => {
    const supervisor = new ServiceSupervisor();
    const delayed = new HealthyService('self-heal', 30_000);
    supervisor.register(delayed);

    await supervisor.startAll(makeCtx());
    await vi.advanceTimersByTimeAsync(0);
    expect(delayed.ticks).toBe(0);

    await supervisor.stopAll();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(delayed.ticks).toBe(0);
  });

  it('restartOne() stops then starts a service in place, with no parked intermediate (PHNX-4116)', async () => {
    const supervisor = new ServiceSupervisor();
    const svc = new HealthyService('session-index');
    supervisor.register(svc);
    await supervisor.startAll(makeCtx());
    await vi.advanceTimersByTimeAsync(0);
    expect(svc.ticks).toBe(1);
    expect(svc.started).toBe(true);

    await supervisor.restartOne('session-index');
    // restartOne is a plain stop + start — the service's stop() ran, and it is
    // immediately running again (never a 'parked' or 'stopped' resting state).
    expect(svc.stopped).toBe(true);
    expect(supervisor.health()['session-index'].state).toBe('running');

    await vi.advanceTimersByTimeAsync(0);
    expect(svc.ticks).toBe(2); // one immediate post-restart tick
  });

  it('restartOne() replaces a periodic timer instead of multiplying its tick rate', async () => {
    const supervisor = new ServiceSupervisor();
    const svc = new HealthyService('session-index');
    supervisor.register(svc);
    await supervisor.startAll(makeCtx());
    await vi.advanceTimersByTimeAsync(0);
    expect(svc.ticks).toBe(1);

    await supervisor.restartOne('session-index');
    await vi.advanceTimersByTimeAsync(0);
    expect(svc.ticks).toBe(2); // one immediate post-restart tick

    await vi.advanceTimersByTimeAsync(1_000);
    expect(svc.ticks).toBe(3); // exactly one recurring timer remains
    await vi.advanceTimersByTimeAsync(1_000);
    expect(svc.ticks).toBe(4);

    await supervisor.stopAll();
  });

  // RUSH-3193 P3 migrated watchdog, device-probe, self-heal, and state-dir-check
  // onto the supervisor. The throw/hang mechanics above already exercise
  // 'watchdog' (ThrowingService) and 'device-probe' (HangingService) by id; this
  // closes the same two guarantees explicitly for every id P3 migrated, proving
  // the mechanism the concrete `*-service.ts` wrappers rely on is id-agnostic.
  describe('RUSH-3193 P3 migrated ids: throw keeps ticking, hang exits (PHNX-4116)', () => {
    const P3_IDS: DaemonServiceId[] = ['watchdog', 'device-probe', 'self-heal', 'state-dir-check'];

    it.each(P3_IDS)('%s: a throwing tick keeps ticking without exiting or crashing a healthy sibling', async (id) => {
      const exit = makeExit();
      const supervisor = new ServiceSupervisor({ exit: exit as unknown as (code: number) => never });
      class NamedThrowingService extends ThrowingService {
        readonly id = id;
      }
      const bad = new NamedThrowingService();
      const good = new HealthyService('scheduler');
      supervisor.register(bad);
      supervisor.register(good);

      await supervisor.startAll(makeCtx());
      await vi.advanceTimersByTimeAsync(0); // tick #1
      await vi.advanceTimersByTimeAsync(1_000); // tick #2
      await vi.advanceTimersByTimeAsync(1_000); // tick #3

      const health = supervisor.health();
      expect(health[id].state).toBe('running');
      expect(health[id].consecutiveFailures).toBeGreaterThanOrEqual(3);
      expect(health['scheduler'].state).toBe('running');
      expect(good.ticks).toBeGreaterThanOrEqual(3);
      expect(exit).not.toHaveBeenCalled();

      await supervisor.stopAll();
    });

    it.each(P3_IDS)('%s: a hanging tick breaches its deadline and exits the process (PHNX-4116)', async (id) => {
      const exit = makeExit();
      const supervisor = new ServiceSupervisor({ exit: exit as unknown as (code: number) => never });
      class NamedHangingService extends HangingService {
        readonly id = id;
      }
      const hanging = new NamedHangingService();
      const good = new HealthyService('scheduler');
      supervisor.register(hanging);
      supervisor.register(good);

      await supervisor.startAll(makeCtx());
      await vi.advanceTimersByTimeAsync(0); // first immediate tick starts, then hangs
      expect(hanging.ticksStarted).toBe(1);

      await vi.advanceTimersByTimeAsync(500); // past the 500ms deadline
      expect(exit).toHaveBeenCalledWith(70);
      expect(supervisor.health()[id].lastError).toMatch(/deadline/);

      await supervisor.stopAll();
    });
  });

  // Review finding on PR #3037: recordSubsystemOk/Error (daemon-health.ts) are
  // called from inside runTick's own catch block. Before the fix, a health-file
  // write failure there (disk full, permission, or — as simulated here — the
  // state dir replaced with an unwritable path mid-run) would throw OUT of that
  // catch with no further handler, becoming an unhandled rejection that takes the
  // whole daemon down — reproducing exactly the failure mode this supervisor
  // exists to prevent.
  it('a health-ledger write failure never escapes runTick — the daemon and every sibling survive', async () => {
    // Point AGENTS_DAEMON_DIR at a FILE instead of a directory, so daemon-health's
    // mkdirSync/writeFileSync both fail on every recordSubsystemOk/Error call.
    fs.rmSync(testDaemonDir, { recursive: true, force: true });
    fs.writeFileSync(testDaemonDir, 'not a directory', 'utf-8');

    const exit = makeExit();
    const supervisor = new ServiceSupervisor({ exit: exit as unknown as (code: number) => never });
    const bad = new ThrowingService();
    const healthy = new HealthyService('scheduler');
    supervisor.register(bad);
    supervisor.register(healthy);

    await supervisor.startAll(makeCtx());
    await vi.advanceTimersByTimeAsync(3_000);

    // The failing service still tracks its own failures correctly...
    expect(bad.ticks).toBeGreaterThan(0);
    expect(supervisor.health()['watchdog'].consecutiveFailures).toBeGreaterThan(0);
    // ...and the healthy sibling was never touched by the other service's
    // health-write failures — this is the actual regression: an escaped throw
    // there would have killed the process before this line ever ran. A throwing
    // tick is recoverable, so the process is never exited for it either.
    expect(healthy.ticks).toBeGreaterThan(0);
    expect(supervisor.health()['scheduler'].state).toBe('running');
    expect(exit).not.toHaveBeenCalled();

    fs.rmSync(testDaemonDir, { force: true });
  });
});
