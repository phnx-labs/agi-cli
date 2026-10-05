/** Reachability write-back + resolver (RUSH-1965). The bug: a reachable device rendered "offline"
 * because the word read only the cached `tailscale.online` snapshot, which the live probe never
 * corrected. Pinned through real registry IO: a live verdict beats the cache. */
import { beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { DeviceStats } from './health.js';

// Redirect the device registry dir to a test-private temp so writes never touch the user's real
// ~/.agents/.history/devices (RUSH-2042). getDevicesDir() reads AGENTS_DEVICES_DIR at call time,
// avoiding the module-cache race a plain HOME override loses once state.ts has been imported.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-reachability-test-'));
process.env.AGENTS_DEVICES_DIR = path.join(TEST_HOME, 'devices');

const { upsertDevice, loadDevices, getDevice, writeReachability } = await import('./registry.js');
const { deviceOnlineState, reachabilityFromStats, collectReachabilityWriteBacks } = await import(
  './reachability.js'
);

function registryPath(): string {
  return path.join(TEST_HOME, 'devices', 'registry.json');
}

function stat(host: string, reachable: boolean, fetchedAt: number): DeviceStats {
  return { host, reachable, fetchedAt };
}

beforeEach(async () => {
  await fsp.rm(registryPath(), { force: true });
  await fsp.rm(`${registryPath()}.lock`, { recursive: true, force: true });
});

describe('deviceOnlineState precedence', () => {
  it('prefers a live stat over both the written-back verdict and the cache', () => {
    const d = {
      name: 'box',
      platform: 'linux' as const,
      shell: 'posix' as const,
      address: { via: 'manual' as const },
      auth: { method: 'key' as const },
      tailscale: { online: false, direct: false },
      reachability: { reachable: false, checkedAt: '2026-01-01T00:00:00Z' },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    expect(deviceOnlineState(d, stat('box', true, Date.now()))).toBe('online');
  });

  it('falls to the written-back verdict over the stale tailscale snapshot', () => {
    const d = {
      name: 'box',
      platform: 'linux' as const,
      shell: 'posix' as const,
      address: { via: 'tailscale' as const },
      auth: { method: 'key' as const },
      tailscale: { online: false, direct: false },
      reachability: { reachable: true, checkedAt: '2026-07-31T00:00:00Z' },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    expect(deviceOnlineState(d)).toBe('online');
  });

  it('returns unknown when nothing at all is known', () => {
    const d = {
      name: 'box',
      platform: 'linux' as const,
      shell: 'posix' as const,
      address: { via: 'manual' as const },
      auth: { method: 'key' as const },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    expect(deviceOnlineState(d)).toBe('unknown');
  });
});

describe('reachability round-trip through the real registry', () => {
  it('a reachable via:"manual" device (no tailscale field) round-trips to online', async () => {
    await upsertDevice('worker', {
      platform: 'linux',
      user: 'muqsit',
      address: { via: 'manual', ip: '192.168.1.80' },
    });
    expect(deviceOnlineState((await getDevice('worker'))!)).toBe('unknown');

    const reg = await loadDevices();
    const statsMap = new Map([['worker', stat('worker', true, Date.now())]]);
    const changed = await writeReachability(collectReachabilityWriteBacks(reg, statsMap));
    expect(changed).toEqual(['worker']);

    const back = await getDevice('worker');
    expect(back!.reachability?.reachable).toBe(true);
    expect(back!.reachability?.via).toBe('manual');
    expect(deviceOnlineState(back!)).toBe('online');
  });

  it('a fresh reachable verdict overrides a stale tailscale.online:false cache', async () => {
    await upsertDevice('s1', {
      platform: 'linux',
      address: { via: 'tailscale', dnsName: 's1.ts.net' },
      tailscale: { online: false, direct: false, lastSeen: '2026-07-22T00:00:00Z' },
    });
    expect(deviceOnlineState((await getDevice('s1'))!)).toBe('offline');

    const reg = await loadDevices();
    const statsMap = new Map([['s1', stat('s1', true, Date.now())]]);
    await writeReachability(collectReachabilityWriteBacks(reg, statsMap));

    const back = await getDevice('s1');
    expect(back!.tailscale?.online).toBe(false);
    expect(deviceOnlineState(back!)).toBe('online');
  });

  it('does not resurrect a device that is no longer registered', async () => {
    const reg = await loadDevices();
    const statsMap = new Map([['ghost', stat('ghost', true, Date.now())]]);
    const changed = await writeReachability(collectReachabilityWriteBacks(reg, statsMap));
    expect(changed).toEqual([]);
    expect(await getDevice('ghost')).toBeNull();
  });

  it('skips the write when the verdict is unchanged and not fresher (no churn)', async () => {
    await upsertDevice('box', { platform: 'linux', address: { via: 'manual', ip: '10.0.0.2' } });
    const reg = await loadDevices();
    const t = Date.now();
    expect(await writeReachability({ box: reachabilityFromStats(reg.box, stat('box', true, t)) })).toEqual(['box']);
    expect(await writeReachability({ box: reachabilityFromStats(reg.box, stat('box', true, t)) })).toEqual([]);
    expect(await writeReachability({ box: reachabilityFromStats(reg.box, stat('box', false, t + 1000)) })).toEqual(['box']);
    expect((await getDevice('box'))!.reachability?.reachable).toBe(false);
  });
});
