/** Device-probe tick as a `PeriodicService` (RUSH-3193 P3): refresh registered devices'
 * reachability and detect new tailnet nodes, dropping a sentinel per pending device for the
 * menu-bar "NEW DEVICES" prompt. Never auto-registers or re-surfaces ignored/known devices. */

import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';

/** Matches the historical inline interval (daemon.ts DEVICE_PROBE_TICK_MS). */
const DEVICE_PROBE_TICK_MS = 3 * 60_000;
/** Hard cap per tick — a tailnet + reachability sweep, short enough that a hang never freezes the service for long. */
const DEVICE_PROBE_DEADLINE_MS = 90_000;

export class DeviceProbeService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'device-probe';
  readonly intervalMs = DEVICE_PROBE_TICK_MS;
  readonly deadlineMs = DEVICE_PROBE_DEADLINE_MS;

  protected async onStart(_ctx: DaemonContext): Promise<void> {
    // No connections/handles to open — each tick performs a fresh soft sync.
  }

  protected async onStop(): Promise<void> {
    // Nothing to release — the supervisor's timer teardown is the only cleanup needed.
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
