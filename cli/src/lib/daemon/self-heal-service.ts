/**
 * Resource self-heal tick as a `PeriodicService` (RUSH-3193 P3).
 *
 * Fills missing resources, repairs invalid manifests, and fast-forwards
 * pristine stale plugins. Conservative 'safe' mode: never overwrites
 * hand-edited content. Does not run when the daemon's state directory no
 * longer exists — that is the state-dir self-check's signal to shut down;
 * background maintenance must not recreate the tree while it is mid-exit.
 *
 * The pass runs in a child process (`agents __self-heal-run`, see
 * `self-heal/child.ts`), never on this event loop. `runSelfHeal` byte-compares
 * every synced resource in every version home with synchronous reads; inline,
 * one pass on a box with many version homes held the loop for over a minute,
 * every other service breached its tick deadline, the supervisor exited for an
 * OS restart, and the restarted daemon ran self-heal again 30 s later. That
 * loop pinned a core indefinitely.
 *
 * The attempt time is persisted BEFORE the child is spawned, and a tick inside
 * the interval since the last attempt is skipped. A daemon restart therefore
 * does not re-run the pass early, even if the previous attempt died with the
 * daemon.
 *
 * The first tick is still staggered by `SELF_HEAL_KICKOFF_MS` (30 s) so
 * shims/PATH settle after daemon start, through the supervisor's generic
 * `startupDelayMs` contract (`service.ts`).
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { getDaemonDir } from '../state.js';
import { getCliLaunch, getAgentsBinPath } from '../cli-entry.js';
import { driveCooperativeChild, type CooperativeChildResult } from './harness-update-service.js';
import { SELF_HEAL_CHILD_CMD, selfHealCancelMessage, type SelfHealChildSummary } from '../self-heal/child.js';

/** Matches the historical inline interval (daemon.ts SELF_HEAL_TICK_MS). Runs ~every 6h. */
const SELF_HEAL_TICK_MS = 6 * 60 * 60_000;
/** Hard cap per tick — a full resource repair sweep across every version home, short enough a hang never freezes the service for long relative to its 6h cadence. */
const SELF_HEAL_DEADLINE_MS = 10 * 60_000;
/** Matches the historical inline kickoff delay (daemon.ts SELF_HEAL_KICKOFF_MS). Staggers self-heal's first tick after shims/PATH settle, so launch itself isn't made busy. */
const SELF_HEAL_KICKOFF_MS = 30_000;
/** On daemon shutdown, how long the child gets to honor the cancel before it is reaped. (A deadline breach exits the daemon at once; the attempt stamp keeps the restart from re-running the pass.) */
const SELF_HEAL_CANCEL_GRACE_MS = 30_000;
/** Records when the last pass was started, so a restart does not start another inside the interval. */
const LAST_ATTEMPT_FILE = 'self-heal-last-attempt';
/**
 * The supervisor's setInterval fires the next tick one interval after the PREVIOUS
 * tick started, but the stamp is written a few ms into that tick. Without slack the
 * scheduled tick reads as "recent" and the pass slips a whole interval (6h → 12h).
 */
const SELF_HEAL_SKIP_SLACK_MS = 5 * 60_000;

/** Async `existsSync` — never a synchronous stat on the daemon tick loop (PHNX-3695). */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function lastAttemptPath(): string {
  return path.join(getDaemonDir(), LAST_ATTEMPT_FILE);
}

/** Epoch ms of the last recorded attempt, or null when none is recorded or the record is unreadable. */
export async function readLastSelfHealAttempt(): Promise<number | null> {
  try {
    const ms = Number((await fsp.readFile(lastAttemptPath(), 'utf-8')).trim());
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  } catch {
    return null;
  }
}

async function recordSelfHealAttempt(nowMs: number): Promise<void> {
  await fsp.writeFile(lastAttemptPath(), String(nowMs), 'utf-8');
}

/** Dependency seam so tests can drive the tick against a fixture child. Production uses {@link defaultSelfHealDeps}. */
export interface SelfHealDeps {
  runChild(signal: AbortSignal): Promise<CooperativeChildResult>;
  now(): number;
}

function defaultSelfHealDeps(): SelfHealDeps {
  return {
    runChild(signal) {
      const { command, args } = getCliLaunch([SELF_HEAL_CHILD_CMD], getAgentsBinPath());
      return driveCooperativeChild(command, args, signal, SELF_HEAL_CANCEL_GRACE_MS, {
        cancelMsg: selfHealCancelMessage(),
        label: 'self-heal',
      });
    },
    now: () => Date.now(),
  };
}

export type SelfHealTickOutcome =
  | { ran: false; reason: 'no-daemon-dir' | 'recent' | 'stamp-unwritable' }
  | { ran: true; exitCode: number | null; cancelled: boolean; summary?: SelfHealChildSummary };

/**
 * One tick: skip when the state dir is gone or the last attempt is inside the
 * interval; otherwise record the attempt, run the child, and log what it changed.
 * A child that fails to run or exits non-zero is logged and returned, never
 * thrown, so it is not mistaken for a hung tick.
 */
export async function runSelfHealTick(
  ctx: DaemonContext,
  signal: AbortSignal,
  deps: SelfHealDeps = defaultSelfHealDeps(),
): Promise<SelfHealTickOutcome> {
  if (!(await pathExists(getDaemonDir()))) return { ran: false, reason: 'no-daemon-dir' };
  const now = deps.now();
  const last = await readLastSelfHealAttempt();
  if (last !== null && now - last < SELF_HEAL_TICK_MS - SELF_HEAL_SKIP_SLACK_MS) return { ran: false, reason: 'recent' };
  try {
    await recordSelfHealAttempt(now);
  } catch (err) {
    // Without the stamp a crash mid-pass would re-run it on every restart, so do not run.
    ctx.log('ERROR', `self-heal: cannot record the attempt in ${lastAttemptPath()}, skipping the pass: ${err instanceof Error ? err.message : String(err)}`);
    return { ran: false, reason: 'stamp-unwritable' };
  }

  let result: CooperativeChildResult;
  try {
    result = await deps.runChild(signal);
  } catch (err) {
    ctx.log('ERROR', `self-heal: pass failed to run: ${err instanceof Error ? err.message : String(err)}`);
    return { ran: true, exitCode: null, cancelled: signal.aborted };
  }
  if (result.cancelled) {
    ctx.log('INFO', 'self-heal: pass cancelled (deadline or daemon shutdown)');
    return { ran: true, exitCode: result.exitCode, cancelled: true };
  }
  if (result.exitCode !== 0) {
    ctx.log('WARN', `self-heal: pass exited ${result.exitCode}: ${result.stdout.slice(0, 2000)}`);
    return { ran: true, exitCode: result.exitCode, cancelled: false };
  }
  let summary: SelfHealChildSummary;
  try {
    summary = JSON.parse(result.stdout) as SelfHealChildSummary;
  } catch {
    ctx.log('WARN', `self-heal: pass printed no summary: ${result.stdout.slice(0, 500)}`);
    return { ran: true, exitCode: 0, cancelled: false };
  }
  if (summary.changed || summary.needsAttention) ctx.log('INFO', `self-heal: ${summary.summary}`);
  return { ran: true, exitCode: 0, cancelled: false, summary };
}

export class SelfHealService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'self-heal';
  readonly intervalMs = SELF_HEAL_TICK_MS;
  readonly deadlineMs = SELF_HEAL_DEADLINE_MS;
  readonly startupDelayMs = SELF_HEAL_KICKOFF_MS;

  protected async onStart(_ctx: DaemonContext): Promise<void> {
    // No connections/handles to open — each tick spawns its own bounded child.
  }

  protected async onStop(): Promise<void> {
    // The supervisor aborts the in-flight tick's signal; driveCooperativeChild
    // turns that into an IPC cancel and reaps the child past the grace window.
  }

  protected async onTick(ctx: DaemonContext, signal: AbortSignal): Promise<void> {
    await runSelfHealTick(ctx, signal);
  }
}
