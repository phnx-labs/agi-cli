
import { spawn, type ChildProcess } from 'child_process';
import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { getCliLaunch, getAgentsBinPath } from '../cli-entry.js';
import { HARNESS_UPDATE_CHILD_CMD, cancelMessage } from '../installations/update-cancellation.js';

const HARNESS_UPDATE_TICK_MS = 15 * 60_000;
const HARNESS_UPDATE_DEADLINE_MS = 10 * 60_000;
const HARNESS_UPDATE_STARTUP_DELAY_MS = 60_000;
const HARNESS_UPDATE_CANCEL_GRACE_MS = 3 * 60_000;

interface HarnessUpdateOutcome {
  ran: boolean;
  reason?: string;
  exitCode?: number | null;
  stdout?: string;
  cancelled?: boolean;
}

export interface CooperativeChildResult {
  exitCode: number | null;
  stdout: string;
  cancelled: boolean;
}

export interface HarnessUpdateDeps {
  runAutoUpdatePass(signal: AbortSignal): Promise<CooperativeChildResult>;
}

function defaultHarnessUpdateDeps(): HarnessUpdateDeps {
  return {
    runAutoUpdatePass(signal) {
      const { command, args } = getCliLaunch([HARNESS_UPDATE_CHILD_CMD], getAgentsBinPath());
      return driveCooperativeChild(command, args, signal, HARNESS_UPDATE_CANCEL_GRACE_MS);
    },
  };
}

export function driveCooperativeChild(
  command: string,
  args: string[],
  signal: AbortSignal,
  graceMs: number,
  spawnOpts: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    cancelMsg?: object;
    label?: string;
  } = {},
): Promise<CooperativeChildResult> {
  const cancelMsg = spawnOpts.cancelMsg ?? cancelMessage();
  const label = spawnOpts.label ?? 'harness-update';
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        detached: process.platform !== 'win32',
        windowsHide: true,
        env: spawnOpts.env,
        cwd: spawnOpts.cwd,
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const MAX = 16 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let cancelRequested = false;
    let forceReaped = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (graceTimer) clearTimeout(graceTimer);
      signal.removeEventListener('abort', requestCancel);
    };

    function requestCancel(): void {
      if (cancelRequested || settled) return;
      cancelRequested = true;
      try { child.send(cancelMsg, () => {}); } catch {  }
      graceTimer = setTimeout(() => {
        if (settled) return;
        forceReaped = true;
        try {
          if (process.platform !== 'win32' && typeof child.pid === 'number') process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch { try { child.kill('SIGKILL'); } catch {  } }
      }, graceMs);
      graceTimer.unref?.();
    }

    if (signal.aborted) requestCancel();
    else signal.addEventListener('abort', requestCancel, { once: true });

    child.stdout?.on('data', (d: Buffer) => { if (stdout.length < MAX) stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { if (stderr.length < MAX) stderr += d.toString(); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });

    child.on('close', (code, sigName) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (forceReaped || sigName) {
        reject(new Error(
          `${label} child did not exit cooperatively after cancel `
          + `(${forceReaped ? `force-reaped after ${graceMs}ms grace` : `died to ${sigName}`}). `
          + (stderr.slice(0, 500) || stdout.slice(0, 500) || 'no output'),
        ));
        return;
      }
      resolve({ exitCode: code, stdout: stdout || stderr, cancelled: cancelRequested });
    });
  });
}

export async function runHarnessUpdateTick(
  ctx: DaemonContext,
  signal: AbortSignal,
  deps: HarnessUpdateDeps = defaultHarnessUpdateDeps(),
): Promise<HarnessUpdateOutcome> {
  try {
    const { exitCode, stdout, cancelled } = await deps.runAutoUpdatePass(signal);
    if (exitCode !== 0) {
      ctx.log('WARN', `harness-update: pass exited ${exitCode} — see stdout for per-installation errors: ${stdout.slice(0, 2000)}`);
    } else if (cancelled) {
      ctx.log('INFO', 'harness-update: pass cancelled at a safe boundary (deadline or daemon shutdown); no work left half-done');
    } else {
      ctx.log('INFO', 'harness-update: pass completed');
    }
    return { ran: true, exitCode, stdout, cancelled };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log('ERROR', `harness-update: pass failed to run: ${message}`);
    return { ran: false, reason: message };
  }
}

export class HarnessUpdateService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'harness-update';
  readonly intervalMs = HARNESS_UPDATE_TICK_MS;
  readonly deadlineMs = HARNESS_UPDATE_DEADLINE_MS;
  readonly startupDelayMs = HARNESS_UPDATE_STARTUP_DELAY_MS;

  protected async onStart(_ctx: DaemonContext): Promise<void> {
  }

  protected async onStop(): Promise<void> {
  }

  protected async onTick(ctx: DaemonContext, signal: AbortSignal): Promise<void> {
    await runHarnessUpdateTick(ctx, signal);
  }
}
