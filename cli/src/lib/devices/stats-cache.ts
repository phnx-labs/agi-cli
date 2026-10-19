import * as fs from 'fs';
import * as path from 'path';

import { getCacheDir } from '../state.js';
import { probeFleetStats, probeLocalStats, type DeviceStats } from './health.js';
import type { DeviceProfile } from './registry.js';

const CACHE_FILE = '.fleet-stats.json';

export const STATS_STALE_MS = 3 * 60_000;

export function isFreshDeviceStats(stats: DeviceStats, now: number = Date.now()): boolean {
  return now - stats.fetchedAt <= STATS_STALE_MS;
}

export function retainHardwareFacts(
  probed: DeviceStats,
  prior: DeviceStats | undefined,
): DeviceStats {

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

export const PLACEMENT_SNAPSHOT_MAX_AGE_MS = 5 * 60_000;

export const PLACEMENT_DEMAND_WINDOW_MS = 24 * 60 * 60_000;

export interface ReadyProbeEntry {
  answered: boolean;
  timedOut?: boolean;
  version: string | null;
  view: string;
  fetchedAt: number;
}

export interface PlacementSnapshot {
  stats: Record<string, DeviceStats>;
  readiness: Record<string, ReadyProbeEntry>;
  demandAt?: number;
}

interface StatsCacheFile {
  version: 1;
  entries: Record<string, DeviceStats>;
  readiness?: Record<string, ReadyProbeEntry>;
  placementDemandAt?: number;
}

function cacheFilePath(): string {
  return path.join(getCacheDir(), CACHE_FILE);
}

function readCacheFile(): StatsCacheFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFilePath(), 'utf-8')) as StatsCacheFile;
    if (parsed && parsed.entries && typeof parsed.entries === 'object') return parsed;
  } catch {
  }
  return { version: 1, entries: {} };
}

function updateCacheFile(update: (current: StatsCacheFile) => StatsCacheFile): void {
  try {
    const dir = getCacheDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = cacheFilePath();
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(update(readCacheFile()), null, 2));
      fs.renameSync(tmp, file);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  } catch {
  }
}

export function readStatsCache(): Record<string, DeviceStats> {
  return readCacheFile().entries;
}

export function writeStatsCache(entries: Record<string, DeviceStats>): void {
  updateCacheFile((current) => ({ ...current, entries: { ...current.entries, ...entries } }));
}

export function readPlacementSnapshot(): PlacementSnapshot {
  const file = readCacheFile();
  return { stats: file.entries, readiness: file.readiness ?? {}, demandAt: file.placementDemandAt };
}

export function writePlacementSnapshot(update: {
  stats?: Record<string, DeviceStats>;
  readiness?: Record<string, ReadyProbeEntry>;
  demandAt?: number;
}): void {
  updateCacheFile((current) => ({
    ...current,
    entries: { ...current.entries, ...update.stats },
    readiness: { ...current.readiness, ...update.readiness },
    placementDemandAt: update.demandAt ?? current.placementDemandAt,
  }));
}

export function freshReadyProbe(
  snapshot: PlacementSnapshot,
  name: string,
  now: number = Date.now(),
): ReadyProbeEntry | undefined {
  const entry = snapshot.readiness[name];
  return entry && now - entry.fetchedAt <= PLACEMENT_SNAPSHOT_MAX_AGE_MS ? entry : undefined;
}

export function freshSnapshotStats(
  snapshot: PlacementSnapshot,
  name: string,
  now: number = Date.now(),
): DeviceStats | undefined {
  const stats = snapshot.stats[name];
  return stats && now - stats.fetchedAt <= PLACEMENT_SNAPSHOT_MAX_AGE_MS ? stats : undefined;
}

export function placementDemandIsRecent(snapshot: PlacementSnapshot, now: number = Date.now()): boolean {
  return snapshot.demandAt !== undefined && now - snapshot.demandAt <= PLACEMENT_DEMAND_WINDOW_MS;
}

export function removeStatsCacheEntry(name: string): void {
  const current = readCacheFile();
  if (!(name in current.entries) && !(current.readiness && name in current.readiness)) return;
  updateCacheFile((file) => ({
    ...file,
    entries: pruneStatsCache(file.entries, name),
    readiness: file.readiness ? pruneStatsCache(file.readiness, name) : undefined,
  }));
}

export function pruneStatsCache<T>(entries: Record<string, T>, name: string): Record<string, T> {
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
