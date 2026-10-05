/** Daemon account-state tick bodies: `refreshUsage` / `refreshAuth` run in-process by the
 * supervised `AccountStateDaemonService` (usage every tick, auth ~3 min). Not routines; the daemon
 * owns this as first-party device state (RUSH-2451); a hung tick is restarted (PHNX-3608). */

import type { FleetStatusRow } from './fleet-status.js';
import { AUTH_PROBE_MAX_AGE_MS, authTargetKey, type AuthProbeRow } from './auth-health.js';
export { AUTH_PROBE_MAX_AGE_MS } from './auth-health.js';

export function isFreshFleetAuthSnapshot(
  value: { row: FleetStatusRow; authRows: AuthProbeRow[] },
  minimumCapturedAt: number,
): boolean {
  return value.row.capturedAt >= minimumCapturedAt
    && value.authRows.length > 0
    && value.authRows.every(authRow => authRow.health.checkedAt >= minimumCapturedAt);
}

/** How stale a cached auth verdict may get before the tick re-probes. The verdict rides the
 * rate-limited `/api/oauth/usage`; probing every 3-minute tick on every device drove a permanent
 * 429 and parked usage fleet-wide (RUSH-2998). 20 minutes cuts traffic ~5x. */
/** Cached rows still backed by a home on this device, by `authTargetKey`. A row for an uninstalled
 * version is an orphan: nothing re-probes it so `checkedAt` is frozen. Pure. */
export function installedAuthRows(
  authRows: readonly AuthProbeRow[],
  installedTargets: ReadonlySet<string>,
): AuthProbeRow[] {
  return authRows.filter((r) => installedTargets.has(authTargetKey(r.agent, r.version)));
}

/** True when every cached auth row for an installed home was probed within AUTH_PROBE_MAX_AGE_MS;
 * no installed row is never fresh. Pure. Orphans are excluded, not counted stale (PHNX-4051):
 * counting them kept this false after any uninstall and re-armed the 429 backoff (RUSH-2998). */
export function isCachedFleetAuthProbeFresh(
  authRows: readonly AuthProbeRow[],
  now: number,
  installedTargets: ReadonlySet<string>,
  maxAgeMs: number = AUTH_PROBE_MAX_AGE_MS,
): boolean {
  const installed = installedAuthRows(authRows, installedTargets);
  return installed.length > 0 && installed.every((r) => now - r.health.checkedAt < maxAgeMs);
}

/** Whether the tick may reuse the cached auth verdict. `force` (on-demand `agents devices ping`)
 * always re-probes; missing `!force` is how `--strict` passed a revoked account (RUSH-2998). Pure
 * and unit-tested against that inversion. */
export function shouldReuseCachedAuthProbe(
  force: boolean,
  cached: readonly AuthProbeRow[],
  now: number,
  installedTargets: ReadonlySet<string>,
  maxAgeMs: number = AUTH_PROBE_MAX_AGE_MS,
): boolean {
  return !force && isCachedFleetAuthProbeFresh(cached, now, installedTargets, maxAgeMs);
}

/** Fleet cache warm: publish this host's row for the caches `agents fleet status` / `devices list`
 * read (PUBLISH-OWN / READ-UNION, RUSH-2061). `force` is set by on-demand callers wanting a live
 * verdict; the periodic tick reuses a recent one (RUSH-2998). */
export async function refreshLocalFleetAuthState(
  opts?: { force?: boolean; signal?: AbortSignal },
): Promise<{ row: FleetStatusRow; authRows: import('./auth-health.js').AuthProbeRow[] }> {
  const force = opts?.force === true;
  const signal = opts?.signal;
  const { machineId } = await import('./machine-id.js');
  const { probeLocalFleetAuth, readFleetAuthRows, writeFleetAuthRows, localAuthTargetKeys } = await import('./auth-health.js');
  const { getCliVersion } = await import('./version.js');
  const self = machineId();
  const requestedAt = Date.now();
  const minimumCapturedAt = requestedAt - 2 * 60_000;
  const { withRefreshLease } = await import('./refresh-coordinator.js');
  const { readFleetStatus, publishLocalFleetStatus } = await import('./fleet-status.js');
  return withRefreshLease({
    scope: 'auth',
    key: self,
    readCompleted: () => {
      const row = readFleetStatus()[self];
      if (!row) return null;
      return { row, authRows: readFleetAuthRows(self) };
    },
    // A recent daemon publication is the completed result, not a reason to probe
    // every provider a second time. An on-demand caller (force) never accepts a
    // cached snapshot — it must return a genuinely live verdict.
    isCompleted: (value) => !force && isFreshFleetAuthSnapshot(value, minimumCapturedAt),
    refresh: async () => {
      // Re-probe the rate-limited /oauth/usage endpoint at most every
      // AUTH_PROBE_MAX_AGE_MS; reuse the last real verdict in between (RUSH-2998).
      // Fleet status publishes every tick regardless — it does not ride that endpoint.
      const installed = localAuthTargetKeys();
      const cached = readFleetAuthRows(self);
      const live = installedAuthRows(cached, installed);
      const reuse = shouldReuseCachedAuthProbe(force, cached, requestedAt, installed);
      const authRows = reuse ? live : await probeLocalFleetAuth({ cliVersion: getCliVersion(), forceLive: force, signal });
      // Write when we probed, and ALSO when the cache holds orphan rows for homes
      // that are gone: a reusing tick is the common case, so leaving the prune on
      // the probe branch would keep them in `agents view` indefinitely (PHNX-4051).
      if (!reuse || live.length !== cached.length) writeFleetAuthRows(self, authRows, installed);
      const row = await publishLocalFleetStatus(self);
      return { row, authRows };
    },
  });
}

export async function runFleetCacheWarmTick(signal?: AbortSignal): Promise<void> {
  const result = await refreshLocalFleetAuthState({ signal });
  // A waiter receives the already-published fleet row. The auth-row count is
  // available only to the process that performed the provider probes.
  const row = result.row;
  const authCount = result.authRows.length;
  console.log(`fleet cache warm: ${authCount} auth row(s) refreshed, ${row.agents.running} running agent(s) on ${row.host}`);
}

/** Usage refresh: keep the usage cache the `agents run` router reads (RUSH-2061) fresh without the
 * hot path fetching. Each host refreshes only accounts it holds credentials for, straight from the
 * provider APIs (RUSH-3193 #15; no cross-host broadcast). */
export async function runUsageRefreshTick(signal?: AbortSignal): Promise<void> {
  const { runUsageRefresh, buildLocalUsageAccounts } = await import('./usage-refresh.js');
  const { writeClaudeUsageCache, readClaudeUsageCache } = await import('./accounting/usage.js');
  const { usageRateLimitedUntil } = await import('./usage-backoff.js');
  const { machineId } = await import('./machine-id.js');
  const r = await runUsageRefresh({
    listAccounts: buildLocalUsageAccounts,
    writeUsageCache: writeClaudeUsageCache,
    backoffUntil: (agentId, usageKey) => usageRateLimitedUntil(agentId, Date.now(), usageKey),
    // The free statusline ingest of a live `agents run` writes this same cache,
    // so a recent capture means the account is already fresh at zero API cost —
    // the refresher re-derives headroom from it and skips the API fetch.
    readCachedSnapshot: (usageKey) => readClaudeUsageCache(usageKey),
    // Thread the supervisor deadline into each provider fetch so the tick's I/O
    // is bounded by deadlineMs, not just each fetch's own 5s timeout (PHNX-3608).
    signal,
    pollerDevice: machineId(),
    // A changed poll refreshes this box's own state file so the next usage-sync
    // fan-out (or a placement probe before it) sends the new reading.
    onSnapshotsChanged: async () => {
      const { publishUsageSnapshotToSharedStore } = await import('./accounting/usage-sync.js');
      await publishUsageSnapshotToSharedStore();
    },
  });
  const { listProfiles } = await import('./profiles.js');
  const { refreshDueByokUsage } = await import('./byok-usage.js');
  const byok = await refreshDueByokUsage(listProfiles());
  console.log(
    `usage refresh: ${r.refreshed} refreshed, ${r.failed} failed, ${r.skippedNotDue} not-due, ${r.skippedBackoff} backed-off, ${r.skippedCap} capped, ${r.skippedBudget} over-budget, ${r.skippedFresh} statusline-fresh; BYOK ${byok.refreshed} refreshed, ${byok.skipped} not-due`,
  );
}

/** Active-sessions warm (RUSH-2062 / RUSH-2484): publish this host's live session rows so `agents
 * sessions watch` gets journal deltas. Gated on reader presence (RUSH-3193): with no recent
 * watcher the `ps`+`lsof` gather is skipped; a watcher edge fires it. */
export async function runActiveSessionsWarmTick(
  opts: { gather?: () => Promise<import('./session/active.js').ActiveSession[]>; nowMs?: number } = {},
): Promise<{ sessions: number }> {
  const { publishLocalActiveSessions, isActiveSessionsJournalReaderRecent } = await import('./session/session-cache.js');
  const nowMs = opts.nowMs ?? Date.now();
  if (!isActiveSessionsJournalReaderRecent(nowMs)) {
    console.log('active-sessions warm: idle (no recent reader), skipping gather');
    return { sessions: 0 };
  }
  // One gather per tick, then fold, then publish. The order is load-bearing: the publish's per-row
  // merge reads the timeline cache, so folding first puts a current timeline on the row
  // (PHNX-3939).
  const gather = opts.gather ?? (async () => {
    const { getActiveSessions } = await import('./session/active.js');
    return getActiveSessions({ localOnly: true });
  });
  const gathered = await gather();
  // Bounded so it can never own the tick: at most 8 sessions, and for the
  // resumable harnesses only the bytes each transcript grew by. A failure here
  // must not cost the publish.
  const { runTimelinePassSync } = await import('./session/timeline-pass.js');
  let timeline = { computed: 0, reused: 0, skipped: 0 };
  try {
    timeline = runTimelinePassSync({ sessions: gathered, nowMs });
  } catch (err) {
    console.log(`active-sessions warm: timeline pass failed: ${(err as Error).message}`);
  }
  const r = await publishLocalActiveSessions({ gather: async () => gathered, nowMs });
  console.log(
    `active-sessions warm: ${r.sessions.length} session(s) published; `
    + `timeline ${timeline.computed} folded, ${timeline.reused} current, ${timeline.skipped} skipped`,
  );
  return { sessions: r.sessions.length };
}

/** Session-index warm (RUSH-2682): incrementally scan this host's transcript dirs into the SQLite
 * index on a timer, single-flight via the DB scan claim. Uses `scanSessionsIncremental`, not
 * `discoverSessions` (RUSH-2691), whose listing filters by the daemon's `$HOME` cwd. */
export async function runSessionIndexWarmTick(): Promise<{ indexed: number; claimed: boolean }> {
  const { scanSessionsIncremental } = await import('./session/discover.js');
  const { claimed, scanned } = await scanSessionsIncremental();
  // A skipped claim is not a failure — a foreground `agents sessions*` is
  // scanning right now and this tick would be a duplicate.
  if (!claimed) return { indexed: 0, claimed: false };
  return { indexed: scanned, claimed: true };
}

/** Deferred tool-index pass for large-transcript harnesses (PHNX-3411). Kimi and Grok scanners
 * yield only metadata, and parseSession on the warm tick wedged the event loop (browser IPC
 * ECONNREFUSED). This calls ensureToolIndex on recent sessions, within byte/file budgets. */
export async function runDeferredToolIndex(): Promise<{ indexed: number }> {
  const { querySessionsForDeferredToolIndex } = await import('./session/db.js');
  const { ensureToolIndex } = await import('./session/tool-index.js');
  // Feed the 200 most-recently-active kimi/grok sessions; ensureToolIndex skips
  // any whose tool_scan_ledger stamp is current.
  const sessions = querySessionsForDeferredToolIndex(200);
  if (sessions.length === 0) return { indexed: 0 };
  const coverage = await ensureToolIndex(sessions, {
    maxFiles: 20,
    maxBytes: 20 * 1024 * 1024, // 20 MB — bounds one tick even on large transcripts
  });
  return { indexed: coverage.indexedFiles };
}
