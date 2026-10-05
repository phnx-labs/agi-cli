import { afterAll, expect, test } from 'vitest';
import { spawnAndDetect, killAndCleanup } from '../harness.js';
import { ScenarioRecorder, percentile, sleep } from '../lib/scenario-record.js';

// The bug that motivated this whole package: a dead agent's stale state file
// outliving it and shadowing the NEW agent that replaces it in the same cwd.
// Each iteration spawns A, kills it, spawns B in the same directory, and
// asserts the tracker now reports B's session — not A's ghost.
const ITERATIONS = 20;
const MATCH_RATE_THRESHOLD = 0.99;
const P95_LATENCY_MS = 1000;

const recorder = new ScenarioRecorder('kill-restart', 'claude');

afterAll(async () => {
  await recorder.flush();
});

test(
  `kill-restart: ${ITERATIONS} same-cwd restarts pick the new session`,
  async () => {
    let freshCarryOver = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      const a = await spawnAndDetect({ agent: 'claude' });
      const cwd = a.cwd;
      const aSession = a.detected.sessionId;
      await killAndCleanup(a);
      await sleep(500);

      // Reuse the SAME cwd so a stale A entry could shadow B if dedup is wrong.
      const b = await spawnAndDetect({ agent: 'claude', cwd });
      try {
        const newSessionWon =
          b.matched &&
          !!b.detected.sessionId &&
          b.detected.sessionId !== aSession;
        if (b.detected.sessionId && b.detected.sessionId === aSession) {
          // Tracker handed back A's id for B — the exact stale-entry bug.
          freshCarryOver++;
        }
        recorder.add({
          iteration: i,
          truth: b.truthSessionId,
          detected: b.detected.sessionId,
          matched: newSessionWon,
          latencyMs: b.detected.latencyMs,
          method: b.detected.method,
          cwd: b.cwd,
          pid: b.proc.pid,
        });
      } finally {
        await killAndCleanup(b);
      }
      await sleep(200);
    }

    const records = recorder.all;
    const matched = records.filter((r) => r.matched).length;
    const matchRate = matched / records.length;
    const p95 = percentile(records.map((r) => r.latencyMs), 95);

    const failures = records.filter((r) => !r.matched);
    if (failures.length > 0) {
      console.error(
        `kill-restart ${failures.length}/${records.length} mismatches ` +
          `(${freshCarryOver} were stale-A-shadowing-B):\n` +
          failures
            .map(
              (f) =>
                `  iter=${f.iteration} truthB=${f.truth} detected=${f.detected} cwd=${f.cwd} pid=${f.pid}`,
            )
            .join('\n'),
      );
    }

    expect(
      freshCarryOver,
      `${freshCarryOver} restarts returned the dead session's id (stale-entry bug)`,
    ).toBe(0);
    expect(
      matchRate,
      `match rate ${(matchRate * 100).toFixed(1)}% < ${MATCH_RATE_THRESHOLD * 100}%`,
    ).toBeGreaterThanOrEqual(MATCH_RATE_THRESHOLD);
    expect(p95, `p95 latency ${p95.toFixed(0)}ms >= ${P95_LATENCY_MS}ms`).toBeLessThan(
      P95_LATENCY_MS,
    );
  },
  600_000,
);
