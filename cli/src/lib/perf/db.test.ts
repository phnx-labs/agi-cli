import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  _resetPerfDbForTest,
  aggregateSamples,
  drainSpool,
  percentile,
  recordSample,
  shortSessionId,
} from './db.js';

describe('perf/db', () => {
  let tmp: string;
  let dbPath: string;
  let spoolPath: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-db-'));
    dbPath = path.join(tmp, 'perf.db');
    spoolPath = path.join(tmp, 'spool.jsonl');
    process.env.AGENTS_PERF_DB = dbPath;
    process.env.AGENTS_PERF_SPOOL = spoolPath;
    delete process.env.AGENTS_DISABLE_PERF;
    _resetPerfDbForTest(dbPath);
  });

  afterEach(() => {
    _resetPerfDbForTest(null);
    delete process.env.AGENTS_PERF_DB;
    delete process.env.AGENTS_PERF_SPOOL;
    delete process.env.AGENTS_DISABLE_PERF;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('shortSessionId strips session_ prefix and keeps 8 chars', () => {
    expect(shortSessionId('session_087bf3be-64f7-4bbc')).toBe('087bf3be');
    expect(shortSessionId('b0b06be0-c484-4db4-8031')).toBe('b0b06be0');
    expect(shortSessionId(undefined)).toBeUndefined();
  });

  it('percentile is linear and bounds-safe', () => {
    expect(percentile([1], 50)).toBe(1);
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([10, 20, 30, 40, 50], 0)).toBe(10);
    expect(percentile([10, 20, 30, 40, 50], 100)).toBe(50);
  });

  it('recordSample + aggregateSamples returns p50/p99 by kind+label', () => {
    const base = Date.now();
    for (const ms of [10, 20, 30, 40, 100]) {
      recordSample({
        tsMs: base,
        kind: 'hook.fire',
        label: 'inject-repo-inflight',
        durationMs: ms,
        sessionId: 'b0b06be0-c484-4db4-8031-1cf89563e6e1',
        agent: 'claude',
        machine: 'yosemite-s1',
        cache: ms === 10 ? 'hit' : 'miss',
      });
    }
    recordSample({
      tsMs: base,
      kind: 'command.end',
      label: 'sessions focus',
      durationMs: 5,
      agent: 'claude',
    });

    const hooks = aggregateSamples({ days: 1, kinds: ['hook.fire'] });
    expect(hooks).toHaveLength(1);
    expect(hooks[0].label).toBe('inject-repo-inflight');
    expect(hooks[0].n).toBe(5);
    expect(hooks[0].p50Ms).toBe(30);
    expect(hooks[0].maxMs).toBe(100);
    expect(hooks[0].cacheHitPct).toBe(20);
    expect(hooks[0].cacheMissPct).toBe(80);

    const cmds = aggregateSamples({ days: 1, kinds: ['command.end'] });
    expect(cmds).toHaveLength(1);
    expect(cmds[0].label).toBe('sessions focus');
    expect(cmds[0].n).toBe(1);
  });

  it('drainSpool ingests bash-shaped NDJSON and empties the spool', () => {
    const line = JSON.stringify({
      ts_ms: Date.now(),
      kind: 'hook.fire',
      label: 'session-identity',
      duration_ms: 18,
      cache: 'none',
      exit_code: 0,
      machine: 'zion',
      hostname: 'zion.local',
    });
    fs.writeFileSync(spoolPath, line + '\n');
    const n = drainSpool();
    expect(n).toBe(1);
    expect(fs.readFileSync(spoolPath, 'utf-8')).toBe('');

    const rows = aggregateSamples({ days: 1, kinds: ['hook.fire'] });
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('session-identity');
    expect(rows[0].meanMs).toBe(18);
  });

  it('AGENTS_DISABLE_PERF silences writes', () => {
    process.env.AGENTS_DISABLE_PERF = '1';
    _resetPerfDbForTest(dbPath);
    recordSample({ kind: 'hook.fire', label: 'x', durationMs: 1 });
    process.env.AGENTS_DISABLE_PERF = '0';
    _resetPerfDbForTest(dbPath);
    delete process.env.AGENTS_DISABLE_PERF;
    _resetPerfDbForTest(dbPath);
    expect(aggregateSamples({ days: 1 })).toHaveLength(0);
  });

  it('fail-soft: empty label is ignored', () => {
    recordSample({ kind: 'hook.fire', label: '', durationMs: 10 });
    expect(aggregateSamples({ days: 1 })).toHaveLength(0);
  });

  it('computes p95Ms, errorRate, and timeoutRate alongside p50/p99', () => {
    const base = Date.now();
    for (let i = 0; i < 10; i++) {
      recordSample({ tsMs: base, kind: 'hook.fire', label: 'guard', durationMs: 10 + i, exitCode: 0 });
    }
    recordSample({ tsMs: base, kind: 'hook.fire', label: 'guard', durationMs: 500, exitCode: 1 });
    recordSample({ tsMs: base, kind: 'hook.fire', label: 'guard', durationMs: 5000, status: 'timeout' });

    const rows = aggregateSamples({ days: 1, kinds: ['hook.fire'] });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.n).toBe(12);
    expect(row.p95Ms).toBeGreaterThanOrEqual(row.p50Ms);
    expect(row.p99Ms).toBeGreaterThanOrEqual(row.p95Ms);
    expect(row.errorCount).toBe(1);
    expect(row.errorRate).toBeCloseTo(1 / 12, 3);
    expect(row.timeoutRate).toBeCloseTo(1 / 12, 3);
    expect(row.blockCount).toBeUndefined();
  });

  it('counts exit 2 as blockCount/blockRate, not errorCount (RUSH-2294)', () => {
    const base = Date.now();
    recordSample({ tsMs: base, kind: 'hook.fire', label: 'ask-user-question-guard', durationMs: 10, exitCode: 0 });
    recordSample({ tsMs: base, kind: 'hook.fire', label: 'ask-user-question-guard', durationMs: 12, exitCode: 2 });
    recordSample({ tsMs: base, kind: 'hook.fire', label: 'ask-user-question-guard', durationMs: 11, exitCode: 2 });
    recordSample({ tsMs: base, kind: 'hook.fire', label: 'ask-user-question-guard', durationMs: 15, exitCode: 1 });

    const rows = aggregateSamples({ days: 1, kinds: ['hook.fire'] });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.n).toBe(4);
    expect(row.blockCount).toBe(2);
    expect(row.blockRate).toBeCloseTo(0.5, 3);
    expect(row.errorCount).toBe(1);
    expect(row.errorRate).toBeCloseTo(0.25, 3);
  });

  it('project filter scopes aggregation to samples whose cwd resolves to that project', () => {
    const repoA = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-proj-a-'));
    fs.mkdirSync(path.join(repoA, '.git'));
    const repoB = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-proj-b-'));
    fs.mkdirSync(path.join(repoB, '.git'));
    try {
      recordSample({ kind: 'hook.fire', label: 'guard', durationMs: 10, cwd: repoA });
      recordSample({ kind: 'hook.fire', label: 'guard', durationMs: 20, cwd: repoA });
      recordSample({ kind: 'hook.fire', label: 'guard', durationMs: 999, cwd: repoB });

      const projectA = path.basename(repoA);
      const rows = aggregateSamples({ days: 1, kinds: ['hook.fire'], project: projectA });
      expect(rows).toHaveLength(1);
      expect(rows[0].n).toBe(2);
      expect(rows[0].project).toBe(projectA);
      expect(rows[0].maxMs).toBe(20);
    } finally {
      fs.rmSync(repoA, { recursive: true, force: true });
      fs.rmSync(repoB, { recursive: true, force: true });
    }
  });

  it('aggregates a startup sub-phase from meta_json into row.phases (PHNX-3468)', () => {
    const base = Date.now();
    for (const [startup, total] of [[40, 900], [60, 1200], [80, 1500], [100, 3000]]) {
      recordSample({
        tsMs: base,
        kind: 'perf.timing',
        label: 'agent.run',
        durationMs: total,
        agent: 'claude',
        metaJson: JSON.stringify({ phases: { startup } }),
      });
    }
    recordSample({ tsMs: base, kind: 'perf.timing', label: 'agent.run', durationMs: 500, agent: 'claude' });

    const rows = aggregateSamples({ days: 1, kinds: ['perf.timing'] });
    const run = rows.find((r) => r.label === 'agent.run');
    expect(run).toBeDefined();
    expect(run!.n).toBe(5);
    expect(run!.phases?.startup).toBeDefined();
    expect(run!.phases!.startup.n).toBe(4);
    expect(run!.phases!.startup.p50Ms).toBe(percentile([40, 60, 80, 100], 50));
    expect(run!.phases!.startup.p90Ms).toBe(percentile([40, 60, 80, 100], 90));
  });

  it('a malformed meta_json phase is skipped, not thrown (PHNX-3468)', () => {
    recordSample({ kind: 'perf.timing', label: 'agent.run', durationMs: 900, metaJson: 'not json' });
    recordSample({ kind: 'perf.timing', label: 'agent.run', durationMs: 900, metaJson: JSON.stringify({ phases: { startup: 'x' } }) });
    const rows = aggregateSamples({ days: 1, kinds: ['perf.timing'] });
    const run = rows.find((r) => r.label === 'agent.run');
    expect(run).toBeDefined();
    expect(run!.phases).toBeUndefined();
  });
});
