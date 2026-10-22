
import { runActiveSessionsWarmTick } from '../daemon-ticks.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { watchActiveSessionsReaderPresence } from '../session/session-cache.js';
import { watchClaudeLiveSessionFiles } from '../session/discover.js';
import { BasePeriodicService, type DaemonContext } from './service.js';

const SESSION_STATE_TICK_MS = 15_000;
const SESSION_STATE_DEADLINE_MS = 30_000;
// A /rename reaches the row this soon instead of on the next 15 s tick; the gap bounds
// how often a busy fleet's status flips re-gather (a warm gather is ~15-40 ms).
const LIVE_CHANGE_SETTLE_MS = 150;
const LIVE_CHANGE_MIN_GAP_MS = 1_000;

export class SessionStateService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'session-state';
  readonly intervalMs = SESSION_STATE_TICK_MS;
  readonly deadlineMs = SESSION_STATE_DEADLINE_MS;

  private stopReaderWatch: (() => void) | null = null;
  private liveFiles: ReturnType<typeof watchClaudeLiveSessionFiles> | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;
  private lastWakeMs = 0;
  private lastChangeMs = 0;

  constructor(private readonly wake: () => void) {
    super();
  }

  protected async onStart(_ctx: DaemonContext): Promise<void> {
    this.stopReaderWatch = watchActiveSessionsReaderPresence(this.wake);
    this.liveFiles = watchClaudeLiveSessionFiles(() => {
      this.lastChangeMs = Date.now();
      this.scheduleWake();
    });
  }

  protected async onStop(): Promise<void> {
    this.stopReaderWatch?.();
    this.stopReaderWatch = null;
    this.liveFiles?.close();
    this.liveFiles = null;
    clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
  }

  protected async onTick(ctx: DaemonContext): Promise<void> {
    const startedMs = Date.now();
    this.liveFiles?.refresh();
    await runActiveSessionsWarmTick({ log: ctx.log });
    // The supervisor drops a wake while a tick is in flight; a change it missed gets one more.
    if (this.lastChangeMs >= startedMs) this.scheduleWake();
  }

  private scheduleWake(): void {
    if (this.wakeTimer || !this.liveFiles) return;
    const delay = Math.max(LIVE_CHANGE_SETTLE_MS, this.lastWakeMs + LIVE_CHANGE_MIN_GAP_MS - Date.now());
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      this.lastWakeMs = Date.now();
      this.wake();
    }, delay);
    this.wakeTimer.unref?.();
  }
}
