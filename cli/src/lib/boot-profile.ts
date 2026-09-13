/**
 * Boot-time profiler for the `agents run` pre-exec phase (PHNX-3585).
 *
 * The AGI EXT "New Claude" boot spends the whole `agents run` wrapper cost
 * BEFORE the harness prints anything — version resolution, account rotation,
 * config sync, login preflight. This module makes that window measurable
 * without a debugger: gate it on `AGENTS_PROFILE_BOOT=1` and the run path
 * stamps named marks, then flushes a per-stage timeline to stderr the instant
 * before the child is spawned (the moment the wrapper's work ends).
 *
 * All marks are `performance.now()` values, which Node measures from
 * `performance.timeOrigin` ≈ process start — so a mark's absolute value is
 * "ms since the `agents` process began", and consecutive marks give the cost
 * of each stage. When the env flag is off, every function here is a couple of
 * cheap branches and pushes nothing, so it is safe to leave wired on the hot
 * path (the committed `scripts/bench-boot.sh` benchmark drives it).
 */
import { performance } from 'node:perf_hooks';

const ENABLED =
  process.env.AGENTS_PROFILE_BOOT === '1' || process.env.AGENTS_PROFILE_BOOT === 'true';

interface BootMark {
  label: string;
  /** ms since process start (performance.timeOrigin). */
  at: number;
}

const marks: BootMark[] = [];
let flushed = false;

/**
 * Record a named stage boundary. No-op unless `AGENTS_PROFILE_BOOT` is set, so
 * this is free to call unconditionally on the launch path.
 */
export function bootMark(label: string): void {
  if (!ENABLED) return;
  marks.push({ label, at: performance.now() });
}

/**
 * Print the collected timeline to stderr, once. Called right before the harness
 * child is spawned (the end of the pre-exec window) and again as an
 * `process.on('exit')` backstop for launch paths that error out before spawn.
 * `reason` labels the final boundary (e.g. `spawn`, `exit`).
 */
export function flushBootProfile(reason: string): void {
  if (!ENABLED || flushed) return;
  flushed = true;
  bootMark(reason);
  if (marks.length === 0) return;

  const start = 0; // process start
  const end = marks[marks.length - 1].at;
  const width = Math.max(...marks.map((m) => m.label.length));
  const lines: string[] = [];
  lines.push(`[boot-profile] pre-exec timeline (total ${(end - start).toFixed(1)}ms since process start)`);
  let prev = start;
  for (const m of marks) {
    const delta = m.at - prev;
    prev = m.at;
    lines.push(
      `  ${m.label.padEnd(width)}  +${delta.toFixed(1).padStart(7)}ms   @${m.at.toFixed(1).padStart(8)}ms`,
    );
  }
  process.stderr.write(lines.join('\n') + '\n');
}

// Backstop: a run that exits before reaching the spawn (a login dead-end, a
// missing install) still emits whatever stages it reached, so the profile is
// never silently empty.
if (ENABLED) {
  process.on('exit', () => flushBootProfile('exit'));
}
