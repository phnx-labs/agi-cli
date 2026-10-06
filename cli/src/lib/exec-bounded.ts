
import { spawn } from 'child_process';

const KILL_GRACE_MS = 250;

interface ExecFileBoundedOptions {
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  maxBuffer?: number;
}

interface BoundedExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

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
      detached: !isWin,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (isWin) {
          spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
        } else {
          process.kill(-child.pid, signal);
        }
      } catch {  }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
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
    const capture = (text: string, chunk: string): string => {
      const next = text + chunk;
      if (opts.maxBuffer === undefined || next.length <= opts.maxBuffer) return next;
      killGroup('SIGKILL');
      return next.slice(0, opts.maxBuffer);
    };
    child.stdout?.on('data', (chunk) => { stdout = capture(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = capture(stderr, chunk); });

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
