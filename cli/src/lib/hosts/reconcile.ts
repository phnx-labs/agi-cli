
import { sshExec, sshExecAsync, type SshExecResult } from '../ssh-exec.js';
import { updateTask, terminalPatch, type HostTask } from './tasks.js';
import { encodePowershell } from './remote-cmd.js';

type RemoteExitState =
  | { state: 'running' }
  | { state: 'done'; code: number }
  | { state: 'unreachable' };

export function classifyExit(res: Pick<SshExecResult, 'code' | 'stdout' | 'timedOut'>): RemoteExitState {

  if (res.timedOut || res.code === null || res.code === 255) return { state: 'unreachable' };
  const out = res.stdout.trim();
  if (out === '') return { state: 'running' };
  const code = parseInt(out, 10);
  return { state: 'done', code: Number.isFinite(code) ? code : 0 };
}

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

async function readRemoteExitAsync(target: string, remoteExit: string, timeoutMs = 6000, identityFile?: string, remoteShell: 'posix' | 'powershell' = 'posix'): Promise<RemoteExitState> {

  return classifyExit(await sshExecAsync(target, remoteExitCommand(remoteExit, remoteShell), remoteExitSshOpts(timeoutMs, identityFile)));
}

export function reconcileTask(task: HostTask): HostTask {
  if (task.status !== 'running') return task;
  const st = readRemoteExit(task.target, task.remoteExit, 6000, task.identityFile, task.remoteShell);
  if (st.state !== 'done') return task;
  return updateTask(task.id, terminalPatch(st.code)) ?? task;
}

export async function reconcileTaskAsync(task: HostTask): Promise<HostTask> {
  if (task.status !== 'running') return task;
  const st = await readRemoteExitAsync(task.target, task.remoteExit, 6000, task.identityFile, task.remoteShell);
  if (st.state !== 'done') return task;
  return updateTask(task.id, terminalPatch(st.code)) ?? task;
}

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
