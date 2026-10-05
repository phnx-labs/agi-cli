
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getDB,
  readSessionInsights,
  readSessionPhenotypes,
  readSessionTopics,
  writeSessionInsights,
  writeSessionPhenotypes,
  writeSessionTopics,
} from '../session/db.js';
import type { SessionAgentId, SessionMeta, SessionRunMode } from '@phnx-labs/sessions-cli/reader';
import { parseSession } from '@phnx-labs/sessions-cli/reader';
import { buildTrajectory, type SessionTrajectory } from '@phnx-labs/sessions-cli/reader';
import { computeInsightFacets, type InsightFacets } from '@phnx-labs/sessions-cli/reader';
import { knownSecretValuesFromEnv, redactSecrets } from '../redact.js';
import { getRuntimeStateDir } from '../state.js';
import { resolveTracesBackend, type TracesBackend } from './backend.js';
import {
  classifyCause,
  classifyTopic,
  computeDriftSignal,
  type BucketStats,
  type ClassifiedTopic,
  type DriftSignal,
  type TraceFailureCause,
  type TraceTopicGroup,
} from './classify.js';
import { computeBehavioralPatterns, computeInsights, type FailurePattern } from './insights.js';
import { classifyPhenotype, recoveredAfterErrors, type FailurePhenotype } from './phenotype.js';
import type { LatencyInsight } from './segments.js';
import { buildSessionDetailV2 } from './schema2-build.js';
import type { SessionEvent } from '@phnx-labs/sessions-cli/reader';

export function buildSessionShard(
  traj: SessionTrajectory,
  events: SessionEvent[],
  knownSecrets: readonly string[] | undefined,
): ReturnType<typeof buildSessionDetailV2> {
  // Commands, queries, results, paths, and metadata are scrubbed at projection.
  return buildSessionDetailV2(traj, events, { redact: true, knownSecrets });
}


export interface SyncOpts {
  limit?: number;
  skipIndex?: boolean;
  dryRun?: boolean;
  outDir?: string;
}

export interface SyncResult {
  uploaded: number;
  skipped: number;
  errors: number;
  transcriptUnavailable: number;
  parseFailed: number;
  uploadFailed: number;
  indexError?: string;
}

export async function syncTraces(opts: SyncOpts = {}): Promise<SyncResult> {
  // Dry-run is local-only: no auth, network, watermark, or failure-ledger mutation.
  const dryRun = opts.dryRun === true;
  const outDir = opts.outDir;
  if (dryRun && !outDir) {
    throw new Error('traces sync --dry-run requires --out <dir>');
  }
  const backend = dryRun ? null : resolveTracesBackend();
  const owner = backend?.userId ?? 'local';
  const ledger = readSyncLedger();
  const db = getDB();
  const device = localDevice();

  const sinceMtime = dryRun ? 0 : (ledger.lastSyncMtime ?? 0);
  // A mirrored database may contain peers; only local-device rows may upload.
  const watermarkRows = db
    .prepare(
      'SELECT * FROM sessions WHERE (machine = ? OR machine IS NULL) AND file_mtime_ms > ? ORDER BY file_mtime_ms ASC',
    )
    .all(device, sinceMtime) as SyncRow[];

  // Retry IDs are unioned independently of the advancing success watermark.
  const retryIds = dryRun
    ? []
    : (ledger.failures ?? [])
        .filter((f) => f.kind !== 'transcript-unavailable')
        .map((f) => f.id);
  let rows = watermarkRows;
  if (retryIds.length) {
    const seen = new Set(watermarkRows.map((r) => r.id));
    const retryRows: SyncRow[] = [];
    for (let i = 0; i < retryIds.length; i += 400) {
      const chunk = retryIds.slice(i, i + 400);
      retryRows.push(
        ...(db
          .prepare(
            `SELECT * FROM sessions WHERE (machine = ? OR machine IS NULL) AND id IN (${chunk.map(() => '?').join(',')})`,
          )
          .all(device, ...chunk) as SyncRow[]),
      );
    }
    const stranded = retryRows.filter((r) => !seen.has(r.id));
    rows = [...watermarkRows, ...stranded].sort(
      (a, b) => (a.file_mtime_ms ?? 0) - (b.file_mtime_ms ?? 0),
    );
  }

  const limited = opts.limit !== undefined ? rows.slice(0, opts.limit) : rows;
  const knownSecrets = knownSecretValuesFromEnv();

  let uploaded = 0;
  let skipped = 0;
  let transcriptUnavailable = 0;
  let parseFailed = 0;
  let uploadFailed = 0;
  let maxSuccessMtime = ledger.lastSyncMtime ?? 0;

  const now = Date.now();
  const failures = new Map<string, SyncFailure>(
    (ledger.failures ?? []).map((f) => [f.id, f]),
  );
  const recordFailure = (row: SyncRow, kind: SyncFailureKind, err: unknown): void => {
    const raw = err instanceof Error ? err.message : String(err);
    const prev = failures.get(row.id);
    failures.set(row.id, {
      id: row.id,
      mtimeMs: row.file_mtime_ms ?? 0,
      kind,
      detail: redactSecrets(raw.split('\n')[0] ?? '', knownSecrets).slice(0, 200),
      firstSeen: prev?.firstSeen ?? now,
      attempts: (prev?.attempts ?? 0) + 1,
    });
  };

  if (dryRun && outDir) {
    fs.mkdirSync(path.join(outDir, 'sessions'), { recursive: true });
  }

  for (const row of limited) {
    if (!row.file_path) {
      skipped++;
      maxSuccessMtime = Math.max(maxSuccessMtime, row.file_mtime_ms ?? 0);
      continue;
    }
    let traj: SessionTrajectory;
    let events: SessionEvent[] = [];
    try {
      const session = rowToMeta(row);
      events = parseSession(row.file_path, row.agent as SessionAgentId);
      traj = buildTrajectory(events, session, { redact: true, knownSecrets });
    } catch (err) {
      if (!fs.existsSync(row.file_path)) {
        transcriptUnavailable++;
        recordFailure(row, 'transcript-unavailable', err);
      } else {
        parseFailed++;
        recordFailure(row, 'parse-failed', err);
      }
      continue;
    }
    try {
      if (dryRun && outDir) {
        fs.writeFileSync(
          path.join(outDir, 'sessions', `${row.id}.json`),
          JSON.stringify(buildSessionShard(traj, events, knownSecrets)),
        );
      } else {
        await putSessionTrace(backend!, device, row.id, traj, events, knownSecrets);
      }
      uploaded++;
      maxSuccessMtime = Math.max(maxSuccessMtime, row.file_mtime_ms ?? 0);
      failures.delete(row.id);
    } catch (err) {
      uploadFailed++;
      recordFailure(row, 'upload-failed', err);
    }
  }

  let indexError: string | undefined;
  if (!opts.skipIndex) {
    try {
      const allRows = db
        .prepare('SELECT * FROM sessions WHERE machine = ? OR machine IS NULL')
        .all(device) as SyncRow[];
      let prevShard: TracesIndexShard | null = null;
      if (dryRun && outDir) {
        const prevPath = path.join(outDir, 'index.json');
        try {
          prevShard = JSON.parse(fs.readFileSync(prevPath, 'utf8')) as TracesIndexShard;
        } catch {  }
      } else if (backend) {
        prevShard = await getIndexShard(backend, device);
      }
      const shard = buildIndexShard(allRows, device, owner, prevShard);
      if (dryRun && outDir) {
        fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(shard, null, 2));
      } else {
        await putIndexShard(backend!, device, owner, shard);
      }
    } catch (err) {
      indexError = err instanceof Error ? err.message : String(err);
    }
  }

  if (!dryRun) {
    const persistedFailures = [...failures.values()].filter(
      (f) =>
        !(
          f.kind === 'transcript-unavailable' &&
          now - f.firstSeen > TRANSCRIPT_UNAVAILABLE_TTL_MS
        ),
    );
    writeSyncLedger({ lastSyncMtime: maxSuccessMtime, failures: persistedFailures });
    // Prix receives only a managed Phoenix bearer, never the BYO static write token.
    if (backend && backend.userId !== 'byo') {
      fetch('https://api.prix.dev/api/v1/traces/link', {
        method: 'POST',
        headers: { Authorization: `Bearer ${backend.token}` },
        signal: AbortSignal.timeout(8_000),
      }).catch(() => {});
    }
  }
  return {
    uploaded,
    skipped,
    errors: transcriptUnavailable + parseFailed + uploadFailed,
    transcriptUnavailable,
    parseFailed,
    uploadFailed,
    indexError,
  };
}


export interface TracesIndexShard {
  schema: 1;
  device: string;
  syncedAt: number;
  owner: string;
  stats: {
    sessionsImported: number;
    medianMs: number;
    p90Ms: number;
    agentMedianMs: number;
    agentP90Ms: number;
    interactiveMedianMs: number;
    measuredFraction: number;
    needAttention: number;
    toolErrorRate: number;
  };
  utilityCount: number;
  needsAttention: IndexedSession[];
  topics: TopicItem[];
  failures: {
    byToolError: Array<{ tool: string; desc: string; cause: TraceFailureCause; count: number }>;
    byCause: Record<TraceFailureCause, number>;
  };
  bucketHistory: BucketStats[][];
  driftSignals: DriftSignal[];
  failurePatterns: FailurePattern[];
  wastedMsTotal: number;
  latency: LatencyInsight;
  sessions?: SessionRosterRow[];
}

export interface SessionRosterRow {
  id: string;
  title: string;
  harness: string;
  model: string;
  repo: string;
  mode: 'interactive' | 'headless';
  projectType: TraceTopicGroup;
  startedAt: number;
  durationMs: number;
  toolCount: number;
  errorCount: number;
  needsAttention: boolean;
  costUsd?: number;
}

export interface IndexedSession {
  id: string;
  title: string;
  repo: string;
  device: string;
  agent: string;
  model: string;
  kind: SessionKind;
  severity: number;
  flags: string[];
}

interface TopicSessionRef {
  id: string;
  title: string;
  kind: SessionKind;
  harness: string;
}

type SessionKind = 'utility' | 'agent';

const UTILITY_PROMPT_SIGNATURES: RegExp[] = [
  /generate a 3-4 word title/i,
  /generate a concise session headline/i,
  /you are a watchdog|watchdog monitoring/i,
  /conventional[- ]commit/i,
  /factory worker/i,
];

export function classifySessionKind(
  row: Pick<SyncRow, 'topic' | 'label' | 'message_count' | 'tool_call_count'>,
  toolCallCount: number,
): SessionKind {
  const haystack = `${row.topic ?? ''}\n${row.label ?? ''}`;
  if (UTILITY_PROMPT_SIGNATURES.some((re) => re.test(haystack))) return 'utility';
  const hasToolCalls = toolCallCount > 0 || (row.tool_call_count ?? 0) > 0;
  const messages = row.message_count ?? 0;
  if (!hasToolCalls && messages <= 2) return 'utility';
  return 'agent';
}

export interface TopicItem {
  key: string;
  label: string;
  count: number;
  group: TraceTopicGroup;
  sessions: TopicSessionRef[];
}

export interface ToolCallRow {
  session_id: string;
  ordinal: number;
  timestamp: string;
  end_timestamp?: string | null;
  tool: string;
  outcome: string;
  exit_code: number | null;
  status_code: number | null;
  error_code: string | null;
  error: string | null;
  parse_error: string | null;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

const IDLE_GAP_THRESHOLD_MS = 120_000;

const TOPIC_SESSION_CAP = 30;

export function sessionActiveMs(
  spanMs: number,
  sessionCalls: ToolCallRow[],
  sessionStartMs: number,
): number {
  if (spanMs <= 0) return Math.max(0, spanMs);
  if (!Number.isFinite(sessionStartMs)) return spanMs;
  const spanEndMs = sessionStartMs + spanMs;
  const ordered = sessionCalls
    .map((c) => ({ startMs: Date.parse(c.timestamp), endMs: Date.parse(c.end_timestamp ?? c.timestamp) }))
    .filter((c) => Number.isFinite(c.startMs))
    .sort((a, b) => a.startMs - b.startMs);
  if (ordered.length === 0) return spanMs;
  let idleMs = 0;
  let cursor = sessionStartMs;
  for (const call of ordered) {
    if (call.startMs > cursor + IDLE_GAP_THRESHOLD_MS) idleMs += call.startMs - cursor;
    const endMs = Number.isFinite(call.endMs) ? Math.max(call.endMs, call.startMs) : call.startMs;
    if (endMs > cursor) cursor = endMs;
  }
  if (spanEndMs > cursor + IDLE_GAP_THRESHOLD_MS) idleMs += spanEndMs - cursor;
  return Math.max(0, spanMs - Math.min(idleMs, spanMs));
}

export function activeMsFromTrajectory(traj: SessionTrajectory): number {
  const idleMs = traj.gaps.reduce((sum, gap) => sum + gap.durationMs, 0);
  return Math.max(0, traj.spanMs - Math.min(idleMs, traj.spanMs));
}

export function failureDescription(call: ToolCallRow, cause: TraceFailureCause): string {
  if (cause === 'guard') return /main-branch-guard/i.test(`${call.error_code ?? ''} ${call.error ?? ''}`)
    ? 'main branch guard' : 'git guard';
  if (cause === 'hook') return 'auto-mode hook denial';
  if (call.status_code != null) return `HTTP ${call.status_code}`;
  if (call.exit_code != null) return `exit ${call.exit_code}`;
  if (call.error_code) return 'tool error code';
  if (call.parse_error) return 'parse error';
  return 'tool error';
}

function attentionFlags(errorCount: number, facets: InsightFacets | undefined): string[] {
  const flags: string[] = [];
  if (errorCount > 0) flags.push(`${errorCount} error${errorCount === 1 ? '' : 's'}`);
  const friction = facets?.frictionSignals ?? {};
  const corrections = facets?.correctionSignals ?? {};
  const retryCount = Object.entries(friction)
    .filter(([key]) => key.startsWith('failed tool loop:'))
    .reduce((sum, [, count]) => sum + count, 0);
  if (retryCount > 0) flags.push('retry loop');
  const stall = Object.entries(friction).find(([key, count]) => key.startsWith('silent stall:') && count > 0);
  if (stall) flags.push(stall[0].replace('silent stall: ', 'stalled '));
  const correctionCount = Object.values(corrections).reduce((sum, count) => sum + count, 0);
  if (correctionCount > 0) flags.push(`${correctionCount} correction${correctionCount === 1 ? '' : 's'}`);
  return flags;
}

function persistDerivedCache(label: string, write: () => void): void {
  try {
    write();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`traces: ${label} cache warm-up skipped (${msg}) — index still built`);
  }
}

export function buildIndexShard(
  rows: SyncRow[],
  device: string,
  owner: string,
  prevShard?: TracesIndexShard | null,
): TracesIndexShard {
  const db = getDB();
  const knownSecrets = knownSecretValuesFromEnv();
  const ids = rows.map((row) => row.id);
  const calls: ToolCallRow[] = [];
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    calls.push(...db.prepare(`
      SELECT session_id, ordinal, timestamp, end_timestamp, tool, outcome, exit_code, status_code, error_code, error, parse_error
      FROM tool_calls
      WHERE session_id IN (${chunk.map(() => '?').join(',')})
    `).all(...chunk) as ToolCallRow[]);
  }
  const toolMix = new Map<string, Record<string, number>>();
  const errorCounts = new Map<string, number>();
  const callsBySession = new Map<string, ToolCallRow[]>();
  for (const call of calls) {
    const mix = toolMix.get(call.session_id) ?? {};
    mix[call.tool] = (mix[call.tool] ?? 0) + 1;
    toolMix.set(call.session_id, mix);
    if (call.outcome === 'error') {
      errorCounts.set(call.session_id, (errorCounts.get(call.session_id) ?? 0) + 1);
    }
    const list = callsBySession.get(call.session_id);
    if (list) list.push(call); else callsBySession.set(call.session_id, [call]);
  }

  const kindOf = new Map<string, SessionKind>(
    rows.map((row) => [row.id, classifySessionKind(row, callsBySession.get(row.id)?.length ?? 0)]),
  );
  const agentRows = rows.filter((row) => kindOf.get(row.id) === 'agent');
  const agentIds = agentRows.map((row) => row.id);
  const utilityCount = rows.length - agentRows.length;
  const agentCalls = calls.filter((call) => kindOf.get(call.session_id) === 'agent');

  const topics = readSessionTopics<ClassifiedTopic>(agentIds);
  const missingTopics = agentRows.filter((row) => !topics.has(row.id)).map((row) => {
    const topic = classifyTopic({
      cwd: row.cwd,
      gitBranch: row.git_branch,
      topic: row.topic,
      label: row.label,
      toolMix: toolMix.get(row.id),
    });
    topics.set(row.id, topic);
    return { id: row.id, fileMtimeMs: row.file_mtime_ms, fileSize: row.file_size, topic };
  });
  persistDerivedCache('session-topics', () => writeSessionTopics(missingTopics));

  const insights = readSessionInsights<InsightFacets>(agentIds);
  const phenotypes = readSessionPhenotypes<FailurePhenotype | null>(agentIds);
  const missingInsights: Array<{
    id: string;
    fileMtimeMs: number | null;
    fileSize: number | null;
    facets: InsightFacets;
  }> = [];
  const missingPhenotypes: Array<{
    id: string;
    fileMtimeMs: number | null;
    fileSize: number | null;
    phenotype: FailurePhenotype | null;
  }> = [];
  for (const row of agentRows) {
    const needInsights = !insights.has(row.id);
    const needPhenotype = !phenotypes.has(row.id);
    if (!needInsights && !needPhenotype) continue;
    let events: ReturnType<typeof parseSession>;
    try {
      events = parseSession(row.file_path, row.agent as SessionAgentId);
    } catch {
      continue;
    }
    if (needInsights) {
      try {
        const facets = computeInsightFacets(events);
        insights.set(row.id, facets);
        missingInsights.push({ id: row.id, fileMtimeMs: row.file_mtime_ms, fileSize: row.file_size, facets });
      } catch {  }
    }
    if (needPhenotype) {
      try {
        const traj = buildTrajectory(events, rowToMeta(row), { redact: true, knownSecrets });
        const phenotype = classifyPhenotype(buildSessionDetail(traj));
        phenotypes.set(row.id, phenotype);
        missingPhenotypes.push({ id: row.id, fileMtimeMs: row.file_mtime_ms, fileSize: row.file_size, phenotype });
      } catch {  }
    }
  }
  persistDerivedCache('session-insights', () => writeSessionInsights(missingInsights));
  persistDerivedCache('session-phenotypes', () => writeSessionPhenotypes(missingPhenotypes));

  const needsAttention = agentRows.flatMap((row): IndexedSession[] => {
    const facets = insights.get(row.id);
    const errorCount = errorCounts.get(row.id) ?? 0;
    const flags = attentionFlags(errorCount, facets);
    if (flags.length === 0) return [];
    const friction = Object.values(facets?.frictionSignals ?? {}).reduce((sum, count) => sum + count, 0);
    const corrections = Object.values(facets?.correctionSignals ?? {}).reduce((sum, count) => sum + count, 0);
    return [{
      id: row.id,
      title: redactSecrets(
        row.label ?? row.topic ?? topics.get(row.id)?.label ?? 'Untitled session',
        knownSecrets,
      ),
      repo: row.project ?? (row.cwd ? path.basename(row.cwd) : 'unknown'),
      device,
      agent: row.agent,
      model: row.model ?? 'unknown',
      kind: 'agent',
      severity: errorCount * 2 + friction * 3 + corrections * 2,
      flags,
    }];
  }).sort((a, b) => b.severity - a.severity || a.id.localeCompare(b.id));

  type TopicBucket = {
    key: string;
    label: string;
    count: number;
    group: TraceTopicGroup;
    refs: Array<{ id: string; title: string; harness: string; recencyMs: number }>;
  };
  const topicCounts = new Map<string, TopicBucket>();
  for (const row of agentRows) {
    const topic = topics.get(row.id);
    if (!topic) continue;
    const bucket = topicCounts.get(topic.key)
      ?? { key: topic.key, label: topic.label, group: topic.group, count: 0, refs: [] };
    bucket.count++;
    bucket.refs.push({
      id: row.id,
      title: redactSecrets(row.label ?? row.topic ?? topic.label ?? 'Untitled session', knownSecrets),
      harness: row.agent,
      recencyMs: Date.parse(row.last_activity ?? row.timestamp) || 0,
    });
    topicCounts.set(topic.key, bucket);
  }

  const failedCalls = agentCalls.filter((call) => call.outcome === 'error');
  const byCause: Record<TraceFailureCause, number> = { real: 0, guard: 0, hook: 0, behavioral: 0 };
  const failureCounts = new Map<string, { tool: string; desc: string; cause: TraceFailureCause; count: number }>();
  for (const call of failedCalls) {
    const cause = classifyCause(call);
    const desc = failureDescription(call, cause);
    byCause[cause]++;
    const key = `${call.tool}\u0000${desc}\u0000${cause}`;
    const current = failureCounts.get(key) ?? { tool: call.tool, desc, cause, count: 0 };
    current.count++;
    failureCounts.set(key, current);
  }
  const activeDurations = agentRows.flatMap((row) =>
    row.duration_ms == null
      ? []
      : [sessionActiveMs(row.duration_ms, callsBySession.get(row.id) ?? [], Date.parse(row.timestamp))],
  );

  const agentActive: number[] = [];
  const interactiveActive: number[] = [];
  let measured = 0;
  for (const row of agentRows) {
    if (row.duration_ms == null) continue;
    measured++;
    const active = sessionActiveMs(row.duration_ms, callsBySession.get(row.id) ?? [], Date.parse(row.timestamp));
    const isAgent = (callsBySession.get(row.id)?.length ?? 0) > 0 || (row.message_count ?? 0) > 8;
    (isAgent ? agentActive : interactiveActive).push(active);
  }
  const measuredFraction = agentRows.length === 0 ? 0 : measured / agentRows.length;

  const todayDate = new Date().toISOString().slice(0, 10);
  const todayStats: BucketStats[] = [...topicCounts.values()].map(({ key }) => {
    const sessionsInBucket = [...topics.entries()]
      .filter(([, t]) => t.key === key)
      .map(([id]) => id);
    const bucketCalls = agentCalls.filter((c) => sessionsInBucket.includes(c.session_id));
    const bucketErrors = bucketCalls.filter((c) => c.outcome === 'error').length;
    const errorRate = bucketCalls.length === 0 ? 0 : bucketErrors / bucketCalls.length;
    const stallCount = sessionsInBucket.filter((id) => {
      const facets = insights.get(id);
      return Object.entries(facets?.frictionSignals ?? {})
        .some(([k, v]) => k.startsWith('silent stall:') && v > 0);
    }).length;
    const stallRate = sessionsInBucket.length === 0 ? 0 : stallCount / sessionsInBucket.length;
    return { key, date: todayDate, count: topicCounts.get(key)!.count, errorRate, stallRate };
  });

  const prevHistory = prevShard?.bucketHistory ?? [];
  const bucketHistory = [...prevHistory, todayStats].slice(-14);
  const driftSignals = computeDriftSignal(prevHistory, todayStats);
  const behavioralPatterns = computeBehavioralPatterns(insights, prevShard);
  const patternInsights = computeInsights(agentRows, agentCalls, prevShard, phenotypes, behavioralPatterns);

  const needsAttentionIds = new Set(needsAttention.map((s) => s.id));
  const sessions: SessionRosterRow[] = agentRows.map((row): SessionRosterRow => {
    const isAgent = (callsBySession.get(row.id)?.length ?? 0) > 0 || (row.message_count ?? 0) > 8;
    const durationMs = row.duration_ms == null
      ? 0
      : sessionActiveMs(row.duration_ms, callsBySession.get(row.id) ?? [], Date.parse(row.timestamp));
    const rosterRow: SessionRosterRow = {
      id: row.id,
      title: redactSecrets(
        row.label ?? row.topic ?? topics.get(row.id)?.label ?? 'Untitled session',
        knownSecrets,
      ),
      harness: row.agent,
      model: row.model ?? 'unknown',
      repo: row.project ?? (row.cwd ? path.basename(row.cwd) : (row.git_branch ?? 'unknown')),
      mode: isAgent ? 'headless' : 'interactive',
      projectType: topics.get(row.id)?.group ?? 'code',
      startedAt: Date.parse(row.timestamp) || 0,
      durationMs,
      toolCount: row.tool_call_count ?? 0,
      errorCount: errorCounts.get(row.id) ?? 0,
      needsAttention: needsAttentionIds.has(row.id),
    };
    if (row.cost_usd != null) rosterRow.costUsd = row.cost_usd;
    return rosterRow;
  });

  return {
    schema: 1,
    device,
    syncedAt: Date.now(),
    owner,
    stats: {
      sessionsImported: agentRows.length,
      medianMs: percentile(activeDurations, 0.5),
      p90Ms: percentile(activeDurations, 0.9),
      agentMedianMs: percentile(agentActive, 0.5),
      agentP90Ms: percentile(agentActive, 0.9),
      interactiveMedianMs: percentile(interactiveActive, 0.5),
      measuredFraction,
      needAttention: needsAttention.length,
      toolErrorRate: agentCalls.length === 0 ? 0 : failedCalls.length / agentCalls.length,
    },
    utilityCount,
    needsAttention,
    topics: [...topicCounts.values()]
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
      .map((bucket) => ({
        key: bucket.key,
        label: bucket.label,
        count: bucket.count,
        group: bucket.group,
        sessions: bucket.refs
          .sort((a, b) => b.recencyMs - a.recencyMs)
          .slice(0, TOPIC_SESSION_CAP)
          .map(({ id, title, harness }): TopicSessionRef => ({ id, title, kind: 'agent', harness })),
      })),
    failures: {
      byToolError: [...failureCounts.values()].sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool)),
      byCause,
    },
    bucketHistory,
    driftSignals,
    failurePatterns: patternInsights.failurePatterns,
    wastedMsTotal: patternInsights.wastedMsTotal,
    latency: patternInsights.latency,
    sessions,
  };
}


export interface SessionDetail {
  schema: 1;
  id: string;
  meta: {
    spanMs: number;
    activeMs: number;
    turns: number;
    tools: number;
    errorCount: number;
    tokens: number;
    costUsd: number;
    outcome: string;
    repo: string;
    agent: string;
    model: string;
  };
  steps: SessionTrajectory['steps'];
  gaps: SessionTrajectory['gaps'];
  truncatedSteps: number;
  whereItWentWrong: string | null;
  surfacedToolFailures: Array<{ tool?: string; label: string; detail?: string }>;
}

export function buildWhereItWentWrong(traj: SessionTrajectory): string | null {
  const errorSteps = traj.steps.filter((s) => s.outcome === 'error');
  const biggestGap = traj.gaps.reduce<SessionTrajectory['gaps'][number] | null>(
    (max, g) => (!max || g.durationMs > max.durationMs ? g : max),
    null,
  );
  const parts: string[] = [];
  if (errorSteps.length > 0) {
    const first = errorSteps[0];
    const who = first.tool ?? first.lane;
    parts.push(
      `${errorSteps.length} tool error${errorSteps.length === 1 ? '' : 's'} (first: ${who} — ${first.label})`,
    );
  }
  if (biggestGap && biggestGap.durationMs >= 60_000) {
    parts.push(`stalled ${Math.round(biggestGap.durationMs / 60_000)}m`);
  }
  if (parts.length === 0) return null;
  return `This run hit ${parts.join('; ')}.`;
}

export function deriveRunOutcome(traj: SessionTrajectory): 'completed' | 'errored' {
  if (traj.errorCount === 0) return 'completed';
  return recoveredAfterErrors({ steps: traj.steps }) ? 'completed' : 'errored';
}

export function buildDetailMeta(traj: SessionTrajectory): SessionDetail['meta'] {
  const s = traj.session as SessionMeta & {
    project?: string;
    cwd?: string;
    costUsd?: number;
  };
  const stats = traj.stats as {
    userTurns?: number;
    assistantTurns?: number;
    toolCount?: number;
    outputTokens?: number;
  };
  const repo = s.project ?? (s.cwd ? path.basename(s.cwd) : 'unknown');
  return {
    spanMs: traj.spanMs,
    activeMs: activeMsFromTrajectory(traj),
    turns: (stats.userTurns ?? 0) + (stats.assistantTurns ?? 0),
    tools: stats.toolCount ?? 0,
    errorCount: traj.errorCount,
    tokens: stats.outputTokens ?? 0,
    costUsd: s.costUsd ?? 0,
    outcome: deriveRunOutcome(traj),
    repo,
    agent: s.agent,
    model: s.model ?? 'unknown',
  };
}

export function buildSessionDetail(traj: SessionTrajectory): SessionDetail {
  const s = traj.session as SessionMeta & { id: string };
  return {
    schema: 1,
    id: s.id,
    meta: buildDetailMeta(traj),
    steps: traj.steps,
    gaps: traj.gaps,
    truncatedSteps: traj.truncatedSteps,
    whereItWentWrong: buildWhereItWentWrong(traj),
    surfacedToolFailures: traj.steps
      .filter((step) => step.outcome === 'error')
      .map((step) => ({ tool: step.tool, label: step.label, detail: step.detail })),
  };
}

async function getIndexShard(
  backend: TracesBackend,
  device: string,
): Promise<TracesIndexShard | null> {
  const url = `${backend.baseUrl}/${backend.userId}/${device}/index.json`;
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${backend.token}` },
    });
    if (!res.ok) return null;
    return await res.json() as TracesIndexShard;
  } catch {
    return null;
  }
}

async function putSessionTrace(
  backend: TracesBackend,
  device: string,
  sessionId: string,
  traj: SessionTrajectory,
  events: SessionEvent[],
  knownSecrets: readonly string[] | undefined,
): Promise<void> {
  const url = `${backend.baseUrl}/${backend.userId}/${device}/sessions/${sessionId}.json`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${backend.token}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(buildSessionShard(traj, events, knownSecrets)),
  });
  if (!res.ok) {
    throw new Error(`PUT ${url} → ${res.status}`);
  }
}

async function putIndexShard(
  backend: TracesBackend,
  device: string,
  owner: string,
  shard: TracesIndexShard,
): Promise<void> {
  const full: TracesIndexShard = { ...shard, device, owner, syncedAt: Date.now() };
  const url = `${backend.baseUrl}/${backend.userId}/${device}/index.json`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${backend.token}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(full),
  });
  if (!res.ok) {
    throw new Error(`PUT ${url} → ${res.status}`);
  }
}


export type SyncFailureKind = 'transcript-unavailable' | 'parse-failed' | 'upload-failed';

export interface SyncFailure {
  id: string;
  mtimeMs: number;
  kind: SyncFailureKind;
  detail: string;
  firstSeen: number;
  attempts: number;
}

const TRANSCRIPT_UNAVAILABLE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

interface SyncLedger {
  lastSyncMtime?: number;
  failures?: SyncFailure[];
}

function ledgerPath(): string {
  return path.join(getRuntimeStateDir(), 'traces-sync.json');
}

export function readSyncLedger(): SyncLedger {
  try {
    const raw = fs.readFileSync(ledgerPath(), 'utf8');
    return JSON.parse(raw) as SyncLedger;
  } catch {
    return {};
  }
}

function writeSyncLedger(ledger: SyncLedger): void {
  const p = ledgerPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
}

export function hasSyncedBefore(): boolean {
  return fs.existsSync(ledgerPath());
}


function localDevice(): string {
  return (process.env['AGENTS_SYNC_MACHINE_ID'] ?? os.hostname()).toLowerCase().replace(/\.local$/, '');
}


export interface SyncRow {
  id: string;
  short_id: string;
  agent: string;
  origin: string | null;
  routine_name: string | null;
  routine_run_id: string | null;
  version: string | null;
  account: string | null;
  account_key: string | null;
  account_org: string | null;
  mode: string | null;
  timestamp: string;
  last_activity: string | null;
  project: string | null;
  cwd: string | null;
  git_branch: string | null;
  topic: string | null;
  label: string | null;
  message_count: number | null;
  token_count: number | null;
  output_tokens: number | null;
  input_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
  cost_usd_nocache: number | null;
  duration_ms: number | null;
  model: string | null;
  tool_call_count: number | null;
  file_path: string;
  file_mtime_ms: number | null;
  file_size: number | null;
  machine: string | null;
}

function rowToMeta(row: SyncRow): SessionMeta {
  const SESSION_RUN_MODES: SessionRunMode[] = ['plan', 'edit', 'auto', 'skip'];
  return {
    id: row.id,
    shortId: row.short_id,
    agent: row.agent as SessionAgentId,
    origin: row.origin === 'routine' ? 'routine' : 'cli',
    routineName: row.routine_name ?? undefined,
    routineRunId: row.routine_run_id ?? undefined,
    timestamp: row.timestamp,
    lastActivity: row.last_activity ?? undefined,
    project: row.project ?? undefined,
    cwd: row.cwd ?? undefined,
    filePath: row.file_path,
    gitBranch: row.git_branch ?? undefined,
    messageCount: row.message_count ?? undefined,
    tokenCount: row.token_count ?? undefined,
    outputTokens: row.output_tokens ?? undefined,
    inputTokens: row.input_tokens ?? undefined,
    cacheReadTokens: row.cache_read_tokens ?? undefined,
    cacheWriteTokens: row.cache_write_tokens ?? undefined,
    costUsd: row.cost_usd ?? undefined,
    costUsdNoCache: row.cost_usd_nocache ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    model: row.model ?? undefined,
    toolCallCount: row.tool_call_count ?? undefined,
    version: row.version ?? undefined,
    account: row.account ?? undefined,
    accountKey: row.account_key ?? undefined,
    accountOrg: row.account_org ?? undefined,
    mode: (SESSION_RUN_MODES as string[]).includes(row.mode ?? '') ? (row.mode as SessionRunMode) : undefined,
    topic: row.topic ?? undefined,
    label: row.label ?? undefined,
    machine: row.machine ?? undefined,
  };
}
