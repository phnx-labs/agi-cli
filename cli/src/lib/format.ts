/** Shared terminal-formatting helpers, the single canonical home for utilities that were
 * copy-pasted across ~20 files and drifted (ellipsis style, long vs short relTime, a
 * `visibleWidth` regex missing its `\x1b` escape). */
import chalk from 'chalk';
import { readSync } from 'node:fs';
import { emitFriction } from './feed/events.js';

/** Options for {@link die} — opt into machine-readable failure output. */
interface DieOptions {
  /** Emits a machine-readable `{"error", "hint"?}` to stdout instead of red stderr text. Pass
   * `isJsonMode(options)` from a `--json` command so an agent gets a structured reason, not an
   * empty stream and a bare nonzero exit (RUSH-1830). */
  json?: boolean;
  /** Optional recovery hint — the command to run instead. Included in both modes. */
  hint?: string;
}

/** Renders a fatal error to the right stream. Pure (no I/O or exit) so the split is testable:
 * `--json` gets `{"error","hint"?}` on stdout, humans get red text plus a gray hint on stderr. */
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

/** Prints `msg` and exits with `code`: red stderr for humans, `{"error","hint"?}` on stdout for
 * `{ json: true }`. `die(msg)` and `die(msg, code)` keep the original behavior. */
export function die(msg: string, code = 1, opts: DieOptions = {}): never {
  const { stream, text } = formatDie(msg, opts);
  // Keep console.* (not process.std*.write): the suite spies on console.error /
  // console.log to capture command output, and fd-level writes bypass those spies.
  if (stream === 'stdout') console.log(text);
  else console.error(text);
  process.exit(code);
}

/** Awaits a command action and turns a thrown Error into `die(message)` instead of a stack dump
 * (bootstrap deliberately rethrows plain Errors as bugs). Helpers keep throwing so tests can
 * assert on them; pass `json` so `--json` callers still get the structured payload. */
export async function runOrDie(fn: () => void | Promise<void>, opts: DieOptions = {}): Promise<void> {
  try {
    await fn();
  } catch (err) {
    die(err instanceof Error ? err.message : String(err), 1, opts);
  }
}

/** `die()` with a structured friction event, for CLI error chokepoints so the nightly routine
 * can rank recurring failures without re-parsing transcripts. `surface` is the subsystem and
 * `failureId` a stable slug (e.g. 'remote-cwd-on-add'). */
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

/** Truncates `s` to at most `max` characters with a single-char `…`. Character-count based; use
 * `truncateToWidth` (`session/width.ts`) for colored strings. */
export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/** Formats an ISO timestamp as a compact relative age ("just now", "5m ago", "3h ago", "2d
 * ago"), the canonical short form. For the session-list long form with calendar fallback see
 * `formatRelativeTime` in `session/relative-time.ts`. */
export function relTime(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 10) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

/** Format a millisecond duration as "45s", "3m", "2h 5m", "1d 3h". */
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

/** Human-readable byte size; canonical home for a helper that was copy-pasted into five files. */
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

/** True when an error came from the user cancelling a prompt (Ctrl+C). Lives here so `lib/`
 * callers don't import upward into the command layer; `commands/utils.ts` re-exports it. */
export function isPromptCancelled(err: unknown): boolean {
  return err instanceof Error && (
    err.name === 'ExitPromptError' ||
    err.message.includes('force closed') ||
    err.message.includes('User force closed')
  );
}

/** True when stdin/stdout are attached to a real terminal. */
export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Parse a comma-separated CLI list, trimming whitespace and dropping empties. */
export function parseCommaSeparatedList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Visible column width of `s`, ignoring ANSI SGR codes; matches the full CSI sequence including
 * the `\x1b` escape. */
export function visibleWidth(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/** Pad `s` with trailing spaces to a target character width. */
export function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/** Pad `s` with trailing spaces to a target *visible* width (ANSI-aware). */
export function padVisible(s: string, width: number): string {
  const w = visibleWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

/** True when `--json` was passed. Piped stdout stays human-readable unless requested. */
export function isJsonMode(opts: { json?: boolean }): boolean {
  return Boolean(opts.json);
}

/** Read all of stdin synchronously and return it UTF-8 decoded and trimmed. */
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

/** Wraps `text` in an OSC 8 hyperlink to `filePath` (a `file://` URL) when stdout is a TTY;
 * otherwise returns `text` unchanged. */
export function termLink(text: string, filePath: string): string {
  if (!filePath || !process.stdout.isTTY) return text;
  const url = `file://${filePath}`;
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}
