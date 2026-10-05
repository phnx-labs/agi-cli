/** The pending-device sentinel dir is the contract between the daemon probe (writer) and the
 * menu-bar helper (reader). Guards: reconcile adds and removes sentinels; a path-traversal name
 * cannot escape the dir; ignored (RUSH-2495) or registered devices are never written. */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-devices-pending-test-'));
process.env.HOME = TEST_HOME;
// Point devices registry/ignore at the hermetic home (tests/setup pins a shared
// AGENTS_DEVICES_DIR; this suite needs its own registry for registered-name
// filtering).
process.env.AGENTS_DEVICES_DIR = path.join(TEST_HOME, '.agents', '.history', 'devices');
process.env.AGENTS_STATE_DIR = path.join(TEST_HOME, '.agents', '.cache', 'state');

const {
  reconcilePendingSentinels,
  pruneDismissedPendingSentinels,
  clearPendingSentinel,
  readPendingSentinels,
} = await import('./pending.js');
const { addIgnored, removeIgnored, upsertDevice, removeDevice } = await import('./registry.js');

function pendingDir(): string {
  return path.join(TEST_HOME, '.agents', '.cache', 'state', 'devices-pending');
}

beforeEach(async () => {
  await fsp.rm(pendingDir(), { recursive: true, force: true });
  await fsp.rm(process.env.AGENTS_DEVICES_DIR!, { recursive: true, force: true });
});

afterAll(async () => {
  await fsp.rm(TEST_HOME, { recursive: true, force: true });
});

describe('pending-device sentinels', () => {
  it('creates one sentinel per pending device with the platform as content', async () => {
    await reconcilePendingSentinels([{ name: 'zion', platform: 'macos' }, { name: 'win-mini', platform: 'windows' }]);
    const read = readPendingSentinels().sort((a, b) => a.name.localeCompare(b.name));
    expect(read).toEqual([
      { name: 'win-mini', platform: 'windows' },
      { name: 'zion', platform: 'macos' },
    ]);
  });

  it('removes a sentinel that is no longer pending on the next reconcile', async () => {
    await reconcilePendingSentinels([{ name: 'zion', platform: 'macos' }, { name: 'win-mini', platform: 'windows' }]);
    // zion got registered → only win-mini remains pending.
    await reconcilePendingSentinels([{ name: 'win-mini', platform: 'windows' }]);
    expect(readPendingSentinels().map((p) => p.name)).toEqual(['win-mini']);
  });

  it('reconcile to empty clears everything', async () => {
    await reconcilePendingSentinels([{ name: 'zion', platform: 'macos' }]);
    await reconcilePendingSentinels([]);
    expect(readPendingSentinels()).toEqual([]);
  });

  it('clearPendingSentinel removes exactly one and no-ops when absent', async () => {
    await reconcilePendingSentinels([{ name: 'zion', platform: 'macos' }, { name: 'win-mini', platform: 'windows' }]);
    clearPendingSentinel('zion');
    expect(readPendingSentinels().map((p) => p.name)).toEqual(['win-mini']);
    expect(() => clearPendingSentinel('zion')).not.toThrow(); // already gone
  });

  it('ignores a path-traversal device name (never escapes the dir)', async () => {
    await reconcilePendingSentinels([{ name: '../evil', platform: 'linux' }]);
    // Nothing written outside; the unsafe name is filtered out.
    expect(fs.existsSync(path.join(TEST_HOME, '.agents', '.cache', 'state', 'evil'))).toBe(false);
    expect(readPendingSentinels()).toEqual([]);
  });

  it('never re-surfaces a device the user has ignored, even in a stale pending set (RUSH-2495)', async () => {
    // The user dismissed 'ghost' (the menu-bar Ignore action persists it via
    // addIgnored). A device-probe that computed its `pending` set BEFORE the
    // dismissal landed still passes 'ghost' in — the writer must drop it.
    await addIgnored('ghost');
    try {
      await reconcilePendingSentinels([
        { name: 'ghost', platform: 'linux' },
        { name: 'zion', platform: 'macos' },
      ]);
      expect(readPendingSentinels().map((p) => p.name)).toEqual(['zion']);
      // And a sentinel that already existed for a device that then got ignored is
      // removed on the next reconcile, not left behind.
      await reconcilePendingSentinels([{ name: 'ghost', platform: 'linux' }]);
      expect(readPendingSentinels()).toEqual([]);
    } finally {
      await removeIgnored('ghost');
    }
  });

  it('never re-surfaces a device already in the registry, even in a stale pending set', async () => {
    // Hermetic runs that redirect AGENTS_DEVICES_DIR empty the registry view while still writing
    // the live devices-pending dir, so every tailnet node would land as NEW, including real roster
    // boxes. The writer re-subtracts the live registry to drop those phantoms.
    await upsertDevice('zion', {
      platform: 'macos',
      address: { via: 'tailscale', dnsName: 'zion.example.ts.net' },
    });
    try {
      await reconcilePendingSentinels([
        { name: 'zion', platform: 'macos' },
        { name: 'newbox', platform: 'linux' },
      ]);
      expect(readPendingSentinels().map((p) => p.name)).toEqual(['newbox']);
      // A leftover sentinel for a device that later got registered is removed.
      await reconcilePendingSentinels([{ name: 'zion', platform: 'macos' }]);
      expect(readPendingSentinels()).toEqual([]);
    } finally {
      await removeDevice('zion');
    }
  });

  it('pruneDismissedPendingSentinels removes registered/ignored without a full reconcile', async () => {
    // Soft-fail recovery path: tailscale is down, so we cannot recompute the
    // full pending set, but we can still drop names we know are dismissed.
    await reconcilePendingSentinels([
      { name: 'ghost', platform: 'linux' },
      { name: 'zion', platform: 'macos' },
      { name: 'maybe-new', platform: 'linux' },
    ]);
    await addIgnored('ghost');
    await upsertDevice('zion', {
      platform: 'macos',
      address: { via: 'tailscale', dnsName: 'zion.example.ts.net' },
    });
    try {
      await pruneDismissedPendingSentinels();
      expect(readPendingSentinels().map((p) => p.name)).toEqual(['maybe-new']);
    } finally {
      await removeIgnored('ghost');
      await removeDevice('zion');
    }
  });
});
