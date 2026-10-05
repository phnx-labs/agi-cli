import chalk from 'chalk';
import { readSync } from 'node:fs';
import { emitFriction } from './feed/events.js';

interface DieOptions {
  json?: boolean;
  hint?: string;
}

export function formatDie(
  msg: string,
  opts: DieOptions = {},
): { stream: 'stdout' | 'stderr'; text: string } {
  if (opts.json) {
    const payload: { error: string; hint?: string } = { error: msg };
    if (opts.hint) payload.hint = opts.hint;
    return { stream: 'stdout', text: JSON.stringify(payload) };
  }
  const lines = [chalk.red(msg)];
  if (opts.hint) lines.push(chalk.gray(opts.hint));
  return { stream: 'stderr', text: lines.join('\n') };
}

export function die(msg: string, code = 1, opts: DieOptions = {}): never {
  const { stream, text } = formatDie(msg, opts);
  if (stream === 'stdout') console.log(text);
  else console.error(text);
  process.exit(code);
}

export async function runOrDie(fn: () => void | Promise<void>, opts: DieOptions = {}): Promise<void> {
  try {
    await fn();
  } catch (err) {
    die(err instanceof Error ? err.message : String(err), 1, opts);
  }
}

export function dieFriction(
  surface: string,
  failureId: string,
  msg: string,
  code = 1,
  opts: DieOptions = {},
): never {
  emitFriction(surface, failureId, { error: msg });
  die(msg, code, opts);
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

export function relTime(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 10) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export function humanDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return mm ? `${h}h ${mm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh ? `${d}d ${hh}h` : `${d}d`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = n / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}

export function isPromptCancelled(err: unknown): boolean {
  return err instanceof Error && (
    err.name === 'ExitPromptError' ||
    err.message.includes('force closed') ||
    err.message.includes('User force closed')
  );
}

export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function parseCommaSeparatedList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function visibleWidth(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

export function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

export function padVisible(s: string, width: number): string {
  const w = visibleWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

export function isJsonMode(opts: { json?: boolean }): boolean {
  return Boolean(opts.json);
}

export function readStdinSync(): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(65536);
  while (true) {
    let bytesRead: number;
    try {
      bytesRead = readSync(0, buf, 0, buf.length, null);
    } catch {
      break;
    }
    if (bytesRead === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks).toString('utf-8').trim();
}

export function termLink(text: string, filePath: string): string {
  if (!filePath || !process.stdout.isTTY) return text;
  const url = `file://${filePath}`;
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}
