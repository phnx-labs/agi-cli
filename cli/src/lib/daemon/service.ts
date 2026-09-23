/**
 * DaemonService contract (RUSH-3193 P1).
 *
 * Historically the daemon's background services were bare `setInterval` closures
 * inside one long `runDaemon()` (daemon.ts), sharing one event loop with no
 * per-service error boundary or deadline. A throw escaping a tick's local
 * try/catch hits the process-wide handler and kills every service; a tick that
 * hangs on an unbounded await latches its in-flight guard `true` forever and
 * silently freezes that service for the daemon's life.
 *
 * This module defines the service shape a `ServiceSupervisor` (supervisor.ts)
 * drives instead: one contract per service, owned timer, per-tick deadline,
 * and a health record the supervisor can report without the service having to
 * know it is being supervised.
 */

import type { DaemonServiceId } from '../daemon-services.js';

/**
 * Lifecycle state a supervised service can be in. There is no `parked` state:
 * a throw keeps the service `running` (it retries on the next tick) and a
 * deadline breach exits the whole daemon for a supervised OS restart (PHNX-4116).
 */
export type ServiceState = 'idle' | 'running' | 'stopped';

/** A service's most recently observed health, as reported by the supervisor. */
export interface ServiceHealth {
  state: ServiceState;
  /** `Date.now()` of the last tick that completed without throwing or timing out. */
  lastRunMs: number;
  lastError?: string;
  /** Consecutive failed/timed-out ticks since the last success. */
  consecutiveFailures: number;
}

/** Shared context every service receives at start/tick time. */
export interface DaemonContext {
  log: (level: string, message: string) => void;
}

/** Base contract every supervised daemon service implements. */
export interface DaemonService {
  readonly id: DaemonServiceId;
  start(ctx: DaemonContext): Promise<void>;
  stop(): Promise<void>;
  /** `stop()` then `start()` — used by the supervisor's circuit-breaker (and, in future, an on-demand `daemon services restart <id>` command — not wired up yet). */
  restart(): Promise<void>;
  health(): ServiceHealth;
}

/** A service the supervisor ticks on a fixed interval, under a hard per-tick deadline. */
export interface PeriodicService extends DaemonService {
  readonly intervalMs: number;
  /**
   * Hard cap per tick. An over-budget tick is a HANG that cannot be retried
   * in-process (its promise may never settle), so the supervisor aborts the
   * tick's {@link AbortSignal} and EXITS the daemon (code 70) for a supervised
   * systemd/launchd restart (PHNX-4116) — there is no park or in-process backoff.
   * A tick that awaits `signal` (or forwards it to its I/O) can observe the
   * deadline and unwind cleanly before the process exits.
   */
  readonly deadlineMs: number;
  /**
   * Delay before the FIRST tick after `start()`, in ms. Every later tick
   * still fires on the normal `intervalMs` cadence — this only staggers the
   * boot-time tick. Default (omitted) is 0, the supervisor's baseline
   * immediate-first-tick behavior. Set this when a service's first-boot work
   * needs something else (shims, PATH) to settle before it runs, rather than
   * firing at daemon startup.
   */
  readonly startupDelayMs?: number;
  /**
   * Run one tick. `signal` aborts when the supervisor's {@link deadlineMs}
   * elapses (or the service is being stopped), so a well-behaved tick threads it
   * into its awaits — `fetch(url, { signal })`, an ssh/exec spawn, a
   * cancellable sleep — to bound its own I/O instead of leaking a runaway await.
   */
  tick(ctx: DaemonContext, signal: AbortSignal): Promise<void>;
}

export function isPeriodicService(service: DaemonService): service is PeriodicService {
  const candidate = service as Partial<PeriodicService>;
  return typeof candidate.tick === 'function' && typeof candidate.intervalMs === 'number' && typeof candidate.deadlineMs === 'number';
}

function blankHealth(): ServiceHealth {
  return { state: 'idle', lastRunMs: 0, consecutiveFailures: 0 };
}

/**
 * Convenience base for a lifecycle-only (non-periodic) daemon service.
 *
 * Concrete subclasses implement `onStart` and `onStop`; the base owns the
 * `ServiceHealth` record and the `restart()` default (`stop` + `start`).
 * Unlike `BasePeriodicService` there is no tick — the supervisor just calls
 * `start()` once at boot, keeps the service marked `running`, and calls
 * `stop()` at shutdown.
 *
 * `lastRunMs` is set to the time `start()` completed, so `supervisor.health()`
 * carries a meaningful "last known healthy" timestamp even with no periodic ticks.
 */
export abstract class BaseDaemonService implements DaemonService {
  abstract readonly id: DaemonServiceId;

  protected ctx: DaemonContext | null = null;
  private healthRecord: ServiceHealth = blankHealth();

  protected abstract onStart(ctx: DaemonContext): Promise<void>;
  protected abstract onStop(): Promise<void>;

  async start(ctx: DaemonContext): Promise<void> {
    this.ctx = ctx;
    await this.onStart(ctx);
    this.healthRecord = { ...this.healthRecord, state: 'running', lastRunMs: Date.now() };
  }

  async stop(): Promise<void> {
    await this.onStop();
    this.healthRecord = { ...this.healthRecord, state: 'stopped' };
  }

  async restart(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) throw new Error(`service '${this.id}' cannot restart before it has started once`);
    await this.stop();
    await this.start(ctx);
  }

  health(): ServiceHealth {
    return { ...this.healthRecord };
  }
}

/**
 * Convenience base for a periodic service: owns the `ServiceHealth` record so
 * concrete services only implement the three lifecycle hooks. `restart()`
 * defaults to `stop()` then `start()` against the last context passed to
 * `start()`, which is what every current-generation service needs — a
 * concrete service overrides it only if it must reuse state across a restart.
 */
export abstract class BasePeriodicService implements PeriodicService {
  abstract readonly id: DaemonServiceId;
  abstract readonly intervalMs: number;
  abstract readonly deadlineMs: number;

  protected ctx: DaemonContext | null = null;
  private healthRecord: ServiceHealth = blankHealth();

  protected abstract onStart(ctx: DaemonContext): Promise<void>;
  protected abstract onStop(): Promise<void>;
  /**
   * Run one tick. `signal` aborts at the supervisor's deadline (or on stop);
   * thread it into the tick's own awaits to bound its I/O. A subclass that does
   * no cancellable work may implement `onTick(ctx)` and ignore the second arg.
   */
  protected abstract onTick(ctx: DaemonContext, signal: AbortSignal): Promise<void>;

  async start(ctx: DaemonContext): Promise<void> {
    this.ctx = ctx;
    await this.onStart(ctx);
    this.healthRecord = { ...this.healthRecord, state: 'running' };
  }

  async stop(): Promise<void> {
    await this.onStop();
    this.healthRecord = { ...this.healthRecord, state: 'stopped' };
  }

  async restart(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) throw new Error(`service '${this.id}' cannot restart before it has started once`);
    await this.stop();
    await this.start(ctx);
  }

  async tick(ctx: DaemonContext, signal: AbortSignal): Promise<void> {
    try {
      await this.onTick(ctx, signal);
      this.healthRecord = { ...this.healthRecord, lastRunMs: Date.now(), consecutiveFailures: 0, lastError: undefined };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.healthRecord = { ...this.healthRecord, lastError: message, consecutiveFailures: this.healthRecord.consecutiveFailures + 1 };
      throw err;
    }
  }

  health(): ServiceHealth {
    return { ...this.healthRecord };
  }
}
