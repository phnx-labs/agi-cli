/**
 * One synchronous, disk-only read facade over the fleet/usage caches.
 *
 * These readers NEVER touch the network and NEVER SSH — they read the caches
 * the daemon keeps warm (usage snapshot, projected headroom, fleet status) and
 * return instantly. That is the whole point: the routing hot path
 * (`agents run` → rotate.ts), device affinity (smart-launch.ts), and Factory can
 * consult live-ish fleet state without paying a provider fetch or an ssh probe
 * on a latency-sensitive path.
 *
 * Writers live elsewhere (the daemon's `runUsageRefresh` for usage/headroom,
 * `runFleetStatusPublish` for the fleet-status mirror); this module is the read
 * side only.
 */
import { readClaudeUsageCache, type UsageSnapshot } from './accounting/usage.js';
import { readHeadroomEntry } from './usage-refresh.js';
import { readFleetStatus as readFleetStatusMirror, type FleetStatusRow } from './fleet-status.js';

/**
 * The fleet-status union the daemon publishes (own row) and the fleet-status
 * command unions (peer rows) — this host's stats + agent workload for every
 * known host, keyed by host. Cache-only: a cold mirror yields an empty map.
 */
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

/**
 * The daemon-computed headroom for an account, or null when nothing has been
 * published yet. Cache-only — a cold cache simply yields null, and callers
 * degrade to snapshot-only behavior.
 */
export function readAccountHeadroom(usageKey: string): AccountHeadroom | null {
  const entry = readHeadroomEntry(usageKey);
  if (!entry) return null;
  return { status: entry.status, minutesToLimit: entry.minutesToLimit };
}
