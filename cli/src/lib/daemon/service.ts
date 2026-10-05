
import type { DaemonServiceId } from '../daemon-services.js';

export type ServiceState = 'idle' | 'running' | 'stopped';

export interface ServiceHealth {
  state: ServiceState;
  lastRunMs: number;
  lastError?: string;
  consecutiveFailures: number;
}

export interface DaemonContext {
  log: (level: string, message: string) => void;
}

export interface DaemonService {
  readonly id: DaemonServiceId;
  start(ctx: DaemonContext): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  health(): ServiceHealth;
}

export interface PeriodicService extends DaemonService {
  readonly intervalMs: number;
  readonly deadlineMs: number;
  readonly startupDelayMs?: number;
  tick(ctx: DaemonContext, signal: AbortSignal): Promise<void>;
}

export function isPeriodicService(service: DaemonService): service is PeriodicService {
  const candidate = service as Partial<PeriodicService>;
  return typeof candidate.tick === 'function' && typeof candidate.intervalMs === 'number' && typeof candidate.deadlineMs === 'number';
}

function blankHealth(): ServiceHealth {
  return { state: 'idle', lastRunMs: 0, consecutiveFailures: 0 };
}

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

export abstract class BasePeriodicService implements PeriodicService {
  abstract readonly id: DaemonServiceId;
  abstract readonly intervalMs: number;
  abstract readonly deadlineMs: number;

  protected ctx: DaemonContext | null = null;
  private healthRecord: ServiceHealth = blankHealth();

  protected abstract onStart(ctx: DaemonContext): Promise<void>;
  protected abstract onStop(): Promise<void>;
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
