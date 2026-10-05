
import { machineId } from './machine-id.js';
import { listBlocks, type OpenBlock } from './feed/feed.js';
import { computeAgentCounts, type FleetAgentCounts } from './fleet-status.js';
import type { AgentId } from './types.js';
import type { UnifiedSyncStatus } from './sync-status.js';
import type { ViewJsonAgent } from './view-types.js';

interface SnapshotFeedBlock {
  blockId: string;
  sessionId: string;
  host: string;
  runtime: string;
  kind?: OpenBlock['kind'];
  ticket?: string;
  pr?: string;
  questionCount: number;
  ts: string;
}

export interface SnapshotFeedSummary {
  openBlocks: number;
  blocks: SnapshotFeedBlock[];
}

export type SnapshotSessionRow = {
  ticketId: string | null;
  project: string | null;
  prLink: string | null;
  viewingIn: string | null;
  [key: string]: unknown;
};

// FleetSnapshot v1 is a stable local stores contract; default collection performs no SSH.
export interface FleetSnapshot {
  version: 1;
  host: string;
  capturedAt: string;
  inventory: ViewJsonAgent[];
  sessions: SnapshotSessionRow[];
  remoteDeviceCount: number;
  agents: FleetAgentCounts;
  feed?: SnapshotFeedSummary;
  sync?: UnifiedSyncStatus;
}

interface ComputeSnapshotOptions {
  agent?: AgentId;
  local?: boolean;
  hosts?: string[];
  withFeed?: boolean;
  withSync?: boolean;
  feedLimit?: number;
}

export function summarizeFeedBlocks(
  blocks: ReadonlyArray<OpenBlock>,
  limit = 50,
): SnapshotFeedSummary {
  const sorted = [...blocks].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  const slice = sorted.slice(0, Math.max(0, limit));
  return {
    openBlocks: blocks.length,
    blocks: slice.map((b) => ({
      blockId: b.blockId,
      sessionId: b.sessionId,
      host: b.host,
      runtime: b.runtime,
      kind: b.kind,
      ticket: b.ticket,
      pr: b.pr,
      questionCount: b.questions?.length ?? 0,
      ts: b.ts,
    })),
  };
}

export function assembleSnapshot(parts: {
  host: string;
  capturedAt: string;
  inventory: ViewJsonAgent[];
  sessions: SnapshotSessionRow[];
  remoteDeviceCount: number;
  feed?: SnapshotFeedSummary;
  sync?: UnifiedSyncStatus;
}): FleetSnapshot {
  return {
    version: 1,
    host: parts.host,
    capturedAt: parts.capturedAt,
    inventory: parts.inventory,
    sessions: parts.sessions,
    remoteDeviceCount: parts.remoteDeviceCount,
    agents: computeAgentCounts(
      parts.sessions.map((s) => ({
        status: typeof s.status === 'string' ? s.status : undefined,
        context: typeof s.context === 'string' ? s.context : undefined,
        kind: typeof s.kind === 'string' ? s.kind : undefined,
      })),
    ),
    ...(parts.feed ? { feed: parts.feed } : {}),
    ...(parts.sync ? { sync: parts.sync } : {}),
  };
}

/**
 * Gather inventory + active sessions (+ optional feed/sync) in one process.
 * Default `local: true` keeps the common poll path free of SSH fan-out; pass
 * `local: false` (or hosts) to match full `sessions --active` fleet scope.
 */
export async function computeSnapshot(
  opts: ComputeSnapshotOptions = {},
): Promise<FleetSnapshot> {
  // Default local-only sessions (cheap poll). Explicit hosts → scoped fan-out.
  // local: false (from --all-hosts) → full sessions --active fan-out.
  const localOnly = opts.hosts?.length ? false : opts.local !== false;

  const [{ collectAgentsJson }, rosterMod, { serializeActiveSessionsForJson }] = await Promise.all([
    import('../commands/view.js'),
    import('../commands/ps-roster.js'),
    import('./session/active.js'),
  ]);

  const inventoryP = collectAgentsJson(opts.agent);
  const sessionsP = rosterMod.gatherActiveSessions({
    local: localOnly,
    hosts: opts.hosts,
  });

  const feedP = opts.withFeed
    ? Promise.resolve(summarizeFeedBlocks(listBlocks(), opts.feedLimit ?? 50))
    : Promise.resolve(undefined);

  const syncP = opts.withSync
    ? import('./sync-status.js').then((m) => m.computeSyncStatus())
    : Promise.resolve(undefined);

  const [inventory, gathered, feed, sync] = await Promise.all([
    inventoryP,
    sessionsP,
    feedP,
    syncP,
  ]);

  const sessions = serializeActiveSessionsForJson(
    gathered.sessions,
  ) as SnapshotSessionRow[];

  return assembleSnapshot({
    host: machineId(),
    capturedAt: new Date().toISOString(),
    inventory,
    sessions,
    remoteDeviceCount: gathered.remoteDeviceCount,
    feed,
    sync,
  });
}
