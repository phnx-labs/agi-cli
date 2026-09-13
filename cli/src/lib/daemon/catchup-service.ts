/**
 * Catch-up recovery as a supervised `PeriodicService` (PHNX-3608).
 *
 * A catch-up pass detects routines whose scheduled fire this device missed (the
 * laptop slept, the daemon was wedged, an OS suspend the process survived) and
 * runs them late. It used to run on a bare `setInterval` booted/stopped inside
 * `runDaemon()` alongside the scheduler, with only a local `catchingUp` overlap
 * flag and NO deadline — a pass that hung on an off-box (host/cloud) dispatch
 * could latch that flag and silently stop recovering missed fires for the
 * daemon's life, the same "abstraction too weak" class the supervisor exists for.
 *
 * Under the supervisor it gets a per-tick deadline, an AbortSignal, and the
 * circuit breaker: a hung pass is abandoned and restarted on backoff instead of
 * latching. The scheduler itself (croner-driven `JobScheduler`) stays outside the
 * supervisor — it is not a tick loop — so this service self-gates on whether the
 * scheduler is currently booted and no-ops cheaply when the scheduler gate is off.
 */

import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';

/**
 * How often to re-run catch-up. A startup pass alone misses a fire lost while the
 * daemon stayed up but its event loop was wedged, or one lost across an OS
 * suspend the process survived — five minutes bounds the cost while still
 * recovering from a wedge or an OS suspend the process survived.
 */
export const CATCHUP_TICK_MS = 5 * 60_000;

interface CatchupServiceDeps {
  /**
   * Whether the routine scheduler is currently booted. When false (the
   * `scheduler.enabled` gate is off), the pass no-ops — there is nothing to
   * catch up on a device where no routines fire.
   */
  isSchedulerBooted: () => boolean;
  /** Run one catch-up pass. Receives the tick's AbortSignal so it can bound its dispatches. */
  runPass: (signal: AbortSignal) => Promise<void>;
}

export class CatchupService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'catchup';
  readonly intervalMs = CATCHUP_TICK_MS;
  /**
   * A pass awaits `executeJobDetached` per overdue job and an off-box dispatch
   * can block for a while, so the bound is generous — but finite, which the old
   * un-deadlined loop was not. A pass exceeding it is hung, not slow.
   */
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
