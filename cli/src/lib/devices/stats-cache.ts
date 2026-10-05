/** Disk cache for fleet {@link DeviceStats} so `agents devices list` and `fleet status` render from
 * the last probe instead of live-SSHing every box. Remote devices come from cache, this machine is
 * probed locally, `--refresh` re-probes all; rows past STATS_STALE_MS re-probe (RUSH-2061). */
import * as fs from 'fs';
import * as path from 'path';

import { getCacheDir } from '../state.js';
import { probeFleetStats, probeLocalStats, type DeviceStats } from './health.js';
import type { DeviceProfile } from './registry.js';

const CACHE_FILE = '.fleet-stats.json';

/** Freshness bound for a cached row, matching the agent-count mirror's window
 * (`AGENT_STATUS_STALE_MS` in `commands/ssh.ts`) so both columns share one staleness model. An
 * older row is re-probed live and the result (unreachable included) rewrites the cache. */
export const STATS_STALE_MS = 3 * 60_000;

export function isFreshDeviceStats(stats: DeviceStats, now: number = Date.now()): boolean {
  return now - stats.fetchedAt <= STATS_STALE_MS;
}

/** Carry a device's last successfully-probed hardware facts onto a row whose probe came back
 * unreachable (RUSH-3096). Cores/RAM/disk survive; `loadPercent`, `memPercent`, and free-byte
 * counts are current readings and stay absent. `specsFetchedAt` keeps when facts were observed. */
export function retainHardwareFacts(
  probed: DeviceStats,
  prior: DeviceStats | undefined,
): DeviceStats {
  // Offline probes retain durable totals only, never stale load, free-memory, or free-disk readings.
  if (probed.reachable || !prior) return probed;
  const ncpu = probed.ncpu ?? prior.ncpu;
  const memTotalBytes = probed.memTotalBytes ?? prior.memTotalBytes;
  const diskTotalBytes = probed.diskTotalBytes ?? prior.diskTotalBytes;
  if (
    ncpu === probed.ncpu &&
    memTotalBytes === probed.memTotalBytes &&
    diskTotalBytes === probed.diskTotalBytes
  ) {
    return probed;
  }
  return {
    ...probed,
    ncpu,
    memTotalBytes,
    diskTotalBytes,
    specsFetchedAt: prior.specsFetchedAt ?? prior.fetchedAt,
  };
}

interface StatsCacheFile {
  version: 1;
  entries: Record<string, DeviceStats>;
}

function cacheFilePath(): string {
  return path.join(getCacheDir(), CACHE_FILE);
}

export function readStatsCache(): Record<string, DeviceStats> {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFilePath(), 'utf-8')) as StatsCacheFile;
    if (parsed && parsed.entries && typeof parsed.entries === 'object') return parsed.entries;
  } catch {
  }
  return {};
}

/** Merge freshly-probed rows into the on-disk cache (best-effort). Rows for devices not in
 * `entries` are preserved, so a partial probe never drops the rest of the fleet's stats. */
export function writeStatsCache(entries: Record<string, DeviceStats>): void {
  try {
    const dir = getCacheDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const merged: StatsCacheFile = {
      version: 1,
      entries: { ...readStatsCache(), ...entries },
    };
    fs.writeFileSync(cacheFilePath(), JSON.stringify(merged, null, 2));
  } catch {
  }
}

export function removeStatsCacheEntry(name: string): void {
  try {
    const current = readStatsCache();
    if (!(name in current)) return;
    const entries = pruneStatsCache(current, name);
    fs.writeFileSync(cacheFilePath(), JSON.stringify({ version: 1, entries }, null, 2));
  } catch {
  }
}

export function pruneStatsCache(entries: Record<string, DeviceStats>, name: string): Record<string, DeviceStats> {
  const { [name]: _removed, ...remaining } = entries;
  void _removed;
  return remaining;
}

interface FleetStatsResult {
  stats: Map<string, DeviceStats>;
  oldestFetchedAt: number | null;
  servedFromCache: boolean;
}

interface LoadFleetStatsOptions {
  forceRefresh?: boolean;
  selfName?: string;
  probeFleet?: typeof probeFleetStats;
  probeLocal?: typeof probeLocalStats;
  readCache?: typeof readStatsCache;
  writeCache?: typeof writeStatsCache;
  now?: number;
}

/** Load fleet stats cache-first (see the module doc for default vs `--refresh`). Never throws: an
 * unreachable box degrades to a `reachable: false` row as the live probe does. */
export async function loadFleetStats(
  devices: DeviceProfile[],
  opts: LoadFleetStatsOptions = {},
): Promise<FleetStatsResult> {
  const probeFleet = opts.probeFleet ?? probeFleetStats;
  const probeLocal = opts.probeLocal ?? probeLocalStats;
  const readCache = opts.readCache ?? readStatsCache;
  const writeCache = opts.writeCache ?? writeStatsCache;
  const self = opts.selfName;
  const now = opts.now ?? Date.now();
  const cache = readCache();

  const stats = new Map<string, DeviceStats>();
  const toProbe: DeviceProfile[] = [];
  let servedFromCache = false;

  for (const d of devices) {
    // Self is always measured locally; stale remote rows are refreshed through the fleet probe.
    if (d.name === self) {
      toProbe.push(d);
      continue;
    }
    const cached = opts.forceRefresh ? undefined : cache[d.name];
    const cacheFresh = cached && isFreshDeviceStats(cached, now);
    if (cached && cacheFresh) {
      stats.set(d.name, cached);
      servedFromCache = true;
    } else {
      toProbe.push(d);
    }
  }

  if (toProbe.length > 0) {
    const probed = await probeFleet(toProbe, { selfName: self });
    const fresh: Record<string, DeviceStats> = {};
    for (const [name, s] of probed) {
      const row = retainHardwareFacts(s, cache[name]);
      stats.set(name, row);
      fresh[name] = row;
    }
    if (Object.keys(fresh).length > 0) writeCache(fresh);
  }

  if (self && !stats.has(self)) {
    stats.set(self, retainHardwareFacts(await probeLocal(self), cache[self]));
  }

  let oldest: number | null = null;
  for (const s of stats.values()) {
    if (oldest === null || s.fetchedAt < oldest) oldest = s.fetchedAt;
  }
  return { stats, oldestFetchedAt: oldest, servedFromCache };
}
