/**
 * computer-client.ts — the ONE process client through which agents-cli talks to
 * the standalone `computer` CLI (PHNX-4075).
 *
 * This is the agents-owned half of the computer extraction, and it is
 * deliberately small. agents-cli no longer carries a helper daemon, an RPC
 * transport, an element cache, an RFB client, or an autonomous loop — the
 * standalone engine owns all of it, exactly as `secrets` took the keychain
 * engine (PHNX-3989) and `sessions` took the transcript engine (PHNX-4012).
 * What stays here is what only the fleet CLI can know: which apps the
 * permissions layer allows, which device a `--device` name resolves to, who the
 * acting session is, and where an action must be recorded.
 *
 * THERE IS NO FALLBACK. A missing executable throws `COMPUTER_BIN_MISSING` with
 * install guidance (DIST-1) rather than silently driving a bundled engine —
 * agents-cli has none to drive, and a fallback would re-couple the two release
 * trains this extraction exists to separate.
 *
 * Transport — inherited-fd passthrough, not request/response:
 *
 *   - stdio 0/1/2 are INHERITED. The engine owns the user's terminal: its
 *     stdout is the command's stdout, its `--json` is the command's `--json`,
 *     its prompts reach a real tty. agents-cli never re-formats engine output,
 *     which is what keeps the surface honest as the engine evolves.
 *   - fd 3 (`COMPUTER_CONTEXT_FD`) carries ONE JSON object — the consumer
 *     context built by `lib/computer/context.ts` — written and closed
 *     immediately, so the engine reads to EOF and proceeds.
 *   - fd 4 (`COMPUTER_EVENTS_FD`) carries NDJSON action events back: one JSON
 *     object per line, each an action the engine actually performed. agents-cli
 *     turns those into feed events and `sessions --computer` history
 *     (`lib/computer/record.ts`). The engine may emit none; it must never block
 *     on this pipe.
 *
 * Both fds are anonymous pipes on the child's side, the same shape
 * `secrets-client.ts` settled on after a named FIFO wedged macOS reads. The
 * context is pushed rather than pulled so the engine needs no callback into
 * agents-cli — one direction each way, no reentrancy.
 */

import { spawn } from 'node:child_process';
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

/**
 * Resolve the standalone executable. `COMPUTER_BIN` wins so a dev build can be
 * driven without touching PATH.
 *
 * Resolution uses `findInPath`, which skips `~/.agents/.cache/shims`. That skip
 * is load-bearing here for the same reason it is in `sessions-client.ts`: a
 * leftover `computer` alias shim execs `agents computer`, and resolving it would
 * recurse into this process (the 1.22.85 secrets fork bomb, agi-cli#3532).
 */
export function resolveComputerBin(): string {
  if (cachedBin) return cachedBin;
  const explicit = process.env.COMPUTER_BIN?.trim();
  const resolved = explicit && explicit.length > 0 ? explicit : findInPath('computer');
  if (!resolved) {
    throw new ComputerClientError(
      'COMPUTER_BIN_MISSING',
      'The standalone `computer` CLI was not found. Install it with:\n' +
        `  ${INSTALL_HINT}\n` +
        'or point $COMPUTER_BIN at its executable.',
    );
  }
  cachedBin = resolved;
  return resolved;
}

/** A `.js` bin is run through this runtime; a real executable is exec'd directly. */
export function invocation(bin: string): { command: string; prefix: string[] } {
  if (/\.[mc]?js$/.test(bin)) return { command: process.execPath, prefix: [bin] };
  return { command: bin, prefix: [] };
}

/** One action the engine performed, as it appears on the NDJSON events fd. */
export interface ComputerActionEvent {
  /** The verb the engine ran (`click`, `type`, `screenshot`, …). */
  verb: string;
  /** pid of the app the action targeted, when the engine resolved one. */
  targetPid?: number;
  /** Bundle id / app identifier the action targeted. */
  bundle?: string;
  /** Device name for a `--device` invocation. */
  device?: string;
  /** Free-form detail the engine attaches (task preview, coordinates, …). */
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
): { events: ComputerActionEvent[]; rest: string } {
  const events: ComputerActionEvent[] = [];
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';
  for (const line of parts) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && typeof (parsed as ComputerActionEvent).verb === 'string') {
        events.push(parsed as ComputerActionEvent);
      }
    } catch {
      // Unreadable receipt — see above.
    }
  }
  return { events, rest };
}

export interface RunComputerOptions {
  /** argv handed to the standalone, after the program name. */
  argv: string[];
  /** The consumer context serialized onto fd 3. */
  context: unknown;
  /** Called once per action event the engine reports on fd 4. */
  onEvent?: (event: ComputerActionEvent) => void;
  /** Extra environment overlay (never used to smuggle context — fd 3 is the channel). */
  env?: NodeJS.ProcessEnv;
  /**
   * Capture the engine's stdout instead of inheriting the terminal.
   *
   * Used only where agents-cli must READ an answer rather than show it — the
   * `agents setup computer` wizard polling `status --json` for trust. Verbs
   * never capture: re-printing engine output would make agents-cli a formatter
   * for a surface it no longer owns.
   */
  capture?: boolean;
}

export interface RunComputerResult {
  exitCode: number;
  /** Engine stdout, only when `capture` was set. */
  stdout: string;
}

/**
 * Run the standalone engine with the consumer context on fd 3 and the action
 * event stream on fd 4. Resolves with the engine's exit code; the caller
 * propagates it so `agents computer` exits exactly as the engine did.
 *
 * Throws `COMPUTER_BIN_MISSING` when the standalone is not installed. Every
 * other failure is the engine's own, reported on the inherited stderr.
 */
export async function runComputer(opts: RunComputerOptions): Promise<RunComputerResult> {
  const bin = resolveComputerBin();
  const { command, prefix } = invocation(bin);

  const child = spawn(command, [...prefix, ...opts.argv], {
    stdio: ['inherit', opts.capture ? 'pipe' : 'inherit', 'inherit', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...opts.env,
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

export const COMPUTER_INSTALL_HINT = INSTALL_HINT;
