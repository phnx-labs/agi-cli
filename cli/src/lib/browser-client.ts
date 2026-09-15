/**
 * browser-client.ts — the ONE process client through which agents-cli talks to
 * the standalone `browser` CLI (@phnx-labs/browser-cli, PHNX-4101).
 *
 * This is the agents-owned half of the browser extraction, and it is
 * deliberately small. agents-cli no longer carries the CDP/BiDi/Arc drivers, a
 * browser IPC service, a chrome-data/profile store, a network-capture pipeline,
 * or the remote SSH driving loop — the standalone engine owns all of it, exactly
 * as `secrets` took the keychain engine (PHNX-3989), `computer` took the
 * accessibility engine (PHNX-4075) and `sessions` took the transcript engine
 * (PHNX-4012). What stays here is what only the fleet CLI can know: which device
 * a `--device` name resolves to, whether this machine consents to being driven,
 * who the acting session is, and where an action must be recorded.
 *
 * THERE IS NO FALLBACK. A missing executable throws `BROWSER_BIN_MISSING` with
 * install guidance (DIST-1) rather than silently driving a bundled engine —
 * agents-cli has none to drive, and a fallback would re-couple the two release
 * trains this extraction exists to separate.
 *
 * Transport — inherited-fd passthrough, not request/response (matches
 * browser-cli's `bin/browser.cjs` launcher, which forwards fds 3-16):
 *
 *   - stdio 0/1/2 are INHERITED. The engine owns the user's terminal: its
 *     stdout is the command's stdout, its `--json` is the command's `--json`,
 *     its prompts reach a real tty. agents-cli never re-formats engine output,
 *     which is what keeps the surface honest as the engine evolves.
 *   - fd 3 (`BROWSER_CONTEXT_FD`) carries ONE JSON object — the consumer context
 *     built by `lib/browser/context.ts` — written and closed immediately, so the
 *     engine reads to EOF and proceeds. The document is read once, before command
 *     parsing; a malformed one is a hard error, an absent one the standalone case.
 *   - fd 4 (`BROWSER_EVENTS_FD`) carries NDJSON action events back: one JSON
 *     object per line, each an action the engine actually performed. agents-cli
 *     turns those into feed events and `sessions --browser` history
 *     (`lib/browser/record.ts`). The engine may emit none; it must never block
 *     on this pipe.
 *
 * Both fds are anonymous pipes on the child's side, the same shape
 * `computer-client.ts` and `secrets-client.ts` settled on after a named FIFO
 * wedged macOS reads. The context is pushed rather than pulled so the engine
 * needs no callback into agents-cli — one direction each way, no reentrancy.
 */

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

/**
 * Accept only the real standalone `browser` executable, never agents-cli's own
 * `browser` command shim (`exec "$AGENTS_BIN" browser`, `installations/shims.ts`)
 * — resolving that would recurse into this process. `findInPath` already skips
 * `~/.agents/.cache/shims`; this guard is the second line, mirroring
 * `isStandaloneComputer` (agents-cli never shipped a `dist/browser.js` bin, but
 * the check stays symmetric and future-proof against one).
 */
export function isStandaloneBrowser(bin: string): boolean {
  let real = browserEntrypoint(bin);
  try { real = realpathSync(real); } catch { /* spawn reports missing explicit paths */ }
  return !/\.(cmd|ps1)$/i.test(real) && !real.endsWith(path.join('dist', 'browser.js'));
}

/**
 * Resolve the standalone executable. `BROWSER_BIN` wins so a dev build can be
 * driven without touching PATH.
 *
 * Resolution uses `findInPath`, which skips `~/.agents/.cache/shims` — see
 * `isStandaloneBrowser` for why that skip is load-bearing.
 */
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

/**
 * One action the engine performed, as it appears on the NDJSON events fd.
 *
 * This is the engine's wire shape (browser-cli integration contract §2), not a
 * translation of it: the engine emits `{event: "browser.action", ts, command,
 * invocationId, pid, task, profile, url, host, sessionId, launchId, actor}`.
 * `command` — not `verb` — is the field that names the action, and it is what
 * marks a line as an action event.
 */
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

/**
 * Split a growing buffer into complete NDJSON lines. Pure so the framing rules —
 * blank lines skipped, a non-JSON line dropped rather than crashing the CLI, a
 * trailing partial line carried forward — are unit-testable without a spawn.
 *
 * A malformed line is dropped, not thrown: these events are telemetry riding
 * alongside a user-visible action that already happened. Failing the command
 * because its receipt was unreadable would be strictly worse than losing the
 * receipt. The action itself already failed loud on its own channel if it failed.
 */
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
  /**
   * Capture the engine's stdout instead of inheriting the terminal.
   *
   * Used only where agents-cli must READ an answer rather than show it (the
   * setup readiness probe polling `status --json`). Verbs never capture:
   * re-printing engine output would make agents-cli a formatter for a surface
   * it no longer owns.
   */
  capture?: boolean;
}

interface RunBrowserResult {
  exitCode: number;
  /** Engine stdout, only when `capture` was set. */
  stdout: string;
}

/**
 * Run the standalone engine with the consumer context on fd 3 and the action
 * event stream on fd 4. Resolves with the engine's exit code; the caller
 * propagates it so `agents browser` exits exactly as the engine did.
 *
 * Throws `BROWSER_BIN_MISSING` when the standalone is not installed. Every other
 * failure is the engine's own, reported on the inherited stderr.
 */
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
