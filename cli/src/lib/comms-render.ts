import chalk from 'chalk';
import { stringWidth, terminalWidth } from './session/width.js';

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
