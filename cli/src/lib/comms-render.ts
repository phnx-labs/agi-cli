import chalk from 'chalk';
import { stringWidth, terminalWidth } from './session/width.js';
import type { CommsMsg } from './mailbox.js';

export type { CommsMsg } from './mailbox.js';

export const GLYPH = {
  live: '●',
  idle: '○',
  ask: '▲',
  delivered: '✓',
  pending: '⏳',
  route: '→',
  stream: '─→',
  thread: '⇄',
} as const;

type Accent = 'cyan' | 'amber';

/** Render the shared one-line comms header, with `right` aligned to the terminal edge. */
export function masthead(o: {
  title: string;
  host: string;
  accent: Accent;
  right?: string;
  stats?: string[];
}): string {
  const accent = o.accent === 'cyan' ? chalk.cyan : chalk.yellow;
  const title = `${accent('⌁')} ${chalk.bold(accent(o.title))}`;
  const host = chalk.dim(` · ${o.host}`);
  const stats = o.stats?.length ? `   ${o.stats.join(chalk.dim(' · '))}` : '';
  const left = `${title}${host}${stats}`;
  if (!o.right) return left;

  const right = chalk.dim(o.right);
  const gap = Math.max(1, terminalWidth() - stringWidth(left) - stringWidth(right));
  return `${left}${' '.repeat(gap)}${right}`;
}

const SPARK_LEVELS = '▁▂▃▄▅▆▇█';

/** Normalize non-negative counts across the eight Unicode sparkline levels. */
export function sparkline(counts: number[]): string {
  if (counts.length === 0) return ' ';
  const normalized = counts.map((count) => Number.isFinite(count) ? Math.max(0, count) : 0);
  const max = Math.max(...normalized);
  if (max === 0) return ' '.repeat(counts.length);
  return normalized
    .map((count) => SPARK_LEVELS[Math.round((count / max) * (SPARK_LEVELS.length - 1))])
    .join('');
}

/** Flatten mailbox histories into one newest-first communication stream. */
export function aggregate(boxes: {
  id: string;
  label: string;
  messages: import('./mailbox.js').StoredMessage[];
}[]): CommsMsg[] {
  return boxes
    .flatMap((box) => {
      const toLabel = box.label || box.id.slice(0, 8);
      return box.messages.map((message) => ({
        from: message.from || 'operator',
        to: message.to,
        toLabel,
        ts: message.ts,
        text: message.text,
        state: message.state,
        box: box.id,
      }));
    })
    .sort((a, b) => compareText(b.ts, a.ts));
}

const HOUR_MS = 60 * 60 * 1_000;

/** Count messages in rolling one-hour buckets, ordered oldest to newest. */
export function hourlyCounts(msgs: CommsMsg[], hours: number, now: Date = new Date()): number[] {
  const bucketCount = Number.isFinite(hours) ? Math.max(0, Math.floor(hours)) : 0;
  const counts = Array.from({ length: bucketCount }, () => 0);
  const nowMs = now.getTime();
  if (bucketCount === 0 || !Number.isFinite(nowMs)) return counts;

  for (const message of msgs) {
    const timestamp = Date.parse(message.ts);
    const age = nowMs - timestamp;
    if (!Number.isFinite(timestamp) || age < 0 || age >= bucketCount * HOUR_MS) continue;
    const bucket = bucketCount - 1 - Math.floor(age / HOUR_MS);
    counts[bucket]++;
  }
  return counts;
}

/** Aggregate the human-readable sender-to-recipient routes, busiest first. */
export function graphEdges(msgs: CommsMsg[]): { from: string; to: string; count: number }[] {
  const edges = new Map<string, { from: string; to: string; count: number }>();
  for (const message of msgs) {
    const key = JSON.stringify([message.from, message.toLabel]);
    const existing = edges.get(key);
    if (existing) existing.count++;
    else edges.set(key, { from: message.from, to: message.toLabel, count: 1 });
  }
  return [...edges.values()].sort((a, b) =>
    b.count - a.count || compareText(a.from, b.from) || compareText(a.to, b.to));
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
