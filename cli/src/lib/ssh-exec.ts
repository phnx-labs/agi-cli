
import { spawn, spawnSync } from 'child_process';
import { StringDecoder } from 'string_decoder';
import * as fs from 'fs';
import * as path from 'path';
import { getCacheDir } from './state.js';

export const SSH_CONN_FAILURE_CODE = 255;

export const SSH_TARGET_RE = /^[a-zA-Z0-9._-]+(@[a-zA-Z0-9._-]+)?$/;

// Validate at the SSH argv sink so metacharacters and leading-option injection never reach ssh.
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

const SSH_KEEPALIVE_OPTS: readonly string[] = [
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=3',
];

export const SSH_OPTS: readonly string[] = [
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10',
  ...SSH_KEEPALIVE_OPTS,
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
export const MAX_CONTROL_PATH_BYTES = 86;

export function controlPathBytes(dir: string): number {
  return Buffer.byteLength(path.join(dir, 'cm-'.padEnd(43, '0')));
}

export function controlOpts(): string[] {
  if (process.platform === 'win32') return [];
  const dir = path.join(getCacheDir(), 'ssh');
  if (controlPathBytes(dir) > MAX_CONTROL_PATH_BYTES) return [];
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
    ...SSH_KEEPALIVE_OPTS,
  ];
}

export function sshConnectOpts(mux: string[], hostKeyOpts?: string[]): string[] {
  // Host-key overrides precede SSH_OPTS because OpenSSH uses the first value.
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

export function sshExecRawStream(
  target: string,
  remoteCmd: string,
  opts: SshExecRawStreamOptions,
): Promise<Omit<SshExecRawResult, 'stdout'>> {
  // Raw streaming preserves byte offsets across UTF-8 chunk boundaries.
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
  // Drain only after abnormal SSH termination; draining a clean exit destroys user typeahead.
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
  const mux = opts.multiplex === false || opts.tty ? [] : controlOpts();
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
