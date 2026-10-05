/** Follow a dispatched host run by streaming its remote log over one long-lived `ssh ... tail
 * -f`, resuming from the saved byte offset after a drop, until the remote watcher emits the
 * exit sentinel (log and `.exit` files on the host). */

import * as fs from 'fs';
import { sshExec, sshExecRaw, sshExecRawStream } from '../ssh-exec.js';
import { encodePowershell } from './remote-cmd.js';
import { localLogPath } from './tasks.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Cap for the local mirror of a distributed teammate's remote log: 10+ chatty teammates would
 * grow it forever, and the full log stays on the host. agents.ts readNewEvents truncates to the
 * trailing bytes after the parser has consumed them. */
export const REMOTE_MIRROR_MAX_BYTES = 512 * 1024;
// Consumers cap distributed local mirrors at this tail window; the complete log remains remote.

/** Pull the new bytes of a remote log since `offset` in one ssh round-trip for the teams
 * monitor. Byte-exact (raw Buffer) so a multibyte char split at the `tail -c` boundary can't
 * drift the offset. Null on a transient ssh failure; the caller retries without advancing. */
export function pullRemoteLogDelta(
  target: string,
  opts: { remoteLog: string; offset: number; extraSshArgs?: string[] },
): { bytes: Buffer; newOffset: number } | null {
  // remoteLog is a dispatch-generated `$HOME/...<hex>.log` path, interpolated unquoted so the
  // remote shell expands `$HOME` (shellQuote would make it literal); the hex basename is injection-
  // safe.
  const remote = `tail -c +${opts.offset + 1} ${opts.remoteLog} 2>/dev/null`;
  const res = sshExecRaw(target, remote, { timeoutMs: 20000, multiplex: true, extraSshArgs: opts.extraSshArgs });
  if (res.code === null) return null;
  return { bytes: res.stdout, newOffset: opts.offset + res.stdout.length };
}

export interface FollowOptions {
  remoteLog: string;
  remoteExit: string;
  taskId: string;
  echo?: boolean;
  timeoutMs?: number;
  pollMs?: number;
  maxPollMs?: number;
  extraSshArgs?: string[];
  remoteShell?: 'posix' | 'powershell';
}

const STREAM_EXIT_POLL_SECONDS = 1;

/** Per-task sentinel separating the log tail from the exit-file contents in one fetch. The 8-hex
 * task id makes collision unlikely, and callers split on the last occurrence so an echoed token
 * is never mistaken for it. */
export function exitMarker(taskId: string): string {
  return `\n@@AGENTS_HOST_EXIT_${taskId}@@\n`;
}

/** Split a combined fetch (`<log bytes><marker><exit>`) at the byte level on the last marker;
 * null when absent (retry, no advance). Byte-level is load-bearing: a UTF-8 decode would turn a
 * split multibyte char into U+FFFD and drift the offset (see followHostTask). */
export function splitProgressBytes(
  buf: Buffer,
  taskId: string,
): { logChunk: Buffer; exit: Buffer; consumed: number } | null {
  const marker = Buffer.from(exitMarker(taskId), 'utf8');
  // The last task-specific marker separates arbitrary log bytes from terminal state.
  const idx = buf.lastIndexOf(marker);
  if (idx === -1) return null;
  return {
    logChunk: buf.subarray(0, idx),
    exit: buf.subarray(idx + marker.length),
    consumed: idx,
  };
}

/** One round-trip: new log bytes since `offset`, the sentinel, then the exit file; null on a
 * transient miss so the caller retries. `remoteLog`/`remoteExit` are $HOME-prefixed hex-
 * basename paths, left unquoted so the remote shell expands $HOME. */
export function fetchProgress(
  target: string,
  opts: { remoteLog: string; remoteExit: string; taskId: string; offset: number; extraSshArgs?: string[]; remoteShell?: 'posix' | 'powershell' },
): { logChunk: Buffer; exit: string } | null {
  // Derive the printf format from the same exitMarker the parser splits on so they cannot desync;
  // only its newlines need escaping.
  const printfArg = exitMarker(opts.taskId).replace(/\n/g, '\\n');
  const remote = opts.remoteShell === 'powershell'
    ? buildWindowsProgressCommand(opts)
    : `tail -c +${opts.offset + 1} ${opts.remoteLog} 2>/dev/null; printf '${printfArg}'; cat ${opts.remoteExit} 2>/dev/null`;
  // Raw bytes (no UTF-8 decode) so the log tail is counted and re-emitted byte-for-byte; the ASCII
  // exit code is safe to decode.
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

/** Remote shell for the persistent follow stream: `tail -c +<offset+1> -f <log>` until `.exit`
 * is non-empty, one more poll to flush, then the sentinel and `cat` of the exit file on stderr,
 * keeping the frame off stdout. Paths stay unquoted for `$HOME` expansion. */
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

export function parseStreamingExitFrame(stderr: Buffer, taskId: string): Buffer | null {
  const marker = Buffer.from(exitMarker(taskId), 'utf8');
  const idx = stderr.lastIndexOf(marker);
  if (idx === -1) return null;
  return stderr.subarray(idx + marker.length);
}

/** File identity (`dev:ino`) of a remote path, or null if it can't be stat'd; GNU `-c` then BSD
 * `-f`, so Linux and macOS both work. */
function readRemoteFileId(target: string, remotePath: string, extraSshArgs?: string[]): string | null {
  const res = sshExec(
    target,
    `stat -c '%d:%i' ${remotePath} 2>/dev/null || stat -f '%d:%i' ${remotePath} 2>/dev/null`,
    { timeoutMs: 8000, extraSshArgs },
  );
  const id = res.stdout.trim();
  return id || null;
}

/** True when the local mirror is the very file being tailed (localhost-as-host, same inode);
 * appending would feed the tail, so the caller must skip the mirror write. */
export function mirrorAliasesSource(localId: string | null, remoteId: string | null): boolean {
  return localId !== null && remoteId !== null && localId === remoteId;
}

export async function followHostTask(target: string, opts: FollowOptions): Promise<number> {
  const fastMs = opts.pollMs ?? 1500;
  const maxMs = Math.max(opts.maxPollMs ?? fastMs * 4, 4000);
  const deadline = Date.now() + (opts.timeoutMs ?? 3600_000);
  const local = localLogPath(opts.taskId);
  let offset = 0;
  let waitMs = fastMs;

  // localhost-as-host guard: if the mirror and the remote log are the same file, appending read
  // bytes feeds the tail and multiplies the log (a plain `--host localhost` follow tripled it);
  // detect by file identity and echo only.
  let mirror = true;
  try {
    const s = fs.statSync(local);
    if (mirrorAliasesSource(`${s.dev}:${s.ino}`, readRemoteFileId(target, opts.remoteLog, opts.extraSshArgs))) {
      mirror = false;
    }
  } catch {  }

  const flush = (logChunk: Buffer): boolean => {
    if (logChunk.length === 0) return false;
    if (opts.echo) process.stdout.write(logChunk);
    if (mirror) { try { fs.appendFileSync(local, logChunk); } catch {  } }
    offset += logChunk.length;
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

    if (Date.now() > deadline) {
      process.stderr.write('\n[hosts] follow timed out; the run continues on the host. Reattach with: agents logs ' + opts.taskId + ' -f\n');
      return -1;
    }

    waitMs = gotOutput ? fastMs : Math.min(maxMs, Math.round(waitMs * 1.5));
    await sleep(waitMs);
  }
}
