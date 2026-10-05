import { performance } from 'node:perf_hooks';

const ENABLED =
  process.env.AGENTS_PROFILE_BOOT === '1' || process.env.AGENTS_PROFILE_BOOT === 'true';

interface BootMark {
  label: string;
  at: number;
}

const marks: BootMark[] = [];
let flushed = false;

export function bootMark(label: string): void {
  if (!ENABLED) return;
  marks.push({ label, at: performance.now() });
}

export function flushBootProfile(reason: string): void {
  if (!ENABLED || flushed) return;
  flushed = true;
  bootMark(reason);
  if (marks.length === 0) return;

  const start = 0;
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

if (ENABLED) {
  process.on('exit', () => flushBootProfile('exit'));
}
