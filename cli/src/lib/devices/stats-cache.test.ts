import { describe, it, expect } from 'vitest';

import { STATS_STALE_MS, isFreshDeviceStats, loadFleetStats, retainHardwareFacts, pruneStatsCache } from './stats-cache.js';
import type { DeviceStats } from './health.js';
import type { DeviceProfile } from './registry.js';

function dev(name: string): DeviceProfile {
  return { name, platform: 'linux' } as DeviceProfile;
}

/** A device whose ssh probe really fails: the address is under `.invalid` (RFC 6761, never
 * resolves), so `probeDeviceStats` runs the real ssh path and returns unreachable without reaching
 * any host. */
function unreachableDev(name: string): DeviceProfile {
  return {
    name,
    platform: 'linux',
    shell: 'posix',
    user: 'someone',
    address: { via: 'tailscale', dnsName: `${name}.probe-must-fail.invalid` },
    auth: { method: 'key' },
  } as DeviceProfile;
}

function stat(host: string, fetchedAt: number, loadPercent = 10): DeviceStats {
  return { host, reachable: true, loadPercent, memPercent: 20, ncpu: 4, memTotalBytes: 16 * 1024 ** 3, diskTotalBytes: 256 * 1024 ** 3, fetchedAt, specsFetchedAt: fetchedAt };
}

/** A probe stub that records which devices it was asked to probe. */
function fakeProbe(now: number, probed: string[]) {
  return (async (devices: DeviceProfile[]) => {
    const m = new Map<string, DeviceStats>();
    for (const d of devices) {
      probed.push(d.name);
      m.set(d.name, stat(d.name, now));
    }
    return m;
  }) as unknown as Parameters<typeof loadFleetStats>[1]['probeFleet'];
}

it('prunes a removed device without dropping unrelated cached rows', () => {
  const cache = { retired: stat('retired', 1), worker: stat('worker', 2) };
  expect(pruneStatsCache(cache, 'retired')).toEqual({ worker: cache.worker });
  expect(cache).toHaveProperty('retired');
});

describe('loadFleetStats', () => {
  it('serves cached remotes and never ssh-probes them (default path)', async () => {
    const probed: string[] = [];
    const cache = { a: stat('a', 1000), b: stat('b', 1000) };
    const res = await loadFleetStats([dev('a'), dev('b')], {
      selfName: 'z', // not in the list — no local probe needed either
      now: 2000,
      readCache: () => ({ ...cache }),
      writeCache: () => {},
      probeFleet: fakeProbe(2000, probed),
      probeLocal: (async (h: string) => stat(h, 2000)) as never,
    });
    expect(probed).toEqual([]); // both served from cache
    expect(res.servedFromCache).toBe(true);
    expect(res.stats.get('a')?.fetchedAt).toBe(1000);
    expect(res.oldestFetchedAt).toBe(1000);
  });

  it('always probes THIS machine locally even when cached', async () => {
    const probed: string[] = [];
    const cache = { z: stat('z', 1000) };
    const res = await loadFleetStats([dev('z')], {
      selfName: 'z',
      now: 2000,
      readCache: () => ({ ...cache }),
      writeCache: () => {},
      probeFleet: fakeProbe(2000, probed),
      probeLocal: (async (h: string) => stat(h, 2000)) as never,
    });
    // self went through probeFleet (which handles selfName locally); it is never
    // served stale from cache.
    expect(probed).toContain('z');
    expect(res.stats.get('z')?.fetchedAt).toBe(2000);
  });

  it('probes only the devices missing from the cache (gap-fill) and persists them', async () => {
    const probed: string[] = [];
    const written: Record<string, DeviceStats>[] = [];
    const cache = { a: stat('a', 1000) };
    const res = await loadFleetStats([dev('a'), dev('b')], {
      selfName: 'z',
      now: 2000,
      readCache: () => ({ ...cache }),
      writeCache: (e) => { written.push(e); },
      probeFleet: fakeProbe(2000, probed),
      probeLocal: (async (h: string) => stat(h, 2000)) as never,
    });
    expect(probed).toEqual(['b']);            // only the uncached one
    expect(res.stats.get('a')?.fetchedAt).toBe(1000); // cached
    expect(res.stats.get('b')?.fetchedAt).toBe(2000); // fresh
    expect(written).toHaveLength(1);
    expect(Object.keys(written[0])).toEqual(['b']);   // only fresh rows persisted
  });

  it('forceRefresh bypasses the cache and probes every device', async () => {
    const probed: string[] = [];
    const cache = { a: stat('a', 1000), b: stat('b', 1000) };
    const res = await loadFleetStats([dev('a'), dev('b')], {
      forceRefresh: true,
      selfName: 'z',
      readCache: () => ({ ...cache }),
      writeCache: () => {},
      probeFleet: fakeProbe(2000, probed),
      probeLocal: (async (h: string) => stat(h, 2000)) as never,
    });
    expect(probed.sort()).toEqual(['a', 'b']);
    expect(res.servedFromCache).toBe(false);
    expect(res.oldestFetchedAt).toBe(2000);
  });

  it('falls back to a local probe for a self not present in the device list', async () => {
    const res = await loadFleetStats([], {
      selfName: 'z',
      readCache: () => ({}),
      writeCache: () => {},
      probeFleet: fakeProbe(2000, []),
      probeLocal: (async (h: string) => stat(h, 3000)) as never,
    });
    expect(res.stats.get('z')?.fetchedAt).toBe(3000);
  });

  // #2666: a cache entry older than STATS_STALE_MS must never be presented as
  // current load — it is re-probed live and the fresh row rewrites the cache.
  it('re-probes and rewrites a cache entry older than STATS_STALE_MS instead of serving it', async () => {
    const now = 10_000_000;
    const probed: string[] = [];
    const written: Record<string, DeviceStats>[] = [];
    const cache = {
      fresh: stat('fresh', now - STATS_STALE_MS, 10),          // exactly on the bound — still served
      stale: stat('stale', now - STATS_STALE_MS - 1, 1058),    // the fossilized 9-day-old shape
    };
    const res = await loadFleetStats([dev('fresh'), dev('stale')], {
      selfName: 'z',
      now,
      readCache: () => ({ ...cache }),
      writeCache: (e) => { written.push(e); },
      probeFleet: fakeProbe(now, probed),
      probeLocal: (async (h: string) => stat(h, now)) as never,
    });
    expect(probed).toEqual(['stale']);                    // stale re-probed, fresh untouched
    expect(res.stats.get('stale')?.loadPercent).toBe(10); // the live number, not 1058
    expect(res.stats.get('stale')?.fetchedAt).toBe(now);
    expect(res.stats.get('fresh')?.fetchedAt).toBe(now - STATS_STALE_MS);
    expect(written).toHaveLength(1);                      // the default read is the writer now
    expect(Object.keys(written[0])).toEqual(['stale']);
  });

  // RUSH-3096: hardware does not change while a box is down, so a failed probe must not erase the
  // last recorded cores/RAM/disk (it rendered an offline row with an empty spec cell).
  it('a real failed probe keeps the hardware from the last successful one, and persists it', async () => {
    const seen = 5_000_000;
    const now = seen + STATS_STALE_MS + 1; // cache is stale, so the box IS re-probed
    const written: Record<string, DeviceStats>[] = [];
    const cache = { 'ci-runner': stat('ci-runner', seen) };

    const res = await loadFleetStats([unreachableDev('ci-runner')], {
      selfName: 'z',
      now,
      readCache: () => ({ ...cache }),
      writeCache: (e) => { written.push(e); },
    });

    const row = res.stats.get('ci-runner')!;
    expect(row.reachable).toBe(false);               // the probe really failed
    expect(row.ncpu).toBe(4);                        // …and the spec survived it
    expect(row.memTotalBytes).toBe(16 * 1024 ** 3);
    expect(row.diskTotalBytes).toBe(256 * 1024 ** 3);
    // Volatile readings are NOT carried: a stale load/mem number rendered as
    // current is the failure mode the staleness bound exists to prevent.
    expect(row.loadPercent).toBeUndefined();
    expect(row.memPercent).toBeUndefined();
    expect(row.diskFreeBytes).toBeUndefined();
    // "This hardware, seen then; unreachable, as of now" — never a backdated
    // read. `fetchedAt` is stamped by the probe's own clock (opts.now drives
    // only the staleness bound), so assert it advanced past the observation.
    expect(row.fetchedAt).toBeGreaterThan(seen);
    expect(row.specsFetchedAt).toBe(seen);
    // The retention is persisted, so the NEXT invocation still has the spec.
    expect(written).toHaveLength(1);
    expect(written[0]['ci-runner'].ncpu).toBe(4);
    expect(written[0]['ci-runner'].reachable).toBe(false);
  }, 15_000);

  // --refresh used to drop the cache entirely before probing, so a forced read
  // of a down box was exactly the call that erased its hardware.
  it('retains hardware across forceRefresh, which never serves the cache but must not erase it', async () => {
    const seen = 5_000_000;
    const cache = { 'ci-runner': stat('ci-runner', seen) };
    const res = await loadFleetStats([unreachableDev('ci-runner')], {
      forceRefresh: true,
      selfName: 'z',
      now: seen + 1,
      readCache: () => ({ ...cache }),
      writeCache: () => {},
    });
    expect(res.servedFromCache).toBe(false);
    const row = res.stats.get('ci-runner')!;
    expect(row.reachable).toBe(false);
    expect(row.ncpu).toBe(4);
    expect(row.specsFetchedAt).toBe(seen);
  }, 15_000);

  // The retention is self-correcting: it only ever fills gaps on an unreachable
  // row, so a re-specced box overwrites its facts the moment it answers again.
  it('a reachable probe replaces the retained facts instead of merging them', async () => {
    const probed: string[] = [];
    const cache = { a: { ...stat('a', 1000), ncpu: 99, memTotalBytes: 1 } };
    const res = await loadFleetStats([dev('a')], {
      forceRefresh: true,
      selfName: 'z',
      readCache: () => ({ ...cache }),
      writeCache: () => {},
      probeFleet: fakeProbe(2000, probed),
      probeLocal: (async (h: string) => stat(h, 2000)) as never,
    });
    expect(probed).toEqual(['a']);
    expect(res.stats.get('a')?.ncpu).toBe(4);                          // live, not 99
    expect(res.stats.get('a')?.memTotalBytes).toBe(16 * 1024 ** 3);    // live, not 1
  });

  it('retainHardwareFacts is a no-op with no prior row, so a never-probed box stays blank', () => {
    const bare: DeviceStats = { host: 'new-box', reachable: false, fetchedAt: 42 };
    expect(retainHardwareFacts(bare, undefined)).toBe(bare);
    // A prior row that never captured a spec adds nothing either.
    expect(retainHardwareFacts(bare, { host: 'new-box', reachable: false, fetchedAt: 1 })).toBe(bare);
  });

  it('isFreshDeviceStats bounds a row at STATS_STALE_MS', () => {
    const now = 1_000_000;
    expect(isFreshDeviceStats(stat('a', now), now)).toBe(true);
    expect(isFreshDeviceStats(stat('a', now - STATS_STALE_MS), now)).toBe(true);
    expect(isFreshDeviceStats(stat('a', now - STATS_STALE_MS - 1), now)).toBe(false);
    expect(isFreshDeviceStats(stat('a', now - 9 * 24 * 3600_000), now)).toBe(false); // the observed 9d row
  });
});
