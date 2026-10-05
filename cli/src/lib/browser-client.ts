/** The one process client to the standalone `browser` CLI (@phnx-labs/browser-cli, PHNX-4101). The
 * engine owns drivers, profiles and capture; this keeps device resolution, driving consent, acting
 * session and action recording. Missing executable: `BROWSER_BIN_MISSING` (DIST-1); no fallback. */

import { spawn } from 'node:child_process';
import { realpathSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { findInPath } from './agent-spec/agents.js';

const INSTALL_HINT = 'npm i -g @phnx-labs/browser-cli';

/** fd the engine reads its one-shot JSON context from. */
export const BROWSER_CONTEXT_FD = 3;
/** fd the engine writes NDJSON action events to. */
export const BROWSER_EVENTS_FD = 4;

export class BrowserClientError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'BrowserClientError';
  }
}

export function isBrowserClientError(err: unknown): err is BrowserClientError {
  return err instanceof BrowserClientError;
}

let cachedBin: string | undefined;

function browserEntrypoint(bin: string): string {
  if (!/\.(cmd|ps1)$/i.test(bin)) return bin;
  const launcher = path.join(path.dirname(bin), 'node_modules', '@phnx-labs', 'browser-cli', 'bin', 'browser.cjs');
  return existsSync(launcher) ? launcher : bin;
}

/** Accept only the real standalone `browser` executable, never agents-cli's own `browser` shim
 * (`exec "$AGENTS_BIN" browser`), which would recurse. `findInPath` already skips the shims dir;
 * this is the second line, symmetric with `isStandaloneComputer`. */
export function isStandaloneBrowser(bin: string): boolean {
  let real = browserEntrypoint(bin);
  try { real = realpathSync(real); } catch { /* spawn reports missing explicit paths */ }
  return !/\.(cmd|ps1)$/i.test(real) && !real.endsWith(path.join('dist', 'browser.js'));
}

/** Resolve the standalone executable; `BROWSER_BIN` wins for dev builds. Uses `findInPath`, which
 * skips `~/.agents/.cache/shims` (see isStandaloneBrowser). */
export function resolveBrowserBin(): string {
  if (cachedBin) return cachedBin;
  const explicit = process.env.BROWSER_BIN?.trim();
  const resolved = explicit && explicit.length > 0 ? (isStandaloneBrowser(explicit) ? explicit : null) : findInPath('browser', { accept: isStandaloneBrowser });
  if (!resolved) {
    throw new BrowserClientError(
      'BROWSER_BIN_MISSING',
      'The standalone `browser` CLI was not found. Install it with:\n' +
        `  ${INSTALL_HINT}\n` +
        'or run `agents setup browser` / `agents clis install browser`, or point $BROWSER_BIN at its executable.',
    );
  }
  cachedBin = browserEntrypoint(resolved);
  return cachedBin;
}

/** True when the standalone `browser` CLI is resolvable — the readiness signal
 * for `agents setup` without a spawn. Never throws. */
export function browserInstalled(): boolean {
  try {
    resolveBrowserBin();
    return true;
  } catch {
    return false;
  }
}

/** A `.js`/`.cjs`/`.mjs` bin is run through this runtime; a real executable is exec'd directly. */
export function invocation(bin: string): { command: string; prefix: string[] } {
  if (/\.[mc]?js$/.test(bin)) return { command: process.execPath, prefix: [bin] };
  return { command: bin, prefix: [] };
}

/** One action the engine performed on the NDJSON events fd: the engine's own wire shape
 * (browser-cli contract §2), `{event: "browser.action", ts, command, ...}`. `command`, not `verb`,
 * names the action and marks a line as an action event. */
export interface BrowserActionEvent {
  /** Always `browser.action` on this stream. */
  event?: string;
  /** ISO timestamp the engine stamped. */
  ts?: string;
  /** The verb the engine ran (`navigate`, `screenshot`, `click`, …). */
  command: string;
  /** The engine's own id for this run — the grouping key for a session row. */
  invocationId?: string;
  /** The engine process's pid. */
  pid?: number;
  /** The browser task the action targeted. */
  task?: string;
  /** The browser profile the task runs under. */
  profile?: string;
  /** The page URL at the time of the action, when the engine reported one. */
  url?: string;
  /** The driven device for a `--device` invocation; absent when local. */
  host?: string;
  /** Identity, echoed back from the context this CLI handed the engine. */
  sessionId?: string;
  launchId?: string;
  actor?: string;
  /** Free-form detail the engine attaches. */
  [key: string]: unknown;
}

/** Split a growing buffer into complete NDJSON lines. Pure: blank lines skipped, a trailing partial
 * line carried forward. Malformed lines are dropped, not thrown: they are telemetry for an action
 * that already happened, and failing the command over an unreadable receipt would be worse. */
export function parseEventLines(
  buffer: string,
): { events: BrowserActionEvent[]; rest: string } {
  const events: BrowserActionEvent[] = [];
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';
  for (const line of parts) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && typeof (parsed as BrowserActionEvent).command === 'string') {
        events.push(parsed as BrowserActionEvent);
      }
    } catch {
      // Unreadable receipt — see above.
    }
  }
  return { events, rest };
}

interface RunBrowserOptions {
  /** argv handed to the standalone, after the program name. */
  argv: string[];
  /** The consumer context serialized onto fd 3. */
  context: unknown;
  /** Called once per action event the engine reports on fd 4. */
  onEvent?: (event: BrowserActionEvent) => void;
  /** Capture the engine's stdout instead of inheriting the terminal, only where agents-cli must
   * read an answer (the setup readiness probe polling `status --json`). Verbs never capture, or
   * agents-cli would format output for a surface it no longer owns. */
  capture?: boolean;
}

interface RunBrowserResult {
  exitCode: number;
  /** Engine stdout, only when `capture` was set. */
  stdout: string;
}

/** Run the standalone engine with the consumer context on fd 3 and action events on fd 4. Resolves
 * with the engine's exit code so `agents browser` exits as the engine did. Throws
 * `BROWSER_BIN_MISSING` if not installed; other failures are the engine's, on inherited stderr. */
export async function runBrowser(opts: RunBrowserOptions): Promise<RunBrowserResult> {
  const bin = resolveBrowserBin();
  const { command, prefix } = invocation(bin);

  const child = spawn(command, [...prefix, ...opts.argv], {
    stdio: ['inherit', opts.capture ? 'pipe' : 'inherit', 'inherit', 'pipe', 'pipe'],
    env: {
      ...process.env,
      BROWSER_CONTEXT_FD: String(BROWSER_CONTEXT_FD),
      BROWSER_EVENTS_FD: String(BROWSER_EVENTS_FD),
    },
  });

  const contextPipe = child.stdio[BROWSER_CONTEXT_FD] as NodeJS.WritableStream | null;
  const eventsPipe = child.stdio[BROWSER_EVENTS_FD] as NodeJS.ReadableStream | null;

  if (contextPipe) {
    // An engine that exits before reading the context (bad argv, `--help`)
    // closes fd 3 and we get EPIPE. That is a normal race, not a failure.
    contextPipe.on('error', () => {});
    contextPipe.end(JSON.stringify(opts.context) + '\n');
  }

  let stdout = '';
  if (opts.capture && child.stdout) {
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
  }

  let pending = '';
  const drained = new Promise<void>((resolve) => {
    if (!eventsPipe) return resolve();
    eventsPipe.setEncoding('utf-8');
    eventsPipe.on('data', (chunk: string) => {
      const { events, rest } = parseEventLines(pending + chunk);
      pending = rest;
      for (const event of events) opts.onEvent?.(event);
    });
    eventsPipe.on('error', () => resolve());
    eventsPipe.on('end', () => {
      // A final line with no trailing newline still counts.
      const { events } = parseEventLines(pending.endsWith('\n') ? pending : pending + '\n');
      pending = '';
      for (const event of events) opts.onEvent?.(event);
      resolve();
    });
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on('error', (err) => {
      reject(new BrowserClientError('BROWSER_SPAWN_FAILED', `Could not run \`${bin}\`: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      // A signalled child has no exit code; report the conventional 128+n so
      // callers and shells see a non-zero status instead of a false success.
      if (code == null) return resolve(signal ? 128 + (osSignalNumber(signal) ?? 0) : 1);
      resolve(code);
    });
  });

  await drained;
  return { exitCode, stdout };
}

/** Signal name → number for the 128+n exit convention. Only the ones a tunnelled
 * or interrupted engine realistically dies on; anything else contributes 0 and
 * still yields a non-zero status. */
function osSignalNumber(signal: NodeJS.Signals): number | undefined {
  const table: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGPIPE: 13, SIGTERM: 15,
  };
  return table[signal];
}

/** Test seam: drop the memoized bin so PATH fixtures can re-resolve. */
export function _resetBrowserClientForTest(): void {
  cachedBin = undefined;
}
