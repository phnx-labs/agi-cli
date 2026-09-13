/**
 * Async, deadline-bounded, process-group-killable subprocess exec (PHNX-3695).
 *
 * The daemon runs every background service on ONE Node event loop. A
 * synchronous `execFileSync`/`spawnSync` on a service tick blocks that loop for
 * the whole life of the child — and while it is blocked NOTHING else on the loop
 * runs, including the supervisor's per-tick deadline timer and the browser IPC
 * server's socket handlers. That is the wedge PHNX-3411 fixed the *symptom* of:
 * the browser `version` probe (a trivial synchronous handler) "accepts but never
 * replies" because the loop that would reply is frozen inside a sync spawn.
 *
 * `execFileBounded` is the non-blocking replacement for those tick-path spawns.
 * It spawns with async `child_process.spawn`, so the event loop keeps serving
 * other work while the child runs, and it bounds the child two ways:
 *
 *  - a `timeoutMs` deadline: on expiry it SIGTERMs the child, then SIGKILLs it
 *    after {@link KILL_GRACE_MS} if it ignored the term — the same escalation
 *    `sshExecAsync` uses (ssh-exec.ts).
 *  - a process GROUP kill: the child is spawned as its own group leader
 *    (`detached` on POSIX) so the signal reaches the whole subtree, not just the
 *    direct child. A bare `child.kill()` would leave grandchildren running — the
 *    orphaned-`ps`/`powershell` leak class. Windows uses `taskkill /T`.
 *
 * It never throws for a non-zero exit, a signal, or a spawn error: every outcome
 * is reported in the returned {@link BoundedExecResult} so a caller on a tick
 * path can branch on it instead of wrapping every call in try/catch.
 */

import { spawn } from 'child_process';

/** Grace between SIGTERM and SIGKILL for a child that overran its deadline. */
const KILL_GRACE_MS = 250;

interface ExecFileBoundedOptions {
  /** Hard wall-clock cap. On expiry the child's process group is SIGTERMed, then SIGKILLed after {@link KILL_GRACE_MS}. Required — an unbounded tick-path spawn is the bug this helper exists to prevent. */
  timeoutMs: number;
  /** Working directory for the child. */
  cwd?: string;
  /** Environment for the child (defaults to the current process env). */
  env?: NodeJS.ProcessEnv;
  /** Optional stdin to write to the child. */
  input?: string;
}

interface BoundedExecResult {
  stdout: string;
  stderr: string;
  /** Exit code, or null when the process was killed by a signal (including our timeout kill) or never spawned. */
  code: number | null;
  /** True when the deadline elapsed and we killed the child, distinguishing a timeout from an ordinary non-zero exit. */
  timedOut: boolean;
}

/**
 * Run `file args` with a hard deadline, killing the whole process group on
 * timeout. Resolves (never rejects) with the captured output and outcome.
 */
export function execFileBounded(
  file: string,
  args: string[],
  opts: ExecFileBoundedOptions,
): Promise<BoundedExecResult> {
  const isWin = process.platform === 'win32';
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      // POSIX: lead a new process group so a timeout kill(-pid) reaches the
      // whole subtree, not just the direct child. Windows has no process
      // groups here — taskkill /T handles the tree instead.
      detached: !isWin,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    // Signal the whole group on POSIX (negative pid); on Windows tear the tree
    // down with taskkill. Best-effort — an already-dead child is fine.
    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (isWin) {
          // taskkill is itself a child; spawn it detached and forget it.
          spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
        } else {
          process.kill(-child.pid, signal);
        }
      } catch { /* group already gone */ }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      // SIGTERM is advisory; a wedged child can ignore it and keep the Promise
      // (and the caller's tick) pending forever. Enforce a hard SIGKILL bound.
      killTimer = setTimeout(() => {
        if (!settled) killGroup('SIGKILL');
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    }, opts.timeoutMs);
    timer.unref?.();

    const clearTimers = (): void => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };

    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });

    // A child that closes stdin early makes end()/write emit EPIPE; with no
    // listener Node escalates it to an uncaught exception. Swallow it — the real
    // outcome is still reported by 'close'/'error' below.
    child.stdin?.on('error', () => {});
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();

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
