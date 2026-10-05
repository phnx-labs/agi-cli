
import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { MONITOR_ENGINE_TICK_MS, MonitorEngine } from '../monitors/engine.js';

export class MonitorEngineService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'monitors';
  readonly intervalMs = MONITOR_ENGINE_TICK_MS;
  readonly deadlineMs = 2 * 60_000;

  private engine: MonitorEngine | null = null;

  getEngine(): MonitorEngine | null {
    return this.engine;
  }

  protected async onStart(ctx: DaemonContext): Promise<void> {
    this.engine = new MonitorEngine((level, message) => ctx.log(level, message));
    this.engine.start({ externalScheduler: true });
  }

  protected async onStop(): Promise<void> {
    this.engine?.stop();
    this.engine = null;
  }

  protected async onTick(_ctx: DaemonContext): Promise<void> {
    if (!this.engine) throw new Error('monitor engine tick requested before start');
    await this.engine.tick();
  }
}
