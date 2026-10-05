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
 * The engine's ENVIRONMENT is inherited verbatim — no overlay. Transport
 * selection (`COMPUTER_HELPER_TCP`, `COMPUTER_HELPER_VNC`,
 * `COMPUTER_HELPER_SOCKET`) is the engine's: it opens the `--device` tunnel and
 * hydrates its own endpoint AND the auth token that goes with it. Publishing a
 * bare endpoint from here would hand the daemon a connection it then rejects
 * with `auth_failed`.
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
import { realpathSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { findInPath } from './agent-spec/agents.js';

const INSTALL_HINT = 'npm i -g @phnx-labs/computer-cli';

export const COMPUTER_CONTEXT_FD = 3;
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
  try { real = realpathSync(real); } catch {  }
  return !/\.(cmd|ps1)$/i.test(real) && !real.endsWith(path.join('dist', 'computer.js'));
}

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

export function invocation(bin: string): { command: string; prefix: string[] } {
  if (/\.[mc]?js$/.test(bin)) return { command: process.execPath, prefix: [bin] };
  return { command: bin, prefix: [] };
}

export interface ComputerActionEvent {
  event?: string;
  command: string;
  invocationId?: string;
  pid?: number;
  targetPid?: number;
  bundle?: string;
  host?: string;
  task?: string;
  sessionId?: string;
  launchId?: string;
  actor?: string;
  [key: string]: unknown;
}

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
    }
  }
  return { events, rest };
}

interface RunComputerOptions {
  argv: string[];
  context: unknown;
  onEvent?: (event: ComputerActionEvent) => void;
  capture?: boolean;
}

interface RunComputerResult {
  exitCode: number;
  stdout: string;
}

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
      if (code == null) return resolve(signal ? 128 + (osSignalNumber(signal) ?? 0) : 1);
      resolve(code);
    });
  });

  await drained;
  return { exitCode, stdout };
}

function osSignalNumber(signal: NodeJS.Signals): number | undefined {
  const table: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGPIPE: 13, SIGTERM: 15,
  };
  return table[signal];
}

export function _resetComputerClientForTest(): void {
  cachedBin = undefined;
}
