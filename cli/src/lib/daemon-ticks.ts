/**
 * Daemon account-state tick bodies.
 *
 * These two bodies are the `refreshUsage` / `refreshAuth` implementations the
 * supervised `AccountStateDaemonService` (daemon/account-state-daemon-service.ts)
 * runs on its tick, in-process (usage every tick, auth on the slower ~3 min
 * cadence). They are NOT routines and are never fired through the scheduler — the
 * daemon owns usage and authentication health as first-party device state
 * (RUSH-2451); the supervisor bounds each tick with a deadline + AbortSignal so a
 * hung refresh is abandoned and restarted instead of latching (PHNX-3608).
 *
 * `refreshLocalFleetAuthState` is also called by `agents fleet`/`ssh` surfaces
 * that need a fresh local auth snapshot on demand; provider-level work is guarded
 * by the cross-process refresh lease so an explicit CLI refresh and the daemon
 * timer converge on the same published result.
 */

import type { FleetStatusRow } from './fleet-status.js';
import { AUTH_PROBE_MAX_AGE_MS, type AuthProbeRow } from './auth-health.js';
export { AUTH_PROBE_MAX_AGE_MS } from './auth-health.js';

export function isFreshFleetAuthSnapshot(
  value: { row: FleetStatusRow; authRows: AuthProbeRow[] },
  minimumCapturedAt: number,
): boolean {
  return value.row.capturedAt >= minimumCapturedAt
    && value.authRows.length > 0
    && value.authRows.every(authRow => authRow.health.checkedAt >= minimumCapturedAt);
}

/**
 * How stale a cached auth verdict may get before the periodic tick re-probes.
 *
 * The auth verdict rides the same rate-limited `/api/oauth/usage` endpoint as
 * the usage probe. Firing it every 3-minute tick on every fleet device drove one
 * per-account request quota to a permanent 429, and the shared backoff then
 * parked usage fleet-wide and froze the usage cache (RUSH-2998). Re-probing at
 * most every 20 minutes cuts that endpoint traffic ~5x while still catching a
 * revocation within one window — and every device keeps a REAL verdict (not a
 * degraded "unverified"), so `agents devices ping --strict` and the run
 * auth-preflight keep working on every host, unlike a publisher/subscriber split
 * that would blind every non-primary box to revocation. Fleet status still
 * publishes every tick — it does not ride that endpoint.
 */
/**
 * True when every cached auth row was probed within {@link AUTH_PROBE_MAX_AGE_MS}
 * — i.e. reusing them would not let a verdict get staler than one probe window.
 * Empty cache is never fresh (nothing to reuse). Pure — unit-tested.
 */
export function isCachedFleetAuthProbeFresh(
  authRows: AuthProbeRow[],
  now: number,
  maxAgeMs: number = AUTH_PROBE_MAX_AGE_MS,
): boolean {
  return authRows.length > 0 && authRows.every((r) => now - r.health.checkedAt < maxAgeMs);
}

/**
 * Whether the tick may reuse the cached auth verdict instead of re-probing the
 * rate-limited endpoint. `force` (an on-demand `agents devices ping`) ALWAYS
 * re-probes — the whole point of the command is a genuinely live verdict, and
 * missing this `!force` is exactly how a `--strict` check silently passed a
 * revoked account (the second `runFleetPing` call site, RUSH-2998). Pure —
 * unit-tested so that inversion cannot regress unnoticed.
 */
export function shouldReuseCachedAuthProbe(
  force: boolean,
  cached: AuthProbeRow[],
  now: number,
  maxAgeMs: number = AUTH_PROBE_MAX_AGE_MS,
): boolean {
  return !force && isCachedFleetAuthProbeFresh(cached, now, maxAgeMs);
}

/**
 * Fleet cache warm: publish THIS host's row for the caches `agents fleet
 * status` / `agents devices list` read (PUBLISH-OWN / READ-UNION, RUSH-2061).
 *
 * `force` is set by on-demand callers (`agents devices ping`) that must return a
 * genuinely live verdict; the periodic daemon tick leaves it unset so it reuses a
 * recent verdict per {@link AUTH_PROBE_MAX_AGE_MS} instead of hammering the
 * rate-limited endpoint every 3 minutes (RUSH-2998).
 */
export async function refreshLocalFleetAuthState(
  opts?: { force?: boolean; signal?: AbortSignal },
): Promise<{ row: FleetStatusRow; authRows: import('./auth-health.js').AuthProbeRow[] }> {
  const force = opts?.force === true;
  const signal = opts?.signal;
  const { machineId } = await import('./machine-id.js');
  const { probeLocalFleetAuth, readFleetAuthRows, writeFleetAuthRows } = await import('./auth-health.js');
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
      const cached = readFleetAuthRows(self);
      const reuse = shouldReuseCachedAuthProbe(force, cached, requestedAt);
      const authRows = reuse ? cached : await probeLocalFleetAuth({ cliVersion: getCliVersion(), forceLive: force, signal });
      if (!reuse) writeFleetAuthRows(self, authRows);
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

/**
 * Usage refresh: keep the usage cache the `agents run` router reads
 * (RUSH-2061, readOnly hot path) fresh, WITHOUT the hot path ever fetching.
 * Every host is its own provider-facing writer — it refreshes only the
 * accounts it holds credentials for, straight from the provider APIs
 * (RUSH-3193 #15; no cross-host broadcast).
 */
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
    onSnapshotsChanged: async () => {
      const { pushUsageSnapshotNow } = await import('./accounting/usage-sync.js');
      await pushUsageSnapshotNow();
    },
  });
  const { listProfiles } = await import('./profiles.js');
  const { refreshDueByokUsage } = await import('./byok-usage.js');
  const byok = await refreshDueByokUsage(listProfiles());
  console.log(
    `usage refresh: ${r.refreshed} refreshed, ${r.failed} failed, ${r.skippedNotDue} not-due, ${r.skippedBackoff} backed-off, ${r.skippedCap} capped, ${r.skippedBudget} over-budget, ${r.skippedFresh} statusline-fresh; BYOK ${byok.refreshed} refreshed, ${byok.skipped} not-due`,
  );
}

/**
 * Active-sessions warm (RUSH-2062 / RUSH-2484): publish THIS host's live session
 * rows so `agents sessions watch` (and the extension that tails it) receive
 * journal deltas. Publish-own only — no cross-host SSH.
 *
 * Cadence matches {@link DEFAULT_ACTIVE_CACHE_MAX_AGE_MS} so one-shot readers and
 * long-lived watchers share one writer. Without this tick the journal has no
 * continuous producer and Factory freezes after the initial cache snapshot.
 *
 * Gated on reader presence (RUSH-3193): when no `sessions watch` / `feed watch`
 * consumer has checked in within {@link ACTIVE_SESSIONS_READER_IDLE_WINDOW_MS} the
 * expensive `ps`+`lsof` gather is skipped entirely on this scheduled tick. A
 * watcher connecting to a cold/idle daemon is NOT served by this tick alone —
 * {@link noteActiveSessionsJournalReader} only writes a presence timestamp, with
 * no path back to this timer — so the daemon separately runs
 * {@link watchActiveSessionsReaderPresence} to detect that idle→recent edge and
 * fire an out-of-band call into this same function immediately (RUSH-2484).
 */
export async function runActiveSessionsWarmTick(
  opts: { gather?: () => Promise<import('./session/active.js').ActiveSession[]>; nowMs?: number } = {},
): Promise<{ sessions: number }> {
  const { publishLocalActiveSessions, isActiveSessionsJournalReaderRecent } = await import('./session/session-cache.js');
  const nowMs = opts.nowMs ?? Date.now();
  if (!isActiveSessionsJournalReaderRecent(nowMs)) {
    console.log('active-sessions warm: idle (no recent reader), skipping gather');
    return { sessions: 0 };
  }
  // ONE gather per tick, then fold, then publish. The order is load-bearing:
  // the publish's per-row merge reads the timeline cache, so folding first is
  // what puts a CURRENT timeline on the row this tick writes to the journal
  // rather than the previous tick's (PHNX-3939).
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

/**
 * Session-index warm (RUSH-2682): incrementally scan THIS host's transcript dirs
 * into the local SQLite index on a timer, so a session started HERE reaches this
 * box's index within seconds instead of on the next unrelated `agents sessions*`
 * call. Indexing was otherwise lazy — only `discoverSessions` writes the index,
 * and nothing scheduled it — which inverted freshness: a peer's session arrived
 * via sync in ~0s while a locally-started one sat unindexed for minutes.
 *
 * The scan is incremental (only files whose mtime/size changed) and single-flight
 * across processes via the DB scan claim, so a foreground `agents sessions*` and
 * this tick never double-scan. The daemon is the single scheduled executor,
 * consistent with the one-scheduler rule.
 *
 * Calls `scanSessionsIncremental`, NOT `discoverSessions` (RUSH-2691). A bare
 * `discoverSessions()` ends in a listing query that defaults its cwd filter to
 * `process.cwd()` — the daemon's, i.e. `$HOME` — and caps at 50, so its row count
 * described "sessions whose cwd is exactly $HOME", which is 0 on a normal box no
 * matter how much the scan indexed. The tick reported that 0 every 20s while
 * still paying for the query's existence check and Linear fetch. Scanning
 * directly reports what was actually parsed and skips the query entirely.
 */
export async function runSessionIndexWarmTick(): Promise<{ indexed: number; claimed: boolean }> {
  const { scanSessionsIncremental } = await import('./session/discover.js');
  const { claimed, scanned } = await scanSessionsIncremental();
  // A skipped claim is not a failure — a foreground `agents sessions*` is
  // scanning right now and this tick would be a duplicate.
  if (!claimed) return { indexed: 0, claimed: false };
  return { indexed: scanned, claimed: true };
}

/**
 * Deferred tool-index pass for large-transcript harnesses (PHNX-3411).
 *
 * Kimi (wire.jsonl) and Grok (chat_history.jsonl) scanners produce only
 * metadata — no events. Calling parseSession for those on the warm tick wedges
 * the Node event loop when the transcript is large and active (observed: several
 * seconds per tick on zion, causing browser IPC ECONNREFUSED). This pass fills
 * the gap: it queries recently-active kimi/grok sessions and calls
 * ensureToolIndex, which uses tool_scan_ledger stamps to skip already-current
 * sessions and applies byte/file budget caps so no large transcript monopolises
 * the tick.
 */
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
