/**
 * Shared host-task log viewer — the show-or-follow core behind the
 * top-level `agents logs <id>`.
 *
 * A running task with follow re-enters the offset-tail (`followHostTask`).
 * Otherwise the view is **concise by default**: a bounded tail of the captured
 * combined-stdout, so an agent glancing at a dispatched run never pulls the whole
 * log. `full` opts into the entire raw log. (A host run's real transcript lives
 * on the remote, not the local index — surfacing its rich summary needs remote
 * runs to be discoverable there first; until then the bounded tail is the safe
 * concise default.) Kept in one place so the two commands can never drift.
 */

import * as fs from 'fs';
import chalk from 'chalk';
import { loadTask, localLogPath, updateTask, terminalPatch, type HostTask } from './tasks.js';
import { followHostTask } from './progress.js';
import { reconcileTask } from './reconcile.js';
import { sshExecRaw } from '../ssh-exec.js';
import { encodePowershell } from './remote-cmd.js';

interface HostLogResult {
  /** False when no host task with this id exists (caller may fall through to sessions). */
  found: boolean;
  /** Process exit code to adopt when the task was shown/followed. */
  exitCode?: number;
}

/** Lines of raw combined-stdout to show in the concise (non-`full`) view. */
const HOST_LOG_TAIL_LINES = 40;

/**
 * Show (or follow, when running) a dispatched host task. Bounded-tail summary by
 * default; `full` dumps the entire raw combined-stdout log.
 */
export async function showHostTaskLog(id: string, follow: boolean, full = false): Promise<HostLogResult> {
  const task = loadTask(id);
  if (!task) return { found: false };

  if (follow && task.status === 'running') {
    const code = await followHostTask(task.target, {
      remoteLog: task.remoteLog,
      remoteExit: task.remoteExit,
      taskId: id,
      echo: true,
      remoteShell: task.remoteShell,
      extraSshArgs: task.identityFile ? ['-i', task.identityFile, '-o', 'IdentitiesOnly=yes'] : [],
    });
    // -1 = follow window closed; the run continues on the host (not a failure,
    // so exit 0). Any real code is the finished run — persist the terminal
    // status the killed dispatch follower would have written.
    if (code === -1) return { found: true, exitCode: 0 };
    updateTask(id, terminalPatch(code));
    return { found: true, exitCode: code };
  }

  // Non-follow view: heal a still-'running' record from the remote `.exit` so a
  // plain `logs <id>` also unsticks a task whose follower was killed. No-op (no
  // ssh) once the record is already terminal.
  reconcileTask(task);

  // Raw combined-stdout: the whole log with `full`, else a bounded tail.
  const raw = readTaskLog(task);
  if (raw === null) {
    process.stdout.write(chalk.gray('(no local log captured for this task)\n'));
    return { found: true, exitCode: 0 };
  }
  process.stdout.write(full ? raw : tailLines(raw, HOST_LOG_TAIL_LINES));
  return { found: true, exitCode: 0 };
}

/**
 * Machine-readable form of a host-dispatch task's log — the task record plus its
 * combined stdout. Powers `agents logs <id> --json` for the host-task branch.
 * Reconciles a still-'running' record from the remote `.exit` first, like the
 * text path does.
 */
export function hostTaskLogJson(id: string): { found: boolean; task?: HostTask; log?: string | null } {
  const task = loadTask(id);
  if (!task) return { found: false };
  // reconcileTask returns the healed record; it does NOT mutate its argument in
  // place. Emit the reconciled task so a run that finished between dispatch and
  // this one-shot read surfaces its terminal status/exitCode, not a stale
  // 'running'. (The text path can discard the return — it only reads the log by
  // id — but this JSON payload carries task.status straight to the consumer.)
  const reconciled = reconcileTask(task);
  return { found: true, task: reconciled, log: readTaskLog(reconciled) };
}

/** Read the task's combined-stdout — local mirror first, else fetch+cache remote. */
function readTaskLog(task: HostTask): string | null {
  try {
    return fs.readFileSync(localLogPath(task.id), 'utf-8');
  } catch {
    // No local log — task was dispatched with --no-follow. Fetch from the remote
    // on demand and cache locally so subsequent calls are instant.
    const remote = fetchAndCacheRemoteLog(task);
    return remote !== null ? remote.toString('utf-8') : null;
  }
}

/** Last `n` lines of `text`, prefixed with an elision note when truncated. */
export function tailLines(text: string, n: number): string {
  const lines = text.split('\n');
  // A trailing newline yields a final empty element — drop it from the count.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length <= n) return lines.join('\n') + '\n';
  const hidden = lines.length - n;
  const note = chalk.gray(`… ${hidden} earlier line${hidden === 1 ? '' : 's'} hidden — pass --full for the whole log\n`);
  return note + lines.slice(-n).join('\n') + '\n';
}

/**
 * Fetch a task's remote log over SSH, write it to the local mirror path (for
 * future instant reads), and return its content. Returns null when the host is
 * unreachable or the remote log is empty/absent.
 *
 * `remoteLog` is a $HOME-prefixed path with a safe (hex) basename — intentionally
 * unquoted so the remote shell expands $HOME, matching the contract in reconcile.ts
 * and progress.ts.
 */
function fetchAndCacheRemoteLog(task: HostTask): Buffer | null {
  const command = task.remoteShell === 'powershell'
    ? `powershell -NoProfile -EncodedCommand ${encodePowershell(`$path = Join-Path $HOME '${task.remoteLog.replace(/^\$HOME\//, '').replace(/'/g, "''")}'; if (Test-Path -LiteralPath $path) { $bytes = [IO.File]::ReadAllBytes($path); [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length) }`)}`
    : `cat ${task.remoteLog} 2>/dev/null`;
  const res = sshExecRaw(task.target, command, {
    timeoutMs: 30000,
    multiplex: true,
    extraSshArgs: task.identityFile ? ['-i', task.identityFile, '-o', 'IdentitiesOnly=yes'] : undefined,
  });
  if (res.code !== 0 || res.stdout.length === 0) return null;
  // The hosts cache dir already exists (saveTask created it) — write is best-effort.
  try { fs.writeFileSync(localLogPath(task.id), res.stdout); } catch { /* best-effort cache */ }
  return res.stdout;
}
