/** Per-host fleet-status rows (stats plus live agent workload) in a shared local mirror. The
 * daemon SSH-probed every device every 3 minutes, N-squared (RUSH-2061); now each publishes only
 * its own row and `agents fleet status` unions peers' `--local` rows (bounded SSH, RUSH-2114). */
import * as fs from 'fs';
import * as path from 'path';

import { getCacheDir } from './state.js';
import { probeLocalStats, type DeviceStats } from './devices/health.js';
import { getActiveSessions } from './session/active.js';
import { atomicWriteFileSync, ensureLockTarget, withFileLock } from './fs-atomic.js';

/** Live agent workload on a host. */
export interface FleetAgentCounts {
  /** Sessions actively working (status === 'running'). */
  running: number;
  /** Total live sessions regardless of status (running/idle/input-required/…). */
  live: number;
  /** Running count broken down by context: terminal / teams / cloud / headless. */
  byContext: Record<string, number>;
  /** Running count broken down by agent CLI: claude / codex / cursor / … */
  byAgent: Record<string, number>;
}

/** One host's published status row. */
export interface FleetStatusRow {
  host: string;
  agents: FleetAgentCounts;
  /** Resource stats from the local probe; null when the probe produced nothing. */
  stats: DeviceStats | null;
  /** Epoch ms this row was computed. */
  capturedAt: number;
}

/** Minimal shape needed to count workload — a subset of ActiveSession. */
type CountableSession = { status?: string; context?: string; kind?: string; pidAlive?: boolean };

/** Tallies running-agent workload from a host's live sessions: `running` is `status ===
 * 'running'`, `live` is every tracked session. Pure. */
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

/** Probes this host: resource stats locally and workload from `getActiveSessions({ localOnly:
 * true })`, which never dials a remote host. Never throws; a failed sub-probe degrades to null
 * stats or zero counts. */
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

/** Test seam for the mirror path (see usage.ts `setClaudeUsageCachePathForTest`). */
let mirrorPathOverride: string | null = null;
export function setFleetStatusMirrorPathForTest(mirrorPath: string | null): string | null {
  const prev = mirrorPathOverride;
  mirrorPathOverride = mirrorPath;
  return prev;
}
function mirrorPath(): string {
  return mirrorPathOverride ?? path.join(getCacheDir(), '.fleet-status.json');
}

/** Read the whole fleet-status mirror (best-effort; missing/corrupt → empty). */
export function readFleetStatus(): Record<string, FleetStatusRow> {
  try {
    const parsed = JSON.parse(fs.readFileSync(mirrorPath(), 'utf-8')) as FleetStatusCacheFile;
    if (parsed && parsed.entries && typeof parsed.entries === 'object') return parsed.entries;
  } catch {
    // missing or corrupt — treat as empty
  }
  return {};
}

/** Merge rows into the mirror (best-effort; preserves other hosts' rows). */
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
    // best-effort; a failed write just means the reader sees an older union
  }
}

/** Publishes this host's row into the mirror (probe self, no SSH); the whole of the daemon's
 * fleet-status duty on its warm tick. */
export async function publishLocalFleetStatus(host: string): Promise<FleetStatusRow> {
  const row = await probeLocalFleetStatus(host);
  writeFleetStatusRows({ [host]: row });
  return row;
}
