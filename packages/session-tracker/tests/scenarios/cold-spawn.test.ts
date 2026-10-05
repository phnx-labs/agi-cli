import { afterAll, expect, test } from 'vitest';
import { spawnAndDetect, killAndCleanup } from '../harness.js';
import {
  ScenarioRecorder,
  percentile,
  sleep,
} from '../lib/scenario-record.js';

// 50 fresh-cwd cold spawns. This is the headline reliability number: does the
// SessionStart hook land a parseable state file fast enough, every time, for a
// brand-new agent in a directory it has never seen?
const ITERATIONS = 50;
const MATCH_RATE_THRESHOLD = 0.99;
const P95_LATENCY_MS = 1000;

const recorder = new ScenarioRecorder('cold-spawn', 'claude');

afterAll(async () => {
  await recorder.flush();
});

test(
  `cold-spawn: ${ITERATIONS} sequential fresh-cwd claude spawns`,
  async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const run = await spawnAndDetect({ agent: 'claude' });
      try {
        recorder.add({
          iteration: i,
          truth: run.truthSessionId,
          detected: run.detected.sessionId,
          matched: run.matched,
          latencyMs: run.detected.latencyMs,
          method: run.detected.method,
          cwd: run.cwd,
          pid: run.proc.pid,
        });
      } finally {
        await killAndCleanup(run);
      }
      // Don't hammer STATE_DIR / pgrep between iterations.
      await sleep(200);
    }

    const records = recorder.all;
    const matched = records.filter((r) => r.matched).length;
    const matchRate = matched / records.length;
    const latencies = records.map((r) => r.latencyMs);
    const p95 = percentile(latencies, 95);

    const failures = records.filter((r) => !r.matched);
    if (failures.length > 0) {
      // Surface enough to debug a missed detection: ground truth vs what the
      // tracker reported, plus the cwd/pid that produced it.
      console.error(
        `cold-spawn ${failures.length}/${records.length} mismatches:\n` +
          failures
            .map(
              (f) =>
                `  iter=${f.iteration} truth=${f.truth} detected=${f.detected} cwd=${f.cwd} pid=${f.pid}`,
            )
            .join('\n'),
      );
    }

    expect(
      matchRate,
      `match rate ${(matchRate * 100).toFixed(1)}% < ${MATCH_RATE_THRESHOLD * 100}%`,
    ).toBeGreaterThanOrEqual(MATCH_RATE_THRESHOLD);
    expect(
      p95,
      `p95 latency ${p95.toFixed(0)}ms >= ${P95_LATENCY_MS}ms`,
    ).toBeLessThan(P95_LATENCY_MS);
  },
  600_000,
);
