
import { span, spanSync, type DiagnosticLog } from './daemon/diagnostics.js';
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

export function installedAuthRows(
  authRows: readonly AuthProbeRow[],
  installedTargets: ReadonlySet<string>,
): AuthProbeRow[] {
  return authRows.filter((r) => installedTargets.has(authTargetKey(r.agent, r.version)));
}

export function isCachedFleetAuthProbeFresh(
  authRows: readonly AuthProbeRow[],
  now: number,
  installedTargets: ReadonlySet<string>,
  maxAgeMs: number = AUTH_PROBE_MAX_AGE_MS,
): boolean {

  const installed = installedAuthRows(authRows, installedTargets);
  return installed.length > 0 && installed.every((r) => now - r.health.checkedAt < maxAgeMs);
}

export function shouldReuseCachedAuthProbe(
  force: boolean,
  cached: readonly AuthProbeRow[],
  now: number,
  installedTargets: ReadonlySet<string>,
  maxAgeMs: number = AUTH_PROBE_MAX_AGE_MS,
): boolean {

  return !force && isCachedFleetAuthProbeFresh(cached, now, installedTargets, maxAgeMs);
}

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
    isCompleted: (value) => !force && isFreshFleetAuthSnapshot(value, minimumCapturedAt),
    refresh: async () => {
      const installed = localAuthTargetKeys();
      const cached = readFleetAuthRows(self);
      const live = installedAuthRows(cached, installed);
      const reuse = shouldReuseCachedAuthProbe(force, cached, requestedAt, installed);
      const authRows = reuse ? live : await probeLocalFleetAuth({ cliVersion: getCliVersion(), forceLive: force, signal });
      if (!reuse || live.length !== cached.length) writeFleetAuthRows(self, authRows, installed);
      const row = await publishLocalFleetStatus(self);
      return { row, authRows };
    },
  });
}

export async function runFleetCacheWarmTick(signal?: AbortSignal): Promise<void> {
  const result = await refreshLocalFleetAuthState({ signal });
  const row = result.row;
  const authCount = result.authRows.length;
  console.log(`fleet cache warm: ${authCount} auth row(s) refreshed, ${row.agents.running} running agent(s) on ${row.host}`);
}

const noLog: DiagnosticLog = () => {};

export async function runUsageRefreshTick(signal?: AbortSignal, log: DiagnosticLog = noLog): Promise<void> {
  const { runUsageRefresh, buildLocalUsageAccounts } = await import('./usage-refresh.js');
  const { writeClaudeUsageCache, readClaudeUsageCache } = await import('./accounting/usage.js');
  const { usageRateLimitedUntil } = await import('./usage-backoff.js');
  const { machineId } = await import('./machine-id.js');
  const r = await span('usage.refresh', () => runUsageRefresh({
    listAccounts: buildLocalUsageAccounts,
    writeUsageCache: writeClaudeUsageCache,
    backoffUntil: (agentId, usageKey) => usageRateLimitedUntil(agentId, Date.now(), usageKey),
    readCachedSnapshot: (usageKey) => readClaudeUsageCache(usageKey),
    signal,
    pollerDevice: machineId(),
    onSnapshotsChanged: async () => {
      const { publishUsageSnapshotToSharedStore } = await import('./accounting/usage-sync.js');
      await publishUsageSnapshotToSharedStore();
    },
  }));
  const { listProfiles } = await import('./profiles.js');
  const { refreshDueByokUsage } = await import('./byok-usage.js');
  const byok = await span('usage.refresh-byok', () => refreshDueByokUsage(listProfiles()));
  log(
    r.failed > 0 ? 'WARN' : 'INFO',
    `usage refresh: ${r.refreshed} refreshed, ${r.failed} failed, ${r.skippedNotDue} not-due, ${r.skippedBackoff} backed-off, ${r.skippedCap} capped, ${r.skippedBudget} over-budget, ${r.skippedFresh} statusline-fresh; BYOK ${byok.refreshed} refreshed, ${byok.skipped} not-due`,
    {
      event: 'usage.refresh', refreshed: r.refreshed, failed: r.failed, notDue: r.skippedNotDue, backedOff: r.skippedBackoff,
      capped: r.skippedCap, overBudget: r.skippedBudget, statuslineFresh: r.skippedFresh, byokRefreshed: byok.refreshed, byokNotDue: byok.skipped,
    },
  );
}

export async function runActiveSessionsWarmTick(
  opts: { gather?: () => Promise<import('./session/active.js').ActiveSession[]>; nowMs?: number; log?: DiagnosticLog } = {},
): Promise<{ sessions: number }> {
  const log = opts.log ?? noLog;
  const { publishLocalActiveSessions, isActiveSessionsJournalReaderRecent } = await import('./session/session-cache.js');
  const nowMs = opts.nowMs ?? Date.now();
  if (!isActiveSessionsJournalReaderRecent(nowMs)) {
    log('DEBUG', 'active-sessions warm: idle (no recent reader), skipping gather', { event: 'sessions.warm', skipped: 'no-reader' });
    return { sessions: 0 };
  }
  const gather = opts.gather ?? (async () => {
    const { getActiveSessions } = await import('./session/active.js');
    return getActiveSessions({ localOnly: true });
  });
  const gathered = await span('sessions.warm.gather', gather, () => ({}));
  const { runTimelinePassSync } = await import('./session/timeline-pass.js');
  let timeline = { computed: 0, reused: 0, skipped: 0 };
  try {
    timeline = spanSync('sessions.timeline-pass', () => runTimelinePassSync({ sessions: gathered, nowMs }), () => ({ sessions: gathered.length }));
  } catch (err) {
    log('WARN', `active-sessions warm: timeline pass failed: ${(err as Error).message}`, { event: 'sessions.timeline-pass.failed', error: (err as Error).message });
  }
  const r = await span('sessions.warm.publish', () => publishLocalActiveSessions({ gather: async () => gathered, nowMs }));
  log(
    'DEBUG',
    `active-sessions warm: ${r.sessions.length} session(s) published; `
    + `timeline ${timeline.computed} folded, ${timeline.reused} current, ${timeline.skipped} skipped`,
    { event: 'sessions.warm', sessions: r.sessions.length, ...timeline },
  );
  return { sessions: r.sessions.length };
}

export async function runSessionIndexWarmTick(): Promise<{ indexed: number; claimed: boolean }> {
  const { scanSessionsIncremental } = await import('./session/discover.js');
  const { claimed, scanned } = await scanSessionsIncremental();
  if (!claimed) return { indexed: 0, claimed: false };
  return { indexed: scanned, claimed: true };
}

export async function runDeferredToolIndex(): Promise<{ indexed: number }> {
  const { querySessionsForDeferredToolIndex } = await import('./session/db.js');
  const { ensureToolIndex } = await import('./session/tool-index.js');
  const sessions = querySessionsForDeferredToolIndex(200);
  if (sessions.length === 0) return { indexed: 0 };
  const coverage = await ensureToolIndex(sessions, {
    maxFiles: 20,
    maxBytes: 20 * 1024 * 1024,
  });
  return { indexed: coverage.indexedFiles };
}
