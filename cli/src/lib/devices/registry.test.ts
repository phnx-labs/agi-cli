import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-devices-registry-test-'));
process.env.AGENTS_DEVICES_DIR = path.join(TEST_HOME, 'devices');

const { upsertDevice, loadDevices, getDevice, removeDevice, isDialableDevice } =
  await import('./registry.js');

function registryPath(): string {
  return path.join(TEST_HOME, 'devices', 'registry.json');
}

beforeAll(async () => {
  await fsp.mkdir(path.dirname(registryPath()), { recursive: true });
});

beforeEach(async () => {
  await fsp.rm(registryPath(), { force: true });
  await fsp.rm(`${registryPath()}.lock`, { recursive: true, force: true });
});

afterAll(async () => {
  await fsp.rm(TEST_HOME, { recursive: true, force: true });
});

describe('device registry round-trip', () => {
  it('persists a profile and reads it back identically', async () => {
    const created = await upsertDevice('win-mini', {
      platform: 'windows',
      user: 'muqsit',
      address: { via: 'tailscale', dnsName: 'win-mini.tail1a85a1.ts.net', ip: '100.68.123.39' },
      auth: { method: 'password', bundle: 'muqsit', bundleKey: 'password' },
      tailscale: { online: true, direct: true, relay: 'sfo', lastSeen: '2026-06-30T00:00:00Z' },
    });

    expect(created.shell).toBe('powershell');

    const back = await getDevice('win-mini');
    expect(back).toEqual(created);
    expect(back!.address.ip).toBe('100.68.123.39');
    expect(back!.auth).toEqual({ method: 'password', bundle: 'muqsit', bundleKey: 'password' });
  });

  it('merges fields on update and re-derives shell when platform flips', async () => {
    await upsertDevice('box', { platform: 'windows', user: 'admin' });
    const updated = await upsertDevice('box', { platform: 'linux' });
    expect(updated.platform).toBe('linux');
    expect(updated.shell).toBe('posix');
    expect(updated.user).toBe('admin');
  });

  it('removes a device and reports absence', async () => {
    await upsertDevice('temp', { platform: 'linux' });
    expect(await removeDevice('temp')).toBe(true);
    expect(await getDevice('temp')).toBeNull();
    expect(await removeDevice('temp')).toBe(false);
  });

  it('rejects a name that is not a valid ssh alias (would break ssh_config render)', async () => {
    await expect(upsertDevice("Bisma's MacBook Pro", { platform: 'macos' })).rejects.toThrow(/Invalid device name/);
    expect(await getDevice("Bisma's MacBook Pro")).toBeNull();
  });
});

describe('device registry concurrency', () => {
  it('serializes concurrent upserts so all land', async () => {
    const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
    const results = await Promise.allSettled(
      names.map((n) => upsertDevice(n, { platform: 'linux', user: n })),
    );
    for (const r of results) expect(r.status).toBe('fulfilled');
    const reg = await loadDevices();
    expect(Object.keys(reg).sort()).toEqual([...names].sort());
  });
});

describe('device registry corruption surfacing', () => {
  it('throws on an unparseable registry instead of returning {}', async () => {
    fs.writeFileSync(registryPath(), '{ not json');
    await expect(loadDevices()).rejects.toThrow(/Device registry corrupted/);
  });

  it('returns {} only when the file truly does not exist', async () => {
    expect(fs.existsSync(registryPath())).toBe(false);
    expect(await loadDevices()).toEqual({});
  });
});

describe('isDialableDevice', () => {
  it('dials a manually-registered device that the live probe reached', () => {
    expect(isDialableDevice({
      name: 'yosemite-s1',
      platform: 'linux',
      address: { via: 'manual', dnsName: 'yosemite-s1.tail1a85a1.ts.net' },
      reachability: { reachable: true, via: 'manual', checkedAt: '2026-08-03T15:30:39.876Z' },
    } as any)).toBe(true);
  });

  it('a failed probe never removes a peer the snapshot still calls online', () => {
    expect(isDialableDevice({
      name: 'mac-mini',
      platform: 'macos',
      address: { via: 'tailscale', dnsName: 'mac-mini.tail1a85a1.ts.net' },
      tailscale: { online: true },
      reachability: { reachable: false, via: 'tailscale', checkedAt: '2026-08-03T15:39:43.427Z' },
    } as any)).toBe(true);
  });

  it('a positive probe rescues a device whose snapshot says offline', () => {
    expect(isDialableDevice({
      name: 'woken-box',
      platform: 'linux',
      address: { via: 'tailscale', dnsName: 'woken-box.tail1a85a1.ts.net' },
      tailscale: { online: false },
      reachability: { reachable: true, via: 'tailscale', checkedAt: '2026-08-03T15:39:43.427Z' },
    } as any)).toBe(true);
  });

  it('keeps dialing a manual device even after a probe says it is unreachable', () => {
    expect(isDialableDevice({
      name: 'dead-manual',
      platform: 'linux',
      address: { via: 'manual', dnsName: 'dead-manual.ts.net' },
      reachability: { reachable: false, via: 'manual', checkedAt: '2026-08-03T15:39:43.504Z' },
    } as any)).toBe(true);
  });

  it('skips a box both signals call offline', () => {
    expect(isDialableDevice({
      name: 'gpu-box',
      platform: 'linux',
      address: { via: 'tailscale', dnsName: 'gpu-box.tail1a85a1.ts.net' },
      tailscale: { online: false },
      reachability: { reachable: false, via: 'tailscale', checkedAt: '2026-08-03T15:39:43.427Z' },
    } as any)).toBe(false);
  });

  it('falls back to the tailscale snapshot when no probe has run yet', () => {
    expect(isDialableDevice({
      name: 'never-probed',
      platform: 'linux',
      address: { via: 'tailscale', dnsName: 'never-probed.ts.net' },
      tailscale: { online: true },
    } as any)).toBe(true);
    expect(isDialableDevice({
      name: 'never-probed-offline',
      platform: 'linux',
      address: { via: 'tailscale', dnsName: 'never-probed-offline.ts.net' },
      tailscale: { online: false },
    } as any)).toBe(false);
  });

  it('treats a never-probed manual device as unknown-not-offline, so it is still dialed', () => {
    expect(isDialableDevice({
      name: 'unknown-manual',
      platform: 'linux',
      address: { via: 'manual', dnsName: 'unknown-manual.ts.net' },
    } as any)).toBe(true);
  });
});

describe('device-name validation — shape vs policy', () => {

  it('assertValidDeviceName is SHAPE-ONLY, so observed names keep working', async () => {
    const { assertValidDeviceName } = await import('./registry.js');
    for (const observed of ['auto', 'interactive', 'all', 'AUTO']) {
      expect(() => assertValidDeviceName(observed), observed).not.toThrow();
    }
    expect(() => assertValidDeviceName('bad name')).toThrow(/Invalid device name/);
  });

  it('assertRegistrableDeviceName rejects the routing sentinels', async () => {
    const { assertRegistrableDeviceName } = await import('./registry.js');
    for (const reserved of ['auto', 'interactive', 'all', 'AUTO', 'Interactive']) {
      expect(() => assertRegistrableDeviceName(reserved), reserved).toThrow(/reserved/i);
    }
    expect(() => assertRegistrableDeviceName('mac-mini')).not.toThrow();
    expect(() => assertRegistrableDeviceName('  Interactive  ')).toThrow(/Invalid device name/);
  });

  it('upsertDevice accepts an observed reserved name — devices sync must not abort', async () => {
    const { upsertDevice } = await import('./registry.js');
    await expect(
      upsertDevice('auto', {
        platform: 'linux',
        user: 'x',
        address: { via: 'manual', dnsName: 'auto.example' },
      } as never),
    ).resolves.toBeTruthy();
  });

  it('addIgnored accepts one too — otherwise the node can be neither registered nor dismissed', async () => {
    const { addIgnored, removeIgnored } = await import('./registry.js');
    try {
      await expect(addIgnored('auto')).resolves.toBeTruthy();
    } finally {
      await removeIgnored('auto');
    }
  });
});
