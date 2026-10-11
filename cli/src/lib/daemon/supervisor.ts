
import { recordSubsystemOk, recordSubsystemError, recordSubsystemState, recordDaemonRestart } from '../daemon-health.js';
import type { DaemonServiceId } from '../daemon-services.js';
import type { DaemonContext, DaemonService, PeriodicService, ServiceHealth, ServiceState } from './service.js';
import { isPeriodicService } from './service.js';
import { syncSpansBetween, type LogFields } from './diagnostics.js';
import { performance } from 'perf_hooks';

const DEADLINE_EXIT_CODE = 70;
const HANG_DEADLINES = 10;

interface ServiceSupervisorOptions {
  lifecycleDeadlineMs?: number;
  exit?: (code: number) => never;
  diagnostics?: () => LogFields;
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
  hangTimer?: ReturnType<typeof setTimeout>;
  tickStartedAt?: number;
  skippedTicks: number;
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
  private readonly diagnostics?: () => LogFields;

  constructor(opts: ServiceSupervisorOptions = {}) {
    this.lifecycleDeadlineMs = opts.lifecycleDeadlineMs ?? DEFAULT_LIFECYCLE_DEADLINE_MS;
    this.exit = opts.exit ?? ((code: number) => process.exit(code));
    this.diagnostics = opts.diagnostics;
  }

  inFlightTicks(now = performance.now()): Array<{ service: DaemonServiceId; elapsedMs: number }> {
    const out: Array<{ service: DaemonServiceId; elapsedMs: number }> = [];
    for (const [id, entry] of this.registry) {
      if (entry.inFlight && entry.tickStartedAt !== undefined) out.push({ service: id, elapsedMs: Math.round(now - entry.tickStartedAt) });
    }
    return out.sort((a, b) => b.elapsedMs - a.elapsedMs);
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
      skippedTicks: 0,
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
    void this.runTick(id, false);
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
    this.clearTickTimers(entry);
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

  // Throws retry; an overrun is aborted and skipped until it settles; only a hang (HANG_DEADLINES) exits 70.
  private async runTick(id: DaemonServiceId, scheduled = true): Promise<void> {
    const entry = this.registry.get(id);
    const ctx = this.ctx;
    if (!entry || !ctx || entry.state !== 'running') return;
    if (!isPeriodicService(entry.service)) return;
    if (entry.inFlight) {
      if (scheduled) entry.skippedTicks += 1;
      return;
    }
    const periodicService = entry.service;
    const deadlineMs = periodicService.deadlineMs;
    entry.inFlight = true;
    entry.skippedTicks = 0;
    const startedAt = performance.now();
    entry.tickStartedAt = startedAt;
    const controller = new AbortController();
    entry.activeController = controller;
    let overran = false;
    ctx.log('DEBUG', `service '${id}' tick start`, { event: 'tick.start', service: id });
    entry.deadlineTimer = setTimeout(() => {
      entry.deadlineTimer = undefined;
      overran = true;
      this.recordOverrun(entry, id, deadlineMs, startedAt);
      controller.abort();
      entry.hangTimer = setTimeout(() => {
        entry.hangTimer = undefined;
        this.exitForRestart(id, new Error(`tick did not settle within ${deadlineMs * HANG_DEADLINES}ms (${HANG_DEADLINES}x its ${deadlineMs}ms deadline)`), startedAt);
      }, deadlineMs * (HANG_DEADLINES - 1));
    }, deadlineMs);
    try {
      const tickPromise = periodicService.tick(ctx, controller.signal);
      entry.activeTick = tickPromise;
      await tickPromise;
      const durMs = Math.round(performance.now() - startedAt);
      const tickFields = { service: id, durMs, deadlineMs };
      if (overran) {
        ctx.log('WARN', `service '${id}' overrun tick settled after ${durMs}ms; ${entry.skippedTicks} tick(s) skipped`, { event: 'tick.settled', ...tickFields, skippedTicks: entry.skippedTicks });
      } else if (durMs * 2 > deadlineMs) {
        ctx.log('WARN', `service '${id}' tick took ${durMs}ms, over half its ${deadlineMs}ms deadline`, { event: 'tick.slow', ...tickFields, inFlight: this.inFlightTicks() });
      } else {
        ctx.log('DEBUG', `service '${id}' tick ok in ${durMs}ms`, { event: 'tick.ok', ...tickFields });
      }
      entry.lastRunMs = Date.now();
      if (!overran) {
        entry.consecutiveFailures = 0;
        entry.lastError = undefined;
        recordSubsystemOk(id);
      }
    } catch (err) {
      const durMs = Math.round(performance.now() - startedAt);
      if (overran) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.log('WARN', `service '${id}' overrun tick settled after ${durMs}ms by throwing: ${message}; ${entry.skippedTicks} tick(s) skipped`, {
          event: 'tick.settled', service: id, durMs, deadlineMs, skippedTicks: entry.skippedTicks, error: message,
        });
      } else {
        this.recordFailure(entry, id, err, durMs);
      }
    } finally {
      this.clearTickTimers(entry);
      entry.activeTick = undefined;
      entry.activeController = undefined;
      entry.tickStartedAt = undefined;
      this.clearInFlight(entry);
    }
  }

  private recordOverrun(entry: RegisteredService, id: DaemonServiceId, deadlineMs: number, startedAt: number): void {
    const cause = `tick exceeded deadline of ${deadlineMs}ms`;
    entry.consecutiveFailures += 1;
    entry.lastError = cause;
    recordSubsystemError(id, cause);
    this.ctx?.log('ERROR', `service '${id}' breached its deadline (${cause}); aborted it and skipping ticks until it settles`, {
      ...this.breachSnapshot(id, startedAt),
      consecutiveFailures: entry.consecutiveFailures,
    });
  }

  private clearTickTimers(entry: RegisteredService): void {
    if (entry.deadlineTimer) { clearTimeout(entry.deadlineTimer); entry.deadlineTimer = undefined; }
    if (entry.hangTimer) { clearTimeout(entry.hangTimer); entry.hangTimer = undefined; }
  }

  private recordFailure(entry: RegisteredService, id: DaemonServiceId, err: unknown, durMs: number): void {
    const message = err instanceof Error ? err.message : String(err);
    entry.consecutiveFailures += 1;
    entry.lastError = message;
    recordSubsystemError(id, message);
    this.ctx?.log('WARN', `service '${id}' failed: ${message}`, {
      event: 'tick.failed', service: id, durMs, consecutiveFailures: entry.consecutiveFailures, error: message,
    });
  }

  private breachSnapshot(id: DaemonServiceId, startedAt: number | undefined): LogFields {
    const now = performance.now();
    const blockers = startedAt === undefined ? [] : syncSpansBetween(startedAt, now)
      .sort((a, b) => b.durMs - a.durMs)
      .slice(0, 8)
      .map((r) => ({ span: r.name, durMs: Math.round(r.durMs), ...r.fields }));
    return {
      event: 'tick.breach',
      service: id,
      elapsedMs: startedAt === undefined ? undefined : Math.round(now - startedAt),
      inFlight: this.inFlightTicks(now),
      syncSpansDuringTick: blockers,
      ...this.diagnostics?.(),
    };
  }

  private exitForRestart(id: DaemonServiceId, err: unknown, startedAt?: number): void {
    const cause = err instanceof Error ? err.message : String(err);
    const entry = this.registry.get(id);
    if (entry) {
      entry.consecutiveFailures += 1;
      entry.lastError = cause;
    }
    recordSubsystemError(id, cause);
    recordDaemonRestart(id, cause);
    this.ctx?.log('ERROR', `service '${id}' hung (${cause}); exiting (code ${DEADLINE_EXIT_CODE}) for a supervised restart`, {
      ...this.breachSnapshot(id, startedAt),
      event: 'tick.hang',
    });
    this.freezeTimers();
    this.exit(DEADLINE_EXIT_CODE);
  }

  private freezeTimers(): void {
    for (const entry of this.registry.values()) {
      if (entry.timer) { clearInterval(entry.timer); entry.timer = undefined; }
      if (entry.startupTimer) { clearTimeout(entry.startupTimer); entry.startupTimer = undefined; }
      this.clearTickTimers(entry);
    }
  }
}
