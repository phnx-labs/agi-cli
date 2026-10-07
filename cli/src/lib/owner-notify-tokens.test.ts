import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startOwnerNotifyApi, type OwnerNotifyApi } from './testdata/owner-notify-api.js';
import { useFreshSecretsHome } from '../../tests/secrets-standalone.js';
import type { DeviceProfile } from './devices/registry.js';
import type { PushBundleResult } from './secrets-types.js';

let api: OwnerNotifyApi;
let tokens: typeof import('./owner-notify-tokens.js');
let identity: typeof import('./identity/client.js');
let shared: typeof import('./fleet-shared-state.js');
let reserved: typeof import('./reserved-stores.js');
let claudeToken: typeof import('./claude-account-token.js');
let usageSync: typeof import('./accounting/usage-sync.js');

beforeAll(async () => {
  api = await startOwnerNotifyApi();
  vi.resetModules();
  process.env.PHOENIX_ID_BASE = api.url;
  tokens = await import('./owner-notify-tokens.js');
  identity = await import('./identity/client.js');
  shared = await import('./fleet-shared-state.js');
  reserved = await import('./reserved-stores.js');
  claudeToken = await import('./claude-account-token.js');
  usageSync = await import('./accounting/usage-sync.js');
});

afterAll(async () => {
  await api.close();
});

function device(name: string): DeviceProfile {
  return { name, platform: 'linux', shell: 'bash', address: { ip: '100.64.0.1' }, auth: {}, createdAt: '', updatedAt: '' } as unknown as DeviceProfile;
}

const ROLES: Record<string, 'personal' | 'desktop' | 'worker'> = {
  zion: 'personal', pinnacles: 'desktop', 'worker-a': 'worker', 'worker-b': 'worker',
};

describe('syncOwnerNotifyTokens — headed box mints one scoped token per worker', () => {
  const secretsHomeDir = useFreshSecretsHome();
  let root: string;
  let cacheDir: string;
  let pushes: Array<{ bundle: string; host: string }>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-notify-tokens-'));
    cacheDir = path.join(root, '.cache');
    pushes = [];
    api.deviceTokens.length = 0;
    api.requests.length = 0;
    identity.writeSession({ access_token: api.sessionToken });
  });

  afterEach(() => {
    identity.clearSession();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function peerState(name: string, ownerNotify: { signedIn: boolean; deviceToken: boolean }, receivedAt?: number) {
    return usageSync.applyPeerFleetState(
      { version: shared.FLEET_SHARED_STATE_VERSION, device: name, ownerNotify },
      { device: 'local-observer', userAgentsDir: root, cachePath: path.join(root, 'usage.json'), receivedAt },
    );
  }

  function tokenIds(): string[] {
    return api.deviceTokens.map((t) => t.id);
  }

  function run(localName = 'zion', devices = ['zion', 'pinnacles', 'worker-a', 'worker-b']) {
    return tokens.syncOwnerNotifyTokens({
      localName,
      userAgentsDir: root,
      cacheDir,
      listDevices: () => devices.map(device),
      selfRole: () => ROLES[localName],
      peerRole: (name) => ROLES[name],
      isPinned: () => true,
      sshTarget: (d) => `user@${d.name}`,
      push: async (bundle: string, host: string): Promise<PushBundleResult> => {
        pushes.push({ bundle, host });
        return { ok: true, host, bundle, keyCount: 1, message: 'pushed' };
      },
    });
  }

  it('mints for each worker that reports owner-notify state, stores it in that worker\'s own bundle, and pushes only there', async () => {
    await peerState('worker-a', { signedIn: false, deviceToken: false });
    await peerState('worker-b', { signedIn: false, deviceToken: false });
    await peerState('pinnacles', { signedIn: false, deviceToken: false });

    const result = await run();
    expect(result.minter).toBe('zion');
    expect(result.minted.sort()).toEqual(['worker-a', 'worker-b']);
    expect(pushes.sort((a, b) => a.bundle.localeCompare(b.bundle))).toEqual([
      { bundle: '__notify-worker-a__', host: 'user@worker-a' },
      { bundle: '__notify-worker-b__', host: 'user@worker-b' },
    ]);
    const minted = api.deviceTokens.find((t) => t.device === 'worker-a')!;
    expect(claudeToken.readReservedCredential(reserved.ownerNotifyStoreName('worker-a'), reserved.OWNER_NOTIFY_TOKEN_KEY)).toBe(minted.token);
    expect(api.requests.filter((r) => r.method === 'POST' && r.path === '/api/v1/auth/tokens').map((r) => r.body))
      .toEqual(expect.arrayContaining([{ device: 'worker-a', scopes: ['notify'] }, { device: 'worker-b', scopes: ['notify'] }]));
    expect(pushes.map((p) => p.host)).not.toContain('user@pinnacles');
  });

  it('a second tick neither re-mints nor re-pushes once the worker reports its token', async () => {
    await peerState('worker-a', { signedIn: false, deviceToken: false });
    await run('zion', ['zion', 'worker-a']);
    await peerState('worker-a', { signedIn: false, deviceToken: true });
    pushes = [];
    const again = await run('zion', ['zion', 'worker-a']);
    expect(again.minted).toEqual([]);
    expect(pushes).toEqual([]);
    expect(again.skipped).toContainEqual({ device: 'worker-a', reason: 'token present' });
  });

  it('re-pushes the stored token when the worker lost it, without minting a replacement', async () => {
    await peerState('worker-a', { signedIn: false, deviceToken: false });
    await run('zion', ['zion', 'worker-a']);
    const before = api.deviceTokens.map((t) => t.id);
    pushes = [];
    const again = await run('zion', ['zion', 'worker-a']);
    expect(again.minted).toEqual([]);
    expect(pushes).toEqual([{ bundle: '__notify-worker-a__', host: 'user@worker-a' }]);
    expect(api.deviceTokens.map((t) => t.id)).toEqual(before);
  });

  it('only the first signed-in headed box by name mints', async () => {
    await peerState('worker-a', { signedIn: false, deviceToken: false });
    await peerState('pinnacles', { signedIn: true, deviceToken: false });
    const fromZion = await run('zion');
    expect(fromZion.minter).toBe('pinnacles');
    expect(fromZion.minted).toEqual([]);
    expect(api.deviceTokens).toEqual([]);
  });

  it('ignores a headed peer whose signed-in report is stale, so a dead box is not elected', async () => {
    await peerState('worker-a', { signedIn: false, deviceToken: false });
    await peerState('pinnacles', { signedIn: true, deviceToken: false }, Date.now() - tokens.OWNER_NOTIFY_PEER_FRESH_MS - 60_000);
    const fromZion = await run('zion');
    expect(fromZion.minter).toBe('zion');
    expect(fromZion.minted).toEqual(['worker-a']);
  });

  it('leaves a token another box minted while the worker reports it usable', async () => {
    await peerState('worker-a', { signedIn: false, deviceToken: true });
    api.deviceTokens.push({ id: 'tok-foreign', token: 'foreign', device: 'worker-a', createdAt: '' });
    const result = await run('zion', ['zion', 'worker-a']);
    expect(result.skipped).toContainEqual({ device: 'worker-a', reason: 'token present' });
    expect(tokenIds()).toEqual(['tok-foreign']);
  });

  it('replaces a live token it does not hold when the worker reports none, so a lost memo or replaced minter never strands it', async () => {
    await peerState('worker-a', { signedIn: false, deviceToken: false });
    api.deviceTokens.push({ id: 'tok-foreign', token: 'foreign', device: 'worker-a', createdAt: '' });
    const result = await run('zion', ['zion', 'worker-a']);
    expect(result.minted).toEqual(['worker-a']);
    expect(api.requests.map((r) => `${r.method} ${r.path}`)).toContain('DELETE /api/v1/auth/tokens/tok-foreign');
    const fresh = api.deviceTokens.find((t) => t.device === 'worker-a')!;
    expect(fresh.id).not.toBe('tok-foreign');
    expect(claudeToken.readReservedCredential(reserved.ownerNotifyStoreName('worker-a'), reserved.OWNER_NOTIFY_TOKEN_KEY)).toBe(fresh.token);
    expect(pushes).toEqual([{ bundle: '__notify-worker-a__', host: 'user@worker-a' }]);

    fs.rmSync(cacheDir, { recursive: true, force: true });
    pushes = [];
    const afterMemoLoss = await run('zion', ['zion', 'worker-a']);
    expect(afterMemoLoss.minted).toEqual(['worker-a']);
    expect(api.deviceTokens.filter((t) => t.device === 'worker-a')).toHaveLength(1);
    expect(pushes).toHaveLength(1);
  });

  it('revokes the token of a device that left the fleet or stopped being a worker', async () => {
    await peerState('worker-a', { signedIn: false, deviceToken: false });
    await run('zion', ['zion', 'worker-a', 'worker-b']);
    api.deviceTokens.push({ id: 'tok-gone', token: 'gone', device: 'retired-box', createdAt: '' });
    api.deviceTokens.push({ id: 'tok-headed', token: 'headed', device: 'pinnacles', createdAt: '' });
    const kept = api.deviceTokens.find((t) => t.device === 'worker-a')!.id;

    const result = await run('zion', ['zion', 'pinnacles', 'worker-a']);
    expect(result.revoked.sort()).toEqual(['pinnacles', 'retired-box']);
    expect(tokenIds()).toEqual([kept]);

    const dropped = await run('zion', ['zion']);
    expect(dropped.revoked).toEqual(['worker-a']);
    expect(api.deviceTokens).toEqual([]);
    expect(claudeToken.readReservedCredential(reserved.ownerNotifyStoreName('worker-a'), reserved.OWNER_NOTIFY_TOKEN_KEY)).toBeNull();
  });

  it('logout revokes every token this box minted and forgets them', async () => {
    await peerState('worker-a', { signedIn: false, deviceToken: false });
    await peerState('worker-b', { signedIn: false, deviceToken: false });
    await run();
    api.deviceTokens.push({ id: 'tok-other', token: 'other', device: 'worker-c', createdAt: '' });
    const out = await tokens.revokeMintedOwnerNotifyTokens(cacheDir);
    expect(out).toEqual({ revoked: ['worker-a', 'worker-b'], errors: [] });
    expect(tokenIds()).toEqual(['tok-other']);
    expect(await tokens.revokeMintedOwnerNotifyTokens(cacheDir)).toEqual({ revoked: [], errors: [] });
  });

  it.skipIf(process.getuid?.() === 0)('revokes a freshly minted token when it cannot be stored, so the next tick mints again', async () => {
    await peerState('worker-a', { signedIn: false, deviceToken: false });
    const secretsHome = secretsHomeDir();
    fs.chmodSync(secretsHome, 0o500);
    let result: Awaited<ReturnType<typeof run>>;
    try {
      result = await run('zion', ['zion', 'worker-a']);
    } finally {
      fs.chmodSync(secretsHome, 0o700);
    }
    expect(result.errors.map((e) => e.device)).toContain('worker-a');
    expect(pushes).toEqual([]);
    expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual(expect.arrayContaining([
      'POST /api/v1/auth/tokens',
      expect.stringMatching(/^DELETE \/api\/v1\/auth\/tokens\/tok-/),
    ]));
    expect(api.deviceTokens).toEqual([]);
  });

  it('does nothing on a worker or a signed-out headed box, and skips a peer on an older CLI', async () => {
    expect(await run('worker-a')).toMatchObject({ minter: null, minted: [], pushed: [] });
    identity.clearSession();
    expect(await run('zion')).toMatchObject({ minter: null, minted: [], pushed: [] });
    identity.writeSession({ access_token: api.sessionToken });
    const result = await run('zion', ['zion', 'worker-a']);
    expect(result.skipped).toContainEqual({ device: 'worker-a', reason: 'no owner-notify state from this peer yet' });
    expect(api.deviceTokens).toHaveLength(0);
  });

  it("publishes this box's own owner-notify state for peers to read", async () => {
    const published = await tokens.publishOwnerNotifyState({ device: 'zion', userAgentsDir: root });
    expect(published).toMatchObject({ signedIn: true, deviceToken: false });
    expect(shared.readOwnFleetSharedDeviceState('zion', root).ownerNotify).toEqual({ signedIn: true, deviceToken: false });
  });
});
