/** The one process client through which agents-cli talks to the standalone `computer` CLI
 * (PHNX-4075). It keeps only what the fleet CLI knows: app permissions, `--device` resolution,
 * acting session. No fallback: a missing executable throws `COMPUTER_BIN_MISSING` (DIST-1). */

import { spawn } from 'node:child_process';
import { realpathSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { findInPath } from './agent-spec/agents.js';

const INSTALL_HINT = 'npm i -g @phnx-labs/computer-cli';

/** fd the engine reads its one-shot JSON context from. */
export const COMPUTER_CONTEXT_FD = 3;
/** fd the engine writes NDJSON action events to. */
export const COMPUTER_EVENTS_FD = 4;

export class ComputerClientError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ComputerClientError';
  }
}

export function isComputerClientError(err: unknown): err is ComputerClientError {
  return err instanceof ComputerClientError;
}

let cachedBin: string | undefined;

function computerEntrypoint(bin: string): string {
  if (!/\.(cmd|ps1)$/i.test(bin)) return bin;
  const launcher = path.join(path.dirname(bin), 'node_modules', '@phnx-labs', 'computer-cli', 'bin', 'computer.cjs');
  return existsSync(launcher) ? launcher : bin;
}

export function isStandaloneComputer(bin: string): boolean {
  let real = computerEntrypoint(bin);
  try { real = realpathSync(real); } catch { /* spawn reports missing explicit paths */ }
  return !/\.(cmd|ps1)$/i.test(real) && !real.endsWith(path.join('dist', 'computer.js'));
}

/** Resolve the standalone executable; `COMPUTER_BIN` wins for dev builds. `findInPath` skips
 * `~/.agents/.cache/shims` because a leftover `computer` alias shim execs `agents computer` and
 * would recurse (1.22.85 fork bomb, agi-cli#3532). */
export function resolveComputerBin(): string {
  if (cachedBin) return cachedBin;
  const explicit = process.env.COMPUTER_BIN?.trim();
  const resolved = explicit && explicit.length > 0 ? (isStandaloneComputer(explicit) ? explicit : null) : findInPath('computer', { accept: isStandaloneComputer });
  if (!resolved) {
    throw new ComputerClientError(
      'COMPUTER_BIN_MISSING',
      'The standalone `computer` CLI was not found. Install it with:\n' +
        `  ${INSTALL_HINT}\n` +
        'or point $COMPUTER_BIN at its executable.',
    );
  }
  cachedBin = computerEntrypoint(resolved);
  return cachedBin;
}

/** A `.js` bin is run through this runtime; a real executable is exec'd directly. */
export function invocation(bin: string): { command: string; prefix: string[] } {
  if (/\.[mc]?js$/.test(bin)) return { command: process.execPath, prefix: [bin] };
  return { command: bin, prefix: [] };
}

/** One action the engine performed, as on the NDJSON events fd. This is the engine's wire shape,
 * not a translation: `command` (not `verb`) names the action and marks a line as an action event. */
export interface ComputerActionEvent {
  /** Always `computer.action` on this stream. */
  event?: string;
  /** The verb the engine ran (`click`, `type`, `screenshot`, …). */
  command: string;
  /** The engine's own id for this run — the grouping key for a session row. */
  invocationId?: string;
  /** The engine process's pid. */
  pid?: number;
  /** pid of the app the action targeted, when the engine resolved one. */
  targetPid?: number;
  /** Bundle id / app identifier the action targeted. */
  bundle?: string;
  /** The driven device for a `--device` invocation; absent when local. */
  host?: string;
  /** `run --task` description, only on the task marker. */
  task?: string;
  /** Identity, echoed back from the context this CLI handed the engine. */
  sessionId?: string;
  launchId?: string;
  actor?: string;
  /** Free-form detail the engine attaches (coordinates, text length, …). */
  [key: string]: unknown;
}

/** Split a buffer into complete NDJSON lines: skip blank lines, drop a non-JSON line, carry a
 * trailing partial forward. A malformed line is dropped, not thrown: losing a receipt beats
 * failing a command whose action already happened. */
export function parseEventLines(
  buffer: string,
): { events: ComputerActionEvent[]; rest: string } {
  const events: ComputerActionEvent[] = [];
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';
  for (const line of parts) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && typeof (parsed as ComputerActionEvent).command === 'string') {
        events.push(parsed as ComputerActionEvent);
      }
    } catch {
      // Unreadable receipt — see above.
    }
  }
  return { events, rest };
}

interface RunComputerOptions {
  /** argv handed to the standalone, after the program name. */
  argv: string[];
  /** The consumer context serialized onto fd 3. */
  context: unknown;
  /** Called once per action event the engine reports on fd 4. */
  onEvent?: (event: ComputerActionEvent) => void;
  /** Capture the engine's stdout instead of inheriting the terminal. Only for where agents-cli must
   * read an answer (the `agents setup computer` wizard polling `status --json`); verbs never
   * capture. */
  capture?: boolean;
}

interface RunComputerResult {
  exitCode: number;
  /** Engine stdout, only when `capture` was set. */
  stdout: string;
}

/** Run the standalone engine with the consumer context on fd 3 and the action stream on fd 4;
 * resolves with its exit code so `agents computer` exits as it did. Throws `COMPUTER_BIN_MISSING`
 * if not installed. */
export async function runComputer(opts: RunComputerOptions): Promise<RunComputerResult> {
  const bin = resolveComputerBin();
  const { command, prefix } = invocation(bin);

  const child = spawn(command, [...prefix, ...opts.argv], {
    stdio: ['inherit', opts.capture ? 'pipe' : 'inherit', 'inherit', 'pipe', 'pipe'],
    env: {
      ...process.env,
      COMPUTER_CONTEXT_FD: String(COMPUTER_CONTEXT_FD),
      COMPUTER_EVENTS_FD: String(COMPUTER_EVENTS_FD),
    },
  });

  const contextPipe = child.stdio[COMPUTER_CONTEXT_FD] as NodeJS.WritableStream | null;
  const eventsPipe = child.stdio[COMPUTER_EVENTS_FD] as NodeJS.ReadableStream | null;

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
      reject(new ComputerClientError('COMPUTER_SPAWN_FAILED', `Could not run \`${bin}\`: ${err.message}`));
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
export function _resetComputerClientForTest(): void {
  cachedBin = undefined;
}
