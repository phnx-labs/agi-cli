
import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { runDeferredToolIndex, runSessionIndexWarmTick } from '../daemon-ticks.js';

const SESSION_INDEX_WARM_TICK_MS = 20_000;
const SESSION_INDEX_WARM_DEADLINE_MS = 60_000;

export class SessionIndexService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'session-index';
  readonly intervalMs = SESSION_INDEX_WARM_TICK_MS;
  readonly deadlineMs = SESSION_INDEX_WARM_DEADLINE_MS;

  protected async onStart(_ctx: DaemonContext): Promise<void> {
  }

  protected async onStop(): Promise<void> {
  }

  protected async onTick(ctx: DaemonContext): Promise<void> {
    const { indexed, claimed } = await runSessionIndexWarmTick();
    if (!claimed) ctx.log('INFO', 'session-index warm: skipped, another process holds the scan claim');
    else if (indexed > 0) ctx.log('INFO', `session-index warm: indexed ${indexed} transcript(s)`);
    if (claimed) {
      const { indexed: toolIndexed } = await runDeferredToolIndex();
      if (toolIndexed > 0) ctx.log('INFO', `session-index deferred: tool-indexed ${toolIndexed} transcript(s)`);
    }
  }
}
