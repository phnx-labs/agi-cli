/** Live-session metadata publisher, the single daemon-owned writer behind `sessions watch`: it
 * publishes an incremental journal snapshot on the idle-to-active edge and every 15 seconds while
 * a reader remains. Callers consume the row and never gather themselves. */

import { runActiveSessionsWarmTick } from '../daemon-ticks.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { watchActiveSessionsReaderPresence } from '../session/session-cache.js';
import { BasePeriodicService, type DaemonContext } from './service.js';

const SESSION_STATE_TICK_MS = 15_000;
const SESSION_STATE_DEADLINE_MS = 30_000;

export class SessionStateService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'session-state';
  readonly intervalMs = SESSION_STATE_TICK_MS;
  readonly deadlineMs = SESSION_STATE_DEADLINE_MS;

  private stopReaderWatch: (() => void) | null = null;

  constructor(private readonly wake: () => void) {
    super();
  }

  protected async onStart(_ctx: DaemonContext): Promise<void> {
    this.stopReaderWatch = watchActiveSessionsReaderPresence(this.wake);
  }

  protected async onStop(): Promise<void> {
    this.stopReaderWatch?.();
    this.stopReaderWatch = null;
  }

  protected async onTick(_ctx: DaemonContext): Promise<void> {
    await runActiveSessionsWarmTick();
  }
}
