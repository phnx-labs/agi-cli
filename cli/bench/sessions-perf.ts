#!/usr/bin/env tsx
// Benchmark harness for the sessions indexing pipeline: cold and warm discover, picker keystroke
// (filterSessionsByQuery) single and 10 successive, searchContentIndex alone, an indexed tool-call
// clause, two indexed git calls in one session, exact static program-occurrence count.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { discoverSessions, searchContentIndex } from '../src/lib/session/discover.js';
import { filterSessionsByQuery, toolOriginSessions } from '../src/commands/sessions.js';
import {
  countToolProgramOccurrences,
  ensureToolIndex,
  readToolIndexCoverage,
  searchToolCalls,
  type ToolIndexCoverage,
} from '../src/lib/session/tool-index.js';
import { getDB } from '../src/lib/session/db.js';
import { getSessionsDbPath, getSessionsDir } from '../src/lib/state.js';

// Resolved through the same helpers the CLI itself uses. Re-deriving the path
// here is what let this benchmark drift onto a directory that no longer exists.
const SESSIONS_DIR = getSessionsDir();
const DB_PATH = getSessionsDbPath();

async function time<T>(fn: () => Promise<T> | T): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await fn();
  const ms = performance.now() - t0;
  return { ms, value };
}

interface Distribution {
  runs: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  allRunsMs: number[];
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

async function distribution(
  fn: () => Promise<unknown> | unknown,
  warmups = 3,
  runs = 30,
): Promise<Distribution> {
  for (let i = 0; i < warmups; i++) await fn();
  const values: number[] = [];
  for (let i = 0; i < runs; i++) values.push((await time(fn)).ms);
  const sorted = [...values].sort((a, b) => a - b);
  return {
    runs,
    minMs: sorted[0],
    p50Ms: percentile(sorted, 0.50),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted.at(-1)!,
    allRunsMs: values,
  };
}

function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function sqliteStorage(): {
  sessionsDbBytes: number;
  walBytes: number;
  pageSize: number;
  pageCount: number;
  freePages: number;
  usedPageBytes: number;
} {
  const db = getDB();
  const pageSize = (db.prepare(`PRAGMA page_size`).get() as { page_size: number }).page_size;
  const pageCount = (db.prepare(`PRAGMA page_count`).get() as { page_count: number }).page_count;
  const freePages = (db.prepare(`PRAGMA freelist_count`).get() as { freelist_count: number }).freelist_count;
  return {
    sessionsDbBytes: fileSize(DB_PATH),
    walBytes: fileSize(DB_PATH + '-wal'),
    pageSize,
    pageCount,
    freePages,
    usedPageBytes: (pageCount - freePages) * pageSize,
  };
}

function removeIfExists(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    // not there
  }
}

function evenlySample<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  return Array.from({ length: limit }, (_, index) =>
    items[Math.floor(index * items.length / limit)]
  );
}

// BENCH_CORPUS=real: copy this machine's live index into a throwaway HOME and
// re-run there. Copying rather than measuring in place is what keeps discover's
// writes off the index `agents sessions` is serving.
function relaunchAgainstRealCorpusCopy(): never {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`BENCH_CORPUS=real: no index at ${DB_PATH} — run \`agents sessions\` once to build one.`);
    process.exit(1);
  }
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-perf-'));
  const destDir = path.join(tmpHome, '.agents', '.history', 'sessions');
  fs.mkdirSync(path.dirname(destDir), { recursive: true });

  console.error(`copying ${(fileSize(DB_PATH) / 1e6).toFixed(0)}MB index -> ${destDir}`);
  const copyStart = performance.now();
  fs.cpSync(SESSIONS_DIR, destDir, { recursive: true });
  console.error(`copied in ${((performance.now() - copyStart) / 1000).toFixed(1)}s`);

  let status: number;
  try {
    const child = spawnSync(process.execPath, [...process.execArgv, process.argv[1]], {
      stdio: 'inherit',
      env: { ...process.env, HOME: tmpHome, BENCH_CORPUS: 'copied' },
    });
    status = child.status ?? 1;
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
  process.exit(status);
}

async function main() {
  const mode = (process.env.BENCH_MODE || 'full').toLowerCase();

  if (process.env.BENCH_CORPUS === 'real') {
    if (mode !== 'warm') {
      console.error(
        'BENCH_CORPUS=real supports BENCH_MODE=warm only. Cold mode rebuilds the index by ' +
          'rescanning transcripts, which a copied index does not carry — measure first-run ' +
          'cost against the default corpus instead.',
      );
      process.exit(1);
    }
    relaunchAgainstRealCorpusCopy();
  }

  const pre = {
    sessionsDbBytes: fileSize(DB_PATH),
    walBytes: fileSize(DB_PATH + '-wal'),
  };

  // ------------------------------------------------------------------
  // A. Cold discover
  // ------------------------------------------------------------------
  if (mode === 'full' || mode === 'cold') {
    // Backup and remove the existing index (SQLite + WAL/SHM) to simulate first-run cost.
    const COLD_PATHS = [
      DB_PATH,
      DB_PATH + '-wal',
      DB_PATH + '-shm',
    ];
    const backup = COLD_PATHS
      .filter(p => fs.existsSync(p))
      .map(p => ({ src: p, bak: p + '.benchbak' }));
    for (const { src, bak } of backup) fs.renameSync(src, bak);

    try {
      const cold = await time(() =>
        discoverSessions({ all: true, cwd: process.cwd(), limit: 5000 }),
      );
      const sessionsCount = (cold.value as any[]).length;

      // Restore originals (discover wrote fresh indexes during the run — keep those)
      // so the warm run below uses real state, not the fresh-from-scan output.
      for (const { src, bak } of backup) {
        if (fs.existsSync(src)) removeIfExists(bak);
        else if (fs.existsSync(bak)) fs.renameSync(bak, src);
      }

      console.error(`A. cold discover: ${cold.ms.toFixed(0)}ms, ${sessionsCount} sessions`);
      (globalThis as any).__A = { ms: cold.ms, sessionsCount };
    } finally {
      // safety net: restore any leftover .benchbak files if the run crashed
      for (const { src, bak } of backup) {
        if (!fs.existsSync(src) && fs.existsSync(bak)) fs.renameSync(bak, src);
      }
    }
  }

  // ------------------------------------------------------------------
  // B. Warm discover — runs with the index freshly populated from A
  // ------------------------------------------------------------------
  let warmSessions: any[] = [];
  const warmDistribution = await distribution(async () => {
    warmSessions = await discoverSessions({ all: true, cwd: process.cwd(), limit: 5000 }) as any[];
  }, 1, 10);
  console.error(`B. warm discover: p50 ${warmDistribution.p50Ms.toFixed(0)}ms, p95 ${warmDistribution.p95Ms.toFixed(0)}ms, ${warmSessions.length} sessions`);

  // ------------------------------------------------------------------
  // C. Single keystroke (filterSessionsByQuery) — using already-loaded sessions
  // ------------------------------------------------------------------
  const singleQuery = 'rush deploy';
  const singleKey = await time(() => filterSessionsByQuery(warmSessions, singleQuery));
  console.error(`C. single keystroke ("${singleQuery}"): ${singleKey.ms.toFixed(1)}ms, ${singleKey.value.length} matches`);

  // ------------------------------------------------------------------
  // D. 10 successive keystrokes (simulates typing a query char by char)
  // ------------------------------------------------------------------
  const typingQueries = [
    'r', 'ru', 'rus', 'rush', 'rush ',
    'rush d', 'rush de', 'rush dep', 'rush depl', 'rush deploy',
  ];
  const perKey: number[] = [];
  let lastMatches = 0;
  for (const q of typingQueries) {
    const r = await time(() => filterSessionsByQuery(warmSessions, q));
    perKey.push(r.ms);
    lastMatches = r.value.length;
  }
  const typingTotal = perKey.reduce((a, b) => a + b, 0);
  const typingAvg = typingTotal / perKey.length;
  console.error(
    `D. 10 successive keystrokes: total ${typingTotal.toFixed(0)}ms, avg ${typingAvg.toFixed(1)}ms/key, final matches ${lastMatches}`,
  );

  // ------------------------------------------------------------------
  // E. searchContentIndex alone (the heaviest component of D)
  // ------------------------------------------------------------------
  const contentDistribution = await distribution(
    () => searchContentIndex(warmSessions, 'rush deploy yaml'),
  );
  console.error(`E. searchContentIndex: p50 ${contentDistribution.p50Ms.toFixed(1)}ms, p95 ${contentDistribution.p95Ms.toFixed(1)}ms`);

  // ------------------------------------------------------------------
  // F/G. Indexed tool-call queries, including same-session distinct calls
  // ------------------------------------------------------------------
  const toolSinceDays = Number(process.env.BENCH_TOOL_SINCE_DAYS ?? 0);
  const toolSampleLimit = Number(process.env.BENCH_TOOL_SAMPLE ?? warmSessions.length);
  const toolCutoff = toolSinceDays > 0 ? Date.now() - toolSinceDays * 86_400_000 : 0;
  const toolCandidates = toolCutoff > 0
    ? warmSessions.filter((session) => Date.parse(session.timestamp) >= toolCutoff)
    : warmSessions;
  const toolSessions = evenlySample(toolCandidates, Math.max(1, toolSampleLimit));
  console.error(`tool scope: ${toolSessions.length} of ${toolCandidates.length} candidates${toolSinceDays > 0 ? ` from ${toolSinceDays} days` : ''}`);
  getDB().pragma('wal_checkpoint(TRUNCATE)');
  if (process.env.BENCH_CORPUS === 'copied' && process.env.BENCH_SKIP_TOOL_BACKFILL !== '1') {
    getDB().exec(`
      DELETE FROM tool_call_text;
      DELETE FROM tool_program_occurrences;
      DELETE FROM tool_call_programs;
      DELETE FROM tool_calls;
      DELETE FROM tool_scan_ledger;
    `);
    getDB().pragma('wal_checkpoint(TRUNCATE)');
  }
  const toolStorageBefore = sqliteStorage();
  let backfillFiles = 0;
  let backfillCalls = 0;
  const backfillStart = performance.now();
  if (process.env.BENCH_SKIP_TOOL_BACKFILL !== '1'
    && (process.env.BENCH_CORPUS === 'copied' || process.env.BENCH_TOOL_BACKFILL === '1')) {
    for (;;) {
      const batch = await ensureToolIndex(toolSessions);
      backfillFiles += batch.indexedFiles;
      backfillCalls += batch.indexedCalls;
      if (batch.remainingFiles === 0 || batch.indexedFiles === 0) break;
    }
  }
  const backfillMs = performance.now() - backfillStart;
  const toolCoverage: ToolIndexCoverage = readToolIndexCoverage(toolSessions);
  const peakBackfillWalBytes = fileSize(DB_PATH + '-wal');
  getDB().pragma('wal_checkpoint(TRUNCATE)');
  const toolStorageAfter = sqliteStorage();
  const queryPre = { sessionsDbBytes: fileSize(DB_PATH), walBytes: fileSize(DB_PATH + '-wal') };
  let toolSingleMatches = 0;
  const toolSingleDistribution = await distribution(() => {
    const value = searchToolCalls(
      toolSessions,
      ['program:git input:status'],
      toolCoverage,
      25,
    );
    toolSingleMatches = value.sessions.length;
  });
  console.error(`F. one tool-call clause: p50 ${toolSingleDistribution.p50Ms.toFixed(1)}ms, p95 ${toolSingleDistribution.p95Ms.toFixed(1)}ms, ${toolSingleMatches} matches`);

  let toolTwoCallMatches = 0;
  const toolTwoCallDistribution = await distribution(() => {
    const value = searchToolCalls(
      toolSessions,
      ['program:git', 'program:git'],
      toolCoverage,
      25,
    );
    toolTwoCallMatches = value.sessions.length;
  });
  console.error(`G. two distinct tool-call clauses: p50 ${toolTwoCallDistribution.p50Ms.toFixed(1)}ms, p95 ${toolTwoCallDistribution.p95Ms.toFixed(1)}ms, ${toolTwoCallMatches} matches`);

  let countTotals = { occurrences: 0, toolCalls: 0, sessions: 0 };
  const originToolSessions = toolOriginSessions(toolSessions, os.hostname(), true);
  const originToolCoverage = readToolIndexCoverage(originToolSessions);
  const countDistribution = await distribution(() => {
    countTotals = countToolProgramOccurrences(
      originToolSessions,
      'git',
      originToolCoverage,
      os.hostname(),
    ).totals;
  });
  console.error(`H. exact git count: p50 ${countDistribution.p50Ms.toFixed(1)}ms, p95 ${countDistribution.p95Ms.toFixed(1)}ms, ${countTotals.occurrences} occurrences`);

  const fullCoverage = readToolIndexCoverage(warmSessions);
  const originWarmSessions = toolOriginSessions(warmSessions, os.hostname(), true);
  const originFullCoverage = readToolIndexCoverage(originWarmSessions);
  const toolSingleFullDistribution = await distribution(() =>
    searchToolCalls(warmSessions, ['program:git input:status'], fullCoverage, 25)
  );
  const toolTwoCallFullDistribution = await distribution(() =>
    searchToolCalls(
      warmSessions,
      ['program:git', 'program:git'],
      fullCoverage,
      25,
    )
  );
  const programCountFullDistribution = await distribution(() =>
    countToolProgramOccurrences(originWarmSessions, 'git', originFullCoverage, os.hostname())
  );
  console.error(`I. full ${warmSessions.length}-session scope: one-clause p95 ${toolSingleFullDistribution.p95Ms.toFixed(1)}ms, two-call p95 ${toolTwoCallFullDistribution.p95Ms.toFixed(1)}ms, count p95 ${programCountFullDistribution.p95Ms.toFixed(1)}ms`);
  const queryPost = { sessionsDbBytes: fileSize(DB_PATH), walBytes: fileSize(DB_PATH + '-wal') };

  const post = {
    sessionsDbBytes: fileSize(DB_PATH),
    walBytes: fileSize(DB_PATH + '-wal'),
  };

  const result = {
    node: process.version,
    timestamp: new Date().toISOString(),
    corpus: process.env.BENCH_CORPUS === 'copied' ? 'real (copied)' : 'whatever $HOME holds',
    sessionsDbPath: DB_PATH,
    sessionsCount: warmSessions.length,
    toolScope: {
      candidates: toolCandidates.length,
      sampledSessions: toolSessions.length,
      sinceDays: toolSinceDays || null,
    },
    pre,
    post,
    coldDiscover: (globalThis as any).__A,
    picker: {
      singleKeystrokeMs: singleKey.ms,
      singleKeystrokeMatches: singleKey.value.length,
      typingTotalMs: typingTotal,
      typingAvgMsPerKey: typingAvg,
      typingPerKeyMs: perKey,
    },
    distributions: {
      warmDiscover: warmDistribution,
      contentFts: contentDistribution,
      toolSingle: toolSingleDistribution,
      toolTwoCall: toolTwoCallDistribution,
      programCount: countDistribution,
      toolSingleFullIndex: toolSingleFullDistribution,
      toolTwoCallFullIndex: toolTwoCallFullDistribution,
      programCountFullIndex: programCountFullDistribution,
    },
    toolBackfill: {
      ms: backfillMs,
      indexedFiles: backfillFiles,
      indexedCalls: backfillCalls,
      coverage: toolCoverage,
      before: toolStorageBefore,
      after: toolStorageAfter,
      dbBytesAdded: toolStorageAfter.sessionsDbBytes - toolStorageBefore.sessionsDbBytes,
      usedPageBytesAdded: toolStorageAfter.usedPageBytes - toolStorageBefore.usedPageBytes,
      peakWalBytes: peakBackfillWalBytes,
    },
    queryStorage: {
      before: queryPre,
      after: queryPost,
      dbDeltaBytes: queryPost.sessionsDbBytes - queryPre.sessionsDbBytes,
      walDeltaBytes: queryPost.walBytes - queryPre.walBytes,
    },
    matches: {
      toolSingle: toolSingleMatches,
      toolTwoCall: toolTwoCallMatches,
    },
    countTotals,
  };

  const baselinePath = process.env.BENCH_BASELINE;
  if (baselinePath) {
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as typeof result;
    const latencyKeys = ['toolSingle', 'toolTwoCall', 'programCount'] as const;
    const regressions = latencyKeys.flatMap((key) => {
      const prior = baseline.distributions[key]?.p95Ms;
      const current = result.distributions[key].p95Ms;
      if (!Number.isFinite(prior) || current <= prior * 1.10) return [];
      return [{ metric: `${key}.p95Ms`, baselineMs: prior, currentMs: current, ratio: current / prior }];
    });
    Object.assign(result, { regressionGate: { baselinePath, maxRatio: 1.10, regressions } });
    if (regressions.length > 0 && process.env.BENCH_FAIL_REGRESSION === '1') {
      process.exitCode = 1;
    }
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
