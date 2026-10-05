/** Session-title service (PHNX-3797), the one generator of session headlines: replaces rows still
 * titled with the raw first user message with a SessionTitleProvider name, persisted in the index.
 * Bounded: SESSION_TITLE_MAX_PER_TICK, never its own sessions; backs off when the harness fails. */

import type { DaemonServiceId } from '../daemon-services.js';
import { runSessionTitleTick, SESSION_TITLE_MAX_PER_TICK, type SessionTitleRunner } from '../session/title.js';
import { BasePeriodicService, type DaemonContext } from './service.js';

/** Cadence of the sweep. Slow on purpose: a title is not a live signal. */
const SESSION_TITLE_TICK_MS = 2 * 60_000;
/** Above the worst case (limit x the per-generation subprocess timeout), below the interval. */
const SESSION_TITLE_DEADLINE_MS = 110_000;
/** Ticks skipped after the first all-failed sweep, doubling up to the ceiling. */
const SESSION_TITLE_BACKOFF_START = 2;
/** ~1h at the tick cadence — long enough that a signed-out box stays quiet. */
const SESSION_TITLE_BACKOFF_MAX = 30;

export class SessionTitleService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'session-title';
  readonly intervalMs = SESSION_TITLE_TICK_MS;
  readonly deadlineMs = SESSION_TITLE_DEADLINE_MS;
  /** Let the box settle (shims, PATH, index warm) before spawning a harness. */
  readonly startupDelayMs = 60_000;

  /** Ticks still to skip before the next attempt; 0 = attempt this tick. */
  private skipTicks = 0;
  /** Skip count applied after the next all-failed sweep. */
  private backoff = 0;

  /** `run` is the model-call seam (defaults to the real subprocess); tests inject one. */
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
      // A success clears the backoff: whatever was broken is working again.
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
    // Nothing generated and nothing failed = every recent session is titled.
    // That is the steady state, and it logs nothing.
  }
}
