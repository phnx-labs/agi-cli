/* Thin client for the standalone computer CLI: no bundled fallback or duplicate engine. */
/* stdio is inherited; fd3 sends one context object and fd4 receives NDJSON action events. */
/* Anonymous one-way pipes avoid credentials in endpoint metadata and named-FIFO deadlocks. */
/* Pass env unchanged: the engine owns the tunnel endpoint and matching auth; agents-cli must not publish a bare endpoint. */

import { spawn } from 'node:child_process';
import { realpathSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { findInPath } from './agent-spec/agents.js';
import { buildComputerContext } from './computer/context.js';

const INSTALL_HINT = 'npm i -g @phnx-labs/computer-cli';

export const COMPUTER_CONTEXT_FD = 3;

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

interface RunComputerResult {
  exitCode: number;
  stdout: string;
}

export async function forwardToComputer(opts: { argv: string[]; capture?: boolean }): Promise<RunComputerResult> {
  let bin: string;
  try {
    bin = resolveComputerBin();
  } catch (err) {
    if (isComputerClientError(err)) {
      console.error(err.message);
      return { exitCode: 1, stdout: '' };
    }
    throw err;
  }
  const { command, prefix } = invocation(bin);
  const context = await buildComputerContext({ computerBin: bin });

  const child = spawn(command, [...prefix, ...opts.argv], {
    stdio: ['inherit', opts.capture ? 'pipe' : 'inherit', 'inherit', 'pipe'],
    env: { ...process.env, COMPUTER_CONTEXT_FD: String(COMPUTER_CONTEXT_FD) },
  });

  const contextPipe = child.stdio[COMPUTER_CONTEXT_FD] as NodeJS.WritableStream | null;
  if (contextPipe) {
    contextPipe.on('error', () => {});
    contextPipe.end(JSON.stringify(context) + '\n');
  }

  let stdout = '';
  if (opts.capture && child.stdout) {
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
  }

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on('error', (err) => {
      reject(new ComputerClientError('COMPUTER_SPAWN_FAILED', `Could not run \`${bin}\`: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      if (code == null) return resolve(signal ? 128 + (osSignalNumber(signal) ?? 0) : 1);
      resolve(code);
    });
  });
  return { exitCode, stdout };
}

function osSignalNumber(signal: NodeJS.Signals): number | undefined {
  const table: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGPIPE: 13, SIGTERM: 15,
  };
  return table[signal];
}

export async function installComputerHelperMacLocal(): Promise<void> {
  const { exitCode } = await forwardToComputer({ argv: ['setup'] });
  if (exitCode !== 0) throw new Error(`\`computer setup\` failed (exit ${exitCode})`);
}

export async function activateComputerHelperMacLocal(): Promise<{ trusted: boolean }> {
  const { exitCode } = await forwardToComputer({ argv: ['start'] });
  if (exitCode !== 0) throw new Error(`\`computer start\` failed (exit ${exitCode})`);
  return { trusted: await probeComputerTrust() };
}

export function parseTrustFromStatusJson(stdout: string): boolean {
  const start = stdout.indexOf('{');
  if (start < 0) return false;
  try {
    const parsed = JSON.parse(stdout.slice(start)) as { trusted?: unknown };
    return parsed.trusted === true;
  } catch {
    return false;
  }
}

export async function probeComputerTrust(): Promise<boolean> {
  try {
    const { exitCode, stdout } = await forwardToComputer({ argv: ['status', '--json'], capture: true });
    if (exitCode !== 0) return false;
    return parseTrustFromStatusJson(stdout);
  } catch {
    return false;
  }
}

export function _resetComputerClientForTest(): void {
  cachedBin = undefined;
}
