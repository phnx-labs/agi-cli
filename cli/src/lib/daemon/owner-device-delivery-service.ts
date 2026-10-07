import type { DaemonServiceId } from '../daemon-services.js';
import { sendImessage } from '../channels/providers/rush.js';
import {
  claimDeviceDeliveries,
  reportDeviceDelivery,
  resolveOwnerCredential,
  selfDeviceName,
} from '../owner-notify.js';
import { BasePeriodicService, type DaemonContext } from './service.js';

const OWNER_DEVICE_DELIVERY_TICK_MS = 15_000;
const OWNER_DEVICE_DELIVERY_DEADLINE_MS = 60_000;

export class OwnerDeviceDeliveryService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'owner-device-delivery';
  readonly intervalMs = OWNER_DEVICE_DELIVERY_TICK_MS;
  readonly deadlineMs = OWNER_DEVICE_DELIVERY_DEADLINE_MS;

  protected async onStart(_ctx: DaemonContext): Promise<void> {}
  protected async onStop(): Promise<void> {}

  protected async onTick(ctx: DaemonContext): Promise<void> {
    if (!resolveOwnerCredential()) return;
    const deliveries = await claimDeviceDeliveries(selfDeviceName());
    for (const delivery of deliveries) {
      const sent = await sendImessage(delivery.body, { target: delivery.address });
      if (!sent.ok) ctx.log('WARN', `owner-device-delivery: ${delivery.id} to ${delivery.address}: ${sent.error}`);
      try {
        await reportDeviceDelivery(delivery.id, sent.ok ? { ok: true } : { ok: false, error: sent.error ?? 'iMessage send failed' });
      } catch (err) {
        ctx.log('WARN', `owner-device-delivery: ${delivery.id} ${sent.ok ? 'sent' : 'failed'} but the result was not recorded: ${(err as Error).message}`);
      }
    }
  }
}
