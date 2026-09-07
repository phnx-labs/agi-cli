import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { updateFleetSharedDeviceState } from './fleet-shared-state.js';
import type { DeviceProfile } from './devices/registry.js';
import type { ConfiguredDeviceRole } from './device-config.js';
import {
  electPublisher,
  peerPresentKeys,
  planAuthBundlePush,
  planReservedStoreSync,
  reconcileLocalWorkerSlots,
  reservedSyncTargets,
  syncReservedAuthBundle,
  syncReservedStores,
  type AuthSyncDevice,
  type ReservedSyncAccount,
  type ReservedSyncPeer,
} from './secrets-policy.js';
import { claudeAccountTokenKey, readClaudeAccountEmail } from './claude-account-token.js';
import { readSlots, slotDir } from './accounts/slots.js';
import { keychainRef, secretsKeychainItem, writeBundleWithItemsSync } from './secrets-client.js';
import type { SecretsBundle } from './secrets-types.js';
import { readMeta } from './state.js';
import { useFreshSecretsHome } from '../../tests/secrets-standalone.js';
import type { Meta, NativeAccountRecord } from './types.js';

const dirs: string[] = [];
function tempStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-auth-store-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function target(name: string, remoteAuth: AuthSyncDevice['remoteAuth']): AuthSyncDevice {
  return { name, reachable: true, pinned: true, remoteAuth };
}

function profile(name: string, online = true): DeviceProfile {
  return {
    name,
    platform: 'linux',
    shell: 'posix',
    address: { via: 'manual', dnsName: `${name}.example` },
    auth: { method: 'key' },
    tailscale: { online, direct: true },
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
  };
}

describe('planAuthBundlePush', () => {
  it('pushes only a known-missing, reachable, pinned peer from the elected source', () => {
    const plan = planAuthBundlePush(true, true, [
      target('missing', 'missing'),
      target('ready', 'ready'),
      target('invalid', 'invalid'),
      target('unknown', 'unknown'),
      { ...target('offline', 'missing'), reachable: false },
      { ...target('unpinned', 'missing'), pinned: false },
    ]);
    expect(plan).toEqual([
      { action: 'push', device: 'missing' },
      { action: 'skip', device: 'ready', reason: 'already present' },
      { action: 'skip', device: 'invalid', reason: 'remote auth bundle uses the wrong backend' },
      { action: 'skip', device: 'unknown', reason: 'no shared auth verdict has arrived from this peer' },
      { action: 'skip', device: 'offline', reason: 'unreachable' },
      { action: 'skip', device: 'unpinned', reason: expect.stringContaining('host key not pinned') },
    ]);
  });

  it('lets only the deterministic elected ready device push', () => {
    expect(planAuthBundlePush(true, false, [target('worker', 'missing')]))
      .toEqual([{ action: 'skip', device: 'worker', reason: 'another ready device is the elected auth publisher' }]);
    expect(planAuthBundlePush(false, false, [target('worker', 'missing')]))
      .toEqual([{ action: 'skip', device: 'worker', reason: 'no local file-backed auth bundle' }]);
  });
});

describe('auth sync through real fleet-shared files', () => {
  it('publishes readiness and does not probe or push a peer with an unknown verdict', async () => {
    const root = tempStore();
    const result = await syncReservedAuthBundle({
      userAgentsDir: root,
      localName: 'source',
      inspectLocal: () => ({ exists: true, ok: true }),
      listDevices: () => [profile('worker')],
      isPinned: () => true,
    });
    expect(result).toMatchObject({ publisher: 'source', stateChanged: true, pushed: [], errors: [] });
    expect(result.skipped).toEqual([{ device: 'worker', reason: expect.stringContaining('no shared auth verdict') }]);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'devices', 'source', 'daemon-state.json'), 'utf-8')))
      .toMatchObject({ version: 1, device: 'source', auth: { status: 'ready' } });
  });

  it('elects the same ready publisher from shared state and skips on non-owner devices', async () => {
    const root = tempStore();
    updateFleetSharedDeviceState('alpha', { auth: { status: 'ready' } }, root);
    updateFleetSharedDeviceState('worker', { auth: { status: 'missing' } }, root);
    const result = await syncReservedAuthBundle({
      userAgentsDir: root,
      localName: 'zulu',
      inspectLocal: () => ({ exists: true, ok: true }),
      listDevices: () => [profile('alpha'), profile('worker')],
      isPinned: () => true,
    });
    expect(result.publisher).toBe('alpha');
    expect(result.pushed).toEqual([]);
    expect(result.skipped.every((item) => item.reason.includes('elected auth publisher'))).toBe(true);
  });

  it('does not let a removed or known-offline stale ready file suppress the live source', async () => {
    for (const staleProfile of [undefined, profile('alpha', false)]) {
      const root = tempStore();
      updateFleetSharedDeviceState('alpha', { auth: { status: 'ready' } }, root);
      updateFleetSharedDeviceState('worker', { auth: { status: 'invalid' } }, root);
      const result = await syncReservedAuthBundle({
        userAgentsDir: root,
        localName: 'zulu',
        inspectLocal: () => ({ exists: true, ok: true }),
        listDevices: () => [...(staleProfile ? [staleProfile] : []), profile('worker')],
        isPinned: () => true,
      });
      expect(result.publisher).toBe('zulu');
      expect(result.skipped).toContainEqual({ device: 'worker', reason: 'remote auth bundle uses the wrong backend' });
    }
  });

  it('publishes missing/invalid verdicts without putting any credential material in the store', async () => {
    for (const [device, local, expected] of [
      ['missing-box', { exists: false, ok: true }, 'missing'],
      ['invalid-box', { exists: true, ok: false }, 'invalid'],
    ] as const) {
      const root = tempStore();
      await syncReservedAuthBundle({ userAgentsDir: root, localName: device, inspectLocal: () => local, listDevices: () => [] });
      const raw = fs.readFileSync(path.join(root, 'devices', device, 'daemon-state.json'), 'utf-8');
      expect(JSON.parse(raw)).toEqual({ version: 1, device, auth: { status: expected } });
      expect(raw).not.toMatch(/token|secret|credential/i);
    }
  });
});

// --- Generalized reserved-store sync (PHNX-3940 T6) -------------------------

function acct(over: Partial<ReservedSyncAccount>): ReservedSyncAccount {
  return { accountId: 'a1', harness: 'claude', bundle: '__claude__', key: 'CLAUDE_CODE_OAUTH_TOKEN_a1', fingerprint: 'm1', ...over };
}

function peer(over: Partial<ReservedSyncPeer>): ReservedSyncPeer {
  return { name: 'w1', headed: false, reachable: true, pinned: true, presentKeys: {}, ...over };
}

describe('planReservedStoreSync — per key, per role', () => {
  it('pushes a bundle to a worker missing at least one of its keys', () => {
    const accounts = [acct({ accountId: 'a1', key: 'K1' }), acct({ accountId: 'a2', key: 'K2' })];
    const plan = planReservedStoreSync(accounts, [peer({ name: 'w1', presentKeys: { __claude__: new Set(['K1']) } })]);
    expect(plan).toEqual([{ action: 'push', device: 'w1', bundle: '__claude__', keys: ['K2'] }]);
  });

  it('a newly-added account (no key present) propagates in one tick', () => {
    const plan = planReservedStoreSync([acct({ key: 'NEW' })], [peer({ presentKeys: { __claude__: new Set() } })]);
    expect(plan).toEqual([{ action: 'push', device: 'w1', bundle: '__claude__', keys: ['NEW'] }]);
  });

  it('skips a worker that already holds every key', () => {
    const plan = planReservedStoreSync([acct({ key: 'K1' })], [peer({ presentKeys: { __claude__: new Set(['K1']) } })]);
    expect(plan).toEqual([{ action: 'skip', device: 'w1', reason: 'all reserved credentials present' }]);
  });

  it('never pushes a durable key to a headed device (role filter)', () => {
    const plan = planReservedStoreSync([acct({ key: 'K1' })], [peer({ name: 'laptop', headed: true, presentKeys: {} })]);
    expect(plan).toEqual([{ action: 'skip', device: 'laptop', reason: 'headed device receives the account row, never a durable key' }]);
  });

  it('skips unreachable and unpinned peers', () => {
    const plan = planReservedStoreSync([acct({ key: 'K1' })], [
      peer({ name: 'off', reachable: false }),
      peer({ name: 'unpinned', pinned: false }),
    ]);
    expect(plan).toEqual([
      { action: 'skip', device: 'off', reason: 'unreachable' },
      { action: 'skip', device: 'unpinned', reason: expect.stringContaining('host key not pinned') },
    ]);
  });

  it('groups keys per bundle and is deterministic across peers and bundles', () => {
    const accounts = [
      acct({ accountId: 'c1', harness: 'claude', bundle: '__claude__', key: 'CK' }),
      acct({ accountId: 'x1', harness: 'grok', bundle: '__grok__', key: 'XK' }),
    ];
    const plan = planReservedStoreSync(accounts, [peer({ name: 'w2' }), peer({ name: 'w1' })]);
    expect(plan).toEqual([
      { action: 'push', device: 'w1', bundle: '__claude__', keys: ['CK'] },
      { action: 'push', device: 'w1', bundle: '__grok__', keys: ['XK'] },
      { action: 'push', device: 'w2', bundle: '__claude__', keys: ['CK'] },
      { action: 'push', device: 'w2', bundle: '__grok__', keys: ['XK'] },
    ]);
  });
});

describe('reservedSyncTargets', () => {
  function metaWith(rows: NativeAccountRecord[]): Pick<Meta, 'accounts' | 'deviceAccounts'> {
    return { accounts: { native: Object.fromEntries(rows.map((r) => [r.id, r])) } };
  }
  it('resolves a T1 workerCredential row to its bundle/key/fingerprint', () => {
    const m = metaWith([
      { id: 'a1', name: 'work', agent: 'claude', identityKey: 'claude:account=a:org=o', scope: 'version', identityLabel: 'w@x.io', workerCredential: { bundle: '__claude__', key: 'CLAUDE_CODE_OAUTH_TOKEN_a1', kind: 'setup-token', mintedAt: 'm1' } },
    ]);
    expect(reservedSyncTargets(m)).toEqual([{ accountId: 'a1', harness: 'claude', bundle: '__claude__', key: 'CLAUDE_CODE_OAUTH_TOKEN_a1', fingerprint: 'm1' }]);
  });
  it('falls back to the legacy auth bundle for a claude row predating T1', () => {
    const m = metaWith([
      { id: 'l1', name: 'dev', agent: 'claude', identityKey: 'claude:account=b:org=o', scope: 'version', identityLabel: 'dev@getrush.ai' },
    ]);
    const targets = reservedSyncTargets(m);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ accountId: 'l1', bundle: 'auth', fingerprint: 'legacy' });
    expect(targets[0].key).toMatch(/^CLAUDE_CODE_OAUTH_TOKEN_/);
  });
  it('drops a non-claude row with no workerCredential (no derivable durable credential)', () => {
    const m = metaWith([
      { id: 'k1', name: 'kimi', agent: 'kimi', identityKey: 'kimi:user=k', scope: 'version', identityLabel: 'k@x.io' },
    ]);
    expect(reservedSyncTargets(m)).toEqual([]);
  });
});

describe('peerPresentKeys', () => {
  const accounts = [
    acct({ accountId: 'a1', bundle: '__claude__', key: 'RK', fingerprint: 'm1' }),
    acct({ accountId: 'l1', bundle: 'auth', key: 'LK', fingerprint: 'legacy' }),
  ];
  it('marks a reserved key present only on a fingerprint-matching memo hit', () => {
    const memo = { 'w1 __claude__ RK': 'm1' };
    expect(peerPresentKeys('w1', accounts, memo, false).__claude__).toEqual(new Set(['RK']));
    // Stale fingerprint (re-mint) is NOT present → will re-push.
    expect(peerPresentKeys('w1', accounts, { 'w1 __claude__ RK': 'old' }, false).__claude__).toBeUndefined();
  });
  it('marks legacy auth keys present when the peer reports coarse ready', () => {
    expect(peerPresentKeys('w1', accounts, {}, true).auth).toEqual(new Set(['LK']));
    expect(peerPresentKeys('w1', accounts, {}, false).auth).toBeUndefined();
  });
});

describe('reconcileLocalWorkerSlots', () => {
  const rows: NativeAccountRecord[] = [
    { id: 'a1', name: 'work', agent: 'claude', identityKey: 'claude:account=a:org=o', scope: 'version', identityLabel: 'w@x.io', workerCredential: { bundle: '__claude__', key: 'K1', kind: 'setup-token', mintedAt: 'm1' } },
  ];
  const readMetaFn = () => ({ accounts: { native: Object.fromEntries(rows.map((r) => [r.id, r])) }, deviceAccounts: {} }) as Pick<Meta, 'accounts' | 'deviceAccounts'>;

  it('provisions a durable slot when the key is present and no slot exists', () => {
    const provisioned: string[] = [];
    const res = reconcileLocalWorkerSlots({ selfRole: 'worker', readMetaFn, hasLocalKey: () => true, provision: (a) => provisioned.push(a.id) });
    expect(provisioned).toEqual(['a1']);
    expect(res.provisioned).toEqual(['a1']);
  });

  it('skips a headed device entirely (provisions via native login)', () => {
    const provisioned: string[] = [];
    const res = reconcileLocalWorkerSlots({ selfRole: 'personal', readMetaFn, hasLocalKey: () => true, provision: (a) => provisioned.push(a.id) });
    expect(provisioned).toEqual([]);
    expect(res.provisioned).toEqual([]);
  });

  it('skips when the durable key has not synced yet', () => {
    const res = reconcileLocalWorkerSlots({ selfRole: 'worker', readMetaFn, hasLocalKey: () => false, provision: () => { throw new Error('should not provision'); } });
    expect(res.provisioned).toEqual([]);
    expect(res.skipped[0]).toMatchObject({ accountId: 'a1', reason: expect.stringContaining('not synced') });
  });

  it('is idempotent: skips an account already backed by a durable slot', () => {
    const withSlot = () => ({
      accounts: { native: Object.fromEntries(rows.map((r) => [r.id, r])) },
      deviceAccounts: { slots: { a1: { accountId: 'a1', slotDir: '/x', authMode: 'durable', verdict: 'unverified' } } },
    }) as Pick<Meta, 'accounts' | 'deviceAccounts'>;
    const res = reconcileLocalWorkerSlots({ selfRole: 'worker', readMetaFn: withSlot, hasLocalKey: () => true, provision: () => { throw new Error('should not re-provision'); } });
    expect(res.provisioned).toEqual([]);
    expect(res.skipped[0]).toMatchObject({ accountId: 'a1', reason: expect.stringContaining('already provisioned') });
  });

  // The mac-mini 2026-09-06 gap: every registered claude row predated T1 (no
  // `workerCredential`), so the loop skipped all 8 while their tokens sat in the
  // legacy `auth` bundle on the box. A legacy row resolves to (auth, email key)
  // exactly as the push plan does, and gets a slot from the same key.
  it('provisions a legacy claude row (no workerCredential) from its email-keyed auth token', () => {
    const legacy: NativeAccountRecord = { id: 'l1', name: 'dev', agent: 'claude', identityKey: 'claude:account=b:org=o', scope: 'version', identityLabel: 'dev@getrush.ai' };
    const kimi: NativeAccountRecord = { id: 'k1', name: 'kimi', agent: 'kimi', identityKey: 'kimi:user=k', scope: 'version', identityLabel: 'k@x.io' };
    const meta = () => ({ accounts: { native: { l1: legacy, k1: kimi } }, deviceAccounts: {} }) as Pick<Meta, 'accounts' | 'deviceAccounts'>;
    const asked: Array<[string, string]> = [];
    const provisioned: string[] = [];
    const res = reconcileLocalWorkerSlots({
      selfRole: 'worker',
      readMetaFn: meta,
      hasLocalKey: (bundle, key) => { asked.push([bundle, key]); return true; },
      provision: (a) => provisioned.push(a.id),
    });
    expect(asked).toEqual([['auth', claudeAccountTokenKey('dev@getrush.ai')]]);
    expect(provisioned).toEqual(['l1']);
    // A per-device harness row has no derivable durable credential: neither
    // provisioned nor reported as "not synced" — there is nothing to sync.
    expect(res.skipped).toEqual([]);
  });

  it('reports a legacy row whose auth key is not on this box as not synced yet', () => {
    const legacy: NativeAccountRecord = { id: 'l1', name: 'dev', agent: 'claude', identityKey: 'claude:account=b:org=o', scope: 'version', identityLabel: 'dev@getrush.ai' };
    const meta = () => ({ accounts: { native: { l1: legacy } }, deviceAccounts: {} }) as Pick<Meta, 'accounts' | 'deviceAccounts'>;
    const res = reconcileLocalWorkerSlots({ selfRole: 'worker', readMetaFn: meta, hasLocalKey: () => false, provision: () => { throw new Error('should not provision'); } });
    expect(res.skipped).toEqual([{ accountId: 'l1', reason: 'durable key not synced yet' }]);
  });
});

// End to end through the real standalone secrets store and the real slot
// writer: a legacy row + its token in a file-backed `auth` bundle ⇒ a durable
// slot with a 0600 `.oauth_token` and the seeded email the claude adapter keys
// the token on at spawn. No mocks; HOME is the vitest sandbox (tests/setup.ts).
describe('reconcileLocalWorkerSlots through the real auth bundle', () => {
  useFreshSecretsHome();
  const created: string[] = [];
  afterEach(() => {
    for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeAuthBundle(values: Record<string, string>): void {
    const bundle: SecretsBundle = { name: 'auth', backend: 'file', policy: 'never', vars: {}, meta: {} };
    const items = new Map<string, string>();
    for (const [key, value] of Object.entries(values)) {
      bundle.vars[key] = keychainRef(key);
      bundle.meta![key] = { type: 'token' };
      items.set(secretsKeychainItem('auth', key), value);
    }
    writeBundleWithItemsSync(bundle, items);
  }

  it('materializes a slot for a pre-T1 claude row from the synced auth token, and only once', () => {
    writeAuthBundle({
      [claudeAccountTokenKey('prix@example.com')]: 'sk-ant-oat01-prix',
      [claudeAccountTokenKey('trp@example.com')]: 'sk-ant-oat01-trp',
    });
    const rows: NativeAccountRecord[] = [
      { id: 'lp', name: 'prix', agent: 'claude', identityKey: 'claude:account=p:org=o', scope: 'version', identityLabel: 'prix@example.com' },
      { id: 'lt', name: 'trp', agent: 'claude', identityKey: 'claude:account=t:org=o', scope: 'version', identityLabel: 'trp@example.com' },
      // Registered, but its token never reached this box.
      { id: 'lm', name: 'smores', agent: 'claude', identityKey: 'claude:account=m:org=o', scope: 'version', identityLabel: 'smores@example.com' },
    ];
    const readMetaFn = () => ({ ...readMeta(), accounts: { native: Object.fromEntries(rows.map((r) => [r.id, r])) } });
    for (const id of ['lp', 'lt', 'lm']) created.push(slotDir('claude', id));

    const first = reconcileLocalWorkerSlots({ selfRole: 'worker', readMetaFn });
    expect(first.errors).toEqual([]);
    expect(first.provisioned.sort()).toEqual(['lp', 'lt']);
    expect(first.skipped).toEqual([{ accountId: 'lm', reason: 'durable key not synced yet' }]);

    for (const [id, token, email] of [['lp', 'sk-ant-oat01-prix', 'prix@example.com'], ['lt', 'sk-ant-oat01-trp', 'trp@example.com']] as const) {
      const dir = slotDir('claude', id);
      const tokenPath = path.join(dir, '.claude', '.oauth_token');
      expect(fs.readFileSync(tokenPath, 'utf-8')).toBe(token);
      expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
      expect(readClaudeAccountEmail(dir)).toBe(email);
      expect(readSlots(readMeta())[id]).toMatchObject({ slotDir: dir, authMode: 'durable' });
    }

    const second = reconcileLocalWorkerSlots({ selfRole: 'worker', readMetaFn });
    expect(second.provisioned).toEqual([]);
    expect(second.skipped.map((s) => s.accountId).sort()).toEqual(['lm', 'lp', 'lt']);
  });
});

describe('electPublisher', () => {
  const roles: Record<string, ConfiguredDeviceRole | undefined> = {
    zion: 'personal',
    'mac-studio': 'desktop',
    'mac-mini': 'worker',
    'yosemite-s1': 'worker',
    unmarked: undefined,
  };
  const roleOf = (name: string) => roles[name];

  it('prefers a ready headed device over a ready worker whatever the name order', () => {
    // The live 2026-09-06 shape: every device ready, name order alone elected mac-mini.
    expect(electPublisher(['mac-mini', 'yosemite-s1', 'zion'], roleOf)).toBe('zion');
    expect(electPublisher(['mac-mini', 'unmarked', 'mac-studio'], roleOf)).toBe('mac-studio');
  });

  it('breaks ties by name within a tier, and returns null with nobody ready', () => {
    expect(electPublisher(['zion', 'mac-studio'], roleOf)).toBe('mac-studio');
    expect(electPublisher(['yosemite-s1', 'mac-mini'], roleOf)).toBe('mac-mini');
    expect(electPublisher([], roleOf)).toBeNull();
  });

  it('is what both sync arms elect with, through real shared-state files', async () => {
    const root = tempStore();
    updateFleetSharedDeviceState('mac-mini', { auth: { status: 'ready' } }, root);
    const devices = [profile('mac-mini')];
    const peerRole = (name: string) => roles[name];
    const legacy = await syncReservedAuthBundle({
      userAgentsDir: root,
      localName: 'zion',
      inspectLocal: () => ({ exists: true, ok: true }),
      listDevices: () => devices,
      isPinned: () => true,
      peerRole,
      selfRole: () => 'personal',
      push: async () => ({ ok: true, message: 'pushed' }),
    });
    expect(legacy.publisher).toBe('zion');
    // mac-mini reports `ready`, so the legacy plan (bundle-coarse) skips it as present.
    expect(legacy.skipped).toEqual([{ device: 'mac-mini', reason: 'already present' }]);

    const reserved = await syncReservedStores({
      userAgentsDir: root,
      cacheDir: tempStore(),
      localName: 'zion',
      localReady: true,
      listDevices: () => devices,
      isPinned: () => true,
      peerRole,
      selfRole: () => 'personal',
      readMetaFn: () => ({ accounts: { native: { a1: { id: 'a1', name: 'work', agent: 'claude', identityKey: 'claude:account=a:org=o', scope: 'version', identityLabel: 'w@x.io', workerCredential: { bundle: '__claude__', key: 'K1', kind: 'setup-token', mintedAt: 'm1' } } } } }),
      hasLocalKey: () => true,
      adoptLegacy: async () => ({ adopted: [], errors: [] }),
      push: async () => ({ ok: true, message: 'pushed' }),
    });
    expect(reserved.publisher).toBe('zion');
    expect(reserved.pushed).toEqual([{ device: 'mac-mini', bundle: '__claude__', keys: ['K1'] }]);
  });

  it('syncReservedStores adopts legacy raw reserved items locally before planning and surfaces adoption errors', async () => {
    // 1.22.84–1.22.89 wrote `__<harness>__` keys as bare file items with no
    // bundle record, which the bundle push cannot read. The tick repairs that
    // on the publisher first, so a key added under the old code propagates
    // the moment the new release runs — and an adoption failure is reported
    // against the local box instead of being swallowed.
    const root = tempStore();
    const meta = { accounts: { native: { a1: { id: 'a1', name: 'gmail', agent: 'cursor', identityKey: 'cursor:user=u', scope: 'version', identityLabel: 'g.io', workerCredential: { bundle: '__cursor__', key: 'CURSOR_API_KEY_a1', kind: 'api-key', mintedAt: 'm1' } } } } } as const;
    const seen: unknown[] = [];
    const reserved = await syncReservedStores({
      userAgentsDir: root,
      cacheDir: tempStore(),
      localName: 'zion',
      localReady: true,
      listDevices: () => [profile('mac-mini')],
      isPinned: () => true,
      peerRole: () => 'worker',
      selfRole: () => 'personal',
      readMetaFn: () => meta,
      hasLocalKey: () => true,
      adoptLegacy: async (m) => { seen.push(m); return { adopted: [{ bundle: '__cursor__', key: 'CURSOR_API_KEY_a1' }], errors: [{ bundle: '__grok__', key: 'XAI_API_KEY_a2', message: 'boom' }] }; },
      push: async () => ({ ok: true, message: 'pushed' }),
    });
    expect(seen).toEqual([meta]);
    expect(reserved.adopted).toEqual([{ bundle: '__cursor__', key: 'CURSOR_API_KEY_a1' }]);
    expect(reserved.errors).toContainEqual({ device: 'zion', message: 'adopt __grok__ XAI_API_KEY_a2: boom' });
    expect(reserved.pushed).toEqual([{ device: 'mac-mini', bundle: '__cursor__', keys: ['CURSOR_API_KEY_a1'] }]);
  });
});
