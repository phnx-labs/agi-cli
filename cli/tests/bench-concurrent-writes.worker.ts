/** Worker for the concurrent-writes benchmark (BENCH_HOME via env): builds the same synthetic
 * session batch in every worker so all race on the same rows, calls upsertSessionsBatch, and
 * reports JSON on stdout. */

const benchHome = process.env.BENCH_HOME;
if (!benchHome) {
  process.stdout.write(JSON.stringify({ ok: false, ms: 0, error: 'BENCH_HOME not set' }) + '\n');
  process.exit(1);
}

// Override HOME before any import so state.ts uses the temp dir.
process.env.HOME = benchHome;

const { upsertSessionsBatch, tryClaimScan, releaseScan, closeDB } = await import('../src/lib/session/db.js');

const NUM_SESSIONS = parseInt(process.env.BENCH_SESSIONS ?? '300', 10);

const entries = Array.from({ length: NUM_SESSIONS }, (_, i) => ({
  meta: {
    id: `bench-session-${i.toString().padStart(5, '0')}`,
    shortId: `bs${i.toString().padStart(5, '0')}`,
    agent: 'claude' as const,
    version: '2.1.138',
    timestamp: new Date(1_746_975_600_000 - i * 1000).toISOString(),
    messageCount: 10,
    filePath: `${benchHome}/.agents/.history/versions/claude/2.1.138/home/.claude/projects/bench/session-${i}.jsonl`,
    isTeamOrigin: false,
  },
  content: `bench session ${i} synthetic content for fts5 tokenization test`,
  scan: {
    // Fixed mtime/size — identical across all workers so they all think the same
    // files changed and race to write the exact same rows.
    fileMtimeMs: 1_746_975_600_000 + i,
    fileSize: 4096 + i,
  },
}));

const useCoordinator = process.env.SCAN_COORD === '1';

const start = performance.now();
try {
  let skipped = false;
  if (useCoordinator) {
    if (tryClaimScan(process.pid)) {
      try {
        upsertSessionsBatch(entries);
      } finally {
        releaseScan(process.pid);
      }
    } else {
      skipped = true; // another process is scanning — skip
    }
  } else {
    upsertSessionsBatch(entries);
  }
  const ms = +(performance.now() - start).toFixed(1);
  process.stdout.write(JSON.stringify({ ok: true, ms, skipped }) + '\n');
} catch (err: unknown) {
  const ms = +(performance.now() - start).toFixed(1);
  const e = err as { message?: string; code?: string; errcode?: number; errmsg?: string };
  const error = e.message ?? String(err);
  const sqliteCode = e.errcode ?? 'unknown'; // 5=SQLITE_BUSY, 6=SQLITE_LOCKED
  const code = e.code ?? 'unknown';
  process.stdout.write(JSON.stringify({ ok: false, ms, error, code, sqliteCode }) + '\n');
}

closeDB();
