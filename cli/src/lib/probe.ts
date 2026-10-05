// POSIX probes own and reap a process group, including on parent exit; settle on direct-child exit, not pipe close.
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
  }
}

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
    child.on('exit', (code) => {
      setImmediate(() =>
        settle(code !== null && (options.acceptedExitCodes ?? [0]).includes(code) ? null : new Error(`probe exited ${code}: ${cmd} ${args.join(' ')}`)),
      );
    });
  });
}
