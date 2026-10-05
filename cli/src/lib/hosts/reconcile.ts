/** Reconcile a local host-task record with the remote truth: a detached `--device` run outlives
 * the follower and writes `<id>.exit`, but a dead follow leaves the record `running` forever.
 * This re-reads `.exit` on demand and heals it, only ever confirming completion. */

import { sshExec, sshExecAsync, type SshExecResult } from '../ssh-exec.js';
import { updateTask, terminalPatch, type HostTask } from './tasks.js';
import { encodePowershell } from './remote-cmd.js';

type RemoteExitState =
  | { state: 'running' }
  | { state: 'done'; code: number }
  | { state: 'unreachable' };

/** Classify a `cat <remoteExit>` result into a remote run state (pure). ssh failure is code 255
 * and spawn error/timeout is `code === null`, both meaning unreachable; an empty read is still
 * running (`.exit` is written only after the run ends). */
export function classifyExit(res: Pick<SshExecResult, 'code' | 'stdout' | 'timedOut'>): RemoteExitState {
  // Unreachable, absent, or empty exit state is still running; only a confirmed code is terminal.
  if (res.timedOut || res.code === null || res.code === 255) return { state: 'unreachable' };
  const out = res.stdout.trim();
  if (out === '') return { state: 'running' };
  const code = parseInt(out, 10);
  return { state: 'done', code: Number.isFinite(code) ? code : 0 };
}

/** Read a task's remote `.exit` over ssh and classify it; `remoteExit` is a $HOME-prefixed hex-
 * basename path left unquoted so the remote shell expands $HOME. */
function remoteExitCommand(remoteExit: string, remoteShell: 'posix' | 'powershell'): string {
  return remoteShell === 'powershell'
    ? `powershell -NoProfile -EncodedCommand ${encodePowershell(`$path = Join-Path $HOME '${remoteExit.replace(/^\$HOME\//, '').replace(/'/g, "''")}'; if (Test-Path -LiteralPath $path) { Get-Content -LiteralPath $path -Raw }`)}`
    : `cat ${remoteExit} 2>/dev/null`;
}

function remoteExitSshOpts(timeoutMs: number, identityFile?: string): { timeoutMs: number; multiplex: true; extraSshArgs?: string[] } {
  return {
    timeoutMs,
    multiplex: true,
    extraSshArgs: identityFile ? ['-i', identityFile, '-o', 'IdentitiesOnly=yes'] : undefined,
  };
}

export function readRemoteExit(target: string, remoteExit: string, timeoutMs = 6000, identityFile?: string, remoteShell: 'posix' | 'powershell' = 'posix'): RemoteExitState {
  return classifyExit(sshExec(target, remoteExitCommand(remoteExit, remoteShell), remoteExitSshOpts(timeoutMs, identityFile)));
}

/** Async twin of readRemoteExit for the daemon heartbeat tick: the ssh read shares the event
 * loop, so it must not use a synchronous `spawnSync('ssh', …)` (PHNX-3695); `sshExecAsync`
 * applies the same timeout bound. */
async function readRemoteExitAsync(target: string, remoteExit: string, timeoutMs = 6000, identityFile?: string, remoteShell: 'posix' | 'powershell' = 'posix'): Promise<RemoteExitState> {
  // Daemon callers use async SSH so a dead host cannot block the event loop.
  return classifyExit(await sshExecAsync(target, remoteExitCommand(remoteExit, remoteShell), remoteExitSshOpts(timeoutMs, identityFile)));
}

/** Heal one record: terminal records are immutable and never re-probed; a `running` one resolves
 * to completed/failed only when the remote `.exit` holds a code. */
export function reconcileTask(task: HostTask): HostTask {
  if (task.status !== 'running') return task;
  const st = readRemoteExit(task.target, task.remoteExit, 6000, task.identityFile, task.remoteShell);
  if (st.state !== 'done') return task;
  return updateTask(task.id, terminalPatch(st.code)) ?? task;
}

/** Async twin of reconcileTask for the daemon heartbeat tick (PHNX-3695): same logic, non-
 * blocking ssh read. */
export async function reconcileTaskAsync(task: HostTask): Promise<HostTask> {
  if (task.status !== 'running') return task;
  const st = await readRemoteExitAsync(task.target, task.remoteExit, 6000, task.identityFile, task.remoteShell);
  if (st.state !== 'done') return task;
  return updateTask(task.id, terminalPatch(st.code)) ?? task;
}

/** Heal a list of records for `agents devices ps`: only `running` tasks are probed, once per
 * host target so a down host costs one short timeout and its tasks stay `running`. Sequential
 * by design; a parallel ssh path is out of scope. */
export function reconcileRunningTasks(tasks: HostTask[]): HostTask[] {
  const running = tasks.filter((t) => t.status === 'running');
  if (running.length === 0) return tasks;

  const reachable = new Map<string, boolean>();
  const patched = new Map<string, HostTask>();
  for (const t of running) {
    if (!reachable.has(t.target)) {
      const probeCommand = reachabilityProbeCommand(t.remoteShell);
      const probe = sshExec(t.target, probeCommand, {
        timeoutMs: 6000,
        extraSshArgs: t.identityFile ? ['-i', t.identityFile, '-o', 'IdentitiesOnly=yes'] : undefined,
      });
      reachable.set(t.target, probe.code === 0);
    }
    if (!reachable.get(t.target)) continue;
    const st = readRemoteExit(t.target, t.remoteExit, 6000, t.identityFile, t.remoteShell);
    if (st.state === 'done') {
      const updated = updateTask(t.id, terminalPatch(st.code));
      if (updated) patched.set(t.id, updated);
    }
  }
  return tasks.map((t) => patched.get(t.id) ?? t);
}

export function reachabilityProbeCommand(remoteShell?: 'posix' | 'powershell'): string {
  return remoteShell === 'powershell' ? 'powershell -NoProfile -Command "exit 0"' : 'true';
}
