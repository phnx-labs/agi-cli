
import { recordSubsystemOk, recordSubsystemError, recordSubsystemState, recordDaemonRestart } from '../daemon-health.js';
import type { DaemonServiceId } from '../daemon-services.js';
import type { DaemonContext, DaemonService, PeriodicService, ServiceHealth, ServiceState } from './service.js';
import { isPeriodicService } from './service.js';

const DEADLINE_EXIT_CODE = 70;

interface ServiceSupervisorOptions {
  lifecycleDeadlineMs?: number;
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
  activeController?: AbortController;
  idleWaiters: Array<() => void>;
  everStarted: boolean;
  timer?: ReturnType<typeof setInterval>;
  startupTimer?: ReturnType<typeof setTimeout>;
  deadlineTimer?: ReturnType<typeof setTimeout>;
}

interface RegisterServiceOptions {
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

  // Resolve idle waiters in the same step that clears inFlight, so reload cannot race the active tick.
  private clearInFlight(entry: RegisteredService): void {
    entry.inFlight = false;
    const waiters = entry.idleWaiters;
    entry.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  async startAll(ctx: DaemonContext): Promise<void> {
    this.ctx = ctx;
    for (const [id, entry] of this.registry) {
      if (entry.state === 'stopped') continue;
      await this.startOne(id);
    }
  }

  async stopAll(): Promise<void> {
    for (const id of this.registry.keys()) await this.stopOne(id, true);
  }

  async restartOne(id: DaemonServiceId): Promise<void> {
    const entry = this.registry.get(id);
    if (!entry) throw new Error(`service '${id}' is not registered`);
    if (entry.inFlight) {
      throw new Error(`service '${id}' cannot restart while a tick is still in flight`);
    }
    await this.stopOne(id, false);
    await this.startOne(id);
  }

  isRegistered(id: DaemonServiceId): boolean {
    return this.registry.has(id);
  }

  registeredIds(): DaemonServiceId[] {
    return Array.from(this.registry.keys());
  }

  async awaitIdle(id: DaemonServiceId): Promise<void> {
    const entry = this.registry.get(id);
    if (!entry) throw new Error(`service '${id}' is not registered`);
    if (!entry.inFlight) return;
    await new Promise<void>((resolve) => { entry.idleWaiters.push(resolve); });
  }

  async start(id: DaemonServiceId): Promise<void> {
    const entry = this.registry.get(id);
    if (!entry) throw new Error(`service '${id}' is not registered`);
    if (entry.state === 'running') return;
    if (entry.inFlight) {
      throw new Error(`service '${id}' cannot start while a tick is still in flight`);
    }
    await this.startOne(id);
  }

  async stop(id: DaemonServiceId): Promise<void> {
    const entry = this.registry.get(id);
    if (!entry) throw new Error(`service '${id}' is not registered`);
    if (entry.state === 'stopped') return;
    await this.stopOne(id, false);
  }

  runNow(id: DaemonServiceId): void {
    if (!this.registry.has(id)) throw new Error(`service '${id}' is not registered`);
    void this.runTick(id);
  }

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
      this.exitForRestart(id, err);
      return;
    }
    entry.everStarted = true;
    entry.state = 'running';
    recordSubsystemState(id, 'running');
    if (isPeriodicService(entry.service)) {
      const startupDelayMs = entry.service.startupDelayMs ?? 0;
      if (startupDelayMs > 0) {
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
      entry.lastRunMs = Date.now();
      recordSubsystemOk(id);
    }
  }

  // Clear deadline timers before abort: a hung tick must not turn deliberate shutdown into an OS restart.
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
    if (entry.deadlineTimer) {
      clearTimeout(entry.deadlineTimer);
      entry.deadlineTimer = undefined;
    }
    entry.state = 'stopped';
    recordSubsystemState(id, 'stopped');
    entry.activeController?.abort();
    if (entry.inFlight && force) {
      const waiters = entry.idleWaiters;
      entry.idleWaiters = [];
      for (const resolve of waiters) resolve();
      return;
    }
    if (!entry.everStarted) return;
    try {
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

  // Thrown ticks retry; a deadline may never settle, so record it durably and exit 70 for supervised restart instead of parking.
  private async runTick(id: DaemonServiceId): Promise<void> {
    const entry = this.registry.get(id);
    const ctx = this.ctx;
    if (!entry || !ctx || entry.state !== 'running' || entry.inFlight) return;
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
      const stoppedDuringTick = this.registry.get(id)?.state === 'stopped';
      if (timedOut && !stoppedDuringTick) {
        controller.abort();
        this.exitForRestart(id, err);
        return;
      }
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

  private freezeTimers(): void {
    for (const entry of this.registry.values()) {
      if (entry.timer) { clearInterval(entry.timer); entry.timer = undefined; }
      if (entry.startupTimer) { clearTimeout(entry.startupTimer); entry.startupTimer = undefined; }
      if (entry.deadlineTimer) { clearTimeout(entry.deadlineTimer); entry.deadlineTimer = undefined; }
    }
  }
}
