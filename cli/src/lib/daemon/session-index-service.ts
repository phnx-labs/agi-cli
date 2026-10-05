/** Session-index warm service (RUSH-2682), the proof-of-concept periodic service on
 * `ServiceSupervisor` (RUSH-3193 P1). Incrementally scans this host's transcript dirs so a local
 * session is discoverable within seconds; single-flight via the DB scan claim. */

import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { runDeferredToolIndex, runSessionIndexWarmTick } from '../daemon-ticks.js';

/** Matches the historical inline interval (daemon.ts SESSION_INDEX_WARM_TICK_MS). */
const SESSION_INDEX_WARM_TICK_MS = 20_000;
/** Hard cap per tick — well above a healthy incremental scan, short enough that a hang never freezes the service for long. */
const SESSION_INDEX_WARM_DEADLINE_MS = 60_000;

export class SessionIndexService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'session-index';
  readonly intervalMs = SESSION_INDEX_WARM_TICK_MS;
  readonly deadlineMs = SESSION_INDEX_WARM_DEADLINE_MS;

  protected async onStart(_ctx: DaemonContext): Promise<void> {
    // No connections/handles to open — the scan claim itself is per-tick state.
  }

  protected async onStop(): Promise<void> {
    // Nothing to release — the supervisor's timer teardown is the only cleanup needed.
  }

  protected async onTick(ctx: DaemonContext): Promise<void> {
    const { indexed, claimed } = await runSessionIndexWarmTick();
    // Log only when the tick did something. A silent tick let it report 0 forever unnoticed
    // (RUSH-2691), but a line on every idle 20s tick would drown the log, so the quiet steady
    // state stays quiet.
    if (!claimed) ctx.log('INFO', 'session-index warm: skipped, another process holds the scan claim');
    else if (indexed > 0) ctx.log('INFO', `session-index warm: indexed ${indexed} transcript(s)`);
    // Deferred tool-index pass (PHNX-3411): fill tool_scan_ledger rows for
    // harnesses whose scanner produces no events. Runs only when the warm tick
    // claimed the scan lock (i.e. we are the active indexer this tick).
    if (claimed) {
      const { indexed: toolIndexed } = await runDeferredToolIndex();
      if (toolIndexed > 0) ctx.log('INFO', `session-index deferred: tool-indexed ${toolIndexed} transcript(s)`);
    }
  }
}
