
import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { getConfigValueAsync } from '../device-config.js';
import { emitAsync } from '../feed/events.js';

const WATCHDOG_TICK_MS = 3 * 60_000;
const WATCHDOG_DEADLINE_MS = 120_000;

export class WatchdogService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'watchdog';
  readonly intervalMs = WATCHDOG_TICK_MS;
  readonly deadlineMs = WATCHDOG_DEADLINE_MS;

  protected async onStart(_ctx: DaemonContext): Promise<void> {
  }

  protected async onStop(): Promise<void> {
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
