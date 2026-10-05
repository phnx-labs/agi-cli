
import * as fsp from 'fs/promises';
import * as path from 'path';
import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { getDaemonDir } from '../state.js';
import { getCliLaunch, getAgentsBinPath } from '../cli-entry.js';
import { driveCooperativeChild, type CooperativeChildResult } from './harness-update-service.js';
import { SELF_HEAL_CHILD_CMD, selfHealCancelMessage, type SelfHealChildSummary } from '../self-heal/child.js';

const SELF_HEAL_TICK_MS = 6 * 60 * 60_000;
const SELF_HEAL_DEADLINE_MS = 10 * 60_000;
const SELF_HEAL_KICKOFF_MS = 30_000;
const SELF_HEAL_CANCEL_GRACE_MS = 30_000;
const LAST_ATTEMPT_FILE = 'self-heal-last-attempt';
const SELF_HEAL_SKIP_SLACK_MS = 5 * 60_000;

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
  }

  protected async onStop(): Promise<void> {
  }

  protected async onTick(ctx: DaemonContext, signal: AbortSignal): Promise<void> {
    await runSelfHealTick(ctx, signal);
  }
}
