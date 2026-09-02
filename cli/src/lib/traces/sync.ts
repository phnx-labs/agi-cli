/**
 * Incremental sync of derived, redacted SessionTrajectory blobs to the
 * agents-traces R2 store.
 *
 * Security invariant: only the derived signal (steps + gaps + stats +
 * errorCount + programTimeShare) is uploaded — no raw transcript text.
 * redactSecrets() is called inside buildTrajectory() before we PUT.
 *
 * Sync gate: `sessions.db` `file_mtime_ms` is the source of truth.  A ledger
 * at `getRuntimeStateDir()/traces-sync.json` records the last sync timestamp
 * per device so re-runs skip unchanged sessions.
 *
 * Retry ledger: the mtime watermark alone cannot retry failures — a later-mtime
 * success advances it past an earlier failed row, which the next run's
 * `file_mtime_ms > watermark` filter then skips forever. So the same ledger also
 * records the identity + typed evidence of each failed session (`failures`), and
 * the row query unions those retry-worthy ids back in regardless of the watermark
 * (PHNX-3267). Failures are typed so a gone transcript (`transcript-unavailable`,
 * expected history, aged out after a TTL and never re-read) is distinguished from a
 * real parse/upload failure (retried until it resolves).
 */

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
import type { SessionAgentId, SessionMeta, SessionRunMode } from '../session/types.js';
import { parseSession } from '../session/parse.js';
import { buildTrajectory, type SessionTrajectory } from '../session/trajectory.js';
import { computeInsightFacets, type InsightFacets } from '../session/insights.js';
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
import type { SessionEvent } from '../session/types.js';

/**
 * The per-session shard body: the schema-2 rich `ToolExecution` detail. The
 * console decoder (prix/web) reads BOTH schema 1 and schema 2 and is the only
 * shard consumer, so emitting schema 2 is backward-compatible by construction —
 * no rollout flag is needed and none should exist (a producer that runs across
 * the fleet must not depend on an operator setting an env var). Both the upload
 * and dry-run paths call this one builder.
 */
export function buildSessionShard(
  traj: SessionTrajectory,
  events: SessionEvent[],
  knownSecrets: readonly string[] | undefined,
): ReturnType<typeof buildSessionDetailV2> {
  return buildSessionDetailV2(traj, events, { redact: true, knownSecrets });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SyncOpts {
  /** Limit to N sessions (for testing / --dry-run); no limit when undefined. */
  limit?: number;
  /** When true, skip uploading the per-device index shard. */
  skipIndex?: boolean;
  /**
   * Compute the derived shards from this device's real sessions.db and WRITE
   * them to `outDir` instead of uploading. No Phoenix auth, no worker, no
   * network — a local export for verifying the real signal. Ignores the
   * incremental watermark so the export reflects every session.
   */
  dryRun?: boolean;
  /** Directory to write `index.json` + `sessions/<id>.json` when `dryRun` is set. */
  outDir?: string;
}

export interface SyncResult {
  uploaded: number;
  skipped: number;
  /** Total failures = transcriptUnavailable + parseFailed + uploadFailed. Kept for callers. */
  errors: number;
  /** The transcript file the row points at is gone/unreadable — expected history, not retried each run. */
  transcriptUnavailable: number;
  /** The transcript exists but could not be parsed into a trajectory — retried until it parses. */
  parseFailed: number;
  /** Parsed fine but the upload PUT failed (network/5xx) — retried on the next sync. */
  uploadFailed: number;
  /**
   * The index shard build or upload failed. Undefined on success. The per-session
   * data still uploaded (that loop runs first), but the aggregated console shard —
   * stats, needs-attention, failure clusters, latency — was NOT refreshed, so the
   * console keeps serving the last good index. Surfaced (not swallowed) so a stale
   * console is diagnosable instead of looking like a clean sync. See PHNX-3401.
   */
  indexError?: string;
}

/** Push derived, redacted trajectories for this device to the traces store. */
export async function syncTraces(opts: SyncOpts = {}): Promise<SyncResult> {
  const dryRun = opts.dryRun === true;
  const outDir = opts.outDir;
  if (dryRun && !outDir) {
    throw new Error('traces sync --dry-run requires --out <dir>');
  }
  // A dry-run computes locally and writes to disk: no Phoenix backend needed.
  const backend = dryRun ? null : resolveTracesBackend();
  const owner = backend?.userId ?? 'local';
  const ledger = readSyncLedger();
  const db = getDB();
  const device = localDevice();

  // Scope to this machine only — the DB can contain peer rows mirrored from the
  // fleet; uploading those under this device's prefix would corrupt the index.
  // NULL machine rows are legacy local sessions (pre-machine-field). A dry-run
  // ignores the incremental watermark so the export covers every session.
  const sinceMtime = dryRun ? 0 : (ledger.lastSyncMtime ?? 0);
  const watermarkRows = db
    .prepare(
      'SELECT * FROM sessions WHERE (machine = ? OR machine IS NULL) AND file_mtime_ms > ? ORDER BY file_mtime_ms ASC',
    )
    .all(device, sinceMtime) as SyncRow[];

  // The watermark alone loses failures: a later-mtime success advances it past an
  // earlier failed row, which the `file_mtime_ms > sinceMtime` filter then skips
  // forever. So union in the sessions we explicitly recorded as retry-worthy
  // failures (parse/upload — a `transcript-unavailable` file is gone, re-reading it
  // wastes work) regardless of where the watermark sits. A dry-run ignores the
  // ledger entirely and already selects every row.
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
  // Advance the watermark only to the max mtime of successfully uploaded sessions.
  // On its own this does NOT retry failures (a later success strands earlier ones);
  // the failure ledger below is what actually re-selects them next run.
  let maxSuccessMtime = ledger.lastSyncMtime ?? 0;

  // Carry prior failures forward by id so a stranded row's identity + evidence
  // survives across syncs. A success removes the id; a repeat failure updates it.
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
      // A gone/unreadable transcript is expected history, not a retry-worthy error;
      // a file that IS present but failed to parse is a real problem to retry.
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
      failures.delete(row.id); // recovered — drop it from the retry set
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
      // Seed rolling bucket history from the previous shard so drift signals accumulate.
      let prevShard: TracesIndexShard | null = null;
      if (dryRun && outDir) {
        const prevPath = path.join(outDir, 'index.json');
        try {
          prevShard = JSON.parse(fs.readFileSync(prevPath, 'utf8')) as TracesIndexShard;
        } catch { /* first run — no prior shard */ }
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
      // Not fatal to the per-session upload (that loop already ran), but it DOES
      // mean the console shard is now stale. Record it so the caller can surface a
      // warning instead of reporting a clean, green sync — a silent swallow here is
      // exactly what let a 59h-stale, insight-less index hide in plain sight
      // (PHNX-3401). Do NOT re-throw: the session data is durable and worth keeping.
      indexError = err instanceof Error ? err.message : String(err);
    }
  }

  // A dry-run never advances the incremental watermark: it is a read-only export.
  if (!dryRun) {
    // Age out long-unavailable transcripts so a corpus of deleted files cannot grow
    // the retry set without bound; parse/upload failures persist until they resolve.
    const persistedFailures = [...failures.values()].filter(
      (f) =>
        !(
          f.kind === 'transcript-unavailable' &&
          now - f.firstSeen > TRANSCRIPT_UNAVAILABLE_TTL_MS
        ),
    );
    writeSyncLedger({ lastSyncMtime: maxSuccessMtime, failures: persistedFailures });
    // Register the Phoenix session with Prix so the console can fetch live data
    // (PHNX-3257). Fire-and-forget — a link failure must not block sync.
    // Managed backend only: the BYO path's token is a static write token that
    // bypasses Phoenix auth (resolveTracesBackend's userId: 'byo' sentinel) —
    // it is not a Phoenix identity credential and must never be sent to Prix.
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

// ---------------------------------------------------------------------------
// Index shard — per-device aggregated stats strip
// ---------------------------------------------------------------------------

export interface TracesIndexShard {
  schema: 1;
  device: string;
  syncedAt: number;
  owner: string;
  stats: {
    sessionsImported: number;
    /**
     * Median ACTIVE duration (span − idle gaps > 120s), ms — the meaningful figure
     * (PHNX-3457). Same key/shape as before this change, so the fleet-aggregate
     * worker (`worker-template.ts`) keeps weighted-averaging it unchanged; only its
     * VALUE moved from raw span to active time. The raw span stays available per
     * session on `SessionDetail.meta.spanMs`.
     */
    medianMs: number;
    /** p90 ACTIVE duration, ms. */
    p90Ms: number;
    /**
     * SEGMENTED active-time stats (PHNX-3472). The blended `medianMs`/`p90Ms`
     * above conflate one-shot interactive queries (63% of the corpus, ~15s
     * median) with substantial agent runs (~15min median), so they headline
     * neither. A session is an AGENT run when it made any tool call OR has more
     * than 8 messages; otherwise INTERACTIVE. These segment the same active-time
     * figure so the console can headline agent runs on their own axis. Each is
     * computed only over sessions with a non-null duration.
     */
    agentMedianMs: number;
    /** p90 ACTIVE duration over AGENT sessions, ms. */
    agentP90Ms: number;
    /** Median ACTIVE duration over INTERACTIVE sessions, ms. */
    interactiveMedianMs: number;
    /** (sessions with a non-null duration) / (total sessions), 0..1 — coverage of the duration stats. */
    measuredFraction: number;
    needAttention: number;
    toolErrorRate: number;
  };
  /**
   * Sessions excluded from the eval corpus as internal utility plumbing (PHNX-3474):
   * single-shot machine calls (no tool call AND ≤2 messages) or a known
   * internal-prompt signature (title generation, watchdog, commit-message, factory
   * worker). Every `stats` figure above, `topics` counts, and `needsAttention` are
   * computed over the AGENT set ONLY — `sessionsImported` is the real agent count,
   * not the raw row count. This is the number that was dropped.
   */
  utilityCount: number;
  needsAttention: IndexedSession[];
  topics: TopicItem[];
  failures: {
    byToolError: Array<{ tool: string; desc: string; cause: TraceFailureCause; count: number }>;
    byCause: Record<TraceFailureCause, number>;
  };
  /** Rolling 14-day window of per-bucket daily stats. Each inner array is one day. */
  bucketHistory: BucketStats[][];
  /** Movement signals for buckets with ≥3 days of history. */
  driftSignals: DriftSignal[];
  /** Cross-session failure clusters ranked by wasted time, from computeInsights(). Top-K, bounded. */
  failurePatterns: FailurePattern[];
  /** Sum of wastedMs across every cluster (not just the top-K rows above) — the headline number. */
  wastedMsTotal: number;
  /** Time-to-first-tool percentiles across this device's sessions. */
  latency: LatencyInsight;
  /**
   * Per-session roster — one flat scalar row per AGENT session (PHNX-3483), the
   * raw material the Rush console filters and re-aggregates live. Every `stats`
   * figure above is a pre-rolled scalar over the whole agent corpus; the console
   * cannot re-derive a filtered headline (e.g. "median for `claude` only") from a
   * scalar, so it needs the underlying rows. `durationMs` is the ACTIVE duration
   * (`sessionActiveMs`, the same value backing `stats.medianMs`; 0 when the span is
   * unmeasured), and `mode` encodes the AGENT-vs-INTERACTIVE segmentation
   * (`headless` = an agent run, `interactive` = a one-shot query) — the SAME
   * partition behind `stats.agentMedianMs` / `stats.interactiveMedianMs`, so a
   * mode-split median over the MEASURED rows reproduces them. The segmented stats
   * skip unmeasured (null-duration) sessions, which the roster still carries at
   * `durationMs: 0`, so a consumer reproducing the medians must exclude those the
   * same way (`measuredFraction` reports the covered share). Utility rows are
   * excluded, exactly like every other index statistic, so the roster length equals
   * the agent count (`stats.sessionsImported`). Optional here for schema
   * compatibility with a shard produced before this field.
   */
  sessions?: SessionRosterRow[];
}

/**
 * One per-session row in the index roster (PHNX-3483) — flat scalars only, so the
 * Rush console can filter the session set and re-aggregate the headline metrics
 * client-side without re-parsing transcripts. Built over AGENT rows only.
 */
export interface SessionRosterRow {
  id: string;
  /** `label ?? topic ?? classified-topic label`, secret-redacted. */
  title: string;
  /** The producing harness (`row.agent`). */
  harness: string;
  model: string;
  /** Short repo name from `project` / `cwd` basename / `git_branch`. */
  repo: string;
  /**
   * `headless` = an agent run (any tool call OR more than 8 messages),
   * `interactive` = a one-shot query — the SAME split behind
   * `stats.agentMedianMs` / `stats.interactiveMedianMs`.
   */
  mode: 'interactive' | 'headless';
  /** Corpus topic group of the session; `code` when unclassified. */
  projectType: TraceTopicGroup;
  /** Session start, epoch ms. */
  startedAt: number;
  /** ACTIVE duration in ms (`sessionActiveMs`); 0 when the span is unmeasured. */
  durationMs: number;
  toolCount: number;
  errorCount: number;
  needsAttention: boolean;
  /** Best-effort — omitted when the source figure is unavailable. */
  costUsd?: number;
}

export interface IndexedSession {
  id: string;
  title: string;
  repo: string;
  device: string;
  /** The harness that produced the session (claude/codex/rush/grok/…). Same as `harness`. */
  agent: string;
  model: string;
  /** Corpus classification (PHNX-3474). Always `'agent'` here — utility rows are excluded. */
  kind: SessionKind;
  severity: number;
  flags: string[];
}

/**
 * One example session under a topic tile — the shape the console drill-down consumes.
 * Carries `kind` + `harness` (PHNX-3474) so the console can filter a tile's session
 * list by corpus class and by harness. Refs on a topic tile are always `'agent'`
 * (utility rows never reach a bucket), but the field is explicit for the consumer.
 */
export interface TopicSessionRef {
  id: string;
  title: string;
  kind: SessionKind;
  harness: string;
}

/**
 * Corpus class of a session (PHNX-3474). `utility` is internal machine plumbing —
 * a single-shot call with no tool use and ≤2 messages, or one whose topic/label
 * matches a known internal-prompt signature (title generation, watchdog,
 * commit-message writer, factory worker). Everything else is `agent`: real agent
 * work the Evals console counts and scores. Utility rows are tagged, never deleted,
 * and excluded from every index statistic.
 */
export type SessionKind = 'utility' | 'agent';

/**
 * Topic/label substrings that identify an internal-prompt session regardless of its
 * message/tool shape. These are the harness-spawned utility prompts the Rush app
 * fires (they run under the `claude` harness): title generation writes the 3–4 word
 * session title, the watchdog polls for stalled agents, the commit-message writer
 * drafts a conventional commit, and factory workers are dispatched sub-agents. The
 * title-generation prompt lives in the `topic` column, the rest can land in either
 * `topic` or `label`, so both are matched.
 */
const UTILITY_PROMPT_SIGNATURES: RegExp[] = [
  /generate a 3-4 word title/i, // title generation
  /generate a 3-6 word technical title/i, // session-title daemon service (PHNX-3797)
  /you are a watchdog|watchdog monitoring/i, // watchdog tick
  /conventional[- ]commit/i, // commit-message writer
  /factory worker/i, // dispatched factory worker
];

/**
 * Classify a session as internal `utility` plumbing vs real `agent` work (PHNX-3474).
 * `toolCallCount` is the AUTHORITATIVE per-session tool-call count from the loaded
 * `tool_calls` rows (the row's own `tool_call_count` column is a fallback for a row
 * whose calls weren't loaded). A session is `utility` when a known internal-prompt
 * signature matches its topic/label, OR it made no tool call AND has ≤2 messages —
 * the single-shot machine-call shape. Otherwise it is `agent`.
 */
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

/**
 * One topic bucket in the treemap. `sessions` carries up to {@link TOPIC_SESSION_CAP}
 * example refs so the console can drill from the tile into its session list — a tile
 * with no refs renders display-only (PHNX-3408). `count` stays the true total.
 */
export interface TopicItem {
  key: string;
  label: string;
  count: number;
  group: TraceTopicGroup;
  sessions: TopicSessionRef[];
}

/** A row from `tool_calls`. `ordinal`/`timestamp` order calls within a session for computeInsights(). */
export interface ToolCallRow {
  session_id: string;
  ordinal: number;
  timestamp: string;
  /**
   * When the call's result arrived — its own end time (PHNX-3437). Optional
   * because rows an older extractor stored, and calls that never produced a
   * result, carry NULL; `computeInsights` falls back to the bounded inter-call
   * gap when it is absent.
   */
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

/**
 * A delta between consecutive events longer than this reads as an idle stall, not
 * work — the same threshold the trajectory uses for its gap detection
 * (`DEFAULT_IDLE_THRESHOLD_MS`, trajectory.ts). Kept in lockstep so active time
 * here and the gaps drawn in a session's detail view agree on what "idle" means.
 */
const IDLE_GAP_THRESHOLD_MS = 120_000;

/** Max example session refs carried per topic tile so a tile is drillable (PHNX-3408). */
const TOPIC_SESSION_CAP = 30;

/**
 * Active time for a session in the index shard: its recorded span minus every idle
 * gap > 120s (PHNX-3457). The index build already holds the ordered `tool_calls`
 * rows for the whole corpus, so idle is derived from them here — no transcript
 * re-parse. A cursor sweeps the span from `sessionStartMs`: each stretch where the
 * cursor sits idle for more than the threshold before the next call starts is
 * subtracted, and idle is measured from a call's END (its own `end_timestamp` when
 * known, else its start) so a call's own blocking duration is never mistaken for
 * idle. Crucially the sweep also books the gaps at the two BOUNDARIES — before the
 * first call and after the last call to the session end — so a session with a lone
 * tool call that was then abandoned and resumed hours later (the case a
 * between-calls-only measure missed entirely, leaving the whole 345h span counted
 * as active) has that trailing idle stripped. A session end is `sessionStartMs +
 * spanMs`, so the two agree by construction.
 *
 * Bounded to `[0, spanMs]`. A session with NO tool calls returns the full span
 * unchanged rather than a fabricated zero: there is no tool-call evidence of idle
 * either way, and treating a chat-only turn as 100% idle would be a worse error
 * than leaving its span uncorrected. Where the full event stream IS available (a
 * per-session `SessionDetail`), {@link activeMsFromTrajectory} is used instead —
 * it sees message events this call-only approximation cannot, so the two are close
 * but not identical by design (the corpus-scale index build cannot afford the
 * per-session parse the detail view does).
 */
export function sessionActiveMs(
  spanMs: number,
  sessionCalls: ToolCallRow[],
  sessionStartMs: number,
): number {
  if (spanMs <= 0) return Math.max(0, spanMs);
  if (!Number.isFinite(sessionStartMs)) return spanMs; // can't place calls on the span
  const spanEndMs = sessionStartMs + spanMs;
  const ordered = sessionCalls
    .map((c) => ({ startMs: Date.parse(c.timestamp), endMs: Date.parse(c.end_timestamp ?? c.timestamp) }))
    .filter((c) => Number.isFinite(c.startMs))
    .sort((a, b) => a.startMs - b.startMs);
  if (ordered.length === 0) return spanMs; // no tool-call evidence of idle
  let idleMs = 0;
  let cursor = sessionStartMs;
  for (const call of ordered) {
    if (call.startMs > cursor + IDLE_GAP_THRESHOLD_MS) idleMs += call.startMs - cursor;
    const endMs = Number.isFinite(call.endMs) ? Math.max(call.endMs, call.startMs) : call.startMs;
    if (endMs > cursor) cursor = endMs;
  }
  // Trailing idle: the stretch from the last call's end to the session's end.
  if (spanEndMs > cursor + IDLE_GAP_THRESHOLD_MS) idleMs += spanEndMs - cursor;
  return Math.max(0, spanMs - Math.min(idleMs, spanMs));
}

/** Active time from an already-built trajectory: span minus its idle gaps (all > threshold). */
export function activeMsFromTrajectory(traj: SessionTrajectory): number {
  const idleMs = traj.gaps.reduce((sum, gap) => sum + gap.durationMs, 0);
  return Math.max(0, traj.spanMs - Math.min(idleMs, traj.spanMs));
}

/** Human description of a failed call, keyed by (tool, desc, cause) for grouping. Exported for computeInsights(). */
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

/**
 * Persist a derived-cache warm-up (topics / insights) without letting a
 * contended DB take down the whole index build.
 *
 * These write-backs only speed up the NEXT sync — the shard about to be built
 * reads from the in-memory `topics` / `insights` maps that were already
 * populated above, never from what this write persists. So the write is
 * genuinely optional to the shard's correctness.
 *
 * Yet it was the single point that broke the console: on an active machine the
 * Rush app holds `sessions.db`, this `BEGIN IMMEDIATE` waits out the 30s
 * `busy_timeout` and throws `SQLITE_BUSY`, the throw escaped `buildIndexShard`,
 * and `syncTraces` swallowed it — so the index (with wasted-time / failure
 * clusters / latency) never re-uploaded and the dashboard sat 59h stale
 * (PHNX-3401). Isolating the failure here keeps the index building; the warning
 * makes the degraded cache visible instead of silent.
 */
function persistDerivedCache(label: string, write: () => void): void {
  try {
    write();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`traces: ${label} cache warm-up skipped (${msg}) — index still built`);
  }
}

/** Build the redacted rich console shard from indexed metadata and derived caches. */
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

  // Classify every row as real `agent` work or internal `utility` plumbing, then run
  // the ENTIRE rest of the shard build over the agent set ONLY (PHNX-3474). Utility
  // rows — title-gen / watchdog / commit-message / factory-worker calls, ~68% of the
  // corpus — are tagged and excluded here, never deleted from sessions.db, so the
  // console counts and scores real agent work: `sessionsImported`, the medians,
  // needs-attention, tool-error-rate, and the topic buckets all measure `agentRows`.
  const kindOf = new Map<string, SessionKind>(
    rows.map((row) => [row.id, classifySessionKind(row, callsBySession.get(row.id)?.length ?? 0)]),
  );
  const agentRows = rows.filter((row) => kindOf.get(row.id) === 'agent');
  const agentIds = agentRows.map((row) => row.id);
  const utilityCount = rows.length - agentRows.length;
  // Tool calls belonging to utility rows never contribute to the failure/latency
  // stats or the tool-error rate — filter them out at the source alongside the rows.
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

  // Insights (frictionSignals) and phenotype (false-termination / …) both need
  // the parsed transcript, which flat tool_calls rows don't carry — so both are
  // lazily derived per-session and cached by transcript mtime+size, then read for
  // the WHOLE corpus (`rows` = allRows) every sync. That full-corpus read is what
  // keeps the phenotype grouping dimension consistent: a session synced weeks ago
  // still contributes its real phenotype from cache, so it can never fragment away
  // from an identically-signatured session synced this run purely by *when* each
  // was first seen (PHNX-3327). A cache-miss row is parsed at most once here even
  // when both derivations are missing.
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
      continue; // gone/unreadable transcript — leave both uncached, same as before
    }
    if (needInsights) {
      try {
        const facets = computeInsightFacets(events);
        insights.set(row.id, facets);
        missingInsights.push({ id: row.id, fileMtimeMs: row.file_mtime_ms, fileSize: row.file_size, facets });
      } catch { /* leave this session's facets uncached; recompute next sync */ }
    }
    if (needPhenotype) {
      try {
        const traj = buildTrajectory(events, rowToMeta(row), { redact: true, knownSecrets });
        const phenotype = classifyPhenotype(buildSessionDetail(traj));
        phenotypes.set(row.id, phenotype);
        missingPhenotypes.push({ id: row.id, fileMtimeMs: row.file_mtime_ms, fileSize: row.file_size, phenotype });
      } catch { /* leave this session's phenotype uncached; recompute next sync */ }
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

  // Aggregate the human task taxonomy the console treemap renders, AND collect a
  // capped set of example session refs per topic so each tile is drillable
  // (PHNX-3457/PHNX-3408): the console gates a tile's click on `topic.sessions`
  // being non-empty, so without refs every tile renders display-only. Iterating
  // `rows` (not `topics.values()`) gives the same per-session count while carrying
  // the row's title + recency for the ref list; every row has a topic (missing
  // ones were classified into `topics` above).
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
  // `behavioral` is not a failed-tool-call cause (classifyCause never returns it),
  // so it stays 0 in this tool-error split; it surfaces as its own failurePatterns.
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
  // Duration stats run over ACTIVE time, not raw span (PHNX-3457): span minus idle
  // gaps > 120s, derived per session from the tool_calls already loaded above. A
  // session resumed after hours, or left idle mid-turn, otherwise inflates the
  // median/p90 with wall-clock the agent did no work in (real corpus max span:
  // 345h). The raw span stays available per session on `SessionDetail.meta.spanMs`.
  const activeDurations = agentRows.flatMap((row) =>
    row.duration_ms == null
      ? []
      : [sessionActiveMs(row.duration_ms, callsBySession.get(row.id) ?? [], Date.parse(row.timestamp))],
  );

  // Segment the same active-time figure into AGENT vs INTERACTIVE runs (PHNX-3472).
  // A session is an AGENT run when it made any tool call OR has more than 8
  // messages; otherwise INTERACTIVE (a one-shot query). Only sessions with a
  // non-null duration contribute to the medians; `measuredFraction` reports how
  // much of the corpus that covers.
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

  // Build today's per-bucket stats for the rolling drift window.
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
  // Silent-stall friction (per-session, no failed tool call) becomes cross-session
  // behavioral FailurePatterns, ranked into the same top-K by wasted idle time.
  const behavioralPatterns = computeBehavioralPatterns(insights, prevShard);
  const patternInsights = computeInsights(agentRows, agentCalls, prevShard, phenotypes, behavioralPatterns);

  // Per-session roster (PHNX-3483): one flat scalar row per agent session, the raw
  // material the Rush console filters and re-aggregates client-side. `durationMs`
  // reuses `sessionActiveMs` (the value behind `stats.medianMs`; 0 for a null-duration
  // row, which the segmented stats above skip entirely), and `mode` reuses the
  // AGENT-vs-INTERACTIVE predicate from the segmentation above so a mode-split median
  // over the MEASURED rows reproduces `stats.agentMedianMs` / `interactiveMedianMs`.
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
        // Up to TOPIC_SESSION_CAP most-recent example sessions, so the console can
        // drill from a tile into its session list. Capped to keep the shard small;
        // the tile's `count` remains the true total. These are correct on this
        // per-device shard; the fleet-aggregate `/all` view (worker-template.ts,
        // a must-not-touch R2 worker here) carries only the first device's refs
        // per topic until PHNX-3464 merges them across devices.
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

// ---------------------------------------------------------------------------
// HTTP PUT helpers
// ---------------------------------------------------------------------------

/** Per-session drill-down detail the console consumes (sessions/<id>.json). */
export interface SessionDetail {
  schema: 1;
  id: string;
  meta: {
    /** Raw wall-clock span (last event − first event), idle time included. */
    spanMs: number;
    /**
     * Active time: `spanMs` minus every idle gap > 120s (PHNX-3457). A session
     * resumed hours later, or left idle mid-turn, inflates `spanMs` with wall-clock
     * the agent did no work in — active time strips those gaps so a duration reads
     * as effort, not calendar span. This is what the console's duration median/p90
     * should trust; `spanMs` stays available as the raw figure.
     */
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
  /** Steps dropped from `steps` when a run was too long — surfaced so truncation is never silent. */
  truncatedSteps: number;
  whereItWentWrong: string | null;
  /**
   * Failed tool steps, surfaced even when `meta.outcome === 'completed'` — a run
   * can finish without throwing while a tool call inside it failed (the
   * LangSmith trap: a green run-level status hiding a real failure).
   */
  surfacedToolFailures: Array<{ tool?: string; label: string; detail?: string }>;
}

/** Plain-language summary of the friction in a run, or null when it ran clean. */
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

/**
 * Truthful run-level outcome (PHNX-3387).
 *
 * A run with zero tool errors `completed`. A run that hit tool errors is
 * `completed` ONLY when it *causally recovered* — a substantive, non-human-facing
 * tool step succeeded strictly after the last error AND resolved the failed work
 * (its work signature matches an errored step's), the exact predicate the
 * false-termination phenotype uses ({@link recoveredAfterErrors}). A run whose
 * last substantive step is the error, whose only post-error steps are human-facing
 * (a punt to `AskUserQuestion` — the case the broken "last tool call ok" heuristic
 * mislabeled `completed`), or whose only post-error success is unrelated work (a
 * failed `bun test` followed by an incidental `ls`) stays `errored`.
 *
 * This is what makes `surfacedToolFailures` on a `completed` run honest: those
 * are failures the run recovered from, not a green status hiding an unresolved
 * failure. It never flips a run that ended unresolved to `completed` (no
 * regression vs the old `errorCount > 0 ? errored : completed`), and it does not
 * flip a run whose failed work was never resolved just because some later,
 * unrelated call happened to succeed.
 */
export function deriveRunOutcome(traj: SessionTrajectory): 'completed' | 'errored' {
  if (traj.errorCount === 0) return 'completed';
  return recoveredAfterErrors({ steps: traj.steps }) ? 'completed' : 'errored';
}

/**
 * Map the derived trajectory to the console's SessionDetail shape, stripping
 * local-machine PII (full cwd, account) that would expose filesystem paths if
 * written to R2. `repo` is the cwd basename only.
 */
/**
 * The `meta` block shared by the schema-1 {@link SessionDetail} and the schema-2
 * `SessionDetailV2`. Strips local-machine PII (full cwd, account): `repo` is the
 * cwd basename only. Factored so both producers stamp identical meta.
 */
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

// ---------------------------------------------------------------------------
// Sync ledger — per-device timestamp gate
// ---------------------------------------------------------------------------

/** How a session failed to sync. Only parse/upload failures are re-queried every run. */
export type SyncFailureKind = 'transcript-unavailable' | 'parse-failed' | 'upload-failed';

export interface SyncFailure {
  id: string;
  mtimeMs: number;
  kind: SyncFailureKind;
  /** Bounded, redacted first line of the underlying error — actionable evidence. */
  detail: string;
  /** Epoch ms first recorded, so a permanently-unavailable transcript can be aged out. */
  firstSeen: number;
  attempts: number;
}

/**
 * A `transcript-unavailable` failure is kept (so its count stays reportable) but
 * not retried, because re-reading a file that is gone wastes work. Age it out of
 * the ledger after this window so a corpus of long-deleted transcripts cannot grow
 * the failure set without bound.
 */
const TRANSCRIPT_UNAVAILABLE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

interface SyncLedger {
  lastSyncMtime?: number;
  /** Failed session identities, keyed by id, that survive across syncs. */
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

export function writeSyncLedger(ledger: SyncLedger): void {
  const p = ledgerPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
}

/**
 * True once the user has run `agents traces sync` at least once (the ledger
 * file exists). This is the opt-in signal the run-exit auto-sync gates on
 * (PHNX-3628): a user who has never synced has not opted into the traces store,
 * so an `agents run` never uploads on their behalf.
 */
export function hasSyncedBefore(): boolean {
  return fs.existsSync(ledgerPath());
}

// ---------------------------------------------------------------------------
// Local device name
// ---------------------------------------------------------------------------

function localDevice(): string {
  return (process.env['AGENTS_SYNC_MACHINE_ID'] ?? os.hostname()).toLowerCase().replace(/\.local$/, '');
}

// ---------------------------------------------------------------------------
// Minimal row type for direct DB queries (SessionRow is not exported)
// ---------------------------------------------------------------------------

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

/** Minimal subset of rowToMeta needed to satisfy buildTrajectory's SessionMeta param. */
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
