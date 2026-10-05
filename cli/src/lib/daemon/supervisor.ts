/** ServiceSupervisor (RUSH-3193 P1, PHNX-4116): owns the timer for every `PeriodicService`,
 * replacing bare `setInterval` closures. A thrown tick is caught per service and retried. A
 * deadline breach is a hang (seen ~51h) that cannot be retried in-process, so the daemon exits. */

import { recordSubsystemOk, recordSubsystemError, recordSubsystemState, recordDaemonRestart } from '../daemon-health.js';
import type { DaemonServiceId } from '../daemon-services.js';
import type { DaemonContext, DaemonService, PeriodicService, ServiceHealth, ServiceState } from './service.js';
import { isPeriodicService } from './service.js';

/** Exit code when a deadline breach hands the daemon back to its OS supervisor: 70 (`EX_SOFTWARE`),
 * distinct from a clean shutdown (0) or a config error. */
const DEADLINE_EXIT_CODE = 70;

interface ServiceSupervisorOptions {
  /** Hard cap on a service's `start()`/`stop()`/`restart()` (PHNX-3608), so a wedged bind/close
   * cannot stall `startAll()` or `stopAll()`. A start/restart breach exits for a supervised
   * restart (PHNX-4116); a stop breach is logged and the service marked stopped. Default 30s. */
  lifecycleDeadlineMs?: number;
  /** How the supervisor ends the process on a deadline breach. Defaults to `process.exit`; injected
   * in tests so a breach is observable (PHNX-4116). */
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
  /** Resolvers for `awaitIdle()` callers, released by `clearInFlight()` where `inFlight` flips to
   * false, so a waiter never sees `inFlight === true` after resuming. Awaiting the tick promise
   * directly raced the tick's own finally and `stop()` threw (PHNX-3608). */
  idleWaiters: Array<() => void>;
  /** True once `start()` has completed without throwing — guards `stop()` from being called on a service that never successfully started. */
  everStarted: boolean;
  timer?: ReturnType<typeof setInterval>;
  startupTimer?: ReturnType<typeof setTimeout>;
  /** The in-flight tick's deadline timer, stored on the entry so `stopOne` can clear it. Otherwise
   * a force-stop leaves it armed and a hung tick that ignores the abort fires `exitForRestart`
   * mid-shutdown (wrong exit code, spurious ledger entry, skipped cleanup). PHNX-4116. */
  deadlineTimer?: ReturnType<typeof setTimeout>;
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

  /** Race `op` against a deadline; on breach reject with a labelled error while `op` settles in the
   * background. Bounds start/stop/restart so a wedged one cannot stall startup or shutdown.
   * `Promise.race` cannot cancel `op`; the caller decides what a breach means. */
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

  /** Register a service before `startAll()`. Accepts `PeriodicService` (ticked on an interval) and
   * lifecycle-only `DaemonService`; `isPeriodicService()` decides whether to schedule a timer. */
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

  /** Flip a tick's in-flight guard off and release every `awaitIdle()` waiter in the same
   * synchronous step (PHNX-3608). */
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

  /** Force one service to restart now, driving `agents daemon services restart <id>` (RUSH-3193
   * P4): a plain stop + start, no `parked` state (PHNX-4116). */
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

  /** Resolve when the service's current tick has settled; daemon control edges use it to queue a
   * live transition without polling. */
  async awaitIdle(id: DaemonServiceId): Promise<void> {
    const entry = this.registry.get(id);
    if (!entry) throw new Error(`service '${id}' is not registered`);
    // Resolve from clearInFlight, which flips `inFlight` false, not from the tick promise: the
    // latter resumed on a shorter microtask chain than the tick's finally, so a queued
    // `.then(stop)` threw "cannot stop while a tick is still in flight" (PHNX-3608).
    if (!entry.inFlight) return;
    await new Promise<void>((resolve) => { entry.idleWaiters.push(resolve); });
  }

  /** Start one registered service live, driving `agents daemon services enable <id>` (RUSH-3193
   * P4). Only affects an already registered service; to enable from a boot-disabled state,
   * register it with `{ enabled: false }` so the supervisor owns it without startup side effects. */
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
    // Cancel the in-flight tick's deadline timer too: left armed it fires `exitForRestart`
    // mid-shutdown if the hung tick ignores the abort (PHNX-4116). The `state === 'stopped'` guard
    // in `runTick` backs this up.
    if (entry.deadlineTimer) {
      clearTimeout(entry.deadlineTimer);
      entry.deadlineTimer = undefined;
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

  /** Run one tick under a hard deadline (PHNX-3608, PHNX-4116). The tick gets an `AbortSignal`
   * aborted at the deadline so it can unwind; the deadline itself uses `Promise.race`. A throw is
   * recorded and retried; a breach is a hang, so the supervisor exits for a restart. */
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
    let timedOut = false;
    const tickPromise = periodicService.tick(ctx, controller.signal);
    entry.activeTick = tickPromise;
    try {
      const deadline = new Promise<never>((_, reject) => {
        entry.deadlineTimer = setTimeout(
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
      // A stopped service must never exit the process: `stopOne` may have force-stopped this tick
      // while its deadline timer was armed, and a hang ignoring the abort would fire
      // `exitForRestart` mid-shutdown (PHNX-4116). Read the state fresh.
      const stoppedDuringTick = this.registry.get(id)?.state === 'stopped';
      if (timedOut && !stoppedDuringTick) {
        // Abort the runaway tick's signal so a cooperating tick can unwind, then hand the daemon
        // to its OS supervisor; a hang has no in-process recovery (PHNX-4116). `exitForRestart`
        // calls `process.exit`; the injected test exit returns and `finally` releases the guard.
        controller.abort();
        this.exitForRestart(id, err);
        return;
      }
      // A throw is recoverable — record it and keep ticking on the next interval.
      // A deadline breach of an already-stopped service is intentionally dropped.
      if (!timedOut) this.recordFailure(entry, id, err);
    } finally {
      if (entry.deadlineTimer) { clearTimeout(entry.deadlineTimer); entry.deadlineTimer = undefined; }
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

  /** Record a deadline breach durably and exit so systemd/launchd restart the daemon (PHNX-4116).
   * `recordSubsystemError` writes `health.json` synchronously before exit; `recordDaemonRestart`
   * appends to the ledger `agents daemon status` reads. Timers are frozen first. */
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
      if (entry.deadlineTimer) { clearTimeout(entry.deadlineTimer); entry.deadlineTimer = undefined; }
    }
  }
}
