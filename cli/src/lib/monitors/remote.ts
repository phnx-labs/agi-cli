
import { gatherRemoteAgentsJson, type GatherRemoteAgentsJsonDeps } from '../remote-agents-json.js';
import type { MonitorConfig } from './config.js';
import { monitorFingerprint } from './fingerprint.js';

export const NO_MONITOR_FANOUT_ENV = 'AGENTS_MONITORS_LOCAL';

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

export interface RemoteMonitor {
  machine: string;
  monitor: Pick<MonitorConfig, 'name' | 'source' | 'condition' | 'action'>;
  display?: RemoteMonitorDisplay;
}

export function parseRemoteMonitors(stdout: string, machine: string): RemoteMonitor[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const rows = parsed;
  const out: RemoteMonitor[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const m = row as Record<string, unknown> & Partial<MonitorConfig>;
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
  discoveryFailed: boolean;
  skipped: string[];
}

interface GatherFleetMonitorsOptions {
  againstFingerprint?: string;
  deps?: GatherRemoteAgentsJsonDeps;
  hosts?: string[];
}

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
    return { monitors: [], skipped: [], discoveryFailed: true };
  }
}
