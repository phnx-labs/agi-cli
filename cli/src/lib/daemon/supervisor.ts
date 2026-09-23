/**
 * ServiceSupervisor (RUSH-3193 P1, PHNX-4116).
 *
 * Owns the timer for every registered `PeriodicService`, replacing the bare
 * `setInterval` closures in `runDaemon()`. Two failure modes motivated it, both
 * observed in production, and each is now handled without ever leaving a service
 * silently dark:
 *
 *  - A throw escaping a tick's local try/catch used to hit the process-wide
 *    `uncaughtException` handler and `process.exit(1)` the whole daemon, taking
 *    every OTHER service down with it. Here a thrown tick is caught per-service,
 *    recorded via `recordFailure`, and the service keeps ticking on its own
 *    interval — a throw is recoverable, so it is retried in place on the next
 *    tick and no sibling is disturbed.
 *  - A tick that HANGS on an unbounded await (SSH, keychain) used to latch its
 *    in-flight guard `true` forever, silently freezing that one service for the
 *    daemon's life (observed ~51h). A hang cannot be retried in-process — the
 *    promise may never settle — so when a tick (or a `start()`/`restart()`
 *    lifecycle call) BREACHES its deadline the supervisor records the cause,
 *    flushes it to disk, and EXITS the process (code 70). systemd
 *    (`Restart=always`, `RestartSec=30`, `StartLimitIntervalSec=0`) and launchd
 *    (`KeepAlive` + `ThrottleInterval=30`) restart the daemon within ~30s and the
 *    wedged service comes back healthy with it.
 *
 * This is the PHNX-4116 model: there is NO `parked` state and NO in-process
 * backoff restart. A supervised service is `idle` before start, `running` while
 * ticking, or `stopped` after a live disable / shutdown — a hang is not a fourth
 * state to sit in, it is a reason to hand the daemon back to its OS supervisor,
 * which is what actually "just works" like systemd/launchd. `start()`/`stop()`/
 * `restart()` stay bounded by {@link ServiceSupervisorOptions.lifecycleDeadlineMs}
 * so a wedged bind or close cannot stall daemon startup or shutdown; a start /
 * restart lifecycle breach exits the same way a tick breach does.
 */

import { recordSubsystemOk, recordSubsystemError, recordSubsystemState, recordDaemonRestart } from '../daemon-health.js';
import type { DaemonServiceId } from '../daemon-services.js';
import type { DaemonContext, DaemonService, PeriodicService, ServiceHealth, ServiceState } from './service.js';
import { isPeriodicService } from './service.js';

/**
 * Exit code the supervisor uses when a deadline breach hands the daemon back to
 * its OS supervisor for a restart. 70 (`EX_SOFTWARE`) marks an internal software
 * fault, distinct from a clean shutdown (0) or a config error.
 */
const DEADLINE_EXIT_CODE = 70;

interface ServiceSupervisorOptions {
  /**
   * Hard cap on a service's `start()`/`stop()`/`restart()` call (PHNX-3608). A
   * wedged bind/close would otherwise stall `startAll()` (which awaits each
   * `startOne` in turn) or `stopAll()` at shutdown. A start/restart that breaches
   * it exits the process for a supervised restart (PHNX-4116); a stop that
   * breaches it is logged and the service is left marked stopped. Default 30s.
   */
  lifecycleDeadlineMs?: number;
  /**
   * How the supervisor ends the process on a deadline breach. Defaults to
   * `process.exit`; injected in tests so a breach is observable without actually
   * exiting the test runner (PHNX-4116).
   */
  exit?: (code: number) => never;
}

interface RegisteredService {
  service: DaemonService;
  state: ServiceState;
  lastRunMs: number;
  lastError?: string;
  consecutiveFailures: number;
  inFlight: boolean;
  activeTick?: Promise<void>;
  /** Aborts the in-flight tick at its deadline (or when the service is stopped). */
  activeController?: AbortController;
  /**
   * Resolvers for `awaitIdle()` callers waiting on the current tick. Resolved by
   * `clearInFlight()` — the SAME place that flips `inFlight` to false — so a
   * waiter never observes `inFlight === true` after `awaitIdle()` resolves
   * (PHNX-3608: the SIGHUP live-disable race — awaiting the tick promise directly
   * could resume the waiter's `.then(stop)` on a shorter microtask chain than the
   * tick's own finally, so `stop()` saw a still-in-flight tick and threw).
   */
  idleWaiters: Array<() => void>;
  /** True once `start()` has completed without throwing — guards `stop()` from being called on a service that never successfully started. */
  everStarted: boolean;
  timer?: ReturnType<typeof setInterval>;
  startupTimer?: ReturnType<typeof setTimeout>;
}

interface RegisterServiceOptions {
  /** Register the lifecycle owner but leave it stopped until a live enable. */
  enabled?: boolean;
}

const DEFAULT_LIFECYCLE_DEADLINE_MS = 30_000;

export class ServiceSupervisor {
  private readonly registry = new Map<DaemonServiceId, RegisteredService>();
  private ctx: DaemonContext | null = null;
  private readonly lifecycleDeadlineMs: number;
  private readonly exit: (code: number) => never;

  constructor(opts: ServiceSupervisorOptions = {}) {
    this.lifecycleDeadlineMs = opts.lifecycleDeadlineMs ?? DEFAULT_LIFECYCLE_DEADLINE_MS;
    this.exit = opts.exit ?? ((code: number) => process.exit(code));
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

  /**
   * Force one service to restart right now — drives `agents daemon services
   * restart <id>` (RUSH-3193 P4). A plain stop + start, with no intermediate
   * `parked` state (PHNX-4116).
   */
  async restartOne(id: DaemonServiceId): Promise<void> {
    const entry = this.registry.get(id);
    if (!entry) throw new Error(`service '${id}' is not registered`);
    if (entry.inFlight) {
      throw new Error(`service '${id}' cannot restart while a tick is still in flight`);
    }
    await this.stopOne(id, false);
    await this.startOne(id);
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
   * edges use this to queue a requested live transition without polling.
   */
  async awaitIdle(id: DaemonServiceId): Promise<void> {
    const entry = this.registry.get(id);
    if (!entry) throw new Error(`service '${id}' is not registered`);
    // Resolve from clearInFlight (which also flips `inFlight` false) rather than
    // from the tick promise directly: awaiting the tick promise resumed this
    // caller on a shorter microtask chain than the tick's own finally, so a
    // queued `.then(stop)` could run before `inFlight` was cleared and `stop()`
    // would throw "cannot stop while a tick is still in flight" (PHNX-3608 — the
    // SIGHUP live-disable regression). Waiting on the guard makes it deterministic.
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
      // A thrown OR wedged start()/restart() cannot leave the service silently
      // dark, and there is no `parked` state to fall back to (PHNX-4116): record
      // the cause and exit so systemd/launchd restart the whole daemon and retry.
      this.exitForRestart(id, err);
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
   * Run one tick under a hard deadline (PHNX-3608, PHNX-4116). The tick receives
   * an `AbortSignal` that is aborted when the deadline elapses, so a cooperating
   * tick can bound its own I/O and unwind. The deadline itself is enforced with
   * `Promise.race` — JS cannot forcibly cancel an arbitrary await.
   *
   * A tick that THROWS is recoverable: it is recorded and the interval keeps
   * firing, so the service retries on its next tick. A tick that BREACHES its
   * deadline is a hang that can never be retried in-process (the promise may
   * never settle), so the supervisor exits the process (`exitForRestart`) and
   * lets systemd/launchd restart the whole daemon.
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
      if (timedOut) {
        // Abort the runaway tick's signal so a cooperating tick can unwind, then
        // hand the daemon back to its OS supervisor: a hang has no in-process
        // recovery (PHNX-4116). `exitForRestart` calls `process.exit`, so nothing
        // below runs in production; the injected test exit returns, and the
        // `finally` still releases the in-flight guard.
        controller.abort();
        this.exitForRestart(id, err);
        return;
      }
      // A throw is recoverable — record it and keep ticking on the next interval.
      this.recordFailure(entry, id, err);
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      entry.activeTick = undefined;
      entry.activeController = undefined;
      this.clearInFlight(entry);
    }
  }

  private recordFailure(entry: RegisteredService, id: DaemonServiceId, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    entry.consecutiveFailures += 1;
    entry.lastError = message;
    recordSubsystemError(id, message);
    this.ctx?.log('WARN', `service '${id}' failed: ${message}`);
  }

  /**
   * Record a deadline breach durably and exit the process so systemd/launchd
   * restart the whole daemon (PHNX-4116). `recordSubsystemError` writes
   * `health.json` synchronously (atomic write under a file lock), so the cause is
   * on disk before we exit; `recordDaemonRestart` appends to the restart ledger
   * `agents daemon status` reads for "restarts in the last 24h". Every timer is
   * frozen first so no further tick fires between this decision and process death
   * — and so an injected test `exit` (which does not actually exit) still observes
   * exactly one call.
   */
  private exitForRestart(id: DaemonServiceId, err: unknown): void {
    const cause = err instanceof Error ? err.message : String(err);
    const entry = this.registry.get(id);
    if (entry) {
      entry.consecutiveFailures += 1;
      entry.lastError = cause;
    }
    recordSubsystemError(id, cause);
    recordDaemonRestart(id, cause);
    this.ctx?.log('ERROR', `service '${id}' breached its deadline (${cause}); exiting (code ${DEADLINE_EXIT_CODE}) for a supervised restart`);
    this.freezeTimers();
    this.exit(DEADLINE_EXIT_CODE);
  }

  /** Clear every service's interval / startup timer — the process is exiting. */
  private freezeTimers(): void {
    for (const entry of this.registry.values()) {
      if (entry.timer) { clearInterval(entry.timer); entry.timer = undefined; }
      if (entry.startupTimer) { clearTimeout(entry.startupTimer); entry.startupTimer = undefined; }
    }
  }
}
