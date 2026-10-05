
import { mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const N = parseInt(process.argv[2] ?? '4', 10);
const NUM_SESSIONS = parseInt(process.argv[3] ?? '300', 10);
const TEST_COORDINATOR = process.env.SCAN_COORD === '1';
const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'bench-concurrent-writes.worker.ts');

const BENCH_HOME = mkdtempSync(join(tmpdir(), 'agents-bench-'));

const label = TEST_COORDINATOR
  ? `Scan coordinator — ${N} workers × ${NUM_SESSIONS} sessions (only 1 should scan)`
  : `Concurrent upsertSessionsBatch — ${N} workers × ${NUM_SESSIONS} sessions`;
console.log(`\n${label}`);
console.log(`Shared DB: ${BENCH_HOME}/.agents/.history/sessions/sessions.db`);
if (!TEST_COORDINATOR) {
  console.log(`Each worker writes the same ${NUM_SESSIONS} rows (simulating the filterChangedFiles race)`);
}
console.log();

interface WorkerResult {
  id: number;
  ms: number;
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

function runWorker(id: number): Promise<WorkerResult> {
  return new Promise(resolve => {
    const child = spawn('./node_modules/.bin/tsx', [workerPath], {
      env: {
        ...process.env,
        BENCH_HOME,
        BENCH_SESSIONS: String(NUM_SESSIONS),
        BENCH_WORKER_ID: String(id),
        SCAN_COORD: TEST_COORDINATOR ? '1' : '0',
        NODE_NO_WARNINGS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('close', () => {
      try {
        const result = JSON.parse(stdout.trim()) as { ok: boolean; ms: number; skipped?: boolean; error?: string; code?: string; sqliteCode?: number };
        resolve({ id, ms: result.ms, ok: result.ok, skipped: result.skipped, error: result.error ? `${result.error} [sqlite:${result.sqliteCode}]` : undefined });
      } catch {
        resolve({ id, ms: 0, ok: false, error: stderr.trim() || 'worker stdout unparseable' });
      }
    });
  });
}

const wallStart = Date.now();
const results = await Promise.all(Array.from({ length: N }, (_, i) => runWorker(i + 1)));
const wallMs = Date.now() - wallStart;

for (const r of results) {
  const status = r.ok ? (r.skipped ? 'SKP' : 'OK ') : 'ERR';
  const ms = r.ms.toFixed(1).padStart(8);
  const suffix = r.error ? `  — ${r.error.split('\n')[0]}` : r.skipped ? '  — scan skipped (coordinator)' : '';
  console.log(`  worker ${r.id}: ${status}  ${ms}ms${suffix}`);
}

const failures = results.filter(r => !r.ok);
const skipped = results.filter(r => r.skipped);
const okTimes = results.filter(r => r.ok && !r.skipped).map(r => r.ms);

console.log(`\nwall time : ${wallMs}ms`);
console.log(`failures  : ${failures.length}/${N}`);
if (skipped.length) console.log(`skipped   : ${skipped.length}/${N} (coordinator working)`);
if (okTimes.length > 0) {
  console.log(`fastest   : ${Math.min(...okTimes).toFixed(1)}ms`);
  console.log(`slowest   : ${Math.max(...okTimes).toFixed(1)}ms`);
}
console.log();

rmSync(BENCH_HOME, { recursive: true, force: true });

process.exit(failures.length > 0 ? 1 : 0);
