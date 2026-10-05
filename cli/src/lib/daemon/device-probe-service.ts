
import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';

const DEVICE_PROBE_TICK_MS = 3 * 60_000;
const DEVICE_PROBE_DEADLINE_MS = 90_000;

export class DeviceProbeService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'device-probe';
  readonly intervalMs = DEVICE_PROBE_TICK_MS;
  readonly deadlineMs = DEVICE_PROBE_DEADLINE_MS;

  protected async onStart(_ctx: DaemonContext): Promise<void> {
  }

  protected async onStop(): Promise<void> {
  }

  protected async onTick(ctx: DaemonContext): Promise<void> {
    const { runDeviceSync } = await import('../devices/sync.js');
    const { reconcilePendingSentinels, pruneDismissedPendingSentinels } = await import('../devices/pending.js');
    const dev = await runDeviceSync({ soft: true, mode: 'refresh' });
    if (!dev.ok) {
      await pruneDismissedPendingSentinels();
      if (dev.reason) ctx.log('WARN', `device probe soft-fail: ${dev.reason}`);
      return;
    }
    await reconcilePendingSentinels(dev.pending);
    if (dev.pending.length) {
      ctx.log('INFO', `devices: ${dev.pending.length} new pending (${dev.pending.map((p) => p.name).join(', ')})`);
    }
  }
}
