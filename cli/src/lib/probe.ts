/** Capability probes of third-party binaries. Node's `timeout:` kills only the direct child, so
 * grandchildren outlive it and race temp-HOME teardown (RUSH-3028). Each probe runs in its own
 * process group, reaped on settle and by a process 'exit' hook. POSIX only; win32 kills the child. */
import { spawn } from 'child_process';

const GROUP_REAP = process.platform !== 'win32';

const LIVE_GROUPS = new Set<number>();
let exitHookInstalled = false;

function ensureExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const pid of LIVE_GROUPS) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* group already fully exited */
      }
    }
  });
}

function reapGroup(pid: number | undefined): void {
  if (!GROUP_REAP || !pid) return;
  LIVE_GROUPS.delete(pid);
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* group already fully exited */
  }
}

/** Async probe capturing stdout; rejects on spawn error, non-zero exit, or timeout (the
 * `execFileAsync` contract) and reaps the whole process group on every settle path. */
export function probeCapture(
  cmd: string,
  args: string[],
  timeoutMs: number,
  options: { acceptedExitCodes?: number[]; maxOutputBytes?: number } = {},
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      detached: GROUP_REAP,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    if (GROUP_REAP && child.pid) {
      LIVE_GROUPS.add(child.pid);
      ensureExitHook();
    }
    let out = '';
    let settled = false;
    const settle = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reapGroup(child.pid);
      // win32 has no group to reap: kill the direct child so a timed-out
      // probe still dies, matching execFile's `timeout:` behavior. No-op
      // after a clean exit.
      if (!GROUP_REAP) child.kill('SIGKILL');
      if (err) reject(err);
      else resolve({ stdout: out });
    };
    const timer = setTimeout(
      () => settle(new Error(`probe timed out after ${timeoutMs}ms: ${cmd} ${args.join(' ')}`)),
      timeoutMs,
    );
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      out += d;
      if (Buffer.byteLength(out) > (options.maxOutputBytes ?? 1024 * 1024)) {
        settle(new Error(`probe output exceeded limit: ${cmd}`));
      }
    });
    child.on('error', (e) => settle(e));
    // Use 'exit', not 'close': a forked grandchild inherits the stdout pipe and 'close' waits for
    // every holder, the very process this helper reaps. Settle when the probed binary exits; one
    // tick's grace lets final stdout chunks land.
    child.on('exit', (code) => {
      setImmediate(() =>
        settle(code !== null && (options.acceptedExitCodes ?? [0]).includes(code) ? null : new Error(`probe exited ${code}: ${cmd} ${args.join(' ')}`)),
      );
    });
  });
}
