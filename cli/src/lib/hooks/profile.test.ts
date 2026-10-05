import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { aggregateHookProfile, loadHookFireEvents, formatMs, formatCacheColumn } from './profile.js';

function utcDateFile(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `events-${yyyy}-${mm}-${dd}.jsonl`;
}

describe('loadHookFireEvents', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-profile-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns [] when the logs dir is missing', () => {
    expect(loadHookFireEvents(7, path.join(tmp, 'nope'))).toEqual([]);
  });

  it('only picks up hook.fire events, ignores other event types and junk lines', () => {
    fs.writeFileSync(path.join(tmp, utcDateFile(0)), [
      '{"event":"hook.fire","hook":"a","ms":10,"cache":"hit","exit":0}',
      '{"event":"version.switch","agent":"claude","version":"2.1.141"}',
      'not json at all',
      '',
      '{"event":"hook.fire","hook":"a","ms":20,"cache":"miss","exit":0}',
    ].join('\n'));
    const evs = loadHookFireEvents(1, tmp);
    expect(evs).toHaveLength(2);
    expect(evs.map(e => e.ms)).toEqual([10, 20]);
  });

  it('reads multiple days back', () => {
    fs.writeFileSync(path.join(tmp, utcDateFile(0)), '{"event":"hook.fire","hook":"x","ms":1,"cache":"hit","exit":0}\n');
    fs.writeFileSync(path.join(tmp, utcDateFile(2)), '{"event":"hook.fire","hook":"x","ms":2,"cache":"hit","exit":0}\n');
    expect(loadHookFireEvents(7, tmp)).toHaveLength(2);
    expect(loadHookFireEvents(1, tmp)).toHaveLength(1);
  });
});

describe('aggregateHookProfile', () => {
  it('computes p50/p99/mean/max correctly on a known distribution', () => {
    const evs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(ms => ({
      event: 'hook.fire', hook: 'h', ms, cache: 'miss', exit: 0,
    }));
    const [row] = aggregateHookProfile(evs);
    expect(row.n).toBe(10);
    expect(row.maxMs).toBe(100);
    expect(row.meanMs).toBe(55);
    expect(row.p50Ms).toBe(55);
    expect(row.p95Ms).toBeGreaterThan(row.p50Ms);
    expect(row.p95Ms).toBeLessThanOrEqual(100);
    expect(row.p99Ms).toBeGreaterThanOrEqual(98);
    expect(row.p99Ms).toBeLessThanOrEqual(100);
    expect(row.p99Ms).toBeGreaterThanOrEqual(row.p95Ms);
  });

  it('computes errorRate only when there are errors', () => {
    const clean = aggregateHookProfile([
      { event: 'hook.fire', hook: 'ok', ms: 10, cache: 'hit', exit: 0 },
      { event: 'hook.fire', hook: 'ok', ms: 12, cache: 'hit', exit: 0 },
    ]);
    expect(clean[0].errorRate).toBeUndefined();
    expect(clean[0].blockCount).toBe(0);
    expect(clean[0].blockRate).toBeUndefined();

    const flaky = aggregateHookProfile([
      { event: 'hook.fire', hook: 'flaky', ms: 10, cache: 'miss', exit: 0 },
      { event: 'hook.fire', hook: 'flaky', ms: 10, cache: 'miss', exit: 0 },
      { event: 'hook.fire', hook: 'flaky', ms: 10, cache: 'miss', exit: 0 },
      { event: 'hook.fire', hook: 'flaky', ms: 10, cache: 'miss', exit: 1 },
    ]);
    expect(flaky[0].errorCount).toBe(1);
    expect(flaky[0].errorRate).toBeCloseTo(0.25, 3);
    expect(flaky[0].blockCount).toBe(0);
  });

  it('counts intentional exit 2 as blockCount, not errorCount (RUSH-2294)', () => {
    const [row] = aggregateHookProfile([
      { event: 'hook.fire', hook: 'ask-user-question-guard', ms: 10, cache: 'miss', exit: 0 },
      { event: 'hook.fire', hook: 'ask-user-question-guard', ms: 12, cache: 'miss', exit: 2 },
      { event: 'hook.fire', hook: 'ask-user-question-guard', ms: 11, cache: 'miss', exit: 2 },
      { event: 'hook.fire', hook: 'ask-user-question-guard', ms: 15, cache: 'miss', exit: 1 },
    ]);
    expect(row.n).toBe(4);
    expect(row.blockCount).toBe(2);
    expect(row.blockRate).toBeCloseTo(0.5, 3);
    expect(row.errorCount).toBe(1);
    expect(row.errorRate).toBeCloseTo(0.25, 3);
  });

  it('aggregates per-hook and sorts by p99 desc', () => {
    const evs = [
      { event: 'hook.fire', hook: 'slow', ms: 5000, cache: 'miss', exit: 0 },
      { event: 'hook.fire', hook: 'slow', ms: 5500, cache: 'miss', exit: 0 },
      { event: 'hook.fire', hook: 'fast', ms: 12,   cache: 'hit',  exit: 0 },
      { event: 'hook.fire', hook: 'fast', ms: 18,   cache: 'hit',  exit: 0 },
    ];
    const rows = aggregateHookProfile(evs);
    expect(rows.map(r => r.hook)).toEqual(['slow', 'fast']);
  });

  it('counts cache hit/stale/miss percentages and non-zero exits', () => {
    const evs = [
      { event: 'hook.fire', hook: 'h', ms: 1, cache: 'hit',  exit: 0 },
      { event: 'hook.fire', hook: 'h', ms: 2, cache: 'hit',  exit: 0 },
      { event: 'hook.fire', hook: 'h', ms: 3, cache: 'hit',  exit: 0 },
      { event: 'hook.fire', hook: 'h', ms: 4, cache: 'stale-prefetch', exit: 0 },
      { event: 'hook.fire', hook: 'h', ms: 5, cache: 'miss', exit: 1 },
    ];
    const [row] = aggregateHookProfile(evs);
    expect(row.cacheHitPct).toBe(60);
    expect(row.cacheStalePct).toBe(20);
    expect(row.cacheMissPct).toBe(20);
    expect(row.errorCount).toBe(1);
    expect(row.blockCount).toBe(0);
  });
});

describe('formatMs', () => {
  it('uses ms below 1s', () => {
    expect(formatMs(0)).toBe('0ms');
    expect(formatMs(42)).toBe('42ms');
    expect(formatMs(999)).toBe('999ms');
  });
  it('uses one decimal for 1-10s', () => {
    expect(formatMs(1234)).toBe('1.2s');
    expect(formatMs(9999)).toBe('10.0s');
  });
  it('uses whole seconds for 10s-1m', () => {
    expect(formatMs(25789)).toBe('26s');
  });
  it('uses minutes above 1m', () => {
    expect(formatMs(65_000)).toBe('1m5s');
    expect(formatMs(120_000)).toBe('2m');
  });
});

describe('formatCacheColumn', () => {
  it('says n/a when nothing was cached', () => {
    expect(formatCacheColumn({ hook: 'x', n: 1, p50Ms: 0, p95Ms: 0, p99Ms: 0, meanMs: 0, maxMs: 0, cacheHitPct: 0, cacheStalePct: 0, cacheMissPct: 0, errorCount: 0, blockCount: 0 })).toBe('n/a');
  });
  it('lists only non-zero buckets', () => {
    expect(formatCacheColumn({ hook: 'x', n: 100, p50Ms: 0, p95Ms: 0, p99Ms: 0, meanMs: 0, maxMs: 0, cacheHitPct: 98, cacheStalePct: 0, cacheMissPct: 2, errorCount: 0, blockCount: 0 }))
      .toBe('hit:98% miss:2%');
  });
});
