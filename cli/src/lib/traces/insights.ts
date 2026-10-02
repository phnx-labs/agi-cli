/**
 * Cross-session failure clustering + time-wasted attribution for the traces
 * insight engine (PHNX-3141) — the piece that turns per-tool error counts
 * into "here is your #1 systemic problem and what it cost."
 *
 * Pure and SQL-shaped: it consumes the same `SyncRow[]` + `tool_calls` rows
 * `buildIndexShard` already loads (no re-parsing of transcripts), so cost
 * stays proportional to this sync's row count, never the full corpus.
 *
 * `tool_calls` rows carry `ordinal`/`timestamp` per call within a session
 * (`db.ts`'s `idx_tool_calls_session ON tool_calls(session_id, ordinal)`), which
 * is enough to reconstruct per-session call order and inter-call gaps without a
 * full `SessionTrajectory` — that is what makes this incremental at scale.
 *
 * Failure phenotype (false-termination / out-of-order / premature-completion /
 * failure-to-act, `phenotype.ts`) is folded in as a fourth grouping dimension
 * (PHNX-3327). Classifying it needs the full derived trajectory, so it is NOT
 * computed here — the caller passes a per-session `phenotypes` map that
 * `buildIndexShard` fills from the persisted, mtime+size-keyed
 * `session_phenotypes` cache for the WHOLE corpus. Keying the group on the
 * cached-per-session phenotype (never on this run's incremental batch) is what
 * keeps two identically-signatured sessions in one cluster regardless of when
 * each was synced. The `signature` OUTPUT is unchanged (`{ tool, cause, key }`);
 * phenotype is an added dimension carried alongside it, so callers that never
 * pass a map (the unit tests, a pre-phenotype caller) see the exact prior
 * grouping.
 */

import { classifyCause, type TraceFailureCause } from './classify.js';
import type { FailurePhenotype } from './phenotype.js';
import { computeLatency, type LatencyInsight, type SegmentSession } from './segments.js';
import { failureDescription, type SyncRow, type ToolCallRow, type TracesIndexShard } from './sync.js';
import type { InsightFacets } from '@phnx-labs/sessions-cli/reader';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FailureSignature {
  tool: string;
  cause: TraceFailureCause;
  /** Normalized error text — volatile tokens (ids, counts, countdowns) stripped so instances fold together. */
  key: string;
}

export interface FailurePattern {
  /** Stable hash of the signature (incl. phenotype) — deep-linkable, unaffected by row order. */
  id: string;
  label: string;
  signature: FailureSignature;
  /**
   * Dominant failure phenotype of the sessions in this cluster, or `null` when
   * none was classifiable. A fourth grouping dimension (PHNX-3327): two failures
   * with the same `(tool, cause, key)` but different phenotypes are distinct
   * patterns.
   */
  phenotype: FailurePhenotype | null;
  /** Distinct sessions this pattern occurred in. */
  sessions: number;
  /** Total failing calls matching this signature. */
  occurrences: number;
  /** Estimated ms of retry/stall time attributable to this pattern (see attribution rule below). */
  wastedMs: number;
  /** Bounded example session ids for drill-down. */
  exampleSessionIds: string[];
  /** Movement vs the same pattern id in the previous shard. */
  drift: 'up' | 'flat' | 'down';
}

interface ComputedInsights {
  /** Top-K patterns ranked by wastedMs (impact) — a rare 1-occurrence/8h loop still surfaces. */
  failurePatterns: FailurePattern[];
  /** Sum of wastedMs across every cluster found this sync, not just the top-K rows above. */
  wastedMsTotal: number;
  latency: LatencyInsight;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Bounded shard size — patterns, not sessions, so 738 or 738k render identically. */
const TOP_K_PATTERNS = 25;
const MAX_EXAMPLE_SESSIONS = 5;
/** A gap this long right after a failure reads as an idle stall, not think-time (matches sync.ts's own "stalled Xm" threshold). */
const STALL_MS = 60_000;
/**
 * Upper bound on how much of a SINGLE inter-call gap is attributable to a
 * failure. Beyond a recovery window a gap is not failure-loop waste — it is a
 * human away from a chat thread, an abandoned session, or an outage. This bounds
 * BOTH branches, and that matters: `nextIsSameFailure` only compares
 * `(tool, cause, normalized-key)`, with no temporal check, so a deterministic
 * failure that recurs identically hours apart (a permanently-denied capability,
 * a missing credential — e.g. a Slack user re-asking "where am I" at 2pm and
 * 6pm) would otherwise look like an "active retry loop" and absorb the whole
 * multi-hour gap — the very artifact this fix targets. A genuine active loop has
 * MANY short gaps that each stay under this cap and still sum to a large total,
 * so bounding a single gap doesn't hide it. Real single-tool stalls (a hung
 * typecheck, a slow build) are minutes and stay fully counted.
 *
 * The same cap bounds the call's OWN blocking duration (PHNX-3437) so a corrupt
 * or backwards end timestamp can't book a single call as hours of waste either.
 */
const MAX_GAP_ATTRIBUTION_MS = 30 * 60_000;

// ---------------------------------------------------------------------------
// Signature normalization — fold volatile per-instance text together
// ---------------------------------------------------------------------------

const VOLATILE_TOKEN_PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bfor user [\w.-]+/gi, replacement: 'for user _' },
  { pattern: /\btry again in [\w.]+s?\b/gi, replacement: 'try again in _s' },
  { pattern: /\b[0-9a-f]{7,40}\b/gi, replacement: '_sha_' },
  { pattern: /\b[\w.-]+@[\w.-]+\.\w+\b/gi, replacement: '_email_' },
  { pattern: /\b\d+\b/g, replacement: '_n_' },
];

/** Strip volatile tokens from a failure's evidence text so repeat instances hash identically. */
export function normalizeErrorKey(desc: string, raw: string | null): string {
  let text = (raw && raw.trim().length > 0 ? raw : desc).toLowerCase();
  for (const { pattern, replacement } of VOLATILE_TOKEN_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function hashSignature(tool: string, cause: string, key: string, phenotype: FailurePhenotype | null): string {
  const input = `${tool} ${cause} ${key} ${phenotype ?? ''}`;
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Label rules — a table, not an if/else-by-name chain (matches segments.ts's TASK_TYPE_RULES)
// ---------------------------------------------------------------------------

const LABEL_RULES: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /rate limit/i, label: 'rate limit back-off loop' },
  { pattern: /permission denied/i, label: 'permission denied' },
  { pattern: /not found|no such file/i, label: 'missing resource' },
  { pattern: /timed? ?out/i, label: 'timeout' },
  { pattern: /econnrefused|connection refused|network/i, label: 'network error' },
  { pattern: /conflict|diverged/i, label: 'git conflict' },
];

function labelFor(tool: string, cause: TraceFailureCause, key: string): string {
  if (cause === 'guard') return `${tool}: git guard denial`;
  if (cause === 'hook') return `${tool}: hook denial`;
  const rule = LABEL_RULES.find((row) => row.pattern.test(key));
  return `${tool}: ${rule ? rule.label : key.slice(0, 48)}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Cluster failed tool calls into ranked patterns and estimate the wasted time
 * behind each, plus device-wide time-to-first-tool latency.
 *
 * wastedMs attribution has two parts that sum:
 *
 * (1) The failed call's OWN blocking duration — `end_timestamp - timestamp`
 * (PHNX-3437). A call that hung for minutes and then failed wasted that whole
 * time even if it was the last call in its session or was followed quickly by an
 * unrelated call — the case the gap heuristic alone booked as ~0. This is what
 * makes a fail-fast fix measurable: a channel that stops hanging 5.5min on stdin
 * and instead fails in <1s (PHNX-3407) drops from ~5.5min of attributed waste to
 * ~0. Bounded by MAX_GAP_ATTRIBUTION_MS so a corrupt end timestamp can't dominate.
 *
 * (2) The idle gap AFTER the call, before the NEXT call in the same session,
 * counted when either (a) the next call repeats the same signature (a retry
 * loop) or (b) the gap is a stall (≥60s) before an unrelated next call — each
 * bounded by MAX_GAP_ATTRIBUTION_MS so one failure can't absorb hours of
 * human-away idle in an async channel session, whether as a lone stall or a
 * same-signature re-ask hours later; a genuine active retry loop is many short
 * gaps that each clear the cap and still sum large. When the end timestamp is
 * known, this gap is measured from the call's END, so the blocking time counted
 * in (1) is never double-counted; for a NULL end (rows an older extractor stored,
 * or a call still pending at scan end) it falls back to the original
 * gap-from-START heuristic unchanged — no crash, no NaN, no regression.
 *
 * An idle gap unrelated to a nearby failure is never counted. This is an
 * estimate, not ground truth; it is not inflated by folding in ordinary
 * processing time between unrelated calls.
 */
export function computeInsights(
  rows: readonly SyncRow[],
  calls: readonly ToolCallRow[],
  prevShard?: TracesIndexShard | null,
  phenotypes?: ReadonlyMap<string, FailurePhenotype | null>,
  behavioralPatterns: readonly FailurePattern[] = [],
): ComputedInsights {
  const bySession = new Map<string, ToolCallRow[]>();
  for (const call of calls) {
    const list = bySession.get(call.session_id);
    if (list) list.push(call);
    else bySession.set(call.session_id, [call]);
  }

  interface Accum {
    tool: string;
    cause: TraceFailureCause;
    key: string;
    phenotype: FailurePhenotype | null;
    sessions: Set<string>;
    occurrences: number;
    wastedMs: number;
    examples: string[];
  }
  const groups = new Map<string, Accum>();

  for (const [sessionId, sessionCalls] of bySession) {
    // Phenotype is a per-session property (one classification per session), so
    // every failing call in this session shares it. A caller that passes no map
    // (unit tests, a pre-phenotype caller) collapses the dimension to `null`,
    // yielding the exact prior grouping.
    const phenotype = phenotypes?.get(sessionId) ?? null;
    const ordered = [...sessionCalls].sort((a, b) => a.ordinal - b.ordinal);
    for (let i = 0; i < ordered.length; i++) {
      const call = ordered[i];
      if (call.outcome !== 'error') continue;
      const cause = classifyCause(call);
      const key = normalizeErrorKey(failureDescription(call, cause), call.error);
      const groupKey = `${call.tool} ${cause} ${key} ${phenotype ?? ''}`;

      let group = groups.get(groupKey);
      if (!group) {
        group = { tool: call.tool, cause, key, phenotype, sessions: new Set(), occurrences: 0, wastedMs: 0, examples: [] };
        groups.set(groupKey, group);
      }
      group.occurrences++;
      group.sessions.add(sessionId);
      if (group.examples.length < MAX_EXAMPLE_SESSIONS && !group.examples.includes(sessionId)) {
        group.examples.push(sessionId);
      }

      // (1) The call's OWN blocking duration (end minus start) is the primary
      // signal — see the computeInsights docblock. Attributed whenever the end
      // timestamp is present, independent of whether a next call follows.
      const startMs = Date.parse(call.timestamp);
      const endMs = call.end_timestamp ? Date.parse(call.end_timestamp) : NaN;
      const hasEnd = Number.isFinite(endMs) && Number.isFinite(startMs);
      if (hasEnd) {
        const ownMs = endMs - startMs;
        if (ownMs > 0) group.wastedMs += Math.min(ownMs, MAX_GAP_ATTRIBUTION_MS);
      }

      // (2) The idle gap after the call, before the next one. Measured from the
      // call's END when known (so the blocking time in (1) isn't double-counted),
      // else from its START — the original heuristic, unchanged for NULL ends.
      const next = ordered[i + 1];
      if (!next) continue;
      const gapFromMs = hasEnd ? endMs : startMs;
      const gapMs = Date.parse(next.timestamp) - gapFromMs;
      if (!Number.isFinite(gapMs) || gapMs <= 0) continue;
      const nextIsSameFailure =
        next.outcome === 'error' &&
        next.tool === call.tool &&
        classifyCause(next) === cause &&
        normalizeErrorKey(failureDescription(next, cause), next.error) === key;
      if (nextIsSameFailure) {
        // Retry loop: a real active loop is many short gaps, each under the cap,
        // summing to a large total. Bound a single gap so one huge same-signature
        // gap (a re-ask hours later, not active retrying) can't absorb it all.
        group.wastedMs += Math.min(gapMs, MAX_GAP_ATTRIBUTION_MS);
      } else if (gapMs >= STALL_MS) {
        // Lone stall before an unrelated next call: same bounded recovery window.
        group.wastedMs += Math.min(gapMs, MAX_GAP_ATTRIBUTION_MS);
      }
    }
  }

  const prevById = new Map((prevShard?.failurePatterns ?? []).map((p) => [p.id, p]));
  const allPatterns: FailurePattern[] = [...groups.values()].map((group) => {
    const id = hashSignature(group.tool, group.cause, group.key, group.phenotype);
    const prev = prevById.get(id);
    const drift: FailurePattern['drift'] = !prev
      ? 'up'
      : group.occurrences > prev.occurrences
        ? 'up'
        : group.occurrences < prev.occurrences
          ? 'down'
          : 'flat';
    return {
      id,
      label: labelFor(group.tool, group.cause, group.key),
      signature: { tool: group.tool, cause: group.cause, key: group.key },
      phenotype: group.phenotype,
      sessions: group.sessions.size,
      occurrences: group.occurrences,
      wastedMs: group.wastedMs,
      exampleSessionIds: group.examples,
      drift,
    };
  });

  // Behavioral patterns (silent stalls — no failed tool call, so absent from the
  // error-anchored clustering above) join the SAME ranking and total, so the top-K
  // is by impact across both kinds and `wastedMsTotal` counts the idle time too.
  const combined = [...allPatterns, ...behavioralPatterns];
  const wastedMsTotal = combined.reduce((sum, p) => sum + p.wastedMs, 0);
  const failurePatterns = [...combined]
    .sort((a, b) => b.wastedMs - a.wastedMs || b.occurrences - a.occurrences || a.id.localeCompare(b.id))
    .slice(0, TOP_K_PATTERNS);

  const latency = computeLatency(firstToolSegments(rows, bySession));
  return { failurePatterns, wastedMsTotal, latency };
}

// ---------------------------------------------------------------------------
// Behavioral patterns — silent failures with no error code
// ---------------------------------------------------------------------------

/**
 * Estimated agent-owned idle ms per silent-stall bucket. A bucket's midpoint,
 * capped at MAX_GAP_ATTRIBUTION_MS exactly like the tool-error gap attribution
 * above so one long overnight stall can't book hours of "waste" — the same
 * honesty bound the error path uses. The open-ended buckets are the cap.
 */
const SILENT_STALL_WASTED_MS: Record<string, number> = {
  '5-15m': 10 * 60_000,
  '15-60m': MAX_GAP_ATTRIBUTION_MS,
  '1h+': MAX_GAP_ATTRIBUTION_MS,
};

/**
 * Promote the per-session silent-stall friction signals — already computed by
 * `computeInsightFacets` in `session/insights.ts` and keyed `silent stall: <bucket>`
 * — into cross-session behavioral `FailurePattern`s. These are silent failures
 * with NO error code: the agent went idle after its last event and a human had to
 * nudge it. They never surface through `computeInsights` (which only clusters
 * `outcome === 'error'` tool calls) and were previously only a `needsAttention`
 * friction counter, never a ranked issue. Cause is `behavioral`; the signature
 * `tool` is the synthetic `silent-stall` and `key` is the duration bucket.
 */
export function computeBehavioralPatterns(
  facetsBySession: ReadonlyMap<string, Pick<InsightFacets, 'frictionSignals'>>,
  prevShard?: TracesIndexShard | null,
): FailurePattern[] {
  interface Accum {
    bucket: string;
    sessions: Set<string>;
    occurrences: number;
    wastedMs: number;
    examples: string[];
  }
  const groups = new Map<string, Accum>();
  for (const [sessionId, facets] of facetsBySession) {
    for (const [signal, count] of Object.entries(facets.frictionSignals ?? {})) {
      if (count <= 0) continue;
      const match = /^silent stall: (.+)$/.exec(signal);
      if (!match) continue;
      const bucket = match[1];
      let group = groups.get(bucket);
      if (!group) {
        group = { bucket, sessions: new Set(), occurrences: 0, wastedMs: 0, examples: [] };
        groups.set(bucket, group);
      }
      group.occurrences += count;
      group.sessions.add(sessionId);
      group.wastedMs += (SILENT_STALL_WASTED_MS[bucket] ?? MAX_GAP_ATTRIBUTION_MS) * count;
      if (group.examples.length < MAX_EXAMPLE_SESSIONS && !group.examples.includes(sessionId)) {
        group.examples.push(sessionId);
      }
    }
  }

  const prevById = new Map((prevShard?.failurePatterns ?? []).map((p) => [p.id, p]));
  return [...groups.values()].map((group) => {
    const id = hashSignature('silent-stall', 'behavioral', group.bucket, null);
    const prev = prevById.get(id);
    const drift: FailurePattern['drift'] = !prev
      ? 'up'
      : group.occurrences > prev.occurrences
        ? 'up'
        : group.occurrences < prev.occurrences
          ? 'down'
          : 'flat';
    return {
      id,
      label: `Agent silent stall (${group.bucket}) — idle until nudged`,
      signature: { tool: 'silent-stall', cause: 'behavioral', key: group.bucket },
      phenotype: null,
      sessions: group.sessions.size,
      occurrences: group.occurrences,
      wastedMs: group.wastedMs,
      exampleSessionIds: group.examples,
      drift,
    };
  });
}

/** Synthesize one-step SegmentSessions carrying only the time-to-first-tool offset, for computeLatency() reuse. */
function firstToolSegments(
  rows: readonly SyncRow[],
  bySession: Map<string, ToolCallRow[]>,
): SegmentSession[] {
  return rows.flatMap((row): SegmentSession[] => {
    const sessionCalls = bySession.get(row.id);
    if (!sessionCalls || sessionCalls.length === 0) return [];
    const first = sessionCalls.reduce((min, call) => (call.ordinal < min.ordinal ? call : min));
    const sessionStartMs = Date.parse(row.timestamp);
    const firstCallMs = Date.parse(first.timestamp);
    if (!Number.isFinite(sessionStartMs) || !Number.isFinite(firstCallMs)) return [];
    return [{ steps: [{ startMs: Math.max(0, firstCallMs - sessionStartMs) }] }];
  });
}
