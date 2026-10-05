import type { DeviceProfile, DeviceReachability, DeviceRegistry } from './registry.js';
import type { DeviceStats } from './health.js';

export type OnlineState = 'online' | 'offline' | 'unknown';

export function deviceOnlineState(d: DeviceProfile, stats?: DeviceStats): OnlineState {
  // Render this-run probe truth first, then persisted SSH reachability, then the Tailscale snapshot.
  if (stats) return stats.reachable ? 'online' : 'offline';
  if (d.reachability) return d.reachability.reachable ? 'online' : 'offline';
  if (d.tailscale) return d.tailscale.online ? 'online' : 'offline';
  return 'unknown';
}

export function reachabilityFromStats(d: DeviceProfile, stats: DeviceStats): DeviceReachability {
  return {
    reachable: stats.reachable,
    via: d.address?.via,
    checkedAt: new Date(stats.fetchedAt).toISOString(),
  };
}

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
