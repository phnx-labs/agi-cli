
import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';

export const CATCHUP_TICK_MS = 5 * 60_000;

interface CatchupServiceDeps {
  isSchedulerBooted: () => boolean;
  runPass: (signal: AbortSignal) => Promise<void>;
}

export class CatchupService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'catchup';
  readonly intervalMs = CATCHUP_TICK_MS;
  readonly deadlineMs = 4 * 60_000;

  constructor(private readonly deps: CatchupServiceDeps) {
    super();
  }

  protected async onStart(): Promise<void> {
  }

  protected async onStop(): Promise<void> {
  }

  protected async onTick(_ctx: DaemonContext, signal: AbortSignal): Promise<void> {
    if (!this.deps.isSchedulerBooted()) return;
    await this.deps.runPass(signal);
  }
}
