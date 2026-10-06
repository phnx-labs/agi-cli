/* Thin client for the standalone computer CLI: no bundled fallback or duplicate engine. */
/* stdio is inherited; fd3 sends one context object and fd4 receives NDJSON action events. */
/* Anonymous one-way pipes avoid credentials in endpoint metadata and named-FIFO deadlocks. */
/* Pass env unchanged: the engine owns the tunnel endpoint and matching auth; agents-cli must not publish a bare endpoint. */

import { spawn } from 'node:child_process';
import { realpathSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { findInPath } from './agent-spec/agents.js';
import { buildComputerContext, type ComputerTargetContext } from './computer/context.js';
import { recordComputerAction } from './computer/record.js';
import { resolveRemoteDevice } from './ssh-tunnel.js';
import { getConfigValue } from './device-config.js';
import { parseAddress, sshTarget } from './address.js';

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

export function withHostFlag(argv: string[], host?: string): string[] {
  if (!host) return argv;
  if (argv.some((arg) => arg === '--host' || arg.startsWith('--host='))) return argv;
  const [verb, ...rest] = argv;
  return [verb, '--host', host, ...rest];
}

export async function resolveDeviceHost(device: string): Promise<{ host: string; target: ComputerTargetContext }> {
  const configured = getConfigValue('computer.host', { device }).value as string | undefined;
  if (configured) {
    const addr = parseAddress(configured);
    if (addr.scheme === 'vnc' || addr.scheme === 'tcp') {
      return { host: configured, target: { alias: device, host: addr.host, user: addr.user ?? '', hostname: addr.host, platform: addr.scheme, sshArgs: [] } };
    }
    const resolved = await resolveRemoteDevice(device, {});
    const target = sshTarget(addr);
    return {
      host: configured,
      target: { alias: device, host: target, user: addr.user ?? resolved.user, hostname: addr.host, platform: resolved.device.platform, sshArgs: resolved.identityArgs },
    };
  }
  const resolved = await resolveRemoteDevice(device, {
    expectPlatform: 'windows',
    forWhat: '`agents computer --device` drives the Windows computer-helper daemon, so it',
  });
  return {
    host: `ssh://${resolved.target}`,
    target: { alias: device, host: resolved.target, user: resolved.user, hostname: resolved.host, platform: resolved.device.platform, sshArgs: resolved.identityArgs },
  };
}

export interface ForwardToComputerOptions {
  argv: string[];
  device?: string;
  record?: boolean;
  capture?: boolean;
}

export async function forwardToComputer(opts: ForwardToComputerOptions): Promise<RunComputerResult> {
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

  const hostFlag = opts.argv.findIndex(arg => arg === '--host' || arg.startsWith('--host='));
  let host = hostFlag < 0 ? undefined : (opts.argv[hostFlag].includes('=') ? opts.argv[hostFlag].slice(7) : opts.argv[hostFlag + 1]);
  let target: ComputerTargetContext | undefined;
  if (!host && opts.device) {
    const resolved = await resolveDeviceHost(opts.device);
    host = resolved.host;
    target = resolved.target;
  }
  const context = await buildComputerContext({ device: opts.device, host, target, computerBin: bin });

  return runComputer({
    argv: withHostFlag(opts.argv, host),
    context,
    capture: opts.capture,
    onEvent: opts.record === false
      ? undefined
      : (event) => recordComputerAction(event, { device: opts.device }),
  });
}

export async function installComputerHelperMacLocal(): Promise<void> {
  const { exitCode } = await forwardToComputer({ argv: ['setup'], record: false });
  if (exitCode !== 0) throw new Error(`\`computer setup\` failed (exit ${exitCode})`);
}

export async function activateComputerHelperMacLocal(): Promise<{ trusted: boolean }> {
  const { exitCode } = await forwardToComputer({ argv: ['start'], record: false });
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
    const { exitCode, stdout } = await forwardToComputer({
      argv: ['status', '--json'],
      record: false,
      capture: true,
    });
    if (exitCode !== 0) return false;
    return parseTrustFromStatusJson(stdout);
  } catch {
    return false;
  }
}

export function _resetComputerClientForTest(): void {
  cachedBin = undefined;
}
