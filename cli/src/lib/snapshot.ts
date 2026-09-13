/**
 * `agents devices snapshot` — one-process fleet consumer snapshot.
 *
 * Consumers (Factory watchdog, menubar, fleet scripts) used to fork:
 *   agents view <agent> --json  × N harnesses
 *   agents sessions --active --json
 *   agents feed --json          (sometimes)
 *
 * That is N+2 process starts per poll tick. This module gathers the same
 * shapes in one invocation so poll count drops to 1 without redefining
 * `agents sync status` (which stays the UnifiedSyncStatus sync contract).
 *
 * Stores are not merged — inventory still comes from view, active rows from
 * sessions, blocks from feed. Only the reader is consolidated.
 */

import { machineId } from './machine-id.js';
import { listBlocks, type OpenBlock } from './feed/feed.js';
import { computeAgentCounts, type FleetAgentCounts } from './fleet-status.js';
import type { AgentId } from './types.js';
import type { UnifiedSyncStatus } from './sync-status.js';
import type { ViewJsonAgent } from './view-types.js';

/** One open-block row in the optional feed summary (no full question bodies). */
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

/** Compact feed slice for needs-you polls. */
export interface SnapshotFeedSummary {
  openBlocks: number;
  blocks: SnapshotFeedBlock[];
}

/** Active-session row as emitted by `sessions --active --json`. */
export type SnapshotSessionRow = {
  ticketId: string | null;
  project: string | null;
  prLink: string | null;
  viewingIn: string | null;
  [key: string]: unknown;
};

/**
 * Stable machine-readable contract for `agents devices snapshot --json`.
 * Bump `version` only on breaking shape changes.
 */
export interface FleetSnapshot {
  version: 1;
  /** Host that produced this snapshot (machineId). */
  host: string;
  /** ISO-8601 capture time. */
  capturedAt: string;
  /** Installed agent inventory — same shape as `agents view --json`. */
  inventory: ViewJsonAgent[];
  /** Live sessions — same row shape as `agents sessions --active --json`. */
  sessions: SnapshotSessionRow[];
  /** How many remote devices contributed sessions (0 when --local). */
  remoteDeviceCount: number;
  /** Running/live tallies derived from `sessions` (same as fleet-status). */
  agents: FleetAgentCounts;
  /** Present when --with-feed. */
  feed?: SnapshotFeedSummary;
  /** Present when --with-sync (UnifiedSyncStatus; does not replace `agents sync status`). */
  sync?: UnifiedSyncStatus;
}

interface ComputeSnapshotOptions {
  /** Restrict inventory to one agent id. */
  agent?: AgentId;
  /** Local sessions only — no cross-machine SSH fan-out. Default true for cheap polls. */
  local?: boolean;
  /** Explicit host filter for the sessions gather (same semantics as sessions --active). */
  hosts?: string[];
  /** Include open feed-block summary. */
  withFeed?: boolean;
  /** Include UnifiedSyncStatus (opt-in; can be slower). */
  withSync?: boolean;
  /** Cap feed.blocks length (default 50). */
  feedLimit?: number;
}

/** Summarize open blocks for the snapshot feed slice. Pure / unit-testable. */
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

/**
 * Assemble a snapshot payload from already-gathered pieces. Pure so tests do
 * not need live process scans or network.
 */
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

  const [{ collectAgentsJson }, sessionsMod] = await Promise.all([
    import('../commands/view.js'),
    import('../commands/sessions.js'),
  ]);

  const inventoryP = collectAgentsJson(opts.agent);
  const sessionsP = sessionsMod.gatherActiveSessions({
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

  const sessions = sessionsMod.serializeActiveSessionsForJson(
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
