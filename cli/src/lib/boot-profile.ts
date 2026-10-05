/** Boot-time profiler for the `agents run` pre-exec phase (PHNX-3585): version resolution,
 * rotation, config sync and login preflight. With `AGENTS_PROFILE_BOOT=1` the run path stamps
 * marks (ms since process start) and flushes a timeline to stderr before spawn. */
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

/** Record a named stage boundary. No-op unless `AGENTS_PROFILE_BOOT` is set, so it is free to call
 * on the launch path. */
export function bootMark(label: string): void {
  if (!ENABLED) return;
  marks.push({ label, at: performance.now() });
}

/** Print the collected timeline to stderr once, right before the harness child spawns and again as
 * a `process.on('exit')` backstop for paths that error before spawn. `reason` labels the final
 * boundary. */
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
