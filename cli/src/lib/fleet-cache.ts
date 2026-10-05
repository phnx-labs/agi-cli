/** A synchronous, disk-only read facade over the fleet/usage caches the daemon keeps warm. Never
 * touches the network or SSH, so the routing hot path (`agents run` rotate.ts), device affinity
 * and Factory can read fleet state without a provider fetch or ssh probe. */
import { readHeadroomEntry } from './usage-refresh.js';
import { readFleetStatus as readFleetStatusMirror, type FleetStatusRow } from './fleet-status.js';

/** The fleet-status union (daemon's own row plus peer rows from the fleet-status command): host
 * stats and workload per host. Cache-only; cold yields an empty map. */
export function readFleetStatus(): Record<string, FleetStatusRow> {
  return readFleetStatusMirror();
}
export type { FleetStatusRow };

/** An account's projected headroom, as published by the daemon refresher. */
interface AccountHeadroom {
  status: 'available' | 'rate_limited' | null;
  /** Projected minutes until the session window caps; null = unknown/idle. */
  minutesToLimit: number | null;
}

/** The daemon-computed headroom for an account, or null when nothing is published. Cache-only;
 * callers degrade to snapshot-only behavior. */
export function readAccountHeadroom(usageKey: string): AccountHeadroom | null {
  const entry = readHeadroomEntry(usageKey);
  if (!entry) return null;
  return { status: entry.status, minutesToLimit: entry.minutesToLimit };
}
