/**
 * Disk cache for fleet {@link DeviceStats} so `agents devices list` and
 * `agents fleet status` render instantly from the last probe instead of
 * live-SSHing every registered box on every invocation.
 *
 * The old behaviour probed the whole fleet over ssh on every call
 * ({@link probeFleetStats}) — with a dozen devices, a few of them cold or
 * timing out, that turned a status glance into a multi-second hang. This module
 * makes the reads cache-first:
 *
 * - **Default:** serve remote devices from the cache (instant); always probe
 *   *this* machine locally (no ssh, sub-ms) so the "this machine" row is live;
 *   probe only the remote devices missing from the cache (first run / a
 *   newly-added box), then persist them.
 * - **`--refresh` / `--live`:** skip the cache and live-probe every device,
 *   rewriting the cache.
 *
 * Every cached row is bounded by {@link STATS_STALE_MS}: a row older than the
 * window is treated exactly like a missing one — re-probed live this call and
 * rewritten — so the default read is itself the cache's writer and a value can
 * never fossilize at the last manual `--refresh`. (The daemon used to warm this
 * cache every ~3 min; RUSH-2061 removed that N² fleet probe, which left the
 * unbounded read serving multi-day-old rows as current fleet state — the
 * scheduler, `--device auto`, and the session-start banner all read these
 * numbers. See #2666.)
 */
import * as fs from 'fs';
import * as path from 'path';

import { getCacheDir } from '../state.js';
import { probeFleetStats, probeLocalStats, type DeviceStats } from './health.js';
import type { DeviceProfile } from './registry.js';

const CACHE_FILE = '.fleet-stats.json';

/**
 * Freshness bound for a cached row. Matches the agent-count mirror's window
 * (`AGENT_STATUS_STALE_MS` in `commands/ssh.ts`) so both columns of
 * `devices list` / `fleet status` share one staleness model. A row older than
 * this is never served as current — it is re-probed live (and the probe result
 * rewrites the cache, unreachable boxes included).
 */
export const STATS_STALE_MS = 3 * 60_000;

/** True when a cached row is still within {@link STATS_STALE_MS}. */
export function isFreshDeviceStats(stats: DeviceStats, now: number = Date.now()): boolean {
  return now - stats.fetchedAt <= STATS_STALE_MS;
}

/**
 * Carry a device's last successfully-probed hardware facts onto a row whose
 * probe just came back unreachable (RUSH-3096).
 *
 * A failed probe knows nothing about the box — `probeDeviceStats` resolves
 * `{ host, reachable: false, fetchedAt }` — and that bare row then replaced the
 * cached one, so `agents devices list` rendered an offline device with an empty
 * `spec` cell and forgot its cores/RAM/disk until it came back up. Cores, total
 * RAM, and root-disk capacity do not change while a machine is down, so they
 * survive the failure; `loadPercent`, `memPercent`, and the free-byte counts are
 * current-state readings and stay absent rather than render a stale number as
 * live.
 *
 * `specsFetchedAt` keeps the moment the facts were actually observed while
 * `fetchedAt` advances to this attempt, so the row reads "this hardware, seen
 * then; unreachable, as of now" instead of backdating a reading that never
 * happened. A reachable probe is returned untouched — its own reading is the
 * truth, including a fact the box has stopped reporting.
 */
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

interface StatsCacheFile {
  version: 1;
  entries: Record<string, DeviceStats>;
}

function cacheFilePath(): string {
  return path.join(getCacheDir(), CACHE_FILE);
}

/** Read the whole cache (best-effort; a missing/corrupt file yields an empty map). */
export function readStatsCache(): Record<string, DeviceStats> {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFilePath(), 'utf-8')) as StatsCacheFile;
    if (parsed && parsed.entries && typeof parsed.entries === 'object') return parsed.entries;
  } catch {
    // missing or corrupt — treat as empty
  }
  return {};
}

/**
 * Merge freshly-probed rows into the on-disk cache (best-effort write). Rows for
 * devices not in `entries` are preserved, so a partial probe (gap-fill, or a
 * single-device refresh) never drops the rest of the fleet's cached stats.
 */
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
    // best-effort; a failed write just means the next read falls back to a live probe
  }
}

/** Drop one removed device so cache-only rows cannot outlive the registry. */
export function removeStatsCacheEntry(name: string): void {
  try {
    const current = readStatsCache();
    if (!(name in current)) return;
    const entries = pruneStatsCache(current, name);
    fs.writeFileSync(cacheFilePath(), JSON.stringify({ version: 1, entries }, null, 2));
  } catch {
    // Cache cleanup is best-effort; registry removal remains authoritative.
  }
}

/** Immutable cache pruning primitive, exported for lifecycle regression tests. */
export function pruneStatsCache(entries: Record<string, DeviceStats>, name: string): Record<string, DeviceStats> {
  const { [name]: _removed, ...remaining } = entries;
  void _removed;
  return remaining;
}

interface FleetStatsResult {
  /** name → stats for every requested device (cache-served + freshly probed). */
  stats: Map<string, DeviceStats>;
  /** Oldest `fetchedAt` among the returned rows, or null when empty. Drives the
   *  "as of …" freshness note. */
  oldestFetchedAt: number | null;
  /** True when at least one row was served from cache rather than probed this call. */
  servedFromCache: boolean;
}

interface LoadFleetStatsOptions {
  /** Skip the cache and live-probe every device (the `--refresh`/`--live` path). */
  forceRefresh?: boolean;
  /** Device name of THIS machine — always probed locally (no ssh), never cached-served. */
  selfName?: string;
  /** Injectable probes + cache IO for tests (default to the real ssh/local/disk ones). */
  probeFleet?: typeof probeFleetStats;
  probeLocal?: typeof probeLocalStats;
  readCache?: typeof readStatsCache;
  writeCache?: typeof writeStatsCache;
  /** Clock override for tests (drives the {@link STATS_STALE_MS} bound). */
  now?: number;
}

/**
 * Load fleet stats cache-first. See the module doc for the default vs
 * `--refresh` behaviour. Never throws — an unreachable box degrades to a
 * `reachable: false` row exactly as the live probe does.
 */
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
  // Always read the cache, even under --refresh. It is not *served* then, but it
  // is the only record of each box's hardware, and a failed probe must not erase
  // it — see {@link retainHardwareFacts}.
  const cache = readCache();

  const stats = new Map<string, DeviceStats>();
  const toProbe: DeviceProfile[] = [];
  let servedFromCache = false;

  for (const d of devices) {
    if (d.name === self) {
      // This machine is always probed locally — cheap, no ssh, always live.
      toProbe.push(d);
      continue;
    }
    const cached = opts.forceRefresh ? undefined : cache[d.name];
    const cacheFresh = cached && isFreshDeviceStats(cached, now);
    if (cached && cacheFresh) {
      stats.set(d.name, cached);
      servedFromCache = true;
    } else {
      // Missing OR beyond the staleness bound: a stale number rendered as
      // current is worse than the probe's cost, so re-probe live (#2666).
      toProbe.push(d);
    }
  }

  if (toProbe.length > 0) {
    const probed = await probeFleet(toProbe, { selfName: self });
    const fresh: Record<string, DeviceStats> = {};
    for (const [name, s] of probed) {
      // A box that just failed to answer keeps the hardware it was last seen
      // with, so this call and the cache it writes both carry the spec.
      const row = retainHardwareFacts(s, cache[name]);
      stats.set(name, row);
      fresh[name] = row;
    }
    if (Object.keys(fresh).length > 0) writeCache(fresh);
  }

  // Guarantee a row for this machine even when it isn't in the passed device
  // list (e.g. self not registered as an ssh target) — matches the old callers'
  // explicit local fallback.
  if (self && !stats.has(self)) {
    stats.set(self, retainHardwareFacts(await probeLocal(self), cache[self]));
  }

  let oldest: number | null = null;
  for (const s of stats.values()) {
    if (oldest === null || s.fetchedAt < oldest) oldest = s.fetchedAt;
  }
  return { stats, oldestFetchedAt: oldest, servedFromCache };
}
