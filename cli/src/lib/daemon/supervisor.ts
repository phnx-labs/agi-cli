/**
 * ServiceSupervisor (RUSH-3193 P1).
 *
 * Owns the timer for every registered `PeriodicService`, replacing the bare
 * `setInterval` closures in `runDaemon()`. Two failure modes motivated it,
 * both observed in production:
 *
 *  - A throw escaping a tick's local try/catch used to hit the process-wide
 *    `uncaughtException` handler and `process.exit(1)` the whole daemon,
 *    taking every OTHER service down with it. Here, a tick failure is caught
 *    per-service and never propagates past `runTick`.
 *  - A tick that hangs on an unbounded await (SSH, keychain) used to latch its
 *    local in-flight guard `true` forever, silently freezing that one service
 *    for the daemon's life (observed ~51h). Here, every tick races a
 *    `deadlineMs` timeout; when the deadline wins, the service is ABANDONED
 *    (PHNX-3608): its `AbortSignal` is aborted so a cooperating tick can unwind
 *    its own I/O, the in-flight guard is released immediately, and the backoff
 *    restart is scheduled right away — it is NOT gated on the runaway promise
 *    settling. An earlier revision kept the guard held until the real promise
 *    settled, which meant a tick that never settles parked the service forever
 *    and blocked backoff restart, `daemon services restart`, and SIGHUP reload —
 *    the exact 12h-usage-dark class this exists to prevent. The orphaned promise
 *    is drained separately in the background; `finishTick` is version-guarded so
 *    its late settlement can never disturb the fresh tick the restart started.
 *
 * Repeated failures (thrown or timed-out) open a circuit breaker: the service
 * is parked (its timer stopped) and retried on exponential backoff via its own
 * `restart()`, while every sibling service keeps ticking on its own timer,
 * unaffected. `start()`/`stop()`/`restart()` are themselves bounded by
 * {@link ServiceSupervisorOptions.lifecycleDeadlineMs} so a wedged bind or close
 * cannot stall daemon startup or shutdown.
 */

import { recordSubsystemOk, recordSubsystemError, recordSubsystemState } from '../daemon-health.js';
import type { DaemonServiceId } from '../daemon-services.js';
import type { DaemonContext, DaemonService, PeriodicService, ServiceHealth, ServiceState } from './service.js';
import { isPeriodicService } from './service.js';

interface ServiceSupervisorOptions {
  /** Consecutive thrown tick failures before a service is parked. Deadline breaches park immediately. Default 3. */
  parkAfterFailures?: number;
  /** First restart backoff delay, doubled on each further failed restart attempt. Default 5s. */
  backoffBaseMs?: number;
  /** Backoff ceiling. Default 5 minutes. */
  backoffMaxMs?: number;
  /**
   * Hard cap on a service's `start()`/`stop()`/`restart()` call (PHNX-3608). A
   * wedged bind/close would otherwise stall `startAll()` (which awaits each
   * `startOne` in turn) or `stopAll()` at shutdown. A start/restart that
   * breaches it is treated as a failure (parked + backoff); a stop that breaches
   * it is logged and the service is left marked stopped. Default 30s.
   */
  lifecycleDeadlineMs?: number;
}

interface RegisteredService {
  service: DaemonService;
  state: ServiceState;
  lastRunMs: number;
  lastError?: string;
  consecutiveFailures: number;
  restartAttempts: number;
  inFlight: boolean;
  activeTick?: Promise<void>;
  /** Aborts the in-flight tick at its deadline (or when the service is stopped). */
  activeController?: AbortController;
  /**
   * Resolvers for `awaitIdle()` callers waiting on the current tick. Resolved by
   * `clearInFlight()` — the SAME place that flips `inFlight` to false — so a
   * waiter never observes `inFlight === true` after `awaitIdle()` resolves
   * (PHNX-3608: the SIGHUP live-disable race — awaiting the tick promise directly
   * could resume the waiter's `.then(stop)` on a shorter microtask chain than
   * `finishTick`, so `stop()` saw a still-in-flight tick and threw).
   */
  idleWaiters: Array<() => void>;
  /** True once `start()` has completed without throwing — guards `stop()` from being called on a service that never successfully started. */
  everStarted: boolean;
  timer?: ReturnType<typeof setInterval>;
  restartTimer?: ReturnType<typeof setTimeout>;
  startupTimer?: ReturnType<typeof setTimeout>;
}

interface RegisterServiceOptions {
  /** Register the lifecycle owner but leave it stopped until a live enable. */
  enabled?: boolean;
}

const DEFAULT_PARK_AFTER_FAILURES = 3;
const DEFAULT_BACKOFF_BASE_MS = 5_000;
const DEFAULT_BACKOFF_MAX_MS = 5 * 60_000;
const DEFAULT_LIFECYCLE_DEADLINE_MS = 30_000;

export class ServiceSupervisor {
  private readonly registry = new Map<DaemonServiceId, RegisteredService>();
  private ctx: DaemonContext | null = null;
  private readonly parkAfterFailures: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly lifecycleDeadlineMs: number;

  constructor(opts: ServiceSupervisorOptions = {}) {
    this.parkAfterFailures = opts.parkAfterFailures ?? DEFAULT_PARK_AFTER_FAILURES;
    this.backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.backoffMaxMs = opts.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    this.lifecycleDeadlineMs = opts.lifecycleDeadlineMs ?? DEFAULT_LIFECYCLE_DEADLINE_MS;
  }

  /**
   * Race `op` against a deadline. On breach the returned promise rejects with a
   * labelled error while the real `op` is left to settle in the background —
   * used to bound the lifecycle calls (`start`/`stop`/`restart`) so a wedged one
   * cannot stall startup or shutdown. `Promise.race` cannot cancel `op`; the
   * caller decides what a breach means for that service.
   */
  private async withDeadline<T>(op: () => Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded deadline of ${ms}ms`)), ms);
    });
    try {
      return await Promise.race([op(), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Register a service. Must be called before `startAll()`.
   *
   * Accepts both `PeriodicService` (ticked on a fixed interval) and
   * lifecycle-only `DaemonService` (started once, stopped at shutdown). The
   * supervisor uses `isPeriodicService()` to decide whether to schedule a timer
   * for each registered entry.
   */
  register(service: DaemonService, options: RegisterServiceOptions = {}): void {
    if (this.registry.has(service.id)) throw new Error(`service '${service.id}' is already registered`);
    this.registry.set(service.id, {
      service,
      state: options.enabled === false ? 'stopped' : 'idle',
      lastRunMs: 0,
      consecutiveFailures: 0,
      restartAttempts: 0,
      inFlight: false,
      everStarted: false,
      idleWaiters: [],
    });
  }

  /**
   * Flip a tick's in-flight guard off and release every `awaitIdle()` waiter in
   * the same synchronous step, so no waiter's continuation can run while
   * `inFlight` is still true (PHNX-3608).
   */
  private clearInFlight(entry: RegisteredService): void {
    entry.inFlight = false;
    const waiters = entry.idleWaiters;
    entry.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /** Start every registered service and begin ticking each on its own timer. */
  async startAll(ctx: DaemonContext): Promise<void> {
    this.ctx = ctx;
    for (const [id, entry] of this.registry) {
      if (entry.state === 'stopped') continue;
      await this.startOne(id);
    }
  }

  /** Stop every registered service and clear all timers. */
  async stopAll(): Promise<void> {
    for (const id of this.registry.keys()) await this.stopOne(id, true);
  }

  /** Force one service to restart right now, outside its normal backoff schedule. Drives `agents daemon services restart <id>` (RUSH-3193 P4). */
  async restartOne(id: DaemonServiceId): Promise<void> {
    const entry = this.registry.get(id);
    if (!entry) throw new Error(`service '${id}' is not registered`);
    if (entry.inFlight) {
      throw new Error(`service '${id}' cannot restart while a tick is still in flight`);
    }
    // A live periodic service already owns an interval. attemptRestart() installs
    // a fresh one after restart, so leaving the existing handles alive would
    // multiply the tick rate on every operator-requested restart.
    if (entry.timer) {
      clearInterval(entry.timer);
      entry.timer = undefined;
    }
    if (entry.startupTimer) {
      clearTimeout(entry.startupTimer);
      entry.startupTimer = undefined;
    }
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = undefined;
    }
    // Block a timer callback already queued in this event-loop turn while the
    // service tears down and starts again.
    entry.state = 'parked';
    recordSubsystemState(id, 'parked');
    await this.attemptRestart(id);
  }

  /** Whether `id` has a lifecycle owner on this supervisor, running or stopped. */
  isRegistered(id: DaemonServiceId): boolean {
    return this.registry.has(id);
  }

  /** Every currently registered service id. */
  registeredIds(): DaemonServiceId[] {
    return Array.from(this.registry.keys());
  }

  /**
   * Resolve when the service's current tick has really settled. Daemon control
   * edges use this to queue a requested live transition without polling or
   * treating a deadline race as cancellation.
   */
  async awaitIdle(id: DaemonServiceId): Promise<void> {
    const entry = this.registry.get(id);
    if (!entry) throw new Error(`service '${id}' is not registered`);
    // Resolve from clearInFlight (which also flips `inFlight` false) rather than
    // from the tick promise directly: awaiting the tick promise resumed this
    // caller on a shorter microtask chain than the tick's own finally→finishTick,
    // so a queued `.then(stop)` could run before `inFlight` was cleared and
    // `stop()` would throw "cannot stop while a tick is still in flight"
    // (PHNX-3608 — the SIGHUP live-disable regression). Waiting on the guard
    // itself makes the ordering deterministic.
    if (!entry.inFlight) return;
    await new Promise<void>((resolve) => { entry.idleWaiters.push(resolve); });
  }

  /**
   * Start one registered service live — drives `agents daemon services enable
   * <id>` (RUSH-3193 P4). Only affects a service already registered on this
   * supervisor. Callers that need live enable from a boot-disabled state must
   * register the service with `{ enabled: false }`, which gives the supervisor
   * ownership without running its startup side effects.
   */
  async start(id: DaemonServiceId): Promise<void> {
    const entry = this.registry.get(id);
    if (!entry) throw new Error(`service '${id}' is not registered`);
    if (entry.state === 'running') return;
    if (entry.inFlight) {
      throw new Error(`service '${id}' cannot start while a tick is still in flight`);
    }
    await this.startOne(id);
  }

  /** Stop one registered service live — drives `agents daemon services disable <id>` (RUSH-3193 P4). */
  async stop(id: DaemonServiceId): Promise<void> {
    const entry = this.registry.get(id);
    if (!entry) throw new Error(`service '${id}' is not registered`);
    if (entry.state === 'stopped') return;
    await this.stopOne(id, false);
  }

  /** Request an immediate supervised tick, used by event edges that cannot wait for the regular cadence. */
  runNow(id: DaemonServiceId): void {
    if (!this.registry.has(id)) throw new Error(`service '${id}' is not registered`);
    void this.runTick(id);
  }

  /** Health for every registered service, keyed by service id. */
  health(): Record<string, ServiceHealth> {
    const out: Record<string, ServiceHealth> = {};
    for (const [id, entry] of this.registry) {
      out[id] = {
        state: entry.state,
        lastRunMs: entry.lastRunMs,
        lastError: entry.lastError,
        consecutiveFailures: entry.consecutiveFailures,
      };
    }
    return out;
  }

  private async startOne(id: DaemonServiceId): Promise<void> {
    const entry = this.registry.get(id);
    const ctx = this.ctx;
    if (!entry || !ctx) return;
    try {
      await this.withDeadline(() => entry.service.start(ctx), this.lifecycleDeadlineMs, `service '${id}' start`);
    } catch (err) {
      // A thrown OR wedged start() parks the service and retries on backoff,
      // rather than propagating out of startAll() and stalling the boot of
      // every service after it (PHNX-3608).
      this.recordFailure(entry, id, err);
      this.park(id);
      return;
    }
    entry.everStarted = true;
    entry.state = 'running';
    recordSubsystemState(id, 'running');
    if (isPeriodicService(entry.service)) {
      const startupDelayMs = entry.service.startupDelayMs ?? 0;
      if (startupDelayMs > 0) {
        // Defer BOTH the first tick and the recurring interval's start until the
        // delay elapses — starting the interval at t=0 would fire its own ticks
        // on top of the staggered one instead of after it.
        entry.startupTimer = setTimeout(() => {
          entry.startupTimer = undefined;
          this.scheduleTimer(id);
          void this.runTick(id);
        }, startupDelayMs);
      } else {
        this.scheduleTimer(id);
        void this.runTick(id);
      }
    } else {
      // Lifecycle-only service: record health once on successful start (no ticks).
      entry.lastRunMs = Date.now();
      recordSubsystemOk(id);
    }
  }

  private async stopOne(id: DaemonServiceId, force: boolean): Promise<void> {
    const entry = this.registry.get(id);
    if (!entry) return;
    if (entry.inFlight && !force) {
      throw new Error(`service '${id}' cannot stop while a tick is still in flight`);
    }
    if (entry.timer) {
      clearInterval(entry.timer);
      entry.timer = undefined;
    }
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = undefined;
    }
    if (entry.startupTimer) {
      clearTimeout(entry.startupTimer);
      entry.startupTimer = undefined;
    }
    entry.state = 'stopped';
    recordSubsystemState(id, 'stopped');
    // Signal any in-flight tick to unwind — a cooperating tick threads this into
    // its I/O and returns promptly at shutdown instead of blocking on it.
    entry.activeController?.abort();
    // Whole-daemon shutdown must not hang forever on an unresolved tick, but it
    // also must not tear down resources the tick may still be using. Stop its
    // timers and mark it stopped; process exit owns final cleanup in this case.
    if (entry.inFlight && force) {
      // Release any awaitIdle waiter — the service is stopping, so no one should
      // keep waiting on a tick that will now be abandoned at process exit.
      const waiters = entry.idleWaiters;
      entry.idleWaiters = [];
      for (const resolve of waiters) resolve();
      return;
    }
    if (!entry.everStarted) return; // start() never succeeded — nothing to stop.
    try {
      // A wedged stop() must not stall stopAll() at shutdown (PHNX-3608).
      await this.withDeadline(() => entry.service.stop(), this.lifecycleDeadlineMs, `service '${id}' stop`);
    } catch (err) {
      this.ctx?.log('WARN', `service '${id}' stop failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private scheduleTimer(id: DaemonServiceId): void {
    const entry = this.registry.get(id);
    if (!entry || !isPeriodicService(entry.service)) return;
    entry.timer = setInterval(() => { void this.runTick(id); }, entry.service.intervalMs);
  }

  /**
   * Run one tick under a hard deadline (PHNX-3608). The tick receives an
   * `AbortSignal` that is aborted when the deadline elapses, so a cooperating
   * tick can bound its own I/O and unwind. The deadline itself is still enforced
   * with `Promise.race` — JS cannot forcibly cancel an arbitrary await — but on
   * a breach the service is ABANDONED, not parked-and-held: the in-flight guard
   * is released immediately and the backoff restart is scheduled right away
   * (via `park()`), so a tick that never settles can no longer wedge backoff,
   * `daemon services restart`, or SIGHUP reload. The runaway promise drains in
   * the background; `finishTick` is version-guarded on `activeTick`, so its late
   * settlement can never disturb the fresh tick a restart has since started.
   */
  private async runTick(id: DaemonServiceId): Promise<void> {
    const entry = this.registry.get(id);
    const ctx = this.ctx;
    if (!entry || !ctx || entry.state !== 'running' || entry.inFlight) return;
    // runTick is only called for periodic services (from scheduleTimer and startOne).
    // The isPeriodicService guard here keeps TypeScript narrowing correct.
    if (!isPeriodicService(entry.service)) return;
    const periodicService = entry.service;
    entry.inFlight = true;
    const controller = new AbortController();
    entry.activeController = controller;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const tickPromise = periodicService.tick(ctx, controller.signal);
    entry.activeTick = tickPromise;
    try {
      const deadline = new Promise<never>((_, reject) => {
        deadlineTimer = setTimeout(
          () => {
            timedOut = true;
            reject(new Error(`tick exceeded deadline of ${periodicService.deadlineMs}ms`));
          },
          periodicService.deadlineMs,
        );
      });
      await Promise.race([tickPromise, deadline]);
      entry.consecutiveFailures = 0;
      entry.lastError = undefined;
      entry.lastRunMs = Date.now();
      recordSubsystemOk(id);
    } catch (err) {
      this.recordFailure(entry, id, err);
      if (timedOut || entry.consecutiveFailures >= this.parkAfterFailures) this.park(id);
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (timedOut) {
        // Abandon the runaway tick: abort its signal so a cooperating tick can
        // unwind, then release the in-flight guard NOW so the backoff restart
        // park() scheduled is not blocked on a promise that may never settle.
        // The real promise is drained separately and its result discarded — the
        // version-guarded finishTick keeps that late settlement from touching a
        // restart's fresh tick.
        controller.abort();
        entry.activeTick = undefined;
        entry.activeController = undefined;
        this.clearInFlight(entry);
        // Re-read the entry so its `state` is the full union, not the `'running'`
        // narrowing from this function's entry-guard — park() set it to 'parked'.
        const current = this.registry.get(id);
        if (current && current.state === 'parked' && !current.restartTimer) this.scheduleRestart(id);
        void tickPromise.then(
          () => undefined,
          () => undefined,
        );
      } else {
        this.finishTick(id, tickPromise);
      }
    }
  }

  private park(id: DaemonServiceId): void {
    const entry = this.registry.get(id);
    if (!entry || entry.state === 'parked' || entry.state === 'stopped') return;
    entry.state = 'parked';
    recordSubsystemState(id, 'parked');
    if (entry.timer) {
      clearInterval(entry.timer);
      entry.timer = undefined;
    }
    this.ctx?.log('WARN', `service '${id}' parked after ${entry.consecutiveFailures} consecutive failure(s)`);
    if (!entry.inFlight) this.scheduleRestart(id);
  }

  private scheduleRestart(id: DaemonServiceId): void {
    const entry = this.registry.get(id);
    if (!entry) return;
    const delay = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** entry.restartAttempts);
    entry.restartAttempts += 1;
    // Drop the handle as the timer fires: park() and finishTick() treat a set
    // `restartTimer` as "a restart is already pending", so a handle left over
    // from a restart that already ran would make every LATER park permanent
    // (PHNX-4116 — heartbeat and usage-sync parked for days after one recovery).
    entry.restartTimer = setTimeout(() => {
      entry.restartTimer = undefined;
      void this.attemptRestart(id);
    }, delay);
  }

  private async attemptRestart(id: DaemonServiceId): Promise<void> {
    const entry = this.registry.get(id);
    const ctx = this.ctx;
    if (!entry || !ctx || entry.state === 'stopped') return;
    try {
      // A wedged restart() must not silently stall the circuit breaker — bound
      // it and treat a breach as another failed restart, retried on backoff.
      await this.withDeadline(() => entry.service.restart(), this.lifecycleDeadlineMs, `service '${id}' restart`);
      entry.everStarted = true; // restart() is stop()+start() on the service — a successful one means it is running again and owes a stop() at shutdown.
      entry.state = 'running';
      recordSubsystemState(id, 'running');
      entry.consecutiveFailures = 0;
      entry.restartAttempts = 0;
      entry.lastError = undefined;
      if (isPeriodicService(entry.service)) {
        this.scheduleTimer(id);
        void this.runTick(id);
      } else {
        entry.lastRunMs = Date.now();
      }
      recordSubsystemOk(id);
      ctx.log('INFO', `service '${id}' restarted`);
    } catch (err) {
      this.recordFailure(entry, id, err);
      entry.state = 'parked';
      recordSubsystemState(id, 'parked');
      this.scheduleRestart(id);
    }
  }

  private recordFailure(entry: RegisteredService, id: DaemonServiceId, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    entry.consecutiveFailures += 1;
    entry.lastError = message;
    recordSubsystemError(id, message);
    this.ctx?.log('WARN', `service '${id}' failed: ${message}`);
  }

  private finishTick(id: DaemonServiceId, tickPromise: Promise<void>): void {
    const entry = this.registry.get(id);
    if (!entry || entry.activeTick !== tickPromise) return;
    entry.activeTick = undefined;
    entry.activeController = undefined;
    this.clearInFlight(entry);
    if (entry.state === 'parked' && !entry.restartTimer) this.scheduleRestart(id);
  }
}
