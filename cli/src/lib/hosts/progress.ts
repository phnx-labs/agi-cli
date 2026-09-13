/**
 * Follow a dispatched host run by streaming its remote log.
 *
 * The run writes combined output to a log file on the host and its exit code to
 * a sibling `.exit` file. The primary path opens one long-lived
 * `ssh ... tail -f` stream (durable, offset-tracked — a dropped connection
 * reconnects from the saved offset) and finishes when the remote-side watcher
 * emits the exit sentinel. Rich transcript-parser rendering is a fast-follow.
 *
 * Efficiency: a healthy follow holds exactly one ssh process/socket for the
 * whole run instead of spawning once per poll cycle. If the connection drops,
 * the next stream resumes at the byte offset already flushed locally.
 */

import * as fs from 'fs';
import { sshExec, sshExecRaw, sshExecRawStream } from '../ssh-exec.js';
import { encodePowershell } from './remote-cmd.js';
import { localLogPath } from './tasks.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cap for the LOCAL mirror of a distributed teammate's remote log. `followHostTask`
 * appends remote bytes into the local mirror forever; a team can spin 10+ chatty
 * remote teammates, so the orchestrator must keep a bounded window (the full log
 * always lives on the host). The teams remote path (agents.ts readNewEvents) writes
 * its own append into each teammate's `stdout.log`, then truncates that file to its
 * trailing `REMOTE_MIRROR_MAX_BYTES` — the parser has already consumed the bytes
 * (status/digest updated via lastReadPos), so trailing-tail history is dead weight.
 */
export const REMOTE_MIRROR_MAX_BYTES = 512 * 1024;

/**
 * Pull the new bytes of a remote log since `offset` in ONE ssh round-trip.
 *
 * The teams remote-teammate monitor calls this each poll to advance its offset-tail
 * cursor into the host's log, mirroring only the delta into the local `stdout.log`
 * the stream-json parser consumes. Byte-exact (raw Buffer, no UTF-8 decode) so a
 * multibyte character split at the `tail -c` boundary neither drifts the offset nor
 * renders as U+FFFD — the same discipline `fetchProgress` uses. `bytes.length` is
 * the exact wire count; `newOffset` is `offset + bytes.length`.
 *
 * Returns null on a transient ssh failure (the caller retries next poll without
 * advancing). `remoteLog` is a $HOME-prefixed path with a safe basename; it's
 * shell-quoted defensively even so.
 */
export function pullRemoteLogDelta(
  target: string,
  opts: { remoteLog: string; offset: number; extraSshArgs?: string[] },
): { bytes: Buffer; newOffset: number } | null {
  // remoteLog is a dispatch-generated `$HOME/.agents/.cache/hosts/<hex>.log` path —
  // interpolate UNQUOTED so the remote shell expands `$HOME` (shellQuote would
  // single-quote it into a literal `$HOME`, and the tail would find nothing). The
  // hex basename is injection-safe, matching fetchProgress below.
  const remote = `tail -c +${opts.offset + 1} ${opts.remoteLog} 2>/dev/null`;
  const res = sshExecRaw(target, remote, { timeoutMs: 20000, multiplex: true, extraSshArgs: opts.extraSshArgs });
  if (res.code === null) return null; // ssh itself failed / timed out
  return { bytes: res.stdout, newOffset: opts.offset + res.stdout.length };
}

export interface FollowOptions {
  remoteLog: string;
  remoteExit: string;
  /** Mirror remote output into this task's local log too. */
  taskId: string;
  /** Print streamed output to stdout. */
  echo?: boolean;
  /** Overall wall-clock cap; returns -1 on timeout. */
  timeoutMs?: number;
  /** Fast poll interval while output is flowing (default 1500ms). */
  pollMs?: number;
  /** Idle-backoff ceiling (default 4× the fast interval, min 4000ms). */
  maxPollMs?: number;
  extraSshArgs?: string[];
  remoteShell?: 'posix' | 'powershell';
}

const STREAM_EXIT_POLL_SECONDS = 1;

/**
 * Build the per-task sentinel that separates the log tail from the exit-file
 * contents in one combined fetch. The task id (8 hex chars) makes collision with
 * the agent's own output effectively impossible; callers still split on the LAST
 * occurrence so a token echoed into the log can never be mistaken for the real
 * trailing marker.
 */
export function exitMarker(taskId: string): string {
  return `\n@@AGENTS_HOST_EXIT_${taskId}@@\n`;
}

/**
 * Split a combined fetch (`<log bytes><marker><exit>`) back into its parts at the
 * BYTE level. Splits on the LAST marker occurrence, so even if the agent's own
 * output happened to echo the token, the real trailing sentinel still wins.
 * Returns null when the marker is absent (a transient fetch miss — the remote
 * shell never ran our printf), telling the caller to retry without advancing.
 *
 * Byte-level (not string) is load-bearing: `logChunk.length` is the EXACT number
 * of log bytes consumed on the wire, which the follow loop adds to its offset. A
 * string split would first UTF-8-decode, turning any multibyte char split at the
 * `tail -c` boundary into a U+FFFD whose re-encoded length ≠ the wire bytes,
 * drifting the offset (see followHostTask). `consumed` is returned explicitly for
 * clarity; it always equals `logChunk.length`.
 */
export function splitProgressBytes(
  buf: Buffer,
  taskId: string,
): { logChunk: Buffer; exit: Buffer; consumed: number } | null {
  const marker = Buffer.from(exitMarker(taskId), 'utf8'); // ASCII-only, unambiguous
  const idx = buf.lastIndexOf(marker);
  if (idx === -1) return null;
  return {
    logChunk: buf.subarray(0, idx),
    exit: buf.subarray(idx + marker.length),
    consumed: idx,
  };
}

/**
 * One round-trip: new log bytes since `offset`, the sentinel, then the exit
 * file. Returns null on a transient fetch miss (ssh error / marker absent) so
 * the caller simply retries next cycle without advancing the offset.
 *
 * `remoteLog`/`remoteExit` are $HOME-prefixed paths with safe (hex) basenames —
 * intentionally unquoted so the remote shell expands $HOME.
 */
export function fetchProgress(
  target: string,
  opts: { remoteLog: string; remoteExit: string; taskId: string; offset: number; extraSshArgs?: string[]; remoteShell?: 'posix' | 'powershell' },
): { logChunk: Buffer; exit: string } | null {
  // Derive the printf format from the SAME exitMarker the parser splits on, so
  // the emitted sentinel and the one we look for can never desync. The marker's
  // only escape-sensitive bytes are its newlines (→ `\n`); it carries no `%`,
  // single-quote, or other printf/shell-special chars (task id is hex).
  const printfArg = exitMarker(opts.taskId).replace(/\n/g, '\\n');
  const remote = opts.remoteShell === 'powershell'
    ? buildWindowsProgressCommand(opts)
    : `tail -c +${opts.offset + 1} ${opts.remoteLog} 2>/dev/null; printf '${printfArg}'; cat ${opts.remoteExit} 2>/dev/null`;
  // Raw bytes (no UTF-8 decode): the log tail must be counted and re-emitted
  // byte-for-byte so a multibyte char split at the `tail -c` boundary neither
  // drifts the offset nor renders as U+FFFD. The exit code is pure ASCII → safe
  // to decode to a string for the caller's `.trim()`.
  const res = sshExecRaw(target, remote, { timeoutMs: 20000, extraSshArgs: opts.extraSshArgs });
  const parts = splitProgressBytes(res.stdout, opts.taskId);
  if (!parts) return null;
  return { logChunk: parts.logChunk, exit: parts.exit.toString('utf8') };
}

export function buildWindowsProgressCommand(opts: { remoteLog: string; remoteExit: string; taskId: string; offset: number }): string {
  const windowsPath = (value: string): string => value.startsWith('$HOME/')
    ? `(Join-Path $HOME '${value.slice('$HOME/'.length).replace(/'/g, "''")}')`
    : `'${value.replace(/'/g, "''")}'`;
  const markerBase64 = Buffer.from(exitMarker(opts.taskId), 'utf8').toString('base64');
  const script = [
    `$out = [Console]::OpenStandardOutput()`,
    `$log = ${windowsPath(opts.remoteLog)}`,
    `$exit = ${windowsPath(opts.remoteExit)}`,
    `if (Test-Path -LiteralPath $log) { $bytes = [IO.File]::ReadAllBytes($log); if ($bytes.Length -gt ${opts.offset}) { $out.Write($bytes, ${opts.offset}, $bytes.Length - ${opts.offset}) } }`,
    `$marker = [Convert]::FromBase64String('${markerBase64}')`,
    `$out.Write($marker, 0, $marker.Length)`,
    `if (Test-Path -LiteralPath $exit) { $bytes = [IO.File]::ReadAllBytes($exit); $out.Write($bytes, 0, $bytes.Length) }`,
  ].join('; ');
  return `powershell -NoProfile -EncodedCommand ${encodePowershell(script)}`;
}

/**
 * Remote shell for the persistent follow stream.
 *
 * Protocol: stream `tail -c +<offset+1> -f <log>` as raw stdout until `.exit`
 * becomes non-empty, give tail one more polling interval to flush final bytes,
 * stop it, then print the same per-task sentinel and `cat` the exit file on
 * stderr. Keeping the terminal frame off stdout lets log bytes pass through
 * live without buffering and without confusing agent output for our marker.
 * `remoteLog`/`remoteExit` are dispatch-generated `$HOME` paths with safe hex
 * basenames (or absolute paths in localhost integration tests), so they stay
 * unquoted to preserve `$HOME` expansion just like `fetchProgress`.
 */
export function buildStreamingFollowCommand(opts: {
  remoteLog: string;
  remoteExit: string;
  taskId: string;
  offset: number;
}): string {
  const printfArg = exitMarker(opts.taskId).replace(/\n/g, '\\n');
  return [
    'set +e',
    'tail_pid=',
    'cleanup() { if [ -n "$tail_pid" ]; then kill "$tail_pid" 2>/dev/null || true; wait "$tail_pid" 2>/dev/null || true; fi; }',
    'trap cleanup EXIT HUP INT TERM',
    `while [ ! -e ${opts.remoteLog} ] && [ ! -s ${opts.remoteExit} ]; do sleep ${STREAM_EXIT_POLL_SECONDS}; done`,
    `tail -c +${opts.offset + 1} -f ${opts.remoteLog} 2>/dev/null &`,
    'tail_pid=$!',
    `while [ ! -s ${opts.remoteExit} ]; do`,
    '  if ! kill -0 "$tail_pid" 2>/dev/null; then wait "$tail_pid" 2>/dev/null; exit 86; fi',
    `  sleep ${STREAM_EXIT_POLL_SECONDS}`,
    'done',
    `sleep ${STREAM_EXIT_POLL_SECONDS}`,
    'cleanup',
    'tail_pid=',
    `printf '${printfArg}' >&2`,
    `cat ${opts.remoteExit} >&2 2>/dev/null`,
  ].join('\n');
}

/** Extract the remote watcher frame from stderr, if the stream ended normally. */
export function parseStreamingExitFrame(stderr: Buffer, taskId: string): Buffer | null {
  const marker = Buffer.from(exitMarker(taskId), 'utf8');
  const idx = stderr.lastIndexOf(marker);
  if (idx === -1) return null;
  return stderr.subarray(idx + marker.length);
}

/**
 * File identity (`dev:ino`) of a path on the remote host, or null if it can't be
 * stat'd. GNU (`-c`) then BSD (`-f`) format, so it works on Linux and macOS hosts.
 */
function readRemoteFileId(target: string, remotePath: string, extraSshArgs?: string[]): string | null {
  const res = sshExec(
    target,
    `stat -c '%d:%i' ${remotePath} 2>/dev/null || stat -f '%d:%i' ${remotePath} 2>/dev/null`,
    { timeoutMs: 8000, extraSshArgs },
  );
  const id = res.stdout.trim();
  return id || null;
}

/**
 * True when the local mirror file IS the very file we're tailing — the
 * localhost-as-host case, where `remoteLog` ($HOME-expanded) and `localLogPath`
 * resolve to the same inode. Appending our read bytes back into it would feed the
 * tail and multiply the log, so the caller must skip the mirror write.
 */
export function mirrorAliasesSource(localId: string | null, remoteId: string | null): boolean {
  return localId !== null && remoteId !== null && localId === remoteId;
}

/** Tail the remote log to stdout until the run finishes; return its exit code. */
export async function followHostTask(target: string, opts: FollowOptions): Promise<number> {
  const fastMs = opts.pollMs ?? 1500;
  const maxMs = Math.max(opts.maxPollMs ?? fastMs * 4, 4000);
  const deadline = Date.now() + (opts.timeoutMs ?? 3600_000);
  const local = localLogPath(opts.taskId);
  let offset = 0;
  let waitMs = fastMs;

  // localhost-as-host guard: when the local mirror and the remote log are the
  // same physical file, appending our read bytes back would feed the tail and
  // multiply the log (a plain `--host localhost` follow otherwise tripled it).
  // Detect via file identity and echo-only in that case.
  let mirror = true;
  try {
    const s = fs.statSync(local);
    if (mirrorAliasesSource(`${s.dev}:${s.ino}`, readRemoteFileId(target, opts.remoteLog, opts.extraSshArgs))) {
      mirror = false;
    }
  } catch { /* mirror absent or unstattable → distinct file, keep mirroring */ }

  const flush = (logChunk: Buffer): boolean => {
    if (logChunk.length === 0) return false;
    if (opts.echo) process.stdout.write(logChunk);
    if (mirror) { try { fs.appendFileSync(local, logChunk); } catch { /* best-effort */ } }
    offset += logChunk.length; // exact wire bytes — no re-encode drift
    return true;
  };

  if (opts.remoteShell === 'powershell') {
    for (;;) {
      if (Date.now() >= deadline) return -1;
      const fetched = fetchProgress(target, { ...opts, offset, remoteShell: 'powershell' });
      if (fetched) {
        flush(fetched.logChunk);
        const code = parseInt(fetched.exit.trim(), 10);
        if (Number.isFinite(code)) return code;
      }
      await sleep(waitMs);
      waitMs = Math.min(maxMs, Math.round(waitMs * 1.5));
    }
  }

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      process.stderr.write('\n[hosts] follow timed out; the run continues on the host. Reattach with: agents logs ' + opts.taskId + ' -f\n');
      return -1;
    }

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), remaining);
    let gotOutput = false;
    let exitFrame: Buffer | null = null;
    try {
      const stream = await sshExecRawStream(
        target,
        buildStreamingFollowCommand({ remoteLog: opts.remoteLog, remoteExit: opts.remoteExit, taskId: opts.taskId, offset }),
        {
          timeoutMs: remaining,
          signal: abort.signal,
          multiplex: true,
          extraSshArgs: opts.extraSshArgs,
          onStdout: (chunk) => { gotOutput = flush(chunk) || gotOutput; },
        },
      );
      exitFrame = parseStreamingExitFrame(stream.stderr, opts.taskId);
    } finally {
      clearTimeout(timer);
    }

    if (exitFrame) {
      const code = parseInt(exitFrame.toString('utf8').trim(), 10);
      return Number.isFinite(code) ? code : 0;
    }

    // SSH dropped before the remote watcher emitted the exit sentinel. Stdout
    // chunks were flushed as they arrived, so reconnect from the advanced offset.
    // If no bytes arrived, back off like the old idle poll.
    if (Date.now() > deadline) {
      process.stderr.write('\n[hosts] follow timed out; the run continues on the host. Reattach with: agents logs ' + opts.taskId + ' -f\n');
      return -1;
    }

    // Reconnect quickly while output flows; ease toward maxMs when the stream
    // drops without bytes so a flapping idle host does not spin ssh processes.
    waitMs = gotOutput ? fastMs : Math.min(maxMs, Math.round(waitMs * 1.5));
    await sleep(waitMs);
  }
}
