/** Fleet-wide monitor lookup: is any box already watching this? Identity is the ARGUMENTS, so
 * per-work-item monitors coexist but the same arguments on two machines must not. Reuses the
 * fan-out of `sessions --active`; monitors/*.yml are not synced (running state). */

import { gatherRemoteAgentsJson, type GatherRemoteAgentsJsonDeps } from '../remote-agents-json.js';
import type { MonitorConfig } from './config.js';
import { monitorFingerprint } from './fingerprint.js';

/** Recursion guard: a peer answering the fan-out must not fan out again. */
export const NO_MONITOR_FANOUT_ENV = 'AGENTS_MONITORS_LOCAL';

/** The owning box's view of a remote monitor beyond its behavioral identity: enough for `monitors
 * list` to render enabled/placement/scope and a liveness note without a second round-trip. All
 * optional (older peers may omit them); the duplicate guard never reads them. */
export interface RemoteMonitorDisplay {
  enabled?: boolean;
  owner?: string;
  scope?: 'user' | 'system';
  stalled?: boolean;
  checkCount?: number;
  lastCheckedAt?: string | null;
  lastFiredAt?: string | null;
  lastActionFailed?: boolean;
}

/** One monitor as seen on a peer, tagged with the box it lives on. */
export interface RemoteMonitor {
  machine: string;
  monitor: Pick<MonitorConfig, 'name' | 'source' | 'condition' | 'action'>;
  /** The owning box's enabled/placement/scope/liveness view, for `list` display. */
  display?: RemoteMonitorDisplay;
}

/** Parses a peer's `monitors list --json`. Defensive against version skew: an older peer may emit
 * another shape or no JSON, and one bad peer must never blank the guard for the rest of the fleet. */
export function parseRemoteMonitors(stdout: string, machine: string): RemoteMonitor[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  // `monitors list --json` writes a BARE array (stdoutJson -> JSON.stringify of
  // monitors.map(...)); it has never wrapped. Guarding an envelope shape that has
  // never existed would be a fallback for an imaginary bug.
  if (!Array.isArray(parsed)) return [];
  const rows = parsed;
  const out: RemoteMonitor[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const m = row as Record<string, unknown> & Partial<MonitorConfig>;
    // Without source+condition+action there is no identity to compare, so the
    // row cannot participate in the duplicate check either way.
    if (!m.name || !m.source || !m.condition || !m.action) continue;
    const display: RemoteMonitorDisplay = {
      enabled: typeof m.enabled === 'boolean' ? m.enabled : undefined,
      owner: typeof m.owner === 'string' ? m.owner : undefined,
      scope: m.scope === 'system' || m.scope === 'user' ? m.scope : undefined,
      stalled: typeof m.stalled === 'boolean' ? m.stalled : undefined,
      checkCount: typeof m.checkCount === 'number' ? m.checkCount : undefined,
      lastCheckedAt: typeof m.lastCheckedAt === 'string' ? m.lastCheckedAt : undefined,
      lastFiredAt: typeof m.lastFiredAt === 'string' ? m.lastFiredAt : undefined,
      lastActionFailed: typeof m.lastActionFailed === 'boolean' ? m.lastActionFailed : undefined,
    };
    out.push({
      machine,
      monitor: { name: m.name, source: m.source, condition: m.condition, action: m.action },
      display,
    });
  }
  return out;
}

interface FleetMonitorsResult {
  monitors: RemoteMonitor[];
  /** Target discovery failed before any peer was dialed — the fleet was not
   *  consulted at all, which must not read as "no duplicate anywhere". */
  discoveryFailed: boolean;
  /** Peers dialed but unreachable / erroring — the guard reports these rather than
   *  silently treating "we could not ask" as "there is no duplicate". */
  skipped: string[];
}

interface GatherFleetMonitorsOptions {
  /** When supplied, the fan-out aborts as soon as any peer returns a monitor with
   *  this behavioral fingerprint. The miss path still waits for every peer so the
   *  guard can prove absence fleet-wide. */
  againstFingerprint?: string;
  /** Optional test seam for the SSH boundary; production uses the real capture. */
  deps?: GatherRemoteAgentsJsonDeps;
  /** Optional explicit host list; production omits it and asks the device registry. */
  hosts?: string[];
}

/** Every monitor on every other registered device. Never throws: an unreachable fleet gives an
 * empty list plus the unconsulted names. With `againstFingerprint`, a peer returning it is a
 * definitive clash and the rest are SIGTERM'd; absence of a clash waits for the whole fleet. */
export async function gatherFleetMonitors(
  options: GatherFleetMonitorsOptions = {},
): Promise<FleetMonitorsResult> {
  try {
    const result = await gatherRemoteAgentsJson<RemoteMonitor>({
      args: ['monitors', 'list', '--json'],
      noFanoutEnv: NO_MONITOR_FANOUT_ENV,
      hosts: options.hosts,
      parse: parseRemoteMonitors,
      quiet: true,
      earlyExit: options.againstFingerprint
        ? {
            isDefinitive: (item) => monitorFingerprint(item.monitor) === options.againstFingerprint,
          }
        : undefined,
    }, options.deps);
    return {
      monitors: result.items,
      skipped: [...result.skipped, ...result.parseFailed],
      discoveryFailed: result.discoveryFailed,
    };
  } catch {
    // Could not consult the fleet at all. Reported as such by the caller, never
    // as an absence of duplicates.
    return { monitors: [], skipped: [], discoveryFailed: true };
  }
}
