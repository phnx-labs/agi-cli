
import * as fs from 'fs';
import chalk from 'chalk';
import { loadTask, localLogPath, updateTask, terminalPatch, type HostTask } from './tasks.js';
import { followHostTask } from './progress.js';
import { reconcileTask } from './reconcile.js';
import { sshExecRaw } from '../ssh-exec.js';
import { encodePowershell } from './remote-cmd.js';

interface HostLogResult {
  found: boolean;
  exitCode?: number;
}

const HOST_LOG_TAIL_LINES = 40;

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
    if (code === -1) return { found: true, exitCode: 0 };
    updateTask(id, terminalPatch(code));
    return { found: true, exitCode: code };
  }

  reconcileTask(task);

  const raw = readTaskLog(task);
  if (raw === null) {
    process.stdout.write(chalk.gray('(no local log captured for this task)\n'));
    return { found: true, exitCode: 0 };
  }
  process.stdout.write(full ? raw : tailLines(raw, HOST_LOG_TAIL_LINES));
  return { found: true, exitCode: 0 };
}

export function hostTaskLogJson(id: string): { found: boolean; task?: HostTask; log?: string | null } {
  // JSON reports the reconciled record, never the stale task loaded before the remote probe.
  const task = loadTask(id);
  if (!task) return { found: false };
  const reconciled = reconcileTask(task);
  return { found: true, task: reconciled, log: readTaskLog(reconciled) };
}

function readTaskLog(task: HostTask): string | null {
  try {
    return fs.readFileSync(localLogPath(task.id), 'utf-8');
  } catch {
    const remote = fetchAndCacheRemoteLog(task);
    return remote !== null ? remote.toString('utf-8') : null;
  }
}

export function tailLines(text: string, n: number): string {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length <= n) return lines.join('\n') + '\n';
  const hidden = lines.length - n;
  const note = chalk.gray(`… ${hidden} earlier line${hidden === 1 ? '' : 's'} hidden — pass --full for the whole log\n`);
  return note + lines.slice(-n).join('\n') + '\n';
}

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
  try { fs.writeFileSync(localLogPath(task.id), res.stdout); } catch {  }
  return res.stdout;
}
