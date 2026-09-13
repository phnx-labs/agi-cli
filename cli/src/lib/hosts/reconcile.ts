/**
 * Reconcile a local host-task record against the remote run's ground truth.
 *
 * A detached `--device` run outlives the local follower: it keeps running and
 * writes its exit code to `<id>.exit` on the host even if the laptop sleeps or
 * the SSH connection drops mid-follow. When that happens the local record is
 * left at `status:'running'` forever, because the only path that finalizes it
 * (dispatch's post-follow `updateTask`) never runs. This module re-reads the
 * remote `.exit` on demand — from `agents devices ps` / `agents logs` — and heals the
 * record. We only ever CONFIRM completion; an unreachable host or an absent
 * `.exit` leaves the record `running` (we never guess failure).
 */

import { sshExec, sshExecAsync, type SshExecResult } from '../ssh-exec.js';
import { updateTask, terminalPatch, type HostTask } from './tasks.js';
import { encodePowershell } from './remote-cmd.js';

type RemoteExitState =
  | { state: 'running' } //     .exit absent, or present-but-empty (mid-write) → not finished
  | { state: 'done'; code: number } // .exit holds an exit code → finished
  | { state: 'unreachable' }; //  ssh itself failed → can't tell, don't touch the record

/**
 * Classify a `cat <remoteExit>` result into a remote run state. Pure: all the
 * bug-prone branching (ssh-failure vs absent vs empty vs coded) lives here so it
 * can be unit-tested without a live host. ssh's own connection failure surfaces
 * as code 255, a spawn error/timeout as `code === null`; neither is the remote
 * command's exit and both mean "unreachable". An empty read is "still running"
 * (the `.exit` is written only after the run ends, so absent `cat` → exit 1 →
 * empty stdout, and a truncate-then-write mid-race is a sub-ms empty window).
 */
export function classifyExit(res: Pick<SshExecResult, 'code' | 'stdout' | 'timedOut'>): RemoteExitState {
  if (res.timedOut || res.code === null || res.code === 255) return { state: 'unreachable' };
  const out = res.stdout.trim();
  if (out === '') return { state: 'running' };
  const code = parseInt(out, 10);
  return { state: 'done', code: Number.isFinite(code) ? code : 0 };
}

/**
 * Read a task's remote `.exit` over ssh and classify it. `remoteExit` is a
 * $HOME-prefixed path with a safe (hex) basename — intentionally unquoted so the
 * remote shell expands $HOME (same contract as progress.ts's fetch).
 */
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

/**
 * Async twin of {@link readRemoteExit} for the daemon's heartbeat tick — the ssh
 * read runs on the shared event loop, so it MUST NOT block it with a synchronous
 * `spawnSync('ssh', …)` (PHNX-3695). `sshExecAsync` applies the same
 * timeout/kill-grace bound.
 */
async function readRemoteExitAsync(target: string, remoteExit: string, timeoutMs = 6000, identityFile?: string, remoteShell: 'posix' | 'powershell' = 'posix'): Promise<RemoteExitState> {
  return classifyExit(await sshExecAsync(target, remoteExitCommand(remoteExit, remoteShell), remoteExitSshOpts(timeoutMs, identityFile)));
}

/**
 * Heal one record. Terminal records are immutable (and never re-probed); a
 * `running` record is resolved to completed/failed only when the remote `.exit`
 * holds a code. Returns the (possibly updated) task.
 */
export function reconcileTask(task: HostTask): HostTask {
  if (task.status !== 'running') return task;
  const st = readRemoteExit(task.target, task.remoteExit, 6000, task.identityFile, task.remoteShell);
  if (st.state !== 'done') return task;
  return updateTask(task.id, terminalPatch(st.code)) ?? task;
}

/**
 * Async twin of {@link reconcileTask} for the daemon heartbeat tick (PHNX-3695):
 * identical healing logic, non-blocking ssh read via {@link readRemoteExitAsync}.
 */
export async function reconcileTaskAsync(task: HostTask): Promise<HostTask> {
  if (task.status !== 'running') return task;
  const st = await readRemoteExitAsync(task.target, task.remoteExit, 6000, task.identityFile, task.remoteShell);
  if (st.state !== 'done') return task;
  return updateTask(task.id, terminalPatch(st.code)) ?? task;
}

/**
 * Heal a list of records for a listing (`agents devices ps`). Only `running` tasks
 * are probed; each host is reachability-checked ONCE (deduped by target) so a
 * down host costs a single short timeout instead of one per task, and its tasks
 * are left `running` rather than falsely failed. Sequential by design — with the
 * shared ssh control socket the live-host reads are sub-100ms, and a parallel
 * (async) ssh path is deliberately out of scope.
 */
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
    if (!reachable.get(t.target)) continue; // host down → leave running
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
