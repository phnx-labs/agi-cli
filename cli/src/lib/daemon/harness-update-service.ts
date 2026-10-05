/** Daemon harness-update service (PHNX-3940): runs the automatic-update pass
 * (`installations/update-runtime.ts`) on a schedule so managed npm harnesses stay current, per
 * `updates.auto` and policy. Sync fs work runs in a child, cancelled via IPC, not killed mid-swap. */

import { spawn, type ChildProcess } from 'child_process';
import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { getCliLaunch, getAgentsBinPath } from '../cli-entry.js';
import { HARNESS_UPDATE_CHILD_CMD, cancelMessage } from '../installations/update-cancellation.js';

/** Runs every 15 minutes — a design decision, not an externally-fixed cadence (PHNX-3940). */
const HARNESS_UPDATE_TICK_MS = 15 * 60_000;
/** Cancellation deadline per tick. A pass can touch several installations, each an npm install
 * (`INSTALL_TIMEOUT_MS` = 120s in strategies.ts) plus two launch probes; 10 minutes leaves
 * headroom while staying under the 15-minute cadence. */
const HARNESS_UPDATE_DEADLINE_MS = 10 * 60_000;
/** First tick fires 60 seconds after daemon boot — long enough for shims/PATH to settle, short enough that a fresh box doesn't wait a full interval for its first check. */
const HARNESS_UPDATE_STARTUP_DELAY_MS = 60_000;
/** How long to wait for the child to exit after a cooperative cancel before force-reaping it. Its
 * work is bounded (one npm install of 120s plus two probes, then a fast swap), so a healthy child
 * stops well inside this. The backstop kills the process group on POSIX and the worker on Windows. */
const HARNESS_UPDATE_CANCEL_GRACE_MS = 3 * 60_000;

interface HarnessUpdateOutcome {
  ran: boolean;
  reason?: string;
  exitCode?: number | null;
  stdout?: string;
  /** True when the pass was asked to stop (deadline/shutdown) and did so cooperatively. */
  cancelled?: boolean;
}

export interface CooperativeChildResult {
  exitCode: number | null;
  stdout: string;
  /** True when a cancel was requested during this child's life (deadline/shutdown). */
  cancelled: boolean;
}

/** Dependency seam so tests can assert the tick's decision/spawn logic without installing anything.
 * Production uses {@link defaultHarnessUpdateDeps}. */
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

/** Spawn `command args` over a Node IPC channel and drive it to a TRUE completion, requesting a
 * cooperative stop (never a kill) when `signal` aborts (tick deadline or daemon shutdown).
 * Resolves with the real exit code and output; rejects on spawn failure or a force-reap. */
export function driveCooperativeChild(
  command: string,
  args: string[],
  signal: AbortSignal,
  graceMs: number,
  spawnOpts: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    /** IPC message that asks the child to stop; defaults to the harness-update cancel. */
    cancelMsg?: object;
    /** Names the child in a failure message. */
    label?: string;
  } = {},
): Promise<CooperativeChildResult> {
  const cancelMsg = spawnOpts.cancelMsg ?? cancelMessage();
  const label = spawnOpts.label ?? 'harness-update';
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        // stdio[3] = 'ipc' is the cancel channel. Detached on POSIX so the child
        // leads its own process group and the backstop below can reap its whole
        // npm subtree; the parent still waits on it (never unref'd).
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
      // Cooperative: a message the child reads at its next safe boundary, never a signal (it would
      // interrupt a swap and is fatal on Windows). If the channel is gone the child's own
      // `disconnect` handler cancels it, so a failed send is not an error.
      try { child.send(cancelMsg, () => {}); } catch { /* channel closed; disconnect handles it */ }
      graceTimer = setTimeout(() => {
        if (settled) return;
        forceReaped = true;
        try {
          if (process.platform !== 'win32' && typeof child.pid === 'number') process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
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

/** Core decision + spawn, shared so a future on-demand trigger (like
 * `triggerSelfUpdateInBackground`) can reuse it. Returns rather than throws; the periodic tick
 * logs the outcome and moves on. */
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
    // No connections/handles to open — each tick spawns its own bounded child.
  }

  protected async onStop(): Promise<void> {
    // The in-flight child (if any) is asked to stop COOPERATIVELY: the supervisor
    // aborts `signal` on the current tick, which `driveCooperativeChild` turns
    // into an IPC cancel message, never a kill. Nothing else to release here.
  }

  protected async onTick(ctx: DaemonContext, signal: AbortSignal): Promise<void> {
    await runHarnessUpdateTick(ctx, signal);
  }
}
