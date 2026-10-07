import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startOwnerNotifyApi, type OwnerNotifyApi } from './testdata/owner-notify-api.js';
import { useFreshSecretsHome } from '../../tests/secrets-standalone.js';
import type { DeviceProfile } from './devices/registry.js';
import type { PushBundleResult } from './secrets-types.js';

// The Phoenix base is read at import, so the modules under test load after the fixture is up.
let api: OwnerNotifyApi;
let tokens: typeof import('./owner-notify-tokens.js');
let identity: typeof import('./identity/client.js');
let shared: typeof import('./fleet-shared-state.js');
let reserved: typeof import('./reserved-stores.js');
let claudeToken: typeof import('./claude-account-token.js');

beforeAll(async () => {
  api = await startOwnerNotifyApi();
  vi.resetModules();
  process.env.PHOENIX_ID_BASE = api.url;
  tokens = await import('./owner-notify-tokens.js');
  identity = await import('./identity/client.js');
  shared = await import('./fleet-shared-state.js');
  reserved = await import('./reserved-stores.js');
  claudeToken = await import('./claude-account-token.js');
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
  useFreshSecretsHome();
  let root: string;
  let cacheDir: string;
  let pushes: Array<{ bundle: string; host: string }>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-notify-tokens-'));
    cacheDir = path.join(root, '.cache');
    pushes = [];
    api.deviceTokens.length = 0;
    identity.writeSession({ access_token: api.sessionToken });
  });

  afterEach(() => {
    identity.clearSession();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function peerState(name: string, ownerNotify: { signedIn: boolean; deviceToken: boolean }): void {
    shared.updateFleetSharedDeviceState(name, { ownerNotify }, root);
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
    peerState('worker-a', { signedIn: false, deviceToken: false });
    peerState('worker-b', { signedIn: false, deviceToken: false });
    peerState('pinnacles', { signedIn: false, deviceToken: false });

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
    peerState('worker-a', { signedIn: false, deviceToken: false });
    await run('zion', ['zion', 'worker-a']);
    peerState('worker-a', { signedIn: false, deviceToken: true });
    pushes = [];
    const again = await run('zion', ['zion', 'worker-a']);
    expect(again.minted).toEqual([]);
    expect(pushes).toEqual([]);
    expect(again.skipped).toContainEqual({ device: 'worker-a', reason: 'token present' });
  });

  it('re-pushes the stored token when the worker lost it, without minting a replacement', async () => {
    peerState('worker-a', { signedIn: false, deviceToken: false });
    await run('zion', ['zion', 'worker-a']);
    const before = api.deviceTokens.map((t) => t.id);
    pushes = [];
    const again = await run('zion', ['zion', 'worker-a']);
    expect(again.minted).toEqual([]);
    expect(pushes).toEqual([{ bundle: '__notify-worker-a__', host: 'user@worker-a' }]);
    expect(api.deviceTokens.map((t) => t.id)).toEqual(before);
  });

  it('only the first signed-in headed box mints, and it never replaces a token another box minted', async () => {
    peerState('worker-a', { signedIn: false, deviceToken: false });
    peerState('pinnacles', { signedIn: true, deviceToken: false });
    const fromZion = await run('zion');
    expect(fromZion.minter).toBe('pinnacles');
    expect(fromZion.minted).toEqual([]);

    peerState('zion', { signedIn: true, deviceToken: false });
    api.deviceTokens.push({ id: 'tok-foreign', token: 'foreign', device: 'worker-a', createdAt: '' });
    const fromPinnacles = await run('pinnacles');
    expect(fromPinnacles.minter).toBe('pinnacles');
    expect(fromPinnacles.skipped).toContainEqual({ device: 'worker-a', reason: 'its token was minted by another device' });
    expect(api.deviceTokens.find((t) => t.device === 'worker-a')?.id).toBe('tok-foreign');
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
