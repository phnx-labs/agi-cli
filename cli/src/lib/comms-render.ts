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

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
