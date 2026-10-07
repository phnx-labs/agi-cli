import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startOwnerNotifyApi, type OwnerNotifyApi } from '../testdata/owner-notify-api.js';

// Off macOS the real osascript sender refuses, which exercises claim → send → report without texting anyone.
describe.skipIf(process.platform === 'darwin')('OwnerDeviceDeliveryService', () => {
  let api: OwnerNotifyApi;
  let service: InstanceType<typeof import('./owner-device-delivery-service.js').OwnerDeviceDeliveryService>;
  let identity: typeof import('../identity/client.js');
  let ownerNotify: typeof import('../owner-notify.js');
  const logs: string[] = [];
  const ctx = { log: (level: string, message: string) => { logs.push(`${level} ${message}`); } };

  beforeAll(async () => {
    api = await startOwnerNotifyApi();
    vi.resetModules();
    process.env.RUSH_PROXY_BASE = api.url;
    const { OwnerDeviceDeliveryService } = await import('./owner-device-delivery-service.js');
    identity = await import('../identity/client.js');
    ownerNotify = await import('../owner-notify.js');
    service = new OwnerDeviceDeliveryService();
  });

  afterAll(async () => {
    identity.clearSession();
    await api.close();
  });

  it('claims each queued iMessage for this device, sends it, and reports the outcome back', async () => {
    identity.writeSession({ access_token: api.sessionToken });
    await ownerNotify.postOwnerNotification({ event: 'needs_you', title: 'Blocked', body: 'publish now?', dedupKey: 'block:b1' });
    expect(api.deliveries).toHaveLength(1);

    await service.tick(ctx, new AbortController().signal);

    const claim = api.requests.find((r) => r.path === '/me/device-deliveries/claim');
    expect(claim?.body).toEqual({ device: ownerNotify.selfDeviceName(), limit: 10 });
    expect(api.deliveries[0]).toMatchObject({
      claimedBy: ownerNotify.selfDeviceName(),
      result: { ok: false, error: 'iMessage requires macOS' },
    });
    expect(logs.some((l) => l.startsWith('WARN owner-device-delivery:'))).toBe(true);
  });

  it('stays idle with no session and no device token', async () => {
    identity.clearSession();
    api.requests.length = 0;
    await service.tick(ctx, new AbortController().signal);
    expect(api.requests).toEqual([]);
  });
});
