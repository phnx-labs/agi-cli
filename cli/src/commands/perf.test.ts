/** Real SQLite warehouse under a temp dir, no mocks. Covers the project filter through
 * loadHookProfile: a filter that finds no warehouse rows must not silently fall back to the
 * unfilterable legacy JSONL log and show unfiltered results. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { _resetPerfDbForTest, recordSample } from '../lib/perf/db.js';
import { asHookRows, loadHookProfile, frictionAction, formatRateColumn } from './perf.js';

describe('loadHookProfile', () => {
  let tmp: string;
  let dbPath: string;
  let spoolPath: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-cmd-'));
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
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('surfaces warehouse rows through asHookRows shape (p95, error/timeout rate)', () => {
    const base = Date.now();
    recordSample({ tsMs: base, kind: 'hook.fire', label: 'git-guard', durationMs: 10, exitCode: 0 });
    recordSample({ tsMs: base, kind: 'hook.fire', label: 'git-guard', durationMs: 20, exitCode: 1 });

    const rows = loadHookProfile(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].hook).toBe('git-guard');
    expect(rows[0].n).toBe(2);
    expect(typeof rows[0].p95Ms).toBe('number');
    expect(rows[0].errorCount).toBe(1);
    expect(rows[0].errorRate).toBeCloseTo(0.5, 3);
    expect(rows[0].blockCount).toBe(0);
  });

  it('maps exit-2 to blockCount and exit-1 to errorCount (RUSH-2294)', () => {
    const base = Date.now();
    recordSample({ tsMs: base, kind: 'hook.fire', label: 'ask-user-question-guard', durationMs: 10, exitCode: 0 });
    recordSample({ tsMs: base, kind: 'hook.fire', label: 'ask-user-question-guard', durationMs: 12, exitCode: 2 });
    recordSample({ tsMs: base, kind: 'hook.fire', label: 'ask-user-question-guard', durationMs: 11, exitCode: 2 });
    recordSample({ tsMs: base, kind: 'hook.fire', label: 'ask-user-question-guard', durationMs: 15, exitCode: 1 });

    const rows = loadHookProfile(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].hook).toBe('ask-user-question-guard');
    expect(rows[0].n).toBe(4);
    expect(rows[0].blockCount).toBe(2);
    expect(rows[0].blockRate).toBeCloseTo(0.5, 3);
    expect(rows[0].errorCount).toBe(1);
    expect(rows[0].errorRate).toBeCloseTo(0.25, 3);
  });

  it('a project filter with zero matching warehouse rows returns empty, never the unfiltered legacy log', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-cmd-repo-'));
    fs.mkdirSync(path.join(repo, '.git'));
    try {
      recordSample({ kind: 'hook.fire', label: 'git-guard', durationMs: 10, cwd: repo });

      const rows = loadHookProfile(1, 'some-other-project-name');
      expect(rows).toEqual([]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('scopes to the requested project and tags each row with it', () => {
    const repoA = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-cmd-a-'));
    fs.mkdirSync(path.join(repoA, '.git'));
    const repoB = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-cmd-b-'));
    fs.mkdirSync(path.join(repoB, '.git'));
    try {
      recordSample({ kind: 'hook.fire', label: 'git-guard', durationMs: 10, cwd: repoA });
      recordSample({ kind: 'hook.fire', label: 'git-guard', durationMs: 999, cwd: repoB });

      const projectA = path.basename(repoA);
      const rows = loadHookProfile(1, projectA);
      expect(rows).toHaveLength(1);
      expect(rows[0].n).toBe(1);
      expect(rows[0].project).toBe(projectA);
    } finally {
      fs.rmSync(repoA, { recursive: true, force: true });
      fs.rmSync(repoB, { recursive: true, force: true });
    }
  });
});

describe('asHookRows', () => {
  it('maps optional rate/project fields through without defaulting them away', () => {
    const rows = asHookRows([
      {
        kind: 'hook.fire', label: 'guard', n: 4, p50Ms: 10, p95Ms: 18, p99Ms: 20,
        meanMs: 12, maxMs: 20, minMs: 8, errorRate: 0.25, blockRate: 0.5, timeoutRate: 0.1, project: 'demo',
      },
    ]);
    expect(rows[0]).toMatchObject({
      hook: 'guard', n: 4, p95Ms: 18, errorRate: 0.25, blockRate: 0.5, timeoutRate: 0.1, project: 'demo',
    });
  });
});

describe('formatRateColumn', () => {
  it('renders err / block / to independently so deny-by-design is not "error"', () => {
    expect(formatRateColumn({})).toBe('');
    expect(formatRateColumn({ errorRate: 0.12 })).toBe('err:12%');
    expect(formatRateColumn({ blockRate: 0.4 })).toBe('block:40%');
    expect(formatRateColumn({ errorRate: 0.05, blockRate: 0.9, timeoutRate: 0.02 }))
      .toBe('err:5% block:90% to:2%');
  });
});

describe('frictionAction', () => {
  // Friction events (emitFriction in events.ts) carry no cwd today (`agents _internal friction`
  // has no --cwd), so the shared parent's `--project` must fail loud instead of returning
  // unfiltered results that look filtered.
  it('rejects --project with a clear error instead of silently ignoring it', () => {
    const errors: string[] = [];
    const originalError = console.error;
    const originalExitCode = process.exitCode;
    console.error = (msg: string) => { errors.push(msg); };
    try {
      frictionAction({ project: 'some-repo' });
    } finally {
      console.error = originalError;
      process.exitCode = originalExitCode;
    }
    expect(errors.some((e) => e.includes('--project'))).toBe(true);
  });
});
