
import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { runSummarizerPass } from '../summarizer/pass.js';

const SESSION_SUMMARIZER_TICK_MS = 20_000;
const SESSION_SUMMARIZER_DEADLINE_MS = 60_000;

export class SessionSummarizerService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'session-summarizer';
  readonly intervalMs = SESSION_SUMMARIZER_TICK_MS;
  readonly deadlineMs = SESSION_SUMMARIZER_DEADLINE_MS;

  protected async onStart(_ctx: DaemonContext): Promise<void> {
  }

  protected async onStop(): Promise<void> {
  }

  protected async onTick(ctx: DaemonContext, signal: AbortSignal): Promise<void> {
    const r = await runSummarizerPass({ signal });
    if (r.disabled) return;
    if (r.computed > 0 || r.skipped > 0) {
      ctx.log('INFO', `session-summarizer: computed ${r.computed}, skipped ${r.skipped}, reused ${r.reused}`);
    }
  }
}
