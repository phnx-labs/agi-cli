/**
 * Shared SSH exec primitive — the single hardened choke point for running a
 * command on a remote host over the system `ssh`.
 *
 * `agents run --device` dispatch and the browser driver both go through here so the
 * connection hardening (`BatchMode`, `accept-new`, `ConnectTimeout`) and the
 * target-injection guard live in exactly one place. Target validation is the
 * canonical definition; `commands/secrets.ts` re-exports it.
 */

import { spawn, spawnSync } from 'child_process';
import { StringDecoder } from 'string_decoder';
import * as fs from 'fs';
import * as path from 'path';
import { getCacheDir } from './state.js';

/**
 * SSH target: a bare ssh-config host alias (e.g. `yosemite-s0`) or `user@host`.
 * The strict allowlist blocks shell metacharacters so a target can't be
 * smuggled in as part of a remote command, and `sshExec` additionally rejects a
 * leading `-` so it can never be parsed as an ssh argv flag.
 */
/**
 * ssh's own connection-layer failure code — the transport dropped or never came
 * up, as opposed to the remote command choosing an exit status. Defined here,
 * in the layer that owns the ssh invocation, and re-exported by
 * `lib/hosts/reconnect.ts` as `SSH_CONN_FAILURE` so there is one constant for
 * the concept rather than two that can drift apart.
 */
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

/**
 * Hardened ssh options applied to every connection — the single baseline every
 * `ssh` in the codebase composes from (directly here, or as `[...SSH_OPTS, …]`
 * in the few callers that need extra flags like `-L`/`-N`/`ProxyCommand`).
 *
 * `ServerAliveInterval`/`ServerAliveCountMax` add in-connection keepalive: a
 * silently-dropped link (laptop sleeps, Wi-Fi flips) is detected and the ssh
 * process exits within ~45s instead of hanging forever — so a followed run or a
 * long-lived `-N` tunnel can't leave a zombie ssh + socket pinned on the laptop.
 */
export const SSH_OPTS: readonly string[] = [
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=3',
];

/**
 * Hard ceiling on the stdout one peer may return before its capture is aborted.
 * A cross-machine fan-out streams every peer's `agents … --json` into memory in
 * parallel, so an unbounded buffer means one runaway peer (a corrupt or
 * pathologically large payload) can exhaust the caller's heap and take the whole
 * sweep down with it — RUSH-2065 observed ~170MB retained across a single
 * `--active` gather. 16 MiB is far above any legitimate JSON listing yet small
 * enough that N peers in flight stay bounded. A peer that overflows is treated as
 * unreachable rather than trusted with partial output.
 */
export const REMOTE_STDOUT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Accumulate SSH stdout as UTF-8 without corrupting a multi-byte code point that
 * a chunk boundary splits — the streaming `on('data')` callbacks hand us raw
 * `Buffer`s, and a naive `buf.toString()` per chunk mangles any character the
 * kernel cut in half. `StringDecoder` holds the trailing partial bytes until the
 * next chunk completes them.
 */
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

/**
 * How long OpenSSH keeps a multiplex master alive after its last client exits
 * (`ControlPersist`, in seconds).
 *
 * The master only survives while it stays IDLE under this window, so it helps
 * exactly a *repeated* touch of the same host that arrives within the window; a
 * touch that arrives after the master has expired pays the full cold TCP+auth
 * handshake again (~100-300ms direct, up to ~500ms relayed; measured on the live
 * fleet 2026-08-10, PHNX-2582).
 *
 * The repeated same-host touches are the ad-hoc `--device` and fleet fan-out
 * calls — `sessions --active`, `fleet ping`/`status`, `doctor`, `teams`, a
 * `--device <box>` command run a few times while working — which arrive in
 * BURSTS spread over minutes, not on a fixed clock. (The one truly high-frequency
 * caller, `followHostTask`'s ~1.5s follow poll, was already warm even at 60s and
 * is not the target here.) At the old 60s window any two touches of the same box
 * more than a minute apart were both cold, so a burst paid a fresh handshake
 * almost every time.
 *
 * 10 minutes keeps a multi-minute burst warm (3-5ms per reuse) while still
 * bounding how long an idle master lingers — an important limit, because a reused
 * master to a box that has since slept costs a ~45s ServerAlive teardown on the
 * first touch (`ServerAliveInterval=15 × ServerAliveCountMax=3`), and a wider
 * window would only widen the chance of hitting that. The daemon's periodic
 * SSH-touching services (`usage-sync`/`auth-sync`) tick every 15 minutes, longer
 * than this window ON PURPOSE: warming them would need a wider window for a
 * handshake that is negligible at that cadence. Fan-outs stay bounded regardless
 * by their own per-peer `timeoutMs`.
 */
export const SSH_CONTROL_PERSIST_SECONDS = 10 * 60;

/**
 * OpenSSH connection-multiplexing options. The first connection to a host opens
 * a control socket; subsequent connections (even from a *separate* `agents`
 * invocation) reuse it, skipping the TCP+auth handshake — so repeated
 * `--device <name>` calls to the same box feel local instead of paying ~100-300ms
 * each. `ControlPersist` keeps the master alive after the last client exits, sized
 * to span a multi-minute burst of repeated touches — see
 * {@link SSH_CONTROL_PERSIST_SECONDS} for the value and the rationale. `%C` (a
 * short fixed-length hash of local-host/remote/port/user) keeps the socket path
 * well under macOS's 104-char `sun_path` limit.
 *
 * This is **on by default** for every `sshExec`/`sshStream` call: the poll loops
 * (`followHostTask`), readiness probes, and per-host fan-outs are exactly the
 * high-frequency callers that benefit most from socket reuse, and they should
 * never have to remember to opt in. A caller passes `multiplex: false` only for
 * a genuine one-shot where a lingering master is pure overhead.
 *
 * The socket directory is created lazily; if ssh can't open the control socket
 * it falls back to a normal connection (multiplexing is an optimisation, never a
 * requirement), so this can never make a reachable host unreachable.
 */
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

/**
 * Compose an ssh connection-option prefix.
 *
 * `hostKeyOpts` (a caller's host-key posture, e.g. a pinned
 * `StrictHostKeyChecking=yes` + managed `UserKnownHostsFile`) go FIRST, ahead of
 * the `SSH_OPTS` baseline: ssh honors the *first* value it sees for each option,
 * so an override placed after the baseline's `accept-new` would be silently
 * ignored. Pure so the ordering contract is unit-testable. See RUSH-1767.
 */
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
  /**
   * Host-key `-o` options that OVERRIDE the accept-new baseline — prepended so
   * ssh's first-value-wins rule takes them (see {@link sshConnectOpts}). Used to
   * force strict verification against the managed known_hosts store on the
   * credential-copy path (RUSH-1767).
   */
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

/**
 * Run `remoteCmd` on `target` over ssh and capture stdout/stderr/exit.
 *
 * `remoteCmd` is passed as a single argv to ssh (the remote login shell parses
 * it); callers that build it from user input must `shellQuote` the pieces.
 */
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

/**
 * Async variant of {@link sshExec}. Same hardened argv composition, but uses
 * child_process.spawn so fleet fan-outs can probe multiple hosts concurrently.
 *
 * A timeout-bearing call uses a fresh ssh connection (`multiplex: false`) even
 * when the caller requests multiplexing: a control-master outlives the local
 * client, so killing the local ssh process on timeout would leave the remote
 * command running. With a direct connection, terminating the local child tears
 * down the remote side (RUSH-2114).
 */
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
          // SIGTERM is advisory. A wedged ssh process can ignore it and keep the
          // Promise (and daemon tick) open forever, so enforce a short hard-kill
          // bound. Timeout calls always disable ControlMaster above; killing this
          // direct client therefore tears down the remote connection too.
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

    // Guard the stdin pipe: if the child closes stdin early (e.g. exits fast), the
    // end()/write below emits EPIPE on the stream. With no listener Node escalates
    // that to an uncaught exception that kills the whole CLI. Swallow it — the real
    // outcome is still reported by the 'close'/'error' handlers below.
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

/**
 * Like {@link sshExec} but returns raw stdout/stderr Buffers — no UTF-8 decode.
 *
 * Use when byte-exactness matters, e.g. offset-tracked log tailing: a multibyte
 * character split across a read boundary must stay raw bytes, not collapse to a
 * U+FFFD replacement char (which would desync a byte offset from the wire).
 */
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

/**
 * Stream raw stdout from a long-lived remote command over ssh.
 *
 * Unlike {@link sshStream}, this does not inherit local stdio: callers receive
 * byte-exact stdout chunks and decide how to account for them. That matters for
 * offset-resumed log following where a UTF-8 decode boundary must not shift the
 * byte cursor.
 */
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
      // Own process group on POSIX so a kill reaches the whole tree. Killing only
      // the ssh pid is not enough: a descendant that inherited stdout keeps the
      // pipe open, `'close'` never fires, and the promise hangs for as long as
      // that grandchild lives — which defeats the timeout entirely.
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
  /**
   * Allocate a remote pseudo-terminal (`ssh -tt`) so an interactive remote
   * command (a picker, a prompt) renders live on the local terminal. Callers
   * pass this when the *local* process is itself a TTY; piped/scripted callers
   * leave it off and forward a non-interactive invocation instead.
   */
  tty?: boolean;
  /** Reuse a persistent control socket across calls (default true; see `controlOpts`). */
  multiplex?: boolean;
  /**
   * Host-key `-o` options that OVERRIDE the accept-new baseline — prepended so
   * ssh's first-value-wins rule takes them (see {@link sshConnectOpts}). Used to
   * force strict verification against the managed known_hosts store on the
   * interactive credential-copy path (RUSH-1767).
   */
  hostKeyOpts?: string[];
  /** Additional OpenSSH argv placed before the target (for example `-i <path>`). */
  extraSshArgs?: string[];
}

/**
 * The DEC private modes a full-screen remote app turns ON and, when it exits
 * cleanly, turns back off itself. A remote agent TUI killed by a dropped link
 * never gets to, so they stay enabled on the LOCAL terminal after ssh is gone:
 * focus reporting (1004) and the mode/colour-scheme reports (996/997) then make
 * the terminal emit answerback sequences at a shell that is not expecting them,
 * which is the `^[[?997;1n ^[[I ^[[O` litter seen after a drop (RUSH-3125). Also
 * resets bracketed paste (2004), the alternate screen (1049), mouse tracking
 * (1000/1002/1003/1006), and re-shows the cursor (25) — every one of which a TUI
 * leaves armed the same way.
 */
export const TERMINAL_MODE_RESET =
  '\x1b[?1004l\x1b[?996l\x1b[?997l\x1b[?2004l\x1b[?1049l'
  + '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?25h';

/**
 * Put the local terminal back the way ssh found it.
 *
 * Two independent kinds of state survive a hard ssh death, and BOTH have to be
 * undone or the next thing the user sees is corrupted:
 *
 *  - **termios** (kernel side): `-tt` puts the tty in raw mode, so a killed ssh
 *    leaves it with echo and line-editing off. `saved` is the `stty -g` snapshot
 *    taken before the spawn; restoring it is exact, unlike guessing at `sane`.
 *  - **DEC private modes** (terminal side): see {@link TERMINAL_MODE_RESET}.
 *
 * Then drain whatever the terminal already answered back into the input buffer.
 * Without the drain those bytes are not merely cosmetic — they are still queued
 * on the tty, so the NEXT attach hands them straight to the agent as if the user
 * had typed them.
 *
 * Best-effort by construction: this runs while recovering from a failure, so a
 * missing `stty`, a non-TTY stdin, or a closed stream must never turn a
 * recoverable drop into a thrown error.
 */
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

/**
 * Foreground counterpart to `sshExec`: run `remoteCmd` on `target` with the
 * local stdio wired straight through (`stdio: 'inherit'`), so output streams as
 * it is produced and — with `tty` — keystrokes reach a remote picker. Blocks
 * until the remote command exits and returns its exit code (255 is ssh's own
 * connection-layer failure; any other non-zero is the remote command's code).
 *
 * On a `tty` stream the local terminal state is snapshotted before the spawn and
 * restored after it. ssh restores termios itself when it exits cleanly, so this
 * is for the case that matters here: the link dying under a full-screen agent
 * TUI, which leaves the tty raw and the TUI's DEC modes armed. Doing it HERE
 * rather than in the reconnect loop means every caller that opens an interactive
 * remote stream is covered, not just the one that noticed (RUSH-3125).
 *
 * **The stdin drain is gated on an ABNORMAL exit, and the distinction is not
 * cosmetic.** Resetting termios and the DEC modes is idempotent — on a clean
 * exit ssh and the remote TUI have already done it, so re-doing it changes
 * nothing. Draining stdin is destructive: it discards whatever the user has
 * typed ahead. On a clean exit those bytes are legitimate type-ahead the
 * resuming shell should receive, and eating them would be a new bug in every
 * caller of this function (`runInteractiveOnHost`, the remote-tmux attach in
 * commands/go.ts, the remote secrets browse) rather than a fix. Only an
 * abnormal exit — ssh killed by a signal (`status === null`) or its own
 * connection-layer failure (255) — produces the answerback storm the drain
 * exists to clear, because only then did the TUI die without sending its own
 * mode resets.
 */
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
