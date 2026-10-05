
import { spawn, spawnSync } from 'child_process';
import { StringDecoder } from 'string_decoder';
import * as fs from 'fs';
import * as path from 'path';
import { getCacheDir } from './state.js';

export const SSH_CONN_FAILURE_CODE = 255;

export const SSH_TARGET_RE = /^[a-zA-Z0-9._-]+(@[a-zA-Z0-9._-]+)?$/;

export function assertValidSshTarget(host: string): void {
  if (host.startsWith('-') || !SSH_TARGET_RE.test(host)) {
    throw new Error(
      `Invalid SSH target ${JSON.stringify(host)}. Expected a host alias or user@host (letters, digits, '.', '_', '-').`,
    );
  }
}

export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export const SSH_OPTS: readonly string[] = [
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=3',
];

export const REMOTE_STDOUT_MAX_BYTES = 16 * 1024 * 1024;

export class RemoteUtf8Accumulator {
  private readonly decoder = new StringDecoder('utf8');
  private value = '';

  write(chunk: Buffer): void {
    this.value += this.decoder.write(chunk);
  }

  end(): string {
    this.value += this.decoder.end();
    return this.value;
  }

  current(): string {
    return this.value;
  }
}

export const SSH_CONTROL_PERSIST_SECONDS = 10 * 60;

let controlDirEnsured = false;
export function controlOpts(): string[] {
  if (process.platform === 'win32') return [];
  const dir = path.join(getCacheDir(), 'ssh');
  if (!controlDirEnsured) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
    }
    controlDirEnsured = true;
  }
  return [
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${path.join(dir, 'cm-%C')}`,
    '-o', `ControlPersist=${SSH_CONTROL_PERSIST_SECONDS}s`,
  ];
}

export function sshConnectOpts(mux: string[], hostKeyOpts?: string[]): string[] {
  return [...(hostKeyOpts ?? []), ...SSH_OPTS, ...mux];
}

interface SshExecOptions {
  input?: string;
  timeoutMs?: number;
  extraSshArgs?: string[];
  multiplex?: boolean;
  hostKeyOpts?: string[];
}

export interface SshExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export const SSH_TIMEOUT_KILL_GRACE_MS = 250;

export function sshExec(target: string, remoteCmd: string, opts: SshExecOptions = {}): SshExecResult {
  assertValidSshTarget(target);
  const mux = opts.multiplex === false ? [] : controlOpts();
  const args = [...sshConnectOpts(mux, opts.hostKeyOpts), ...(opts.extraSshArgs ?? []), target, remoteCmd];
  const res = spawnSync('ssh', args, {
    input: opts.input,
    encoding: 'utf-8',
    timeout: opts.timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const timedOut =
    !!(res.error && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') ||
    (!!opts.timeoutMs && res.signal !== null);
  return {
    code: typeof res.status === 'number' ? res.status : null,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    timedOut,
  };
}

export function sshExecAsync(target: string, remoteCmd: string, opts: SshExecOptions = {}): Promise<SshExecResult> {
  assertValidSshTarget(target);
  const mux = opts.multiplex === false || opts.timeoutMs ? [] : controlOpts();
  const args = [...sshConnectOpts(mux, opts.hostKeyOpts), ...(opts.extraSshArgs ?? []), target, remoteCmd];
  return new Promise((resolve) => {
    const child = spawn('ssh', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          killTimer = setTimeout(() => {
            if (!settled) child.kill('SIGKILL');
          }, SSH_TIMEOUT_KILL_GRACE_MS);
          killTimer.unref?.();
        }, opts.timeoutMs)
      : null;

    const clearTimers = (): void => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.stdin.on('error', () => {});
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({ code: null, stdout, stderr: stderr + err.message, timedOut });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

interface SshExecRawResult {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
}

export function sshExecRaw(target: string, remoteCmd: string, opts: SshExecOptions = {}): SshExecRawResult {
  assertValidSshTarget(target);
  const mux = opts.multiplex === false ? [] : controlOpts();
  const args = [...sshConnectOpts(mux, opts.hostKeyOpts), ...(opts.extraSshArgs ?? []), target, remoteCmd];
  const res = spawnSync('ssh', args, {
    input: opts.input,
    timeout: opts.timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const timedOut =
    !!(res.error && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') ||
    (!!opts.timeoutMs && res.signal !== null);
  return {
    code: typeof res.status === 'number' ? res.status : null,
    stdout: (res.stdout as Buffer | null) ?? Buffer.alloc(0),
    stderr: (res.stderr as Buffer | null) ?? Buffer.alloc(0),
    timedOut,
  };
}

interface SshExecRawStreamOptions extends SshExecOptions {
  onStdout: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
  signal?: AbortSignal;
}

export const SSH_STREAM_KILL_GRACE_MS = 3_000;
export const SSH_STREAM_MAX_STDERR = 8 * 1024;

export interface SshStreamResult {
  code: number | null;
  stderr: Buffer;
  timedOut: boolean;
  killed: boolean;
  stderrTruncated: boolean;
}

/**
 * Stream one ssh command's stdout, with the args and env a CALLER built.
 *
 * This exists because {@link sshExecRawStream} assembles its own ssh args, which
 * means it cannot carry a device's canonical auth — the askpass shim for a
 * password-auth box, `-i`/`IdentitiesOnly` for an explicit identity file, or the
 * managed known-hosts pinning. A caller that has already built those through
 * `buildSshInvocation` needs a way to run them, and duplicating the transport to
 * get it would be the worse answer. So this takes `args`/`env` verbatim and adds
 * only the lifecycle guarantees:
 *
 * - **SIGTERM then SIGKILL.** A timeout or abort that only sends SIGTERM leaks a
 *   child that ignores it — ssh does, mid-handshake — and the promise never
 *   settles. After {@link SSH_STREAM_KILL_GRACE_MS} the child is SIGKILLed and
 *   `killed` says so.
 * - **Bounded stderr.** A peer that writes endlessly to stderr would otherwise
 *   grow this buffer without limit; it is capped and `stderrTruncated` says so.
 * - **`onStdout` cannot break the caller's cleanup.** A throw from the consumer
 *   is captured and re-thrown by the awaiting caller, so a write failure ends the
 *   transfer instead of escaping as an unhandled error inside a stream event.
 */
export function sshStreamWithArgs(opts: {
  args: string[];
  env?: Record<string, string>;
  onStdout: (chunk: Buffer) => void;
  timeoutMs?: number;
  killGraceMs?: number;
  maxStderrBytes?: number;
  signal?: AbortSignal;
  sshBin?: string;
}): Promise<SshStreamResult> {
  const maxStderr = opts.maxStderrBytes ?? SSH_STREAM_MAX_STDERR;
  const grace = opts.killGraceMs ?? SSH_STREAM_KILL_GRACE_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(opts.sshBin ?? 'ssh', opts.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    let stderrTruncated = false;
    let timedOut = false;
    let killed = false;
    let consumerError: unknown;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const signal = (sig: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {  }
    };
    const escalate = () => {
      signal('SIGTERM');
      killTimer = setTimeout(() => { killed = true; signal('SIGKILL'); }, grace);
      killTimer.unref?.();
    };
    const stop = () => escalate();
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', stop);
      if (consumerError !== undefined) { reject(consumerError); return; }
      resolve({ code, stderr: Buffer.concat(stderr), timedOut, killed, stderrTruncated });
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => { timedOut = true; escalate(); }, opts.timeoutMs)
      : null;

    child.stdout.on('data', (chunk: Buffer) => {
      if (consumerError !== undefined) return;
      try { opts.onStdout(chunk); } catch (error) {
        consumerError = error;
        escalate();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const room = maxStderr - stderrBytes;
      if (room <= 0) { stderrTruncated = true; return; }
      if (chunk.length > room) { stderrTruncated = true; stderr.push(chunk.subarray(0, room)); stderrBytes = maxStderr; return; }
      stderr.push(chunk);
      stderrBytes += chunk.length;
    });
    child.once('error', () => finish(null));
    child.once('close', finish);
    if (opts.signal?.aborted) escalate();
    else opts.signal?.addEventListener('abort', stop, { once: true });
  });
}

export function sshExecRawStream(
  target: string,
  remoteCmd: string,
  opts: SshExecRawStreamOptions,
): Promise<Omit<SshExecRawResult, 'stdout'>> {
  assertValidSshTarget(target);
  const mux = opts.multiplex === false ? [] : controlOpts();
  const args = [...sshConnectOpts(mux, opts.hostKeyOpts), ...(opts.extraSshArgs ?? []), target, remoteCmd];
  return new Promise((resolve) => {
    const child = spawn('ssh', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stderr: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let aborted = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
      resolve({ code, stderr: Buffer.concat(stderr), timedOut });
    };
    const abort = () => {
      aborted = true;
      child.kill('SIGTERM');
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
        }, opts.timeoutMs)
      : null;

    child.stdout.on('data', (chunk: Buffer) => { opts.onStdout(chunk); });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
      opts.onStderr?.(chunk);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input ?? '');
    opts.signal?.addEventListener('abort', abort, { once: true });

    child.on('error', (err) => {
      stderr.push(Buffer.from(err.message));
      finish(null);
    });
    child.on('close', (code) => {
      finish(aborted ? null : code);
    });
  });
}

export function sshReachable(target: string, timeoutMs = 10000): boolean {
  return sshExec(target, 'true', { timeoutMs, multiplex: true }).code === 0;
}

interface SshStreamOptions {
  tty?: boolean;
  multiplex?: boolean;
  hostKeyOpts?: string[];
  extraSshArgs?: string[];
}

export const TERMINAL_MODE_RESET =
  '\x1b[?1004l\x1b[?996l\x1b[?997l\x1b[?2004l\x1b[?1049l'
  + '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?25h';

export function restoreLocalTerminal(saved: string | undefined, opts: { drainStdin: boolean }): void {
  try {
    if (saved) spawnSync('stty', [saved], { stdio: ['inherit', 'ignore', 'ignore'] });
  } catch {  }
  try {
    if (process.stdout.isTTY) process.stdout.write(TERMINAL_MODE_RESET);
  } catch {  }
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode?.(false);
  } catch {  }
  if (!opts.drainStdin) return;
  try {
    if (process.stdin.isTTY) {
      while (process.stdin.read() !== null) {  }
    }
  } catch {  }
}

export function saveLocalTerminal(): string | undefined {
  if (!process.stdin.isTTY) return undefined;
  try {
    const r = spawnSync('stty', ['-g'], { stdio: ['inherit', 'pipe', 'ignore'], encoding: 'utf-8' });
    const out = r.status === 0 ? r.stdout?.trim() : '';
    return out || undefined;
  } catch {
    return undefined;
  }
}

export function sshStream(target: string, remoteCmd: string, opts: SshStreamOptions = {}): number {
  assertValidSshTarget(target);
  const mux = opts.multiplex === false ? [] : controlOpts();
  const tty = opts.tty ? ['-tt'] : [];
  const args = [...sshConnectOpts(mux, opts.hostKeyOpts), ...(opts.extraSshArgs ?? []), ...tty, target, remoteCmd];
  const saved = opts.tty ? saveLocalTerminal() : undefined;
  let abnormal = true;
  try {
    const res = spawnSync('ssh', args, { stdio: 'inherit' });
    const code = typeof res.status === 'number' ? res.status : 255;
    abnormal = res.status === null || code === SSH_CONN_FAILURE_CODE;
    return code;
  } finally {
    if (opts.tty) restoreLocalTerminal(saved, { drainStdin: abnormal });
  }
}
