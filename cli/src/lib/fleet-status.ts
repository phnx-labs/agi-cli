// Fleet status is publish-own/read-union: daemons probe only themselves, readers union peers, and mirror writes preserve other hosts.
// running means active work; live includes every tracked state.
import * as fs from 'fs';
import * as path from 'path';

import { getCacheDir } from './state.js';
import { probeLocalStats, type DeviceStats } from './devices/health.js';
import { getActiveSessions } from './session/active.js';
import { atomicWriteFileSync, ensureLockTarget, withFileLock } from './fs-atomic.js';

export interface FleetAgentCounts {
  running: number;
  live: number;
  byContext: Record<string, number>;
  byAgent: Record<string, number>;
}

export interface FleetStatusRow {
  host: string;
  agents: FleetAgentCounts;
  stats: DeviceStats | null;
  capturedAt: number;
}

type CountableSession = { status?: string; context?: string; kind?: string; pidAlive?: boolean };

export function computeAgentCounts(sessions: ReadonlyArray<CountableSession>): FleetAgentCounts {
  const byContext: Record<string, number> = {};
  const byAgent: Record<string, number> = {};
  let running = 0;
  let live = 0;
  for (const s of sessions) {
    live += 1;
    if (s.status !== 'running') continue;
    running += 1;
    const ctx = s.context ?? 'unknown';
    const agent = s.kind ?? 'unknown';
    byContext[ctx] = (byContext[ctx] ?? 0) + 1;
    byAgent[agent] = (byAgent[agent] ?? 0) + 1;
  }
  return { running, live, byContext, byAgent };
}

export async function probeLocalFleetStatus(host: string, now: number = Date.now()): Promise<FleetStatusRow> {
  const [stats, sessions] = await Promise.all([
    probeLocalStats(host).catch(() => null),
    getActiveSessions({ localOnly: true }).catch(() => [] as CountableSession[]),
  ]);
  return {
    host,
    agents: computeAgentCounts(sessions),
    stats: stats ?? null,
    capturedAt: now,
  };
}

interface FleetStatusCacheFile {
  version: 1;
  entries: Record<string, FleetStatusRow>;
}

let mirrorPathOverride: string | null = null;
export function setFleetStatusMirrorPathForTest(mirrorPath: string | null): string | null {
  const prev = mirrorPathOverride;
  mirrorPathOverride = mirrorPath;
  return prev;
}
function mirrorPath(): string {
  return mirrorPathOverride ?? path.join(getCacheDir(), '.fleet-status.json');
}

export function readFleetStatus(): Record<string, FleetStatusRow> {
  try {
    const parsed = JSON.parse(fs.readFileSync(mirrorPath(), 'utf-8')) as FleetStatusCacheFile;
    if (parsed && parsed.entries && typeof parsed.entries === 'object') return parsed.entries;
  } catch {
  }
  return {};
}

export function writeFleetStatusRows(entries: Record<string, FleetStatusRow>): void {
  try {
    const target = mirrorPath();
    ensureLockTarget(target, JSON.stringify({ version: 1, entries: {} }));
    withFileLock(target, () => {
      const merged: FleetStatusCacheFile = {
        version: 1,
        entries: { ...readFleetStatus(), ...entries },
      };
      atomicWriteFileSync(target, JSON.stringify(merged, null, 2));
    });
  } catch {
  }
}

export async function publishLocalFleetStatus(host: string): Promise<FleetStatusRow> {
  const row = await probeLocalFleetStatus(host);
  writeFleetStatusRows({ [host]: row });
  return row;
}
