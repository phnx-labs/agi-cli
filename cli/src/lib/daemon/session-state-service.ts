
import { runActiveSessionsWarmTick } from '../daemon-ticks.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { watchActiveSessionsReaderPresence } from '../session/session-cache.js';
import { watchClaudeLiveSessionFiles } from '../session/discover.js';
import { BasePeriodicService, type DaemonContext } from './service.js';

const SESSION_STATE_TICK_MS = 15_000;
const SESSION_STATE_DEADLINE_MS = 30_000;
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

  protected async onStart(ctx: DaemonContext): Promise<void> {
    this.stopReaderWatch = watchActiveSessionsReaderPresence(this.wake);
    const warned = new Set<string>();
    this.liveFiles = watchClaudeLiveSessionFiles(() => {
      this.lastChangeMs = Date.now();
      this.scheduleWake();
    }, (dir, err) => {
      if (warned.has(dir)) return;
      warned.add(dir);
      ctx.log('WARN', `session-state: cannot watch ${dir} (${err.message}); renames there wait for the 15 s tick`, { event: 'sessions.live-watch.failed', dir, error: err.message });
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
    await runActiveSessionsWarmTick({ log: ctx.log });
    this.liveFiles?.refresh();
    const changedDuringTick = this.lastChangeMs >= startedMs;
    if (changedDuringTick) this.scheduleWake();
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
