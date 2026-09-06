/**
 * Fleet distribution of identity-keyed Claude usage through the user repo.
 *
 * A headed device can read authoritative usage; a worker's setup-token cannot.
 * Headed daemons therefore publish one snapshot into their conflict-free
 * `~/.agents/devices/<device>/daemon-state.json`. The daemon's bounded Git
 * transport delivers those files automatically; workers merge newest-wins.
 * There is deliberately no device-to-device SSH in this module or its tick.
 */
import { isHeadedDeviceRole, listConfiguredDeviceRoles, selfConfiguredDeviceRole, type ConfiguredDeviceRole } from '../device-config.js';
import {
  readFleetSharedDeviceStates,
  updateFleetSharedDeviceStateAsync,
} from '../fleet-shared-state.js';
import { getUserAgentsDir } from '../state.js';
import { machineId, normalizeHost } from '../session/sync/config.js';
import {
  exportClaudeUsageCacheRows,
  ingestPeerClaudeUsageRows,
  type CachedUsageSnapshot,
} from './usage.js';

/** Cadence of the usage-sync git tick — the trust window for a `sync` snapshot. */
export const USAGE_SYNC_INTERVAL_MS = 15 * 60_000;
/** Re-publish an unchanged windowed row at least this often so workers' 15-min trust does not lapse. */
export const USAGE_PUBLISH_HEARTBEAT_MS = 10 * 60_000;

function usageMeterSignature(row: CachedUsageSnapshot): string {
  return JSON.stringify({
    windows: row.windows,
    plan: row.plan ?? null,
    unavailable: row.unavailable ?? null,
    freshnessSource: row.freshnessSource ?? null,
    pollerDevice: row.pollerDevice ?? null,
  });
}

/**
 * Keep the previously published `capturedAt` when meters have not moved and
 * the last publish is still inside the heartbeat. Stops statusline re-renders
 * from dirtying the shared store (and taking the git lock) every few seconds.
 */
export function mergeUsageRowsForPublish(
  previous: Record<string, CachedUsageSnapshot> | undefined,
  next: Record<string, CachedUsageSnapshot>,
  nowMs: number = Date.now(),
): Record<string, CachedUsageSnapshot> {
  if (!previous) return next;
  const out: Record<string, CachedUsageSnapshot> = {};
  for (const [key, row] of Object.entries(next)) {
    const prior = previous[key];
    if (prior && usageMeterSignature(prior) === usageMeterSignature(row)) {
      const priorMs = prior.capturedAt ? Date.parse(prior.capturedAt) : NaN;
      if (Number.isFinite(priorMs) && nowMs - priorMs < USAGE_PUBLISH_HEARTBEAT_MS) {
        out[key] = { ...row, capturedAt: prior.capturedAt };
        continue;
      }
    }
    out[key] = row;
  }
  return out;
}

/** Legacy hidden ingest/export envelope kept for older fleet CLI compatibility. */
export interface UsageSyncPayload {
  v: 1;
  rows: Record<string, CachedUsageSnapshot>;
}

export interface PublishUsageSnapshotOptions {
  userAgentsDir?: string;
  cachePath?: string;
  role?: ConfiguredDeviceRole;
  device?: string;
}

export interface PublishUsageSnapshotResult {
  published: boolean;
  changed: boolean;
  skipped: string | null;
  error: string | null;
  path: string | null;
}

/** Publish this headed device's stable usage snapshot into its owned store file. */
export async function publishUsageSnapshotToSharedStore(
  options: PublishUsageSnapshotOptions = {},
): Promise<PublishUsageSnapshotResult> {
  const result: PublishUsageSnapshotResult = {
    published: false,
    changed: false,
    skipped: null,
    error: null,
    path: null,
  };
  const role = options.role ?? selfConfiguredDeviceRole();
  if (!isHeadedDeviceRole(role)) {
    result.skipped = 'this device is not a usage publisher (mark it personal or desktop)';
    return result;
  }
  const rawRows = exportClaudeUsageCacheRows(options.cachePath);
  if (Object.keys(rawRows).length === 0) {
    result.skipped = 'no local usage snapshot to publish';
    return result;
  }
  try {
    const device = options.device ?? machineId();
    const userAgentsDir = options.userAgentsDir ?? getUserAgentsDir();
    const prior = readFleetSharedDeviceStates(userAgentsDir).states
      .find((state) => normalizeHost(state.device) === normalizeHost(device))
      ?.usage?.rows;
    const rows = mergeUsageRowsForPublish(prior, rawRows);
    const write = await updateFleetSharedDeviceStateAsync(
      device,
      { usage: { rows } },
      userAgentsDir,
    );
    result.published = true;
    result.changed = write.changed;
    result.path = write.path;
  } catch (err) {
    result.error = (err as Error).message;
  }
  return result;
}

/**
 * Publish a changed snapshot immediately and exchange the shared repo so
 * workers see it without waiting for the 15-minute tick. No-ops when the
 * serialized store is unchanged (statusline re-renders with the same windows).
 */
export async function pushUsageSnapshotNow(
  options: PublishUsageSnapshotOptions & { lockPath?: string; timeoutMs?: number } = {},
): Promise<{ published: PublishUsageSnapshotResult; transport?: import('../fleet-shared-repo-sync.js').FleetSharedRepoSyncResult }> {
  const published = await publishUsageSnapshotToSharedStore(options);
  if (!published.changed) return { published };
  const { syncFleetSharedStateRepo } = await import('../fleet-shared-repo-sync.js');
  const transport = await syncFleetSharedStateRepo({
    userAgentsDir: options.userAgentsDir,
    device: options.device,
    timeoutMs: options.timeoutMs,
    lockPath: options.lockPath,
  });
  return { published, transport };
}

export interface ConsumeUsageSnapshotsOptions {
  userAgentsDir?: string;
  cachePath?: string;
  role?: ConfiguredDeviceRole;
  device?: string;
  roles?: Record<string, ConfiguredDeviceRole>;
}

export interface ConsumeUsageSnapshotsResult {
  sources: string[];
  merged: number;
  skipped: string | null;
  errors: Array<{ device: string; message: string }>;
}

function capturedAtMs(row: CachedUsageSnapshot): number | null {
  if (!row.capturedAt) return null;
  const ms = Date.parse(row.capturedAt);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Read headed publishers from the local user-repo checkout and merge one
 * newest-wins batch into the worker cache. No network or subprocess is touched.
 */
export function consumeUsageSnapshotsFromSharedStore(
  options: ConsumeUsageSnapshotsOptions = {},
): ConsumeUsageSnapshotsResult {
  const result: ConsumeUsageSnapshotsResult = { sources: [], merged: 0, skipped: null, errors: [] };
  if ((options.role ?? selfConfiguredDeviceRole()) !== 'worker') {
    result.skipped = 'this device is not a worker';
    return result;
  }
  const read = readFleetSharedDeviceStates(options.userAgentsDir ?? getUserAgentsDir());
  result.errors.push(...read.errors);
  const self = normalizeHost(options.device ?? machineId());
  const roles = options.roles ?? listConfiguredDeviceRoles(read.states.map((state) => state.device));
  const rows: Record<string, CachedUsageSnapshot> = {};
  for (const state of read.states) {
    if (normalizeHost(state.device) === self || !isHeadedDeviceRole(roles[state.device]) || !state.usage) continue;
    result.sources.push(state.device);
    for (const [identity, incoming] of Object.entries(state.usage.rows)) {
      if (!incoming || !Array.isArray(incoming.windows) || incoming.windows.length === 0) continue;
      const stamped: CachedUsageSnapshot = {
        ...incoming,
        freshnessSource: 'sync',
        pollerDevice: incoming.pollerDevice ?? state.device,
      };
      const current = rows[identity];
      if (!current) {
        rows[identity] = stamped;
        continue;
      }
      const incomingMs = capturedAtMs(stamped);
      const currentMs = capturedAtMs(current);
      if (incomingMs !== null && (currentMs === null || incomingMs > currentMs)) rows[identity] = stamped;
    }
  }
  result.sources.sort();
  result.merged = ingestPeerClaudeUsageRows(rows, options.cachePath);
  return result;
}
