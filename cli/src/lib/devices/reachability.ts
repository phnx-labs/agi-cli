/** One reachability resolver for the fleet render (RUSH-1965). The live SSH probe, the registry
 * verdict and the cached `tailscale.online` disagreed, so stale or manual devices showed "offline
 * forever". The render and the write-back share this one ordering so they agree. */
import type { DeviceProfile, DeviceReachability, DeviceRegistry } from './registry.js';
import type { DeviceStats } from './health.js';

export type OnlineState = 'online' | 'offline' | 'unknown';

/** Resolve a device's online/offline state from the freshest signal: a live stat from this run,
 * then the persisted verdict from a prior probe, then the cached `tailscale.online`. 'unknown'
 * only when nothing is known. */
export function deviceOnlineState(d: DeviceProfile, stats?: DeviceStats): OnlineState {
  if (stats) return stats.reachable ? 'online' : 'offline';
  if (d.reachability) return d.reachability.reachable ? 'online' : 'offline';
  if (d.tailscale) return d.tailscale.online ? 'online' : 'offline';
  return 'unknown';
}

/** Build the reachability verdict to persist from a fresh probe stat. Pure. */
export function reachabilityFromStats(d: DeviceProfile, stats: DeviceStats): DeviceReachability {
  return {
    reachable: stats.reachable,
    via: d.address?.via,
    checkedAt: new Date(stats.fetchedAt).toISOString(),
  };
}

/** Collect reachability verdicts to write back from a fleet's fresh stats map. Only registry
 * devices are included (a stat for an untracked name is dropped, not resurrected). Pure; hand the
 * result to {@link writeReachability}. */
export function collectReachabilityWriteBacks(
  reg: DeviceRegistry,
  statsMap: Map<string, DeviceStats>,
): Record<string, DeviceReachability> {
  const out: Record<string, DeviceReachability> = {};
  for (const [name, stats] of statsMap) {
    const d = reg[name];
    if (!d) continue;
    out[name] = reachabilityFromStats(d, stats);
  }
  return out;
}
