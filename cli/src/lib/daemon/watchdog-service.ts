/** Watchdog tick as a `PeriodicService` (RUSH-3193 P3): nudges this host's own stalled sessions.
 * The timer always fires but the tick checks the `watchdog.enabled` device-config flag (`agents
 * watchdog enable`) itself, as the pre-migration inline code did. */

import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { getConfigValueAsync } from '../device-config.js';
import { emitAsync } from '../feed/events.js';

/** Matches the historical inline interval (daemon.ts WATCHDOG_TICK_MS). */
const WATCHDOG_TICK_MS = 3 * 60_000;
/** Hard cap per tick — `runWatchdogPass` is host-local (adds no SSH fan-out of its own, `watchdog/runner.ts:580`); short enough that a hang never freezes the service for long. */
const WATCHDOG_DEADLINE_MS = 120_000;

export class WatchdogService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'watchdog';
  readonly intervalMs = WATCHDOG_TICK_MS;
  readonly deadlineMs = WATCHDOG_DEADLINE_MS;

  protected async onStart(_ctx: DaemonContext): Promise<void> {
    // No connections/handles to open — each tick re-reads the enable flag.
  }

  protected async onStop(): Promise<void> {
    // Nothing to release — the supervisor's timer teardown is the only cleanup needed.
  }

  protected async onTick(ctx: DaemonContext): Promise<void> {
    if ((await getConfigValueAsync('watchdog.enabled')).value !== true) return;
    const { runWatchdogPass } = await import('../watchdog/service.js');
    const result = await runWatchdogPass({ nudge: true });
    ctx.log('INFO', `watchdog: ${result.counts.total} live, ${result.counts.stalled} stalled, ${result.counts.nudged} nudged`);
    await emitAsync('watchdog.action', {
      module: 'watchdog',
      total: result.counts.total,
      stalled: result.counts.stalled,
      nudged: result.counts.nudged,
    });
  }
}
