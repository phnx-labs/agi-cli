import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startOwnerNotifyApi, type OwnerNotifyApi } from './testdata/owner-notify-api.js';
import { useFreshSecretsHome } from '../../tests/secrets-standalone.js';
import type { OpenBlock } from './feed/feed.js';
import type { Meta } from './types.js';

let api: OwnerNotifyApi;
let ownerNotify: typeof import('./owner-notify.js');
let identity: typeof import('./identity/client.js');
let notify: typeof import('./notify.js');
let send: typeof import('./channels/send.js');
let broadcast: typeof import('./feed-broadcast.js');
let routines: typeof import('./routine-notify-owner.js');
let authMint: typeof import('./auth-mint.js');
let reserved: typeof import('./reserved-stores.js');

const SESSION = '6fc1db18-1111-4222-8333-444455556666';

beforeAll(async () => {
  api = await startOwnerNotifyApi();
  vi.resetModules();
  process.env.RUSH_PROXY_BASE = api.url;
  process.env.PHOENIX_ID_BASE = api.url;
  ownerNotify = await import('./owner-notify.js');
  identity = await import('./identity/client.js');
  notify = await import('./notify.js');
  send = await import('./channels/send.js');
  broadcast = await import('./feed-broadcast.js');
  routines = await import('./routine-notify-owner.js');
  authMint = await import('./auth-mint.js');
  reserved = await import('./reserved-stores.js');
});

afterAll(async () => {
  await api.close();
});

beforeEach(() => {
  api.requests.length = 0;
  api.dedupKeys.length = 0;
  identity.writeSession({ access_token: api.sessionToken, email: 'owner@example.com' });
});

afterEach(() => {
  identity.clearSession();
});

function notifications() {
  return api.requests.filter((r) => r.path === '/me/notifications').map((r) => r.body as Record<string, unknown>);
}

describe('postOwnerNotification — the one owner path', () => {
  useFreshSecretsHome();

  it('posts the contract shape with the Phoenix session as bearer and returns the dispatch result', async () => {
    const result = await ownerNotify.postOwnerNotification({
      event: 'message', title: 'Hi', body: 'hello owner', dedupKey: 'k-1', source: { device: 'zion', agent: 'claude' },
    });
    expect(result).toMatchObject({ delivered: ['slack'], queued: ['imessage'], skipped: [], suppressed: null });
    expect(api.requests[0]).toMatchObject({
      method: 'POST', path: '/me/notifications', bearer: api.sessionToken,
      body: { event: 'message', title: 'Hi', body: 'hello owner', dedupKey: 'owner:k-1', source: { device: 'zion', agent: 'claude' } },
    });
  });

  it('throws OwnerNotSignedInError with no session and no device token, and sends nothing', async () => {
    identity.clearSession();
    await expect(ownerNotify.postOwnerNotification({ event: 'message', title: 't', body: 'b', dedupKey: 'k-2' }))
      .rejects.toBeInstanceOf(ownerNotify.OwnerNotSignedInError);
    expect(api.requests).toHaveLength(0);
  });

  it("falls to this worker's device token from its reserved store when there is no session", async () => {
    identity.clearSession();
    const device = ownerNotify.selfDeviceName();
    api.deviceTokens.push({ id: 'tok-w', token: 'phx-device-self', device, createdAt: new Date().toISOString() });
    authMint.writeReservedStoreItem(reserved.ownerNotifyStoreName(device), reserved.OWNER_NOTIFY_TOKEN_KEY, 'phx-device-self', 'test');
    expect(ownerNotify.resolveOwnerCredential()).toEqual({ kind: 'device', token: 'phx-device-self' });
    await ownerNotify.postOwnerNotification({ event: 'failed', title: 't', body: 'b', dedupKey: 'k-3' });
    expect(api.requests[0].bearer).toBe('phx-device-self');
  });

  it('namespaces every producer key as owner:<key> on the wire, exactly once', async () => {
    const keys = ['block:blk-9', 'feed:s:2026-10-06T12:00:00Z', 'routine:nightly:run-1', 'routine-start:nightly:2026-10-06T00:00:00.000Z', 'send:u-1'];
    for (const dedupKey of keys) await ownerNotify.postOwnerNotification({ event: 'message', title: 't', body: 'b', dedupKey });
    expect(api.dedupKeys).toEqual(keys.map((k) => `owner:${k}`));
  });

  it('marks a device token rush/api rejects as unusable, so its worker reports deviceToken: false', async () => {
    identity.clearSession();
    const device = ownerNotify.selfDeviceName();
    authMint.writeReservedStoreItem(reserved.ownerNotifyStoreName(device), reserved.OWNER_NOTIFY_TOKEN_KEY, 'phx-device-revoked', 'test');
    expect(ownerNotify.hasUsableDeviceToken(device)).toBe(true);
    await expect(ownerNotify.postOwnerNotification({ event: 'failed', title: 't', body: 'b', dedupKey: 'k-5' }))
      .rejects.toThrow(/re-mints it/);
    expect(ownerNotify.hasUsableDeviceToken(device)).toBe(false);
    authMint.writeReservedStoreItem(reserved.ownerNotifyStoreName(device), reserved.OWNER_NOTIFY_TOKEN_KEY, 'phx-device-fresh', 'test');
    expect(ownerNotify.hasUsableDeviceToken(device)).toBe(true);
  });

  it('clears the rejected mark once the same device token authenticates again', async () => {
    identity.clearSession();
    const device = ownerNotify.selfDeviceName();
    authMint.writeReservedStoreItem(reserved.ownerNotifyStoreName(device), reserved.OWNER_NOTIFY_TOKEN_KEY, 'phx-device-flaky', 'test');
    await expect(ownerNotify.postOwnerNotification({ event: 'failed', title: 't', body: 'b', dedupKey: 'k-6' })).rejects.toThrow(/re-mints it/);
    expect(ownerNotify.hasUsableDeviceToken(device)).toBe(false);
    api.deviceTokens.push({ id: 'tok-flaky', token: 'phx-device-flaky', device, createdAt: new Date().toISOString() });
    await ownerNotify.postOwnerNotification({ event: 'failed', title: 't', body: 'b', dedupKey: 'k-7' });
    expect(ownerNotify.hasUsableDeviceToken(device)).toBe(true);
  });

  it('names the fix when rush/api rejects the session', async () => {
    identity.writeSession({ access_token: 'stale-token' });
    await expect(ownerNotify.postOwnerNotification({ event: 'message', title: 't', body: 'b', dedupKey: 'k-4' }))
      .rejects.toThrow(/agents auth login/);
  });
});

describe('producers map onto account events', () => {
  function block(): OpenBlock {
    return {
      blockId: 'blk-1', sessionId: SESSION, mailboxId: 'm1', host: 'zion', runtime: 'headless',
      ts: '2026-10-06T12:00:00.000Z', questions: [{ header: 'Deploy', text: 'Ship it?' }],
    };
  }

  it('an urgent feed block is a needs_you event keyed on the block, so a repeat is suppressed server-side', async () => {
    expect(await notify.notifyUrgentBlock(block())).toEqual({ ok: true });
    expect(await notify.notifyUrgentBlock(block())).toEqual({ ok: true });
    const [first] = notifications();
    expect(first).toMatchObject({ event: 'needs_you', title: 'Deploy', sessionId: SESSION, dedupKey: 'owner:block:blk-1', source: { device: 'zion' } });
    expect(String(first.body)).toContain('Ship it?');
  });

  it('a --blocked post and an important post reach the owner through the default sink, as needs_you and message', async () => {
    const config = broadcast.effectiveBroadcastConfig(undefined, 'important');
    expect(config).toEqual({ owner: { channel: 'owner' } });
    const blocked = broadcast.blockBroadcastContext({ ...block(), blockId: 'blk-2' }, { title: 'Publish?', body: 'npm publish now?' });
    const posted = { title: 'Release out', text: '1.22.200 is live', level: 'important' as const, host: 'zion', agent: 'claude', session: SESSION, eventKey: `${SESSION}:2026-10-06T12:01:00Z` };
    const outcomes = [
      ...(await broadcast.runFeedBroadcast(broadcast.planFeedBroadcast(config, blocked), {} as Meta)),
      ...(await broadcast.runFeedBroadcast(broadcast.planFeedBroadcast(config, posted), {} as Meta)),
    ];
    expect(outcomes).toEqual([{ name: 'owner', ok: true }, { name: 'owner', ok: true }]);
    const [needsYou, message] = notifications();
    expect(needsYou).toMatchObject({ event: 'needs_you', title: 'Publish?', dedupKey: 'owner:block:blk-2' });
    expect(message).toMatchObject({ event: 'message', title: 'Release out', dedupKey: `owner:feed:${SESSION}:2026-10-06T12:01:00Z`, source: { device: 'zion', agent: 'claude' } });
    expect(String(message.body)).toContain('1.22.200 is live');
    expect(String(message.body)).not.toContain('Release out');
  });

  it('a signed-out box reports the owner sink as failed instead of silently succeeding', async () => {
    identity.clearSession();
    const ctx = { title: 't', text: 'b', level: 'important' as const, eventKey: 'e1' };
    const [outcome] = await broadcast.runFeedBroadcast(broadcast.planFeedBroadcast({ owner: { channel: 'owner' } }, ctx), {} as Meta);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/agents auth login/);
    expect(broadcast.blockDeliveryFailure(true, [outcome])).toMatch(/NOT delivered/);
  });

  it('agents send --to owner is a message event; an explicit channel is refused rather than half-honoured', async () => {
    const out = await send.sendMessage({ to: 'owner', text: 'need a decision on the release', urls: ['https://example.com/pr/1'] }, {} as Meta);
    expect('result' in out && out.result.ok).toBe(true);
    const [sent] = notifications();
    expect(sent).toMatchObject({ event: 'message', url: 'https://example.com/pr/1' });
    expect(String(sent.dedupKey)).toMatch(/^owner:send:/);
    expect(String(sent.body)).toContain('need a decision on the release');

    expect(await send.sendMessage({ to: 'owner', channel: 'slack', text: 'x' }, {} as Meta)).toEqual({ error: expect.stringMatching(/cannot be combined with --channel/) });
    expect(await send.sendMessage({ to: 'owner', text: 'x', attachments: ['/tmp/a.png'] }, {} as Meta)).toEqual({ error: expect.stringMatching(/--attach does not apply/) });
    expect(notifications()).toHaveLength(1);
  });

  it('a failed routine run is one failed event per run; a green run stays silent', async () => {
    const run = { jobName: 'nightly', runId: 'run-A', status: 'failed', exitCode: 1, errorMessage: 'auth_failed: 401', agent: 'claude' } as Parameters<typeof routines.notifyOwnerRoutineFinish>[0];
    await routines.notifyOwnerRoutineFinish(run);
    const second = await routines.notifyOwnerRoutineFinish(run);
    expect(second?.suppressed).toBe('duplicate');
    expect(await routines.notifyOwnerRoutineFinish({ ...run, runId: 'run-B', status: 'completed', exitCode: 0 })).toBeNull();
    const [failed] = notifications();
    expect(failed).toMatchObject({ event: 'failed', title: 'Routine failed: nightly', dedupKey: 'owner:routine:nightly:run-A' });
    expect(String(failed.body)).toContain('auth_failed: 401');
    expect(notifications()).toHaveLength(2);
  });
});
