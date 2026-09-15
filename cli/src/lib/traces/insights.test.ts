import { describe, expect, it } from 'vitest';
import { computeBehavioralPatterns, computeInsights, normalizeErrorKey } from './insights.js';
import type { SyncRow, ToolCallRow } from './sync.js';
import type { InsightFacets } from '@phnx-labs/sessions-cli/reader';

function makeRow(id: string, timestamp: string): SyncRow {
  return {
    id, short_id: id.slice(0, 8), agent: 'claude', origin: 'cli', routine_name: null,
    routine_run_id: null, version: null, account: null, account_key: null,
    account_org: null, mode: 'auto', timestamp, last_activity: null, project: 'agents-cli',
    cwd: '/redacted/agents-cli', git_branch: null, topic: null, label: null,
    message_count: null, token_count: null, output_tokens: null, input_tokens: null,
    cache_read_tokens: null, cache_write_tokens: null, cost_usd: null, cost_usd_nocache: null,
    duration_ms: null, model: 'claude-opus-4-8', tool_call_count: null,
    file_path: `/tmp/${id}.jsonl`, file_mtime_ms: 0, file_size: 0, machine: 'test-device',
  };
}

function makeCall(
  sessionId: string,
  ordinal: number,
  timestamp: string,
  tool: string,
  outcome: 'ok' | 'error',
  opts: Partial<Pick<ToolCallRow, 'exit_code' | 'status_code' | 'error_code' | 'error' | 'parse_error' | 'end_timestamp'>> = {},
): ToolCallRow {
  return {
    session_id: sessionId, ordinal, timestamp, tool, outcome,
    end_timestamp: opts.end_timestamp ?? null,
    exit_code: opts.exit_code ?? null, status_code: opts.status_code ?? null,
    error_code: opts.error_code ?? null, error: opts.error ?? null, parse_error: opts.parse_error ?? null,
  };
}

const T0 = '2026-08-27T00:00:00.000Z';
const iso = (offsetMs: number): string => new Date(Date.parse(T0) + offsetMs).toISOString();

describe('normalizeErrorKey', () => {
  it('folds volatile per-instance tokens so repeat failures hash identically', () => {
    const a = normalizeErrorKey('rate limit', 'API rate limit exceeded for user 111 (try again in 30s)');
    const b = normalizeErrorKey('rate limit', 'API rate limit exceeded for user 222 (try again in 47s)');
    expect(a).toBe(b);
    expect(a).toBe('api rate limit exceeded for user _ (try again in _s)');
  });
});

describe('computeInsights', () => {
  it('folds near-identical rate-limit errors into one pattern and sums wasted time exactly', () => {
    const rows = [makeRow('sess-rate', T0)];
    const calls: ToolCallRow[] = [
      makeCall('sess-rate', 1, iso(0), 'Bash', 'error', {
        error: 'API rate limit exceeded for user 111 (try again in 30s)',
      }),
      // Same signature after normalization, 2 minutes later — a retry loop.
      makeCall('sess-rate', 2, iso(120_000), 'Bash', 'error', {
        error: 'API rate limit exceeded for user 222 (try again in 47s)',
      }),
      // Recovers, but only after a 3-minute stall following the second failure.
      makeCall('sess-rate', 3, iso(120_000 + 180_000), 'Bash', 'ok'),
    ];

    const result = computeInsights(rows, calls, null);
    expect(result.failurePatterns).toHaveLength(1);
    const pattern = result.failurePatterns[0];
    expect(pattern.signature).toEqual({
      tool: 'Bash',
      cause: 'real',
      key: 'api rate limit exceeded for user _ (try again in _s)',
    });
    expect(pattern.occurrences).toBe(2);
    expect(pattern.sessions).toBe(1);
    expect(pattern.label).toBe('Bash: rate limit back-off loop');
    // 120s (retry-loop gap) + 180s (stall after the second failure) = 300s.
    expect(pattern.wastedMs).toBe(300_000);
    expect(result.wastedMsTotal).toBe(300_000);
  });

  it('ranks by wasted-time impact, not occurrence count — a rare long stall outranks a frequent short one', () => {
    const rows = [makeRow('sess-big', T0), ...Array.from({ length: 50 }, (_, i) => makeRow(`sess-freq-${i}`, T0))];
    const calls: ToolCallRow[] = [
      // One session, one failure, an 8-hour idle before the next (unrelated) call.
      // The failure did not cause 8h of waste — bound it to the recovery window.
      makeCall('sess-big', 1, iso(0), 'Bash', 'error', { error: 'connection refused' }),
      makeCall('sess-big', 2, iso(8 * 60 * 60 * 1000), 'Bash', 'ok'),
      // 50 sessions, one quick failure each, no follow-up call — zero wasted time.
      ...Array.from({ length: 50 }, (_, i) =>
        makeCall(`sess-freq-${i}`, 1, iso(0), 'Read', 'error', { error: 'permission denied' }),
      ),
    ];

    const result = computeInsights(rows, calls, null);
    const big = result.failurePatterns.find((p) => p.signature.tool === 'Bash');
    const frequent = result.failurePatterns.find((p) => p.signature.tool === 'Read');
    expect(big?.occurrences).toBe(1);
    // Lone stall bounded to the recovery window, not the full 8h of idle.
    expect(big?.wastedMs).toBe(30 * 60 * 1000);
    expect(frequent?.occurrences).toBe(50);
    expect(frequent?.wastedMs).toBe(0);
    expect(result.failurePatterns.indexOf(big!)).toBeLessThan(result.failurePatterns.indexOf(frequent!));
  });

  it('bounds a lone async stall so a chat reply hours later is not booked as failure-loop waste', () => {
    // The real PHNX-3423 case: rush-assistant in a Slack thread calls a tool that
    // fails, then the human replies ~4.5h later (an unrelated next call). The raw
    // >=60s rule booked the whole 4.5h against the failure; it must be bounded.
    const rows = [makeRow('sess-chat', T0)];
    const calls: ToolCallRow[] = [
      makeCall('sess-chat', 1, iso(0), 'user_location', 'error', { error: 'GPS capability denied or unavailable: timeout' }),
      makeCall('sess-chat', 2, iso(4.5 * 60 * 60 * 1000), 'recall', 'ok'),
    ];
    const result = computeInsights(rows, calls, null);
    const pattern = result.failurePatterns.find((p) => p.signature.tool === 'user_location');
    expect(pattern?.occurrences).toBe(1);
    expect(pattern?.wastedMs).toBe(30 * 60 * 1000); // bounded, not 4.5h
    expect(result.wastedMsTotal).toBe(30 * 60 * 1000);
  });

  it('sums a real active retry loop from its many short gaps — total exceeds a single-gap cap', () => {
    // A genuine back-off loop: 6 same-signature failures 10m apart. Each inter-retry
    // gap (10m) is under the 30m cap and counts in full, so the loop's total (50m)
    // still exceeds one gap's cap — bounding a single gap doesn't hide a real loop.
    const rows = [makeRow('sess-loop', T0)];
    const calls: ToolCallRow[] = Array.from({ length: 6 }, (_, i) =>
      makeCall('sess-loop', i + 1, iso(i * 10 * 60 * 1000), 'Bash', 'error', {
        error: `API rate limit exceeded (try again in ${30 + i}s)`,
      }),
    );
    const result = computeInsights(rows, calls, null);
    const pattern = result.failurePatterns[0];
    expect(pattern.occurrences).toBe(6);
    expect(pattern.wastedMs).toBe(5 * 10 * 60 * 1000); // 5 gaps × 10m = 50m, all counted
  });

  it('bounds a same-signature failure that recurs hours apart — a chat re-ask, not an active loop', () => {
    // The reviewer's case: nextIsSameFailure has no temporal check, so two identical
    // deterministic failures (GPS permanently denied) 4.5h apart would otherwise look
    // like an "active retry loop" and absorb the whole 4.5h. The per-gap cap prevents it.
    const rows = [makeRow('sess-reask', T0)];
    const calls: ToolCallRow[] = [
      makeCall('sess-reask', 1, iso(0), 'user_location', 'error', { error: 'GPS capability denied or unavailable: timeout' }),
      makeCall('sess-reask', 2, iso(4.5 * 60 * 60 * 1000), 'user_location', 'error', { error: 'GPS capability denied or unavailable: timeout' }),
    ];
    const result = computeInsights(rows, calls, null);
    const pattern = result.failurePatterns[0];
    expect(pattern.occurrences).toBe(2);
    expect(pattern.wastedMs).toBe(30 * 60 * 1000); // bounded, not 4.5h
  });

  it('bounds the shard to the top-K patterns regardless of corpus size', () => {
    const rows = Array.from({ length: 40 }, (_, i) => makeRow(`sess-${i}`, T0));
    const calls = rows.map((row, i) =>
      makeCall(row.id, 1, iso(0), `Tool${i}`, 'error', { error: `distinct failure ${i}` }),
    );
    const result = computeInsights(rows, calls, null);
    expect(result.failurePatterns.length).toBeLessThanOrEqual(25);
  });

  it('does not attribute an ordinary gap between unrelated successful calls as wasted time', () => {
    const rows = [makeRow('sess-clean', T0)];
    const calls: ToolCallRow[] = [
      makeCall('sess-clean', 1, iso(0), 'Read', 'ok'),
      makeCall('sess-clean', 2, iso(30_000), 'Edit', 'ok'),
    ];
    const result = computeInsights(rows, calls, null);
    expect(result.failurePatterns).toHaveLength(0);
    expect(result.wastedMsTotal).toBe(0);
  });

  it('attributes a failed call\'s own blocking duration (end - start), even with no next call', () => {
    // A user_location tool that hung ~5.5 minutes on stdin and then failed
    // (PHNX-3407). It is the last call in the session, so the gap heuristic alone
    // would book ~0 — the call's own end timestamp is what makes it measurable.
    const rows = [makeRow('sess-hang', T0)];
    const calls: ToolCallRow[] = [
      makeCall('sess-hang', 1, iso(0), 'user_location', 'error', {
        end_timestamp: iso(330_000), error: 'stdin read timed out',
      }),
    ];
    const result = computeInsights(rows, calls, null);
    expect(result.failurePatterns).toHaveLength(1);
    expect(result.failurePatterns[0].wastedMs).toBe(330_000);
    expect(result.wastedMsTotal).toBe(330_000);
  });

  it('a fail-fast call (end - start < 1s) contributes ~0 wasted time', () => {
    // The PHNX-3407 fix: the same tool now fails in under a second instead of
    // hanging. The failure is still clustered, but its wasted time drops to ~0.
    const rows = [makeRow('sess-fast', T0)];
    const calls: ToolCallRow[] = [
      makeCall('sess-fast', 1, iso(0), 'user_location', 'error', {
        end_timestamp: iso(800), error: 'stdin read timed out',
      }),
    ];
    const result = computeInsights(rows, calls, null);
    expect(result.failurePatterns).toHaveLength(1);
    expect(result.failurePatterns[0].wastedMs).toBe(800);
    expect(result.failurePatterns[0].wastedMs).toBeLessThan(1_000);
  });

  it('a NULL end_timestamp degrades to the bounded-gap heuristic — no crash, no NaN', () => {
    // Old rows (pre-migration extractor) carry no end timestamp. A lone failed
    // call with no following call and no end must contribute exactly 0, not NaN.
    const rows = [makeRow('sess-old', T0)];
    const calls: ToolCallRow[] = [
      makeCall('sess-old', 1, iso(0), 'Bash', 'error', { error: 'boom' }),
    ];
    const result = computeInsights(rows, calls, null);
    expect(result.failurePatterns[0].wastedMs).toBe(0);
    expect(Number.isNaN(result.wastedMsTotal)).toBe(false);
    expect(result.wastedMsTotal).toBe(0);
  });

  it('sums own blocking duration and the post-call retry gap without double-counting', () => {
    // Call 1 blocks 30s then fails; the same failure recurs 90s after it ended
    // (a retry loop). Own duration (30s) + gap-from-END to the retry (90s) = 120s
    // — the gap is measured from the call's end, so the 30s blocking counted once.
    const rows = [makeRow('sess-retry', T0)];
    const calls: ToolCallRow[] = [
      makeCall('sess-retry', 1, iso(0), 'Bash', 'error', {
        end_timestamp: iso(30_000), error: 'network timeout',
      }),
      makeCall('sess-retry', 2, iso(120_000), 'Bash', 'error', {
        end_timestamp: iso(150_000), error: 'network timeout',
      }),
    ];
    const result = computeInsights(rows, calls, null);
    // call 1: own 30s + retry gap (120s-30s = 90s) = 120s. call 2: own 30s, no
    // next call = 30s. Total 150s.
    expect(result.failurePatterns[0].wastedMs).toBe(150_000);
  });

  it('bounds the own blocking duration by MAX_GAP_ATTRIBUTION_MS (30m)', () => {
    // A corrupt/backwards end timestamp — 8 hours after the start — must not book
    // 8 hours of waste; it is capped at the 30-minute recovery window.
    const rows = [makeRow('sess-corrupt', T0)];
    const calls: ToolCallRow[] = [
      makeCall('sess-corrupt', 1, iso(0), 'Bash', 'error', {
        end_timestamp: iso(8 * 3_600_000), error: 'network timeout',
      }),
    ];
    const result = computeInsights(rows, calls, null);
    expect(result.failurePatterns[0].wastedMs).toBe(30 * 60_000);
  });

  it('computes time-to-first-tool latency from the first call offset per session', () => {
    const rows = [makeRow('sess-a', T0), makeRow('sess-b', T0)];
    const calls: ToolCallRow[] = [
      makeCall('sess-a', 1, iso(5_000), 'Read', 'ok'),
      makeCall('sess-b', 1, iso(15_000), 'Read', 'ok'),
    ];
    const result = computeInsights(rows, calls, null);
    expect(result.latency.firstToolMs.p50).toBeGreaterThanOrEqual(5_000);
    expect(result.latency.firstToolMs.max).toBe(15_000);
  });

  it('splits an identical (tool,cause,key) signature by phenotype, and folds same-phenotype sessions together (PHNX-3327)', () => {
    // Three sessions, all with the SAME failure signature (Bash / real / "command failed").
    // Two share a phenotype (false-termination) and must fold into one cluster; the
    // third has a different phenotype (premature-completion) and is a distinct cluster.
    const rows = [makeRow('sess-ft-1', T0), makeRow('sess-ft-2', T0), makeRow('sess-pc', T0)];
    const calls: ToolCallRow[] = [
      makeCall('sess-ft-1', 1, iso(0), 'Bash', 'error', { error: 'command failed' }),
      makeCall('sess-ft-2', 1, iso(0), 'Bash', 'error', { error: 'command failed' }),
      makeCall('sess-pc', 1, iso(0), 'Bash', 'error', { error: 'command failed' }),
    ];
    const phenotypes = new Map<string, 'false-termination' | 'premature-completion' | null>([
      ['sess-ft-1', 'false-termination'],
      ['sess-ft-2', 'false-termination'],
      ['sess-pc', 'premature-completion'],
    ]);

    const result = computeInsights(rows, calls, null, phenotypes);
    // Two clusters for one signature — one per phenotype — not three.
    expect(result.failurePatterns).toHaveLength(2);
    const ft = result.failurePatterns.find((p) => p.phenotype === 'false-termination');
    const pc = result.failurePatterns.find((p) => p.phenotype === 'premature-completion');
    expect(ft?.sessions).toBe(2); // the two false-termination sessions folded together
    expect(ft?.occurrences).toBe(2);
    expect(pc?.sessions).toBe(1);
    // Distinct, deep-linkable ids per phenotype even though (tool,cause,key) matches.
    expect(ft?.id).not.toBe(pc?.id);
    // The signature output itself is unchanged (no phenotype leaked into it).
    expect(ft?.signature).toEqual({ tool: 'Bash', cause: 'real', key: 'command failed' });
  });

  it('with no phenotype map, grouping is exactly the prior (tool,cause,key) behavior', () => {
    // A caller that passes no phenotypes map (the pre-PHNX-3327 shape) collapses the
    // dimension to null, so two identically-signatured sessions stay one cluster.
    const rows = [makeRow('sess-a', T0), makeRow('sess-b', T0)];
    const calls: ToolCallRow[] = [
      makeCall('sess-a', 1, iso(0), 'Bash', 'error', { error: 'command failed' }),
      makeCall('sess-b', 1, iso(0), 'Bash', 'error', { error: 'command failed' }),
    ];
    const result = computeInsights(rows, calls, null);
    expect(result.failurePatterns).toHaveLength(1);
    expect(result.failurePatterns[0].sessions).toBe(2);
    expect(result.failurePatterns[0].phenotype).toBeNull();
  });

  it('marks drift up/down/flat against the previous shard by pattern id', () => {
    const rows = [makeRow('sess-drift', T0)];
    const calls: ToolCallRow[] = [
      makeCall('sess-drift', 1, iso(0), 'Bash', 'error', { error: 'network timeout' }),
    ];
    const first = computeInsights(rows, calls, null);
    expect(first.failurePatterns[0].drift).toBe('up');

    const prevShard = { failurePatterns: first.failurePatterns } as never;
    const same = computeInsights(rows, calls, prevShard);
    expect(same.failurePatterns[0].drift).toBe('flat');

    const moreCalls = [...calls, makeCall('sess-drift', 2, iso(1), 'Bash', 'error', { error: 'network timeout' })];
    const grew = computeInsights(rows, moreCalls, prevShard);
    expect(grew.failurePatterns[0].drift).toBe('up');
  });
});

function facets(frictionSignals: Record<string, number>): Pick<InsightFacets, 'frictionSignals'> {
  return { frictionSignals };
}

describe('computeBehavioralPatterns', () => {
  it('promotes silent-stall friction across sessions into one behavioral pattern per bucket', () => {
    const map = new Map<string, Pick<InsightFacets, 'frictionSignals'>>([
      ['sess-a', facets({ 'silent stall: 5-15m': 2 })],
      ['sess-b', facets({ 'silent stall: 5-15m': 1, 'silent stall: 1h+': 1 })],
    ]);
    const patterns = computeBehavioralPatterns(map);
    const byBucket = new Map(patterns.map((p) => [p.signature.key, p]));

    const short = byBucket.get('5-15m')!;
    expect(short.signature).toEqual({ tool: 'silent-stall', cause: 'behavioral', key: '5-15m' });
    expect(short.occurrences).toBe(3); // 2 in a, 1 in b
    expect(short.sessions).toBe(2);
    expect(short.wastedMs).toBe(3 * 10 * 60_000); // bucket midpoint * occurrences
    expect(short.exampleSessionIds.sort()).toEqual(['sess-a', 'sess-b']);

    const long = byBucket.get('1h+')!;
    expect(long.occurrences).toBe(1);
    expect(long.wastedMs).toBe(30 * 60_000); // open bucket capped at MAX_GAP_ATTRIBUTION_MS
  });

  it('ignores non-silent-stall friction signals', () => {
    const map = new Map<string, Pick<InsightFacets, 'frictionSignals'>>([
      ['sess-x', facets({ 'failed tool loop: Bash': 4, 'CI red loop': 2, 'blocked guard': 1 })],
    ]);
    expect(computeBehavioralPatterns(map)).toEqual([]);
  });

  it('marks drift down when a bucket occurs less than the previous shard', () => {
    const now = new Map<string, Pick<InsightFacets, 'frictionSignals'>>([
      ['sess-a', facets({ 'silent stall: 5-15m': 1 })],
    ]);
    const prev = computeBehavioralPatterns(
      new Map([['sess-a', facets({ 'silent stall: 5-15m': 5 })]]),
    );
    const patterns = computeBehavioralPatterns(now, { failurePatterns: prev } as never);
    expect(patterns[0].drift).toBe('down');
  });
});

describe('computeInsights with behavioral patterns', () => {
  it('ranks behavioral patterns into the same top-K and sums their wasted time into the total', () => {
    const rows = [makeRow('sess-1', T0)];
    const calls = [
      makeCall('sess-1', 1, iso(0), 'Bash', 'error', { error: 'network timeout' }),
      makeCall('sess-1', 2, iso(1_000), 'Bash', 'ok'),
    ];
    const behavioral = computeBehavioralPatterns(
      new Map([['sess-1', facets({ 'silent stall: 1h+': 1 })]]),
    );
    const withBehavioral = computeInsights(rows, calls, null, undefined, behavioral);
    const withoutBehavioral = computeInsights(rows, calls, null, undefined, []);

    // The behavioral pattern (30m of idle) outranks the small tool-error pattern.
    expect(withBehavioral.failurePatterns[0].signature.cause).toBe('behavioral');
    expect(withBehavioral.failurePatterns.some((p) => p.signature.cause === 'real')).toBe(true);
    // Its wasted time is added to the corpus total, not swallowed.
    expect(withBehavioral.wastedMsTotal).toBe(withoutBehavioral.wastedMsTotal + 30 * 60_000);
  });
});
