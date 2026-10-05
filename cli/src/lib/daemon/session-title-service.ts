
import type { DaemonServiceId } from '../daemon-services.js';
import { runSessionTitleTick, SESSION_TITLE_MAX_PER_TICK, type SessionTitleRunner } from '../session/title.js';
import { BasePeriodicService, type DaemonContext } from './service.js';

const SESSION_TITLE_TICK_MS = 2 * 60_000;
const SESSION_TITLE_DEADLINE_MS = 110_000;
const SESSION_TITLE_BACKOFF_START = 2;
const SESSION_TITLE_BACKOFF_MAX = 30;

export class SessionTitleService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'session-title';
  readonly intervalMs = SESSION_TITLE_TICK_MS;
  readonly deadlineMs = SESSION_TITLE_DEADLINE_MS;
  readonly startupDelayMs = 60_000;

  private skipTicks = 0;
  private backoff = 0;

  constructor(private readonly run?: SessionTitleRunner) {
    super();
  }

  protected async onStart(_ctx: DaemonContext): Promise<void> {}
  protected async onStop(): Promise<void> {}

  protected async onTick(ctx: DaemonContext, signal: AbortSignal): Promise<void> {
    if (this.skipTicks > 0) {
      this.skipTicks--;
      return;
    }
    const result = await runSessionTitleTick({
      limit: SESSION_TITLE_MAX_PER_TICK,
      signal,
      ...(this.run ? { run: this.run } : {}),
    });
    if (result.generated > 0) {
      this.backoff = 0;
      ctx.log('INFO', `session-title: generated ${result.generated} title(s) (${result.cached} already current)`);
      return;
    }
    if (result.failed > 0) {
      this.backoff = this.backoff === 0
        ? SESSION_TITLE_BACKOFF_START
        : Math.min(this.backoff * 2, SESSION_TITLE_BACKOFF_MAX);
      this.skipTicks = this.backoff;
      ctx.log(
        'WARN',
        `session-title: ${result.failed} generation(s) produced no title; backing off ${this.backoff} tick(s)`,
      );
    }
  }
}
