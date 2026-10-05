
import { classifyCause, type TraceFailureCause } from './classify.js';
import type { FailurePhenotype } from './phenotype.js';
import { computeLatency, type LatencyInsight, type SegmentSession } from './segments.js';
import { failureDescription, type SyncRow, type ToolCallRow, type TracesIndexShard } from './sync.js';
import type { InsightFacets } from '@phnx-labs/sessions-cli/reader';


export interface FailureSignature {
  tool: string;
  cause: TraceFailureCause;
  key: string;
}

export interface FailurePattern {
  id: string;
  label: string;
  signature: FailureSignature;
  phenotype: FailurePhenotype | null;
  sessions: number;
  occurrences: number;
  wastedMs: number;
  exampleSessionIds: string[];
  drift: 'up' | 'flat' | 'down';
}

interface ComputedInsights {
  failurePatterns: FailurePattern[];
  wastedMsTotal: number;
  latency: LatencyInsight;
}


const TOP_K_PATTERNS = 25;
const MAX_EXAMPLE_SESSIONS = 5;
const STALL_MS = 60_000;
const MAX_GAP_ATTRIBUTION_MS = 30 * 60_000;


const VOLATILE_TOKEN_PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bfor user [\w.-]+/gi, replacement: 'for user _' },
  { pattern: /\btry again in [\w.]+s?\b/gi, replacement: 'try again in _s' },
  { pattern: /\b[0-9a-f]{7,40}\b/gi, replacement: '_sha_' },
  { pattern: /\b[\w.-]+@[\w.-]+\.\w+\b/gi, replacement: '_email_' },
  { pattern: /\b\d+\b/g, replacement: '_n_' },
];

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

      const startMs = Date.parse(call.timestamp);
      const endMs = call.end_timestamp ? Date.parse(call.end_timestamp) : NaN;
      const hasEnd = Number.isFinite(endMs) && Number.isFinite(startMs);
      if (hasEnd) {
        const ownMs = endMs - startMs;
        if (ownMs > 0) group.wastedMs += Math.min(ownMs, MAX_GAP_ATTRIBUTION_MS);
      }

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
        group.wastedMs += Math.min(gapMs, MAX_GAP_ATTRIBUTION_MS);
      } else if (gapMs >= STALL_MS) {
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

  const combined = [...allPatterns, ...behavioralPatterns];
  const wastedMsTotal = combined.reduce((sum, p) => sum + p.wastedMs, 0);
  const failurePatterns = [...combined]
    .sort((a, b) => b.wastedMs - a.wastedMs || b.occurrences - a.occurrences || a.id.localeCompare(b.id))
    .slice(0, TOP_K_PATTERNS);

  const latency = computeLatency(firstToolSegments(rows, bySession));
  return { failurePatterns, wastedMsTotal, latency };
}


const SILENT_STALL_WASTED_MS: Record<string, number> = {
  '5-15m': 10 * 60_000,
  '15-60m': MAX_GAP_ATTRIBUTION_MS,
  '1h+': MAX_GAP_ATTRIBUTION_MS,
};

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
