/** Shared SSH exec primitive: the single hardened choke point for running a command remotely over
 * system `ssh`. `agents run --device` and the browser driver share the connection hardening
 * (`BatchMode`, `accept-new`, `ConnectTimeout`) and the target-injection guard here. */

import { spawn, spawnSync } from 'child_process';
import { StringDecoder } from 'string_decoder';
import * as fs from 'fs';
import * as path from 'path';
import { getCacheDir } from './state.js';

/** SSH target: a bare ssh-config alias or `user@host`. A strict allowlist blocks shell
 * metacharacters, and `sshExec` also rejects a leading `-` so it cannot parse as an ssh flag. */
/** ssh's own connection-layer failure code (transport dropped or never up), distinct from the
 * remote command's exit status. Defined here and re-exported by `lib/hosts/reconnect.ts` as
 * `SSH_CONN_FAILURE` so there is one constant. */
export const SSH_CONN_FAILURE_CODE = 255;

export const SSH_TARGET_RE = /^[a-zA-Z0-9._-]+(@[a-zA-Z0-9._-]+)?$/;

export function assertValidSshTarget(host: string): void {
  if (host.startsWith('-') || !SSH_TARGET_RE.test(host)) {
    throw new Error(
      `Invalid SSH target ${JSON.stringify(host)}. Expected a host alias or user@host (letters, digits, '.', '_', '-').`,
    );
  }
}

/** POSIX single-quote a string for safe interpolation into a remote shell command. */
export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Hardened ssh options for every connection; the single baseline other callers compose from
 * (`[...SSH_OPTS, …]` when they need `-L`/`-N`/`ProxyCommand`). `ServerAlive*` keepalive makes a
 * silently dropped link exit within ~45s instead of leaving a zombie ssh. */
export const SSH_OPTS: readonly string[] = [
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=3',
];

/** Hard ceiling (16 MiB) on one peer's stdout before capture aborts: fan-outs buffer every peer in
 * parallel, so one runaway peer could exhaust the heap (RUSH-2065: ~170MB per `--active` gather).
 * An overflowing peer is treated as unreachable, not trusted with partial output. */
export const REMOTE_STDOUT_MAX_BYTES = 16 * 1024 * 1024;

/** Accumulate SSH stdout as UTF-8 without corrupting a multi-byte character split across chunks:
 * `StringDecoder` holds the trailing partial bytes until the next chunk, unlike a naive per-chunk
 * `toString()`. */
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

/** OpenSSH `ControlPersist` seconds for the multiplex master: 10 minutes keeps bursts of repeated
 * same-host touches warm (PHNX-2582). Do not widen: a reused master to a slept box costs a ~45s
 * ServerAlive teardown. usage-sync/auth-sync tick every 15 min, beyond this window on purpose. */
export const SSH_CONTROL_PERSIST_SECONDS = 10 * 60;

/** OpenSSH multiplexing, on by default: a control socket lets later connections (even other
 * `agents` runs) skip TCP+auth. `%C` keeps the path under macOS's 104-char `sun_path`. If the
 * socket fails, ssh connects normally, so it never makes a reachable host unreachable. */
let controlDirEnsured = false;
export function controlOpts(): string[] {
  // OpenSSH on Windows has no ControlMaster/ControlPath (unix-socket) support —
  // passing those options makes ssh error out. Multiplexing is a pure latency
  // optimisation, so on Windows we simply skip it and use a fresh connection.
  if (process.platform === 'win32') return [];
  const dir = path.join(getCacheDir(), 'ssh');
  if (!controlDirEnsured) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      /* best-effort — ssh degrades to a fresh connection if the dir is missing */
    }
    controlDirEnsured = true;
  }
  return [
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${path.join(dir, 'cm-%C')}`,
    '-o', `ControlPersist=${SSH_CONTROL_PERSIST_SECONDS}s`,
  ];
}

/** Compose an ssh connection-option prefix. Caller `hostKeyOpts` (e.g. pinned
 * `StrictHostKeyChecking=yes`) go first, before the `SSH_OPTS` baseline: ssh honors the first
 * value per option, so a later override would be ignored (RUSH-1767). */
export function sshConnectOpts(mux: string[], hostKeyOpts?: string[]): string[] {
  return [...(hostKeyOpts ?? []), ...SSH_OPTS, ...mux];
}

interface SshExecOptions {
  /** Piped to the remote command's stdin (never interpolated into the shell). */
  input?: string;
  /** Kill the ssh process after this many ms. */
  timeoutMs?: number;
  /** Extra ssh flags inserted before the target (e.g. `-tt`). */
  extraSshArgs?: string[];
  /** Reuse a persistent control socket across calls (default true; see `controlOpts`). */
  multiplex?: boolean;
  /** Host-key `-o` options overriding the accept-new baseline, prepended so ssh's first-value-wins
   * takes them. Forces strict verification against the managed known_hosts store on the
   * credential-copy path (RUSH-1767). */
  hostKeyOpts?: string[];
}

export interface SshExecResult {
  /** Remote exit status, or null if ssh itself failed / timed out. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Grace after a timed-out child receives SIGTERM before SIGKILL enforces the bound. */
export const SSH_TIMEOUT_KILL_GRACE_MS = 250;

/** Run `remoteCmd` on `target` over ssh and capture stdout/stderr/exit. It is a single argv parsed
 * by the remote login shell; callers building it from user input must `shellQuote` the pieces. */
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
  // Node's spawnSync with a `timeout` option kills the child via SIGTERM and sets
  // res.signal (e.g. 'SIGTERM') — it does NOT set res.error.code = 'ETIMEDOUT'.
  // Check both so the detection fires whether the timeout is signalled or errored.
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

/** Async variant of sshExec (same hardened argv, via spawn) so fan-outs probe hosts concurrently.
 * A timeout-bearing call forces `multiplex: false`: a control master outlives the local client, so
 * killing ssh on timeout would leave the remote command running (RUSH-2114). */
export function sshExecAsync(target: string, remoteCmd: string, opts: SshExecOptions = {}): Promise<SshExecResult> {
  assertValidSshTarget(target);
  // Control-master connections defeat local timeouts — the master keeps the
  // remote command alive after we kill the client. Force a fresh connection
  // whenever the caller asked for a timeout so the timeout actually stops work.
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
          // SIGTERM is advisory: a wedged ssh can ignore it and hold the Promise (and daemon tick)
          // open forever, so enforce a short hard-kill bound. Timeout calls disable ControlMaster,
          // so killing this direct client tears down the remote connection too.
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

    // Guard the stdin pipe: if the child closes stdin early, end()/write emits EPIPE, and with no
    // listener Node raises an uncaught exception that kills the CLI. Swallow it; the real outcome
    // is reported by the 'close'/'error' handlers.
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

/** Like sshExec but returns raw stdout/stderr Buffers with no UTF-8 decode, for byte-exact uses
 * such as offset-tracked log tailing, where a split multibyte character must not become U+FFFD and
 * desync the byte offset. */
export function sshExecRaw(target: string, remoteCmd: string, opts: SshExecOptions = {}): SshExecRawResult {
  assertValidSshTarget(target);
  const mux = opts.multiplex === false ? [] : controlOpts();
  const args = [...sshConnectOpts(mux, opts.hostKeyOpts), ...(opts.extraSshArgs ?? []), target, remoteCmd];
  const res = spawnSync('ssh', args, {
    input: opts.input,
    // No `encoding` → spawnSync returns Buffers.
    timeout: opts.timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  // Same fix as sshExec: spawnSync sets res.signal, not error.code = 'ETIMEDOUT'.
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

/** Stream raw stdout from a long-lived remote command over ssh. Unlike sshStream it does not
 * inherit local stdio: callers get byte-exact chunks, so offset-resumed log following keeps its
 * byte cursor. */
/** Grace between SIGTERM and SIGKILL for a stream that will not stop. */
export const SSH_STREAM_KILL_GRACE_MS = 3_000;
/** Bytes of a stream's stderr retained; the rest is dropped, with a note. */
export const SSH_STREAM_MAX_STDERR = 8 * 1024;

export interface SshStreamResult {
  code: number | null;
  stderr: Buffer;
  timedOut: boolean;
  /** True when the child had to be SIGKILLed after ignoring SIGTERM. */
  killed: boolean;
  /** True when stderr was truncated at {@link SSH_STREAM_MAX_STDERR}. */
  stderrTruncated: boolean;
}

/** Stream one ssh command's stdout with caller-built args/env (from `buildSshInvocation`, carrying
 * canonical auth sshExecRawStream cannot). Adds: SIGTERM then SIGKILL after a grace (ssh ignores
 * SIGTERM mid-handshake), capped stderr, and `onStdout` throws re-thrown to the awaiting caller. */
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
      // Own process group on POSIX so a kill reaches the whole tree: a descendant holding stdout
      // keeps the pipe open, 'close' never fires, and the promise hangs as long as the grandchild
      // lives, defeating the timeout.
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

    /** Signal the whole group where the platform supports it, else just the child. */
    const signal = (sig: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch { /* already gone */ }
    };
    const escalate = () => {
      signal('SIGTERM');
      // Escalation, not a second polite ask: a child still alive after the grace
      // is one that is not going to honour SIGTERM.
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
        // Captured, not thrown: a throw here would surface as an unhandled error
        // on the stream and skip the caller's cleanup entirely.
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

/** True if `target` is reachable over ssh (a passwordless `true` succeeds quickly). */
export function sshReachable(target: string, timeoutMs = 10000): boolean {
  return sshExec(target, 'true', { timeoutMs, multiplex: true }).code === 0;
}

interface SshStreamOptions {
  /** Allocate a remote pseudo-terminal (`ssh -tt`) so an interactive remote command renders live.
   * Pass it when the local process is a TTY; piped or scripted callers leave it off and forward a
   * non-interactive invocation. */
  tty?: boolean;
  /** Reuse a persistent control socket across calls (default true; see `controlOpts`). */
  multiplex?: boolean;
  /** Host-key `-o` options overriding the accept-new baseline, prepended so ssh's first-value-wins
   * takes them (see sshConnectOpts). Forces strict verification against the managed known_hosts on
   * the credential-copy path (RUSH-1767). */
  hostKeyOpts?: string[];
  /** Additional OpenSSH argv placed before the target (for example `-i <path>`). */
  extraSshArgs?: string[];
}

/** DEC private modes a full-screen remote app enables and normally disables on exit. A TUI killed
 * by a dropped link leaves them armed locally: focus reporting (1004) and 996/997 reports make the
 * terminal answer back at the shell (`^[[?997;1n ^[[I ^[[O`, RUSH-3125). */
export const TERMINAL_MODE_RESET =
  '\x1b[?1004l\x1b[?996l\x1b[?997l\x1b[?2004l\x1b[?1049l'
  + '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?25h';

/** Restore the local terminal after a hard ssh death: termios (raw mode from `-tt`, restored
 * exactly from the `stty -g` snapshot) and DEC private modes (TERMINAL_MODE_RESET). Then drain
 * queued answerback bytes, which the next attach would hand to the agent as typing. */
export function restoreLocalTerminal(saved: string | undefined, opts: { drainStdin: boolean }): void {
  try {
    if (saved) spawnSync('stty', [saved], { stdio: ['inherit', 'ignore', 'ignore'] });
  } catch { /* no stty, or stdin is not a tty — nothing to restore */ }
  try {
    if (process.stdout.isTTY) process.stdout.write(TERMINAL_MODE_RESET);
  } catch { /* stream closed */ }
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode?.(false);
  } catch { /* stdin not controllable in this context */ }
  // The DRAIN is the one destructive step here, so it is opt-in per exit. See
  // {@link sshStream} for why it must not run on a clean exit.
  if (!opts.drainStdin) return;
  try {
    // read() on a paused non-flowing stdin returns the buffered bytes and
    // discards them; the loop clears a burst rather than one chunk.
    if (process.stdin.isTTY) {
      while (process.stdin.read() !== null) { /* discard */ }
    }
  } catch { /* stdin not readable in this context */ }
}

/** `stty -g` snapshot of the local tty, or undefined when there is nothing to snapshot. */
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

/** Foreground counterpart to `sshExec`: inherits stdio and returns the exit code (255 = ssh link
 * failure). On a tty, terminal state is restored here for every caller (RUSH-3125). The stdin
 * drain runs only on ABNORMAL exit (signal or 255): on a clean exit it would eat real type-ahead. */
export function sshStream(target: string, remoteCmd: string, opts: SshStreamOptions = {}): number {
  assertValidSshTarget(target);
  const mux = opts.multiplex === false ? [] : controlOpts();
  const tty = opts.tty ? ['-tt'] : [];
  const args = [...sshConnectOpts(mux, opts.hostKeyOpts), ...(opts.extraSshArgs ?? []), ...tty, target, remoteCmd];
  const saved = opts.tty ? saveLocalTerminal() : undefined;
  let abnormal = true; // a throw before/inside the spawn is abnormal by definition
  try {
    const res = spawnSync('ssh', args, { stdio: 'inherit' });
    const code = typeof res.status === 'number' ? res.status : 255;
    // Killed by a signal (no numeric status) or ssh's own connection-layer
    // failure — the two shapes in which the remote TUI never got to reset the
    // terminal. Any other code is ssh exiting normally with the remote's status.
    abnormal = res.status === null || code === SSH_CONN_FAILURE_CODE;
    return code;
  } finally {
    // `finally`, because the abnormal exits are precisely the ones that leave
    // the terminal wrecked — but the drain within it is gated (see the doc).
    if (opts.tty) restoreLocalTerminal(saved, { drainStdin: abnormal });
  }
}
