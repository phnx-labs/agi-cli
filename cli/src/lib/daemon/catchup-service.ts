/** Catch-up recovery as a supervised `PeriodicService` (PHNX-3608). A pass runs routines whose fire
 * this device missed; on a bare `setInterval` a pass hung on an off-box dispatch could latch its
 * flag and stop recovery for the daemon's life. It now has a deadline, AbortSignal and breaker. */

import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';

/** How often to re-run catch-up. A startup pass alone misses a fire lost to a wedged event loop or
 * an OS suspend the process survived; five minutes bounds the cost while recovering from both. */
export const CATCHUP_TICK_MS = 5 * 60_000;

interface CatchupServiceDeps {
  /** Whether the routine scheduler is booted. When false (`scheduler.enabled` off) the pass no-ops,
   * since no routines fire to catch up on. */
  isSchedulerBooted: () => boolean;
  /** Run one catch-up pass. Receives the tick's AbortSignal so it can bound its dispatches. */
  runPass: (signal: AbortSignal) => Promise<void>;
}

export class CatchupService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'catchup';
  readonly intervalMs = CATCHUP_TICK_MS;
  /** A pass awaits `executeJobDetached` per overdue job and an off-box dispatch can block, so the
   * bound is generous but finite (the old un-deadlined loop was not). A pass exceeding it is hung,
   * not slow. */
  readonly deadlineMs = 4 * 60_000;

  constructor(private readonly deps: CatchupServiceDeps) {
    super();
  }

  protected async onStart(): Promise<void> {
    // No owned resources — the supervisor owns the timer.
  }

  protected async onStop(): Promise<void> {
    // No owned resources.
  }

  protected async onTick(_ctx: DaemonContext, signal: AbortSignal): Promise<void> {
    if (!this.deps.isSchedulerBooted()) return;
    await this.deps.runPass(signal);
  }
}
