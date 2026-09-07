/**
 * Daemon harness-update service (PHNX-3940).
 *
 * Runs the automatic-update pass (`installations/update-runtime.ts`) on a
 * schedule so a managed, transactional npm harness (Claude, Codex, …) stays
 * current with no operator action, subject to the `updates.auto` /
 * `updates.<agent>.auto` switches and each installation's own update policy.
 *
 * The pass itself does real, synchronous filesystem work per installation —
 * staging an npm install into a sibling directory, `fs.renameSync`/`fs.cpSync`
 * swaps, `fs.rmSync` cleanup — potentially across several installations in one
 * tick. Running that inline on the daemon's own event loop would stall every
 * other service (browser IPC, the scheduler, monitors) for the
 * duration, the same class of problem `self-update-service.ts` solves for the
 * CLI's OWN upgrade by installing into a fresh process it then exits into.
 * Here there is no "exit and let the supervisor restart" option (the daemon
 * itself isn't what's being updated), so instead this tick SPAWNS a bounded
 * child (`agents __harness-update-run`) over a Node IPC channel and only waits
 * on that child — every sync fs call happens in the child's own event loop /
 * thread pool, never this one.
 *
 * Cancellation is COOPERATIVE and cross-platform (PHNX-3940). On the tick's
 * deadline or daemon shutdown — both delivered as the supervisor aborting the
 * tick's `AbortSignal` — the daemon does NOT force-kill the child (execFile's
 * `timeout`/`signal` would, unconditionally on Windows, mid-swap). It SENDS the
 * child an IPC cancel message; the child stops at its next safe boundary (see
 * `installations/update-cancellation.ts` + `update.ts`'s `shouldCancel`) and
 * exits on its own, and the daemon waits for that TRUE exit. A wedged child that
 * ignores the request past a generous grace — never the normal path, since the
 * child's own npm/probe work is bounded — is force-reaped only as an
 * orphan-prevention backstop, and that abnormal case is reported as a failure,
 * never as a clean pass.
 */

import { spawn, type ChildProcess } from 'child_process';
import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { getCliLaunch, getAgentsBinPath } from '../cli-entry.js';
import { HARNESS_UPDATE_CHILD_CMD, cancelMessage } from '../installations/update-cancellation.js';

/** Runs every 15 minutes — a design decision, not an externally-fixed cadence (PHNX-3940). */
const HARNESS_UPDATE_TICK_MS = 15 * 60_000;
/**
 * Cancellation deadline per tick. A real pass can touch several installations, each an npm
 * install (`INSTALL_TIMEOUT_MS` = 120s in strategies.ts) plus two launch
 * probes; 10 minutes leaves headroom for a handful of harnesses in one pass
 * while staying comfortably under the 15-minute cadence above.
 */
export const HARNESS_UPDATE_DEADLINE_MS = 10 * 60_000;
/** First tick fires 60 seconds after daemon boot — long enough for shims/PATH to settle, short enough that a fresh box doesn't wait a full interval for its first check. */
const HARNESS_UPDATE_STARTUP_DELAY_MS = 60_000;
/**
 * How long to wait for the child to exit AFTER a cooperative cancel before
 * force-reaping it as an orphan backstop. The child's own work is bounded — one
 * npm install (`INSTALL_TIMEOUT_MS` = 120s in strategies.ts) plus two launch
 * probes, then a fast synchronous swap — so a healthy child stops well within
 * this window. A slow staging/postinstall can also exhaust it, but a delivered
 * cancel prevents that stage from committing. The backstop kills the process
 * group on POSIX and the worker on Windows; the tick reports a failure.
 */
export const HARNESS_UPDATE_CANCEL_GRACE_MS = 3 * 60_000;

export interface HarnessUpdateOutcome {
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

/**
 * Dependency seam so tests can assert the tick's decision/spawn logic without
 * actually installing anything. Production always uses
 * {@link defaultHarnessUpdateDeps}.
 */
export interface HarnessUpdateDeps {
  runAutoUpdatePass(signal: AbortSignal): Promise<CooperativeChildResult>;
}

export function defaultHarnessUpdateDeps(): HarnessUpdateDeps {
  return {
    runAutoUpdatePass(signal) {
      const { command, args } = getCliLaunch([HARNESS_UPDATE_CHILD_CMD], getAgentsBinPath());
      return driveCooperativeChild(command, args, signal, HARNESS_UPDATE_CANCEL_GRACE_MS);
    },
  };
}

/**
 * Spawn `command args` as a child over a Node IPC channel and drive it to a TRUE
 * completion, requesting a cooperative stop (never a kill) when `signal` aborts —
 * the supervisor aborts it on the tick's deadline OR on daemon shutdown.
 *
 * Resolves with the child's real exit code and captured output. Rejects only on:
 *   - a spawn failure (missing binary) — a genuine service failure; and
 *   - the child having to be force-reaped past the grace window, or dying to an
 *     external signal — never a clean pass, so the tick logs it as ERROR instead
 *     of reading a killed process as a completed update.
 *
 * A non-zero exit with no kill is resolved (not rejected): the pass exits
 * non-zero for a per-installation vendor error, which is a normal tick outcome.
 *
 * Exported for the real-subprocess cancellation tests.
 */
export function driveCooperativeChild(
  command: string,
  args: string[],
  signal: AbortSignal,
  graceMs: number,
  spawnOpts: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<CooperativeChildResult> {
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
      // Cooperative: a message the child reads at its next safe boundary. NEVER a
      // signal — that would interrupt a swap (and is fatal on Windows, which has
      // no cooperative SIGTERM). If the channel is already gone the child's own
      // `disconnect` handler cancels it, so a failed send is not an error.
      try { child.send(cancelMessage(), () => {}); } catch { /* channel closed; disconnect handles it */ }
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
          `harness-update child did not exit cooperatively after cancel `
          + `(${forceReaped ? `force-reaped after ${graceMs}ms grace` : `died to ${sigName}`}). `
          + (stderr.slice(0, 500) || stdout.slice(0, 500) || 'no output'),
        ));
        return;
      }
      resolve({ exitCode: code, stdout: stdout || stderr, cancelled: cancelRequested });
    });
  });
}

/**
 * Core decision + spawn, shared so a future on-demand trigger (mirroring
 * `triggerSelfUpdateInBackground`) can reuse it. Returns rather than throws —
 * the periodic tick logs the outcome and moves on either way.
 */
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
