/** DaemonService contract (RUSH-3193 P1). Services were bare `setInterval` closures sharing one
 * event loop with no error boundary or deadline: a throw escaping a tick killed every service, and
 * a hung tick froze its service. `ServiceSupervisor` drives this contract instead. */

import type { DaemonServiceId } from '../daemon-services.js';

/** Lifecycle state of a supervised service. There is no `parked` state: a throw keeps it `running`
 * (retry next tick); a deadline breach exits the daemon for an OS restart (PHNX-4116). */
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
  /** Hard cap per tick. An over-budget tick is a hang that cannot be retried in-process, so the
   * supervisor aborts its AbortSignal and exits the daemon (code 70) for a supervised restart
   * (PHNX-4116). A tick that awaits `signal` can unwind cleanly first. */
  readonly deadlineMs: number;
  /** Delay in ms before the first tick after `start()`; later ticks use `intervalMs`. Default 0
   * (immediate). Set it when first-boot work needs something else (shims, PATH) to settle. */
  readonly startupDelayMs?: number;
  /** Run one tick. `signal` aborts at the supervisor's deadlineMs or on stop; thread it into awaits
   * (`fetch`, ssh/exec, sleeps) so I/O is bounded. */
  tick(ctx: DaemonContext, signal: AbortSignal): Promise<void>;
}

export function isPeriodicService(service: DaemonService): service is PeriodicService {
  const candidate = service as Partial<PeriodicService>;
  return typeof candidate.tick === 'function' && typeof candidate.intervalMs === 'number' && typeof candidate.deadlineMs === 'number';
}

function blankHealth(): ServiceHealth {
  return { state: 'idle', lastRunMs: 0, consecutiveFailures: 0 };
}

/** Base for a lifecycle-only (non-periodic) daemon service: subclasses implement `onStart` and
 * `onStop`; the base owns `ServiceHealth` and a `restart()` default (stop + start). The supervisor
 * calls `start()` once and `stop()` at shutdown. */
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

/** Base for a periodic service: owns the `ServiceHealth` record so subclasses implement only the
 * lifecycle hooks. `restart()` defaults to `stop()` then `start()` with the last context; override
 * only to reuse state across a restart. */
export abstract class BasePeriodicService implements PeriodicService {
  abstract readonly id: DaemonServiceId;
  abstract readonly intervalMs: number;
  abstract readonly deadlineMs: number;

  protected ctx: DaemonContext | null = null;
  private healthRecord: ServiceHealth = blankHealth();

  protected abstract onStart(ctx: DaemonContext): Promise<void>;
  protected abstract onStop(): Promise<void>;
  /** Run one tick. `signal` aborts at the supervisor's deadline or on stop; thread it into awaits.
   * A subclass without cancellable work may ignore it. */
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
