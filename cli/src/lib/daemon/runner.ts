/**
 * Job execution engine for routines.
 *
 * Builds agent-specific CLI commands from job configs, spawns them with
 * sandboxed or unsandboxed environments, captures stdout to log files,
 * enforces timeouts, and extracts the final assistant report from the
 * agent's stream-JSON output.
 *
 * Version/account selection mirrors `agents run`: when a routine does not pin
 * `version:`, the runner uses the configured run strategy (default `balanced`)
 * to pick a healthy install, pins the absolute binary via `getBinaryPath`, and
 * arms same-agent failover across other healthy accounts when a rate/usage
 * limit is detected mid-run (foreground `executeJob` only — detached daemon
 * fires once with the pre-flight pick).
 */

import { spawn, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { getCliLaunch, getAgentsBinDir } from '../cli-entry.js';
import type { JobConfig, RunMeta } from '../scheduling/routines.js';
import {
  resolveJobPrompt,
  parseTimeout,
  writeRunMeta,
  listRuns,
  getJobRunsDir,
  getRunDir,
  jobRunsOnThisDevice,
  checkJobDeviceEligibility,
  finalizeRunMeta,
  resolveJobExecutionContext,
  slotRunId,
  claimRunSlot,
  readRunMeta,
  resolveHostStrategy,
} from '../scheduling/routines.js';
import type { ResolvedExecutionContext, PlacementMode } from '../routine-context.js';
import { getRunsDir, getUserAgentsDir, readMeta, getDaemonDir } from '../state.js';
import type { AgentId } from '../types.js';
import { shortCodexHome } from '../codex-home.js';
import { prepareJobHome, buildSpawnEnv, getJobHomePath, assertSandboxForwardsHostGhAuth, linkVersionAuth } from '../sandbox.js';
import { resolveModel, buildReasoningFlags } from '../models.js';
import { createTimer, redactPrompt, emitRoutineEnd, emitRoutineEndAsync } from '../feed/events.js';
import { resolveHarnessAdapter } from '../harness/index.js';
import { applyAddDirs } from '../add-dir.js';
import {
  normalizeMode,
  resolveHeadlessMode,
  buildExecEnv,
  detectRateLimit,
  detectAuthFailure,
  isAuthFailureFromLog,
  authFailureReason,
  type ExecOptions,
  type ExecEffort,
  type FallbackEntry,
  AGENT_COMMANDS,
} from '../exec.js';
import { resolveActor } from '../actor.js';
import type { LoopDeps } from '../loop.js';
import { loadTask as loadHostTask } from '../hosts/tasks.js';
import { reconcileTask as reconcileHostTask, reconcileTaskAsync as reconcileHostTaskAsync } from '../hosts/reconcile.js';
import { backgroundSpawnOptions, isAlive, killTree } from '../platform/process.js';
import { execFileBounded } from '../exec-bounded.js';
import lockfile from 'proper-lockfile';
import { ensureLockTarget } from '../fs-atomic.js';
import { logAndContinueOnLockCompromised } from '../lock-compromise.js';
import { walkForFiles } from '../fs-walk.js';
import { getBinaryPath, isVersionInstalled, resolveVersion, getVersionHomePath } from '../installations/versions.js';
import { resolveClaudeSetupToken } from '../claude-account-token.js';
import {
  getConfiguredRunStrategy,
  resolveRunVersion,
  resolveAccountCandidate,
  resolveAccountVersion,
  rotationFailoverChain,
  readinessFromCandidate,
  formatNoHealthyAccountError,
  formatNoVerifiedUsageError,
  type RotateCandidate,
  type RotateResult,
} from '../accounting/rotate.js';
import { isHeadedDeviceRole, selfConfiguredDeviceRole } from '../device-config.js';
import { isSelfUpdatingAgent, ROUTINE_AGENT_IDS, isAgentHardDeprecated, hardDeprecationError } from '../agents.js';
import { isCustomHarnessName, readProfile } from '../profiles.js';
import { findAccount, findUnifiedAccount, resolveAccountSelection, resolveCredentialAccount } from '../account-registry.js';

/** Result of a completed job execution, including metadata and optional report. */
export interface RunResult {
  meta: RunMeta;
  reportPath: string | null;
}

export class RoutineAlreadyRunningError extends Error {
  constructor(jobName: string, runId: string) {
    super(`Routine '${jobName}' already has a running execution (${runId})`);
    this.name = 'RoutineAlreadyRunningError';
  }
}

const ROUTINE_LAUNCH_LOCK_STALE_MS = 30_000;
const ROUTINE_LAUNCH_LOCK_WAIT_MS = 10_000;

/**
 * The prior run of this routine that still holds the active-run slot, or null.
 *
 * ONLY a run still marked `running` can hold the slot. Every terminal status —
 * completed / failed / timeout / missed / blocked / skipped — releases it the
 * moment it is reached (RUSH-2640). A `failed`/`timeout` record used to keep the
 * slot while its pid stayed alive, but that conflated two different operations:
 * cleaning up a leftover process group (reapTerminalRoutineProcesses's job) with
 * occupying the slot. A daemon-launched run that reached a terminal state while
 * still carrying the daemon's own pid (a host run that threw `target_unreachable`
 * before spawning a child) then held the slot forever, because the daemon never
 * dies and `isPidOurs` never went false — every later scheduled slot was refused
 * with `already has an active run` while the routine was silently dead.
 *
 * A `running` record is also aged out past its own timeout: a run cannot
 * legitimately outlive its configured deadline, so past that window it is a
 * wedged record (a daemon that died mid-run, a missed child-exit event, a reused
 * pid an old record without `spawnedAt` reads as "ours"), not a live run — and it
 * never holds the slot regardless of what its recorded pid now points at.
 */
function activeRoutineRun(config: Pick<JobConfig, 'name' | 'timeout'>): RunMeta | null {
  const timeoutMs = parseTimeout(config.timeout) || 10 * 60 * 1000;
  const now = Date.now();
  const runs = listRuns(config.name);
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    if (run.status !== 'running') continue;
    const startedAt = Date.parse(run.startedAt);
    const limit = run.timeoutMs ?? timeoutMs;
    if (Number.isFinite(startedAt) && now - startedAt >= limit) continue;
    // A provisional launcher claim carries no child pid yet — trust it until the
    // timeout window above elapses. A record with a child pid is active only
    // while that pid is genuinely ours (alive with the same birth time).
    if (!run.pid) return run;
    if (isPidOurs(run.pid, run.spawnedAt)) return run;
  }
  return null;
}

/**
 * Consecutive trailing `skipped`/`active_run` records — a routine that keeps
 * being refused because a prior run "still owns" the slot. After the slot is
 * released correctly on terminal states (see {@link activeRoutineRun}) this can
 * only accumulate for a genuine long-overlap or a new wedge; either way it means
 * the routine has stopped firing on schedule and should be surfaced, not left to
 * pile up silently. `runs` is oldest→newest (listRuns sorts by run id).
 */
export function activeRunSkipStreak(runs: RunMeta[]): number {
  let streak = 0;
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    if (run.status === 'skipped' && run.skipReason === 'active_run') { streak++; continue; }
    break;
  }
  return streak;
}

/** How many consecutive active-run skips before a routine's stall is surfaced. */
const SKIP_STREAK_ALERT_THRESHOLD = 3;

/**
 * The pid to stamp on a launcher's provisional active claim, or null when the
 * launcher is this box's routines daemon.
 *
 * The claim pid exists so a launcher that dies between claiming the slot and
 * spawning the child releases the slot quickly (`isPidOurs` goes false) instead
 * of wedging it for the full timeout. That fast recovery only helps a SHORT-LIVED
 * foreground launcher (`agents routines run`): the daemon never dies between
 * claim and spawn, and recording ITS pid is actively harmful — the daemon
 * outlives every run, so `isPidOurs` never goes false and a claim finalized to a
 * terminal state before its child spawned kept the slot and drew
 * `reapTerminalRoutineProcesses` at the daemon's own process group on every tick
 * (RUSH-2640, requirement: never record the daemon's own pid as a run's pid). So
 * the daemon records no claim pid; the timeout window bounds a daemon that
 * crashes mid-claim instead.
 */
export function launcherClaimPid(): number | null {
  try {
    // Mirrors daemon.ts readDaemonPid() (PID_FILE = 'daemon.pid'); read directly
    // rather than importing it to avoid a runner<->daemon import cycle.
    const daemonPid = parseInt(fs.readFileSync(path.join(getDaemonDir(), 'daemon.pid'), 'utf-8').trim(), 10);
    if (Number.isFinite(daemonPid) && daemonPid === process.pid) return null;
  } catch { /* no daemon pid file — a foreground launcher; record its pid */ }
  return process.pid;
}

/** How a routine attempt was triggered, plus the schedule slot it belongs to. */
export interface RoutineTrigger {
  kind: NonNullable<RunMeta['triggerKind']>;
  /** UTC fire time for a schedule/catchup attempt; keys the single-fire slot claim. */
  scheduledFor?: Date | string;
}

/** A claimed attempt: the run id to use, plus the RunMeta fields to stamp on it. */
interface RoutineAttempt {
  runId: string;
  stamp: Partial<Pick<RunMeta, 'triggerKind' | 'scheduledFor' | 'project' | 'requestedCwd' | 'resolvedCwd'>>;
}

type AttemptAllocation =
  | { proceed: true; attempt: RoutineAttempt }
  /** No agent process is spawned; a terminal record (blocked/skipped) is already written. */
  | { proceed: false; terminal: RunMeta };

/** Serialize concurrent launches of one routine on this box (the on-disk claim
 *  primitive `claimRunSlot` is what holds across processes; this lock only makes
 *  the allocate→spawn window atomic within this process's launch paths). */
async function withRoutineLock<T>(config: JobConfig, launch: () => Promise<T>): Promise<T> {
  const target = path.join(getJobRunsDir(config.name), '.launch-claim');
  ensureLockTarget(target, '', 0o700);
  const release = await lockfile.lock(target, {
    stale: ROUTINE_LAUNCH_LOCK_STALE_MS,
    retries: {
      retries: Math.ceil(ROUTINE_LAUNCH_LOCK_WAIT_MS / 100),
      factor: 1,
      minTimeout: 100,
      maxTimeout: 100,
    },
    onCompromised: logAndContinueOnLockCompromised('routines launch'),
  });
  try {
    return await launch();
  } finally {
    await release();
  }
}

/**
 * Reject placement/body combinations the runner cannot execute — before the
 * attempt is allocated, so an invalid config (host+workflow, cloud+command, …)
 * throws cleanly rather than allocating a run record it can never satisfy. These
 * mirror the defensive guards inside `executeJobOnHost`/`executeJobOnCloud`;
 * `validateJob` already rejects the same combinations at add/edit time.
 */
function assertRunnablePlacement(config: JobConfig): void {
  const strategy = resolveHostStrategy(config);
  if (strategy === 'host' || strategy === 'fleet') {
    if (config.workflow) throw new Error(`Routine '${config.name}' runs a workflow bundle, which can't execute on a host yet — remove 'host:' or 'workflow:'.`);
    if (config.loop) throw new Error(`Routine '${config.name}' uses 'loop:', which can't execute on a host yet — remove 'host:' or 'loop:'.`);
    if (config.command) throw new Error(`Routine '${config.name}' uses 'command:', which can't execute on a host yet — remove 'host:' or 'command:'.`);
  }
  if (strategy === 'cloud') {
    if (config.workflow) throw new Error(`Routine '${config.name}' runs a workflow bundle, which can't execute in the cloud yet — remove 'hostStrategy: cloud' or 'workflow:'.`);
    if (config.loop) throw new Error(`Routine '${config.name}' uses 'loop:', which can't execute in the cloud yet — remove 'hostStrategy: cloud' or 'loop:'.`);
    if (config.command) throw new Error(`Routine '${config.name}' uses 'command:', which can't execute in the cloud yet — remove 'hostStrategy: cloud' or 'command:'.`);
  }
}

/** Write a pre-execution terminal record (blocked/skipped) that spawns nothing. */
function writeTerminalRecord(
  config: JobConfig,
  runId: string,
  status: RunMeta['status'],
  trigger: RoutineTrigger,
  extra: Partial<RunMeta>,
): RunMeta {
  fs.mkdirSync(getRunDir(config.name, runId), { recursive: true });
  const now = new Date().toISOString();
  const scheduledForIso = trigger.scheduledFor
    ? (typeof trigger.scheduledFor === 'string' ? trigger.scheduledFor : trigger.scheduledFor.toISOString())
    : undefined;
  const meta: RunMeta = {
    jobName: config.name,
    runId,
    ...runProvenance(config),
    ...(config.workflow ? { workflow: config.workflow } : config.command ? { command: config.command } : config.agent ? { agent: config.agent } : {}),
    triggerKind: trigger.kind,
    ...(scheduledForIso ? { scheduledFor: scheduledForIso } : {}),
    pid: null,
    spawnedAt: Date.now(),
    status,
    startedAt: now,
    completedAt: now,
    exitCode: null,
    duration: 0,
    ...extra,
  };
  writeRunMeta(meta);
  return meta;
}

/** Persist the cross-entry-point active claim before releasing the launch lock. */
function writeActiveClaim(config: JobConfig, attempt: RoutineAttempt): RunMeta {
  const now = new Date().toISOString();
  const meta: RunMeta = {
    jobName: config.name,
    runId: attempt.runId,
    ...runProvenance(config),
    ...attempt.stamp,
    ...(config.workflow ? { workflow: config.workflow } : config.command ? { command: config.command } : config.agent ? { agent: config.agent } : {}),
    // The launcher owns this provisional claim until the command/agent child
    // replaces it with its own pid. Recording a SHORT-LIVED foreground launcher's
    // pid makes a crash between lock release and child spawn recoverable instead
    // of wedging the routine for its full configured timeout. The long-lived
    // daemon records no pid here (see launcherClaimPid): its pid never dies, so
    // recording it wedged the slot forever and mis-aimed the process reaper at the
    // daemon itself (RUSH-2640).
    pid: launcherClaimPid(),
    // `isPidOurs` compares this value with the OS process birth time. The
    // daemon may have been alive for days before claiming a routine, so the
    // claim must carry the launcher's birth, not the claim timestamp.
    spawnedAt: Date.now() - process.uptime() * 1000,
    status: 'running',
    startedAt: now,
    completedAt: null,
    exitCode: null,
    timeoutMs: parseTimeout(config.timeout) || 10 * 60 * 1000,
  };
  writeRunMeta(meta);
  return meta;
}

/**
 * Allocate a routine attempt BEFORE any placement / version / sandbox / preflight
 * / dispatch work, so every rejected, skipped, or blocked fire leaves exactly one
 * visible terminal record. Runs inside {@link withRoutineLock}. Enforces, in order:
 *
 *  1. single-fire — a scheduled slot atomically claims its (routine, UTC) run
 *     directory; a duplicate cron delivery for the same slot returns the original
 *     attempt and spawns nothing.
 *  2. non-overlap — a prior run of this routine that is still active makes this
 *     attempt a `skipped`/`active_run` record linking the live run.
 *  3. readiness — an unresolved/blocked execution context (bad cwd, non-portable
 *     path, missing project base, …) makes this a `blocked` record.
 */
function allocateRoutineAttempt(config: JobConfig, trigger: RoutineTrigger): AttemptAllocation {
  const scheduledForIso = trigger.scheduledFor
    ? (typeof trigger.scheduledFor === 'string' ? trigger.scheduledFor : trigger.scheduledFor.toISOString())
    : undefined;

  // 1. Slot claim (schedule/catchup). Manual/webhook/event fires get a fresh id.
  let runId: string;
  if (scheduledForIso) {
    runId = slotRunId(scheduledForIso);
    if (!claimRunSlot(config.name, runId)) {
      const existing = readRunMeta(config.name, runId);
      if (existing) return { proceed: false, terminal: existing };
      return {
        proceed: false,
        terminal: writeTerminalRecord(config, generateRunId(), 'skipped', trigger, {
          skipReason: 'duplicate_slot',
          activeRunId: runId,
          errorMessage: 'duplicate schedule-slot delivery — the slot is already claimed',
        }),
      };
    }
  } else {
    runId = generateRunId();
    fs.mkdirSync(getRunDir(config.name, runId), { recursive: true });
  }

  // 2. Non-overlap: a prior run of THIS routine is still live.
  const active = activeRoutineRun(config);
  if (active && active.runId !== runId) {
    return {
      proceed: false,
      terminal: writeTerminalRecord(config, runId, 'skipped', trigger, {
        skipReason: 'active_run',
        activeRunId: active.runId,
        errorMessage: `skipped — '${config.name}' already has an active run (${active.runId})`,
      }),
    };
  }

  const eligibility = checkJobDeviceEligibility(config);
  if (eligibility) {
    return {
      proceed: false,
      terminal: writeTerminalRecord(config, runId, 'skipped', trigger, {
        skipReason: 'wrong_owner',
        errorMessage: eligibility.message,
      }),
    };
  }

  // Gate on deprecation alone, not ROUTINE_AGENT_IDS membership — a retired
  // harness leaves the command table (gemini did), and the legacy routine must
  // still land a visible 'blocked' record, never a generic buildJobCommand
  // failure (RUSH-2202).
  if (!config.workflow && config.agent && !isCustomHarnessName(config.agent) && isAgentHardDeprecated(config.agent as AgentId)) {
    const reason = hardDeprecationError(config.agent as AgentId);
    return {
      proceed: false,
      terminal: writeTerminalRecord(config, runId, 'blocked', trigger, {
        readiness: { code: 'agent_unavailable', message: reason },
        errorMessage: reason,
      }),
    };
  }

  try {
    assertRunnablePlacement(config);
  } catch (err) {
    const message = (err as Error).message;
    return {
      proceed: false,
      terminal: writeTerminalRecord(config, runId, 'blocked', trigger, {
        readiness: { code: 'placement_unsupported', message },
        errorMessage: message,
      }),
    };
  }

  // 3. Readiness: resolve the execution context for the routine's placement.
  //    Local placement inspects this box's filesystem; host/fleet/cloud defer
  //    existence (the remote fs is unreachable here) and enforce portability only.
  const mode: PlacementMode = resolveHostStrategy(config);
  const ctx = resolveJobExecutionContext(config, {
    mode,
    probe: mode === 'local' ? undefined : null,
  });
  const stamp: RoutineAttempt['stamp'] = {
    triggerKind: trigger.kind,
    ...(scheduledForIso ? { scheduledFor: scheduledForIso } : {}),
    ...(config.project ? { project: config.project } : {}),
    ...(config.cwd ? { requestedCwd: config.cwd } : {}),
    ...(ctx.resolvedCwd ? { resolvedCwd: ctx.resolvedCwd } : {}),
  };
  if (!ctx.ready) {
    return {
      proceed: false,
      terminal: writeTerminalRecord(config, runId, 'blocked', trigger, {
        ...stamp,
        readiness: ctx.readiness,
        errorMessage: `blocked: ${ctx.readiness?.code ?? 'not_ready'}${ctx.readiness?.message ? ` — ${ctx.readiness.message}` : ''}`,
      }),
    };
  }

  return { proceed: true, attempt: { runId, stamp } };
}

/**
 * Emit a loud, once-per-wedge warning when a routine has been refused its slot
 * for {@link SKIP_STREAK_ALERT_THRESHOLD} consecutive scheduled runs. Fires only
 * when the streak first reaches the threshold (not on every later skip), so a
 * genuinely-stalled routine surfaces once instead of piling up silent `skipped`
 * records the way RUSH-2640 did. Runs on the daemon's own stderr, so it lands in
 * the daemon log the operator reads.
 */
function surfaceWedgedRoutine(config: JobConfig, terminal: RunMeta): void {
  if (terminal.status !== 'skipped' || terminal.skipReason !== 'active_run') return;
  const streak = activeRunSkipStreak(listRuns(config.name));
  if (streak !== SKIP_STREAK_ALERT_THRESHOLD) return;
  const stuck = terminal.activeRunId ?? 'unknown';
  process.stderr.write(
    `[agents] routine '${config.name}' skipped ${streak} consecutive scheduled runs — ` +
    `its active-run slot is still held by ${stuck}; the routine is not firing on schedule.\n`,
  );
}

/**
 * Claim one routine attempt under the short launch lock, then execute after
 * releasing it. The persisted `running` claim makes a concurrent entry point
 * skip immediately instead of waiting for a foreground run to finish. `run` is
 * the placement/command/agent dispatch, invoked only when the attempt proceeds;
 * `wrapTerminal` adapts a pre-spawn terminal record into the caller's return type.
 */
async function runWithAttempt<T>(
  config: JobConfig,
  trigger: RoutineTrigger,
  run: (attempt: RoutineAttempt) => Promise<T>,
  wrapTerminal: (meta: RunMeta) => T,
): Promise<T> {
  const claimed: { terminal: RunMeta } | { attempt: RoutineAttempt } = await withRoutineLock(config, async () => {
    const alloc = allocateRoutineAttempt(config, trigger);
    if (!alloc.proceed) return { terminal: alloc.terminal };
    writeActiveClaim(config, alloc.attempt);
    return { attempt: alloc.attempt };
  });
  if ('terminal' in claimed) {
    surfaceWedgedRoutine(config, claimed.terminal);
    return wrapTerminal(claimed.terminal);
  }

  try {
    return await run(claimed.attempt);
  } catch (err) {
    const message = (err as Error).message;
    const existing = readRunMeta(config.name, claimed.attempt.runId);
    if (existing) {
      finalizeRunMeta(existing, 'failed', 1, { errorMessage: message });
      writeRunMeta(existing);
      return wrapTerminal(existing);
    }
    return wrapTerminal(writeTerminalRecord(config, claimed.attempt.runId, 'blocked', trigger, {
      ...claimed.attempt.stamp,
      readiness: { code: 'target_unreachable', message },
      errorMessage: message,
    }));
  }
}

function terminateRoutineTree(pid: number | null): void {
  if (!pid) return;
  // Never take THIS process down. Both kills below are unconditional SIGKILLs,
  // so a RunMeta naming the reaper's own pid -- a reused pid, a record written
  // by the process now doing the reaping, or a hand-written fixture -- makes the
  // reaper SIGKILL itself, and via `-pid` its whole process group with it. There
  // is no recovery from that: the run is never finalized, and on the daemon it
  // takes the scheduler down mid-sweep. daemon.ts:457 already refuses to evict an
  // incumbent whose pid is `process.pid` for exactly this reason; the reap path
  // needs the same guard. Skipping the kill still lets the caller finalize the
  // run record, which is the part that matters.
  if (pid === process.pid) return;
  if (process.platform === 'win32') {
    killTree(pid);
    return;
  }
  // Detached spawn makes the child a new process-group leader; kill the group.
  // If setsid has not landed yet (or the pid is not a leader), -pid fails with
  // ESRCH and the child stays up — also kill the pid itself.
  try {
    process.kill(-pid, 'SIGKILL');
  } catch { /* not a group leader, or already exited */ }
  try {
    process.kill(pid, 'SIGKILL');
  } catch { /* already exited */ }
}

/**
 * Where each agent's transcript files live under an overlay HOME, mirroring
 * `SESSION_ROOT_SPECS` (session/discover.ts) — the CLI's own source of truth
 * for which on-disk trees hold live session files. Kept in this shape (not a
 * shared import) because `archiveRoutineTranscripts` only needs a flat
 * root+ext pair to `walkForFiles`, not the version-home/backup fan-out
 * `getAgentSessionDirs` does for live discovery.
 *
 * `opencode` is deliberately absent: `SESSION_ROOT_SPECS` itself has no entry
 * for it — its transcripts live in one incrementally-scanned SQLite db
 * (`scanOpenCodeIncremental`), not a per-session file tree — so there is
 * nothing here to mirror without inventing a new discovery path.
 */
const ROUTINE_TRANSCRIPT_SPECS: Partial<Record<AgentId, Array<{ root: string[]; ext: string }>>> = {
  claude: [{ root: ['.claude', 'projects'], ext: '.jsonl' }],
  codex: [{ root: ['.codex', 'sessions'], ext: '.jsonl' }],
  cursor: [{ root: ['.cursor', 'projects'], ext: '.jsonl' }],
  gemini: [{ root: ['.gemini', 'tmp'], ext: '.json' }],
  antigravity: [{ root: ['.gemini', 'antigravity-cli', 'conversations'], ext: '.db' }],
  droid: [{ root: ['.factory', 'sessions'], ext: '.jsonl' }],
  // Kimi splits a session across two files (session/discover.ts:4382-4384):
  // state.json (title/timestamps) and agents/main/wire.jsonl (the actual
  // conversation). Both extensions are needed — .json alone archives only
  // the metadata shell and silently drops every message.
  kimi: [
    { root: ['.kimi-code', 'sessions'], ext: '.json' },
    { root: ['.kimi-code', 'sessions'], ext: '.jsonl' },
  ],
  grok: [{ root: ['.grok', 'sessions'], ext: '.json' }],
  // Muse: ~/.local/share/muse/sessions/YYYY/MM/DD/<uuid>/session.jsonl
  muse: [{ root: ['.local', 'share', 'muse', 'sessions'], ext: '.jsonl' }],
};

/**
 * Working directory for a routine's LOCAL child, resolved from its explicit
 * `project`/`cwd` execution anchor via {@link resolveJobExecutionContext} — never
 * inferred from `repo` (which is external repository identity only) and never the
 * daemon's launch cwd. A command routine with neither field lands in `$HOME`
 * (housekeeping); an unresolved/blocked agent context also falls back to `$HOME`
 * so a caller that reaches this (past the readiness gate) has a valid directory,
 * but the gate should have paused such a routine before it ever spawned.
 */
export function routineSpawnCwd(
  config: Pick<JobConfig, 'name' | 'project' | 'cwd' | 'agent' | 'workflow' | 'command'>,
): string {
  const ctx = resolveJobExecutionContext(config, { mode: 'local' });
  return ctx.absoluteCwd ?? os.homedir();
}

/**
 * Bake the daemon-job argv skeleton from AGENT_COMMANDS.
 *
 * The two tables used to be independent copies of the same launch decision.
 * Argv now comes from AGENT_COMMANDS.base / promptFlag / jsonFlags / modeFlags.
 * Two documented exceptions, not a second table:
 *   - kimi uses `--prompt` (long form). `-p` is the exec alias; combining
 *     either with --plan/--auto/--yolo aborts, so routineModeArgs emits no
 *     mode flag. The daemon has always spawned the long form.
 *   - claude places `--verbose` (from jsonFlags) before the prompt and bakes
 *     modeFlags.plan so claudeAdapter.routineModeArgs can splice
 *     plan → acceptEdits / auto / skip.
 *
 * Returns undefined when `agent` is outside ROUTINE_AGENT_IDS (gemini, grok,
 * and every other harness the daemon does not fire locally).
 */
export function bakeRoutineArgv(agent: string): string[] | undefined {
  if (!ROUTINE_AGENT_IDS.includes(agent)) return undefined;
  const template = AGENT_COMMANDS[agent as AgentId];
  if (!template) return undefined;

  const json = template.jsonFlags ?? [];
  const cmd = [...template.base];

  if (agent === 'kimi') {
    cmd.push('--prompt', '{prompt}', ...json);
    return cmd;
  }

  if (agent === 'claude') {
    const verbose = json.includes('--verbose') ? ['--verbose'] : [];
    const jsonRest = json.filter((flag) => flag !== '--verbose');
    cmd.push(template.promptFlag as string, ...verbose, '{prompt}', ...jsonRest, ...(template.modeFlags.plan ?? []));
    return cmd;
  }

  if (template.promptFlag === 'positional') {
    cmd.push('{prompt}', ...json);
  } else {
    cmd.push(template.promptFlag, '{prompt}', ...json);
  }
  return cmd;
}

/** Build the full CLI argv for executing a job, applying mode, model, and permission flags. */
export function buildJobCommand(config: JobConfig, resolvedPrompt: string, forwardAccount = true): string[] {
  // Workflow branch: delegate to `agents run <workflow>` which handles subagent
  // injection, WORKFLOW.md orchestration, and model selection via frontmatter.
  // appendModelAndReasoning is intentionally skipped — the workflow frontmatter
  // owns model selection. No --timeout flag: the runner enforces its own SIGTERM/SIGKILL.
  if (config.workflow) {
    const cmd = ['agents', 'run', config.workflow, resolvedPrompt, '--mode', config.mode];
    if (config.account && forwardAccount) cmd.push('--account', config.account);
    return cmd;
  }

  // Past the workflow branch this is an agent (or resume) job — command jobs never
  // reach buildJobCommand (execute*Job branches out first), and validateJob guarantees agent.
  const agent = config.agent!;

  // Resume branch: reopen an EXISTING session via `agents run <agent> --resume <id>`
  // instead of starting fresh. The real session resumes with its full prior context
  // (index-based lookup, cwd-independent) and `resolvedPrompt` becomes its next turn —
  // so a self-scheduled wake (e.g. /hibernate) is handled by the session that scheduled
  // it, not a fresh, context-less agent that would refuse an "opaque" instruction.
  if (config.resume) {
    const cmd = ['agents', 'run', agent, '--resume', config.resume, resolvedPrompt, '--mode', config.mode];
    if (config.account && forwardAccount) cmd.push('--account', config.account);
    return cmd;
  }

  // Custom-harness branch: delegate to `agents run <name>`, which owns profile
  // resolution (host binary, model env, provider auth) — the same delegation
  // the workflow and resume branches use. The profile pins its own version and
  // auth, so no command template, binary pinning, or account-env injection
  // applies here.
  if (isCustomHarnessName(agent)) {
    const cmd = ['agents', 'run', agent, resolvedPrompt, '--mode', config.mode];
    if (config.account && forwardAccount) cmd.push('--account', config.account);
    return cmd;
  }

  // The run resolver owns account configuration and credential materialization.
  if (config.account && forwardAccount) {
    const spec = config.version
      ? `${agent}@${config.version}`
      : `${agent}`;
    const cmd = ['agents', 'run', spec, resolvedPrompt, '--mode', config.mode, '--account', config.account, '--json'];
    if (config.config?.model) cmd.push('--model', String(config.config.model));
    const effort = config.config?.reasoning ?? config.effort;
    if (effort) cmd.push('--effort', String(effort));
    for (const dir of config.allow?.dirs ?? []) {
      if (!dir.startsWith('-')) cmd.push('--add-dir', dir.replace(/^~/, os.homedir()));
    }
    return cmd;
  }

  const template = bakeRoutineArgv(agent);
  if (!template) {
    // A name outside both tables was either never valid or was a custom
    // harness whose profile has since been deleted — validateJob accepted it
    // against a profile that existed then. Name the repair, not just the miss.
    throw new Error(
      `Unsupported agent for daemon jobs: ${agent}. ` +
      `If '${agent}' was a custom harness, its profile no longer exists on this device — ` +
      `recreate it (agents harness add ${agent} ...) or point the routine at another agent.`,
    );
  }

  let cmd = template.map((part) => part.replace('{prompt}', resolvedPrompt));

  // Canonicalize mode (accepts legacy `full` as alias for `skip`).
  const mode = normalizeMode(config.mode);

  // Routine launch-arg quirks (the harness axis of Move 3): each per-agent arm
  // moves to its harness adapter; runner appends model/reasoning flags after,
  // exactly as every arm did. Agents with no routine quirk have no adapter
  // override, so they skip both — the old behavior for an entry with no arm.
  const routineAdapter = resolveHarnessAdapter(agent as AgentId);
  if (routineAdapter.routineModeArgs) {
    routineAdapter.routineModeArgs(cmd, { mode, config, resolveHeadlessMode });
    appendModelAndReasoning(cmd, config);
  }

  // allow.dirs → harness-specific grants. Codex is handled in its branch above
  // (workspace_roots). Claude / Kimi / Cursor take --add-dir; Grok gets rules
  // (+ sandbox widen when GROK_SANDBOX is on). Reject leading '-' so a routine
  // YAML can't smuggle an argv flag past the sandbox as an allow.dirs entry.
  if (config.allow?.dirs?.length && agent !== 'codex') {
    for (const dir of config.allow.dirs) {
      if (dir.startsWith('-')) {
        throw new Error(`allow.dirs entries must not start with '-': ${JSON.stringify(dir)}`);
      }
    }
    applyAddDirs(agent as AgentId, cmd, config.allow.dirs, {
      cwd: routineSpawnCwd(config),
    });
  }

  return cmd;
}

/**
 * Append the agent's canonical model flag and reasoning flags to a command.
 *
 * Pass-through model resolution: validates against the installed (agent, version)
 * catalog when possible and writes a warning to stderr on miss, but never blocks.
 * Reasoning level (config.config.reasoning) maps to per-agent flags via models.ts.
 */
function appendModelAndReasoning(cmd: string[], config: JobConfig): void {
  // Only called from buildJobCommand's agent path AFTER the custom-harness
  // branch returned — config.agent is a native id here.
  const agent = config.agent! as AgentId;
  const model = config.config?.model as string | undefined;
  if (model) {
    const modelFlag = AGENT_COMMANDS[agent].modelFlag;
    if (!modelFlag) {
      throw new Error(`Agent ${agent} does not support routine model selection`);
    }
    if (config.version) {
      const resolved = resolveModel(agent, config.version, model);
      if (resolved.warning) {
        process.stderr.write(`[agents] ${resolved.warning}\n`);
      }
      cmd.push(modelFlag, resolved.forwarded);
    } else {
      cmd.push(modelFlag, model);
    }
  }

  const reasoning = config.config?.reasoning as string | undefined;
  if (reasoning) {
    const flags = buildReasoningFlags(agent, reasoning);
    if (flags.length > 0) cmd.push(...flags);
  }
}

function generateRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Agents whose config dir `buildExecEnv` relocates OUT of the sandbox overlay HOME
 * into their per-version home (exec.ts: CLAUDE_CONFIG_DIR / CODEX_HOME). A routine
 * spawned for one of these writes its transcript under the version home, NOT the overlay
 * the sandbox generated — so the archiver has to read it there. Both are version-pinned
 * (never self-updating), so `RunMeta.version` names a real home.
 *
 * Scoped to the agents whose archived transcript the DISCOVERY side can already index as
 * origin='routine' — `readRoutineArchiveMeta` (session/discover.ts) has a branch for
 * claude and codex but not kimi. Kimi also relocates (KIMI_CODE_HOME) and hits the same
 * bug, but archiving it here without a discovery branch would only copy files that are
 * never indexed; adding a kimi reader (its session spans state.json + wire.jsonl under a
 * `session_<uuid>` dir) is the separate follow-up that lets kimi join this set. Muse
 * (XDG, self-updating) and copilot (no transcript spec) are likewise out of scope.
 */
const CONFIG_DIR_RELOCATED_AGENTS = new Set<AgentId>(['claude', 'codex']);

/** Whether this run's transcript lands in a SHARED per-version home (accumulating every
 *  session that version+account ever ran) rather than the run's own disposable overlay. */
function usesSharedTranscriptHome(agent: AgentId, version: string | undefined): boolean {
  return Boolean(version) && CONFIG_DIR_RELOCATED_AGENTS.has(agent);
}

/**
 * The directories the child actually writes a transcript to for one spec — resolved to
 * match `buildExecEnv` (exec.ts), the single decision-point for where the transcript
 * lands, so the archiver can never drift from it. For a config-dir-relocated agent that
 * is the per-version home (`.claude`, `.codex`, …); for everyone else it is the sandbox
 * overlay HOME. Codex may run from a SUN_LEN-safe short home on macOS (codex-home.ts),
 * so both candidates are returned and the caller skips whichever does not exist.
 */
function routineTranscriptSourceRoots(
  agent: AgentId,
  version: string | undefined,
  overlayHome: string,
  spec: { root: string[] },
  execHome?: string,
): string[] {
  if (execHome) return [path.join(execHome, ...spec.root)];
  if (usesSharedTranscriptHome(agent, version)) {
    const roots = [path.join(getVersionHomePath(agent, version!), ...spec.root)];
    if (agent === 'codex') {
      roots.push(path.join(shortCodexHome(getUserAgentsDir(), version!), ...spec.root.slice(1)));
    }
    return roots;
  }
  return [path.join(overlayHome, ...spec.root)];
}

/** Path of the per-run baseline recorded before spawn (see {@link snapshotRoutineTranscriptBase}). */
function transcriptBasePath(runDir: string): string {
  return path.join(runDir, '.transcript-base.json');
}

/**
 * Record every transcript file already present in the child's transcript dirs BEFORE
 * the run spawns. When the transcript lands in a shared per-version home, this baseline
 * is what lets the archiver copy only the file THIS run produced instead of sweeping in
 * every sibling session that home holds (which would mis-tag them all `origin='routine'`
 * under this run's name). Called once per run, before spawn.
 */
export function snapshotRoutineTranscriptBase(
  meta: Pick<RunMeta, 'jobName' | 'agent' | 'version' | 'execHome'>,
  runDir: string,
  overlayHome?: string,
): void {
  if (!meta.agent) return;
  // A host/cloud custom-harness run records the harness name, which has no
  // transcript spec — the null-specs guard below skips it, as before.
  const specs = ROUTINE_TRANSCRIPT_SPECS[meta.agent as AgentId];
  if (!specs) return;

  const home = overlayHome ?? getJobHomePath(meta.jobName);
  const preexisting = new Set<string>();
  for (const spec of specs) {
    for (const root of routineTranscriptSourceRoots(meta.agent as AgentId, meta.version, home, spec, meta.execHome)) {
      if (!fs.existsSync(root)) continue;
      for (const f of walkForFiles(root, spec.ext, 100_000)) preexisting.add(f);
    }
  }
  try {
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(transcriptBasePath(runDir), JSON.stringify([...preexisting]), { mode: 0o600 });
  } catch {
    // Best-effort: a missing baseline is handled conservatively at archive time
    // (a shared home is skipped rather than bulk-copied).
  }
}

/** Read the pre-spawn baseline. `null` means none was recorded (older run or a failed
 *  snapshot) — the archiver then refuses to bulk-copy a shared home. */
function readTranscriptBase(runDir: string): Set<string> | null {
  try {
    const arr = JSON.parse(fs.readFileSync(transcriptBasePath(runDir), 'utf-8'));
    if (Array.isArray(arr)) return new Set(arr.filter((x): x is string => typeof x === 'string'));
  } catch {
    // No baseline file, or it was unreadable/corrupt.
  }
  return null;
}

export function archiveRoutineTranscripts(
  meta: Pick<RunMeta, 'jobName' | 'runId' | 'agent' | 'version' | 'execHome'>,
  runDir: string,
  overlayHome?: string,
): void {
  if (!meta.agent) return;
  // A host/cloud custom-harness run records the harness name, which has no
  // transcript spec — the null-specs guard below skips it, as before.
  const specs = ROUTINE_TRANSCRIPT_SPECS[meta.agent as AgentId];
  if (!specs) return;

  const home = overlayHome ?? getJobHomePath(meta.jobName);
  const shared = Boolean(meta.execHome) || usesSharedTranscriptHome(meta.agent as AgentId, meta.version);
  const base = readTranscriptBase(runDir);
  // A shared per-version home holds every session that version+account ran, so without a
  // per-run baseline we cannot tell this run's transcript from a sibling's — copy nothing
  // rather than mis-tag them all. A disposable overlay is this run's alone, so copy all.
  if (shared && base === null) return;

  for (const spec of specs) {
    const destRoot = path.join(runDir, 'sessions', meta.agent, spec.root[spec.root.length - 1]);
    for (const sourceRoot of routineTranscriptSourceRoots(meta.agent as AgentId, meta.version, home, spec, meta.execHome)) {
      if (!fs.existsSync(sourceRoot)) continue;
      for (const sourcePath of walkForFiles(sourceRoot, spec.ext, 100_000)) {
        // Skip files that predate this run (a sibling session in the shared home).
        if (base?.has(sourcePath)) continue;
        const rel = path.relative(sourceRoot, sourcePath);
        if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
        const destPath = path.join(destRoot, rel);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        try {
          fs.copyFileSync(sourcePath, destPath);
          fs.chmodSync(destPath, 0o600);
        } catch {
          // The process already reached a terminal state; a concurrently removed
          // transcript should not rewrite that outcome.
        }
      }
    }
  }
}

/**
 * Build the argv for a command-mode routine: run the shell string directly
 * through the platform shell. No agent binary, no rotation, no sandbox.
 */
function buildShellCommand(command: string): string[] {
  return process.platform === 'win32'
    ? ['cmd', '/c', command]
    : ['/bin/sh', '-c', command];
}

/**
 * Real (un-sandboxed) environment for a command routine. Command routines do
 * `npm i -g` / `git pull` and need the actual $HOME / $PATH, not the sandbox
 * overlay. Only TZ is injected when the routine pins a timezone.
 *
 * The current binary's directory is prepended to PATH so bare `agents` invocations
 * resolve to the same install on Windows (where shell-function injection is not
 * available) and as a fallback on POSIX for invocations like `command agents`.
 */
function commandSpawnEnv(config: JobConfig): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  if (config.timezone) env.TZ = config.timezone;
  const sep = process.platform === 'win32' ? ';' : ':';
  const binDir = getAgentsBinDir();
  const existing = env.PATH ?? '';
  if (!existing.split(sep).includes(binDir)) {
    env.PATH = existing ? `${binDir}${sep}${existing}` : binDir;
  }
  return env;
}

/** POSIX single-quote a string so it is safe to embed in a `/bin/sh -c` script. */
function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build a POSIX shell function that forwards `agents <sub...>` to the SAME binary
 * currently running. Command routines shell out to the bare name `agents`
 * (e.g. `agents repo pull system`); without this, the routine resolves `agents`
 * through its inherited PATH, which can pick up a stale install in an nvm/system
 * Node prefix that shadows the current binary (RUSH-2431).
 *
 * Uses getCliLaunch so the relaunch is correct for both JS installs
 * (`node <entry> <sub...>`) and compiled standalone binaries (`<bin> <sub...>`).
 */
function agentsShellFunction(): string {
  const launch = getCliLaunch(['__ac_placeholder__']);
  const parts: string[] = [launch.command];
  // JS installs: getCliLaunch returns [node, entryScript, placeholder].
  // Standalone: it returns [binary, placeholder].
  if (launch.args.length > 0 && launch.args[0] !== '__ac_placeholder__' && fs.existsSync(launch.args[0])) {
    parts.push(launch.args[0]);
  }
  const invocation = parts.map(shSingleQuote).join(' ');
  return `agents() { ${invocation} "$@"; }`;
}

/**
 * Wrap a command-routine shell string so any bare `agents` invocation resolves
 * to the current binary. On POSIX this injects an `agents` shell function; on
 * Windows it is left unchanged and commandSpawnEnv prepends the current binary's
 * directory to PATH instead.
 */
function wrapCommandRoutine(command: string): string {
  if (process.platform === 'win32') return command;
  return `${agentsShellFunction()}\n${command}`;
}

/**
 * Detached command routines write their own exit code to `<runDir>/exit-code`
 * (see the wrapper in executeCommandJobDetached). `monitorRunningJobs` reads it
 * to recover the true terminal status when the daemon restarted between spawn and
 * exit and so missed the in-process `child.on('exit')`. Returns null when the
 * file is absent/unparseable (child killed or crashed before writing it).
 */
function readCommandExitCode(runDir: string): number | null {
  try {
    const raw = fs.readFileSync(path.join(runDir, 'exit-code'), 'utf-8').trim();
    if (!/^-?\d+$/.test(raw)) return null;
    return parseInt(raw, 10);
  } catch {
    return null;
  }
}

/** Pre-flight version/account selection for a routine job. */
export interface RoutineLaunchPlan {
  /** Ordered attempts: primary first, then same-agent failover accounts. */
  chain: Array<FallbackEntry & { account?: string; candidate?: RotateCandidate }>;
  /** Full rotation result when strategy selected among healthy accounts; null when pinned. */
  rotation: RotateResult | null;
  /** True when `config.version` pinned the target (no rotation). */
  pinned: boolean;
  /**
   * When true, `buildJobCommand` appends `--account`. Native slot accounts
   * share one managed-install version, so the pin is forwarded rather than
   * treated as implied by the version. False only when the caller opts out.
   */
  forwardAccount?: boolean;
}

/**
 * Resolve the version/account chain for a routine the same way `agents run`
 * does: honor an explicit `version:` pin; otherwise use the configured run
 * strategy (default `balanced`) so credit-exhausted / rate-limited accounts
 * are skipped pre-flight, and synthesize a same-agent failover chain from the
 * other healthy accounts for mid-run rate limits.
 *
 * Workflows are left alone — `agents run <workflow>` owns selection.
 */
export async function resolveRoutineLaunch(
  config: JobConfig,
  cwd: string = process.cwd(),
  deps: {
    resolveRunVersion?: typeof resolveRunVersion;
    resolveAccountVersion?: typeof resolveAccountVersion;
    resolveAccountCandidate?: typeof resolveAccountCandidate;
    findCredentialAccount?: (name: string) => boolean;
    readMeta?: typeof readMeta;
    resolveCredentialAccount?: (name: string, host: AgentId) => { env: Record<string, string> };
  } = {},
): Promise<RoutineLaunchPlan> {
  if (config.workflow) {
    return { chain: [], rotation: null, pinned: false };
  }
  if (config.agent && isCustomHarnessName(config.agent)) {
    // A custom harness pins its own version/auth in the profile, so there is
    // no version/account chain to resolve here — `agents run <name>` owns it
    // (matching exec's "strategy ignored: custom harness pins its own
    // version/auth").
    return { chain: [], rotation: null, pinned: false };
  }

  // resolveRoutineLaunch is only called for agent jobs (workflow returns above;
  // command jobs branch out of execute*Job before reaching this).
  const agent = config.agent! as AgentId;
  const { findAccount, findUnifiedAccount, resolveAccountSelection, resolveCredentialAccount } = await import('../account-registry.js');
  const meta = (deps.readMeta ?? readMeta)();
  const explicitCredential = config.account
    ? (deps.findCredentialAccount?.(config.account) ?? (deps.resolveCredentialAccount !== undefined || findAccount(config.account) !== null))
    : false;
  const selectedCredential = config.account
    ? (explicitCredential ? config.account : undefined)
    : resolveAccountSelection(undefined, agent, meta)?.id;
  if (selectedCredential && !config.account) {
    return resolveRoutineLaunch({ ...config, account: selectedCredential }, cwd, deps);
  }
  if (selectedCredential) {
    // A default/binding may resolve to a native account — never route that
    // through the provider credential path (it has no bundle to resolve).
    const unified = findUnifiedAccount(selectedCredential, meta);
    if (unified?.kind !== 'native') (deps.resolveCredentialAccount ?? resolveCredentialAccount)(selectedCredential, agent);
  }
  if (config.account && explicitCredential) {
    return {
      chain: [{ agent, version: config.version ?? resolveVersion(agent, cwd) ?? undefined, account: config.account }],
      rotation: null,
      pinned: true,
      forwardAccount: true,
    };
  }
  if (config.account && !explicitCredential) {
    // A native routine account is named by its durable name; the version matcher
    // keys on the identity (email/accountKey), so translate before resolving,
    // and refuse a login that belongs to a different harness. Scope the lookup to
    // the routine's own harness: `identityLabel` defaults to the login's email, so
    // `account: <email>` matches every harness that identity is signed into, and
    // un-scoped this resolved whichever row the store ordered first — then rejected
    // it on the very next line.
    const unified = findUnifiedAccount(config.account, meta, undefined, agent);
    if (unified?.kind === 'native' && unified.agent !== agent) {
      throw new Error(`Routine '${config.name}' account '${config.account}' is a ${unified.agent} login and cannot authenticate ${agent}.`);
    }
    const identity = unified?.kind === 'native' ? unified.identityKey : config.account;
    // Prefer the full candidate so a slot-sourced native account (shared
    // managed-install `version`) still carries its name for `--account`.
    const candidate = deps.resolveAccountVersion ? undefined : await (deps.resolveAccountCandidate ?? resolveAccountCandidate)(agent, identity);
    const accountVersion = deps.resolveAccountVersion
      ? await deps.resolveAccountVersion(agent, identity)
      : candidate?.version ?? null;
    if (accountVersion) {
      return {
        chain: [{ agent, version: config.version ?? accountVersion, ...(candidate ? { candidate, account: config.account } : {}) }],
        rotation: null,
        pinned: true,
        // Post-T5 every native slot on a harness shares the managed binary
        // version, so the version pin is no longer enough — forward `--account`
        // (name or `#name`) so spawn resolves the selected slot.
        forwardAccount: true,
      };
    }
    throw new Error(
      `Routine '${config.name}' account '${config.account}' is not signed in for ${agent}; refusing to rotate to another account.`,
    );
  }

  // A per-routine strategy travels with the definition and beats the firing
  // box's ambient run.<agent>.strategy — otherwise selection policy silently
  // depends on whichever device fires the job (RUSH-2719).
  const strategy = config.strategy ?? getConfiguredRunStrategy(agent, cwd);
  let version: string | undefined;
  let rotation: RotateResult | null = null;
  let exhausted: RotateCandidate[] | undefined;
  let noVerifiedUsage = false;
  try {
    const resolved = await (deps.resolveRunVersion ?? resolveRunVersion)(agent, strategy, cwd);
    version = resolved.version ?? undefined;
    rotation = resolved.rotation;
    exhausted = resolved.exhausted;
    noVerifiedUsage = resolved.noVerifiedUsage ?? false;
    if (noVerifiedUsage) {
      // Entirely stale usage (PHNX-2526): a routine is unattended, so there is
      // no picker to divert to — it fails loud below rather than launch on a
      // stale number. Do NOT log `rotation.picked` as a pick; it is the refused
      // stale candidate, kept only for the failover chain.
      process.stderr.write(
        `[agents] routine ${config.name}: ${strategy} found no ${agent} account with fresh usage — refusing to route on stale data\n`,
      );
    } else if (rotation) {
      const label = rotation.picked.email
        ? `${rotation.picked.email} · ${agent}@${rotation.picked.version}`
        : `${agent}@${rotation.picked.version}`;
      const ratio = `${rotation.healthy.length} of ${rotation.healthy.length + rotation.excluded.length} healthy`;
      process.stderr.write(
        `[agents] routine ${config.name}: ${strategy} picked ${label} (${ratio})\n`,
      );
      if (rotation.excluded.length > 0) {
        const reasons = rotation.excluded
          .map((c) => {
            const r = readinessFromCandidate(c);
            const why = r.ready ? 'deduped' : r.reason;
            return `${c.agent}@${c.version}=${why}`;
          })
          .join(', ');
        process.stderr.write(
          `[agents] routine ${config.name}: skipped ${reasons}\n`,
        );
      }
    } else if (!version && !exhausted) {
      process.stderr.write(
        `[agents] routine ${config.name}: strategy ${strategy} found no usable ${agent} version; ` +
          `falling back to default pin\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `[agents] routine ${config.name}: strategy ${strategy} skipped: ${(err as Error).message}\n`,
    );
  }

  // Zero healthy accounts is NOT a "fall back to the default pin" case — that
  // pin is exactly the exhausted account an unattended routine would hammer
  // every tick (RUSH-2132). Throwing fails the job run (nonzero), and the
  // message text is the contract the Factory watchdog tail-detects.
  if (exhausted) {
    throw new Error(formatNoHealthyAccountError(agent, strategy, exhausted));
  }

  // Entirely stale usage is also NOT a "fall back to the default pin" case — the
  // default is exactly the account whose stale number can't be trusted. Fail the
  // run loud (NO_VERIFIED_USAGE) rather than hammer it every tick (PHNX-2526).
  if (noVerifiedUsage) {
    throw new Error(formatNoVerifiedUsageError(agent, strategy, rotation?.healthy ?? []));
  }

  if (!version) {
    version = config.version ?? resolveVersion(agent, cwd) ?? undefined;
  }

  if (!version) {
    process.stderr.write(
      `[agents] routine ${config.name}: no version of ${agent} configured — ` +
        `run: agents add ${agent}@<version> && agents use ${agent} <version>\n`,
    );
    return { chain: [{ agent }], rotation: null, pinned: false };
  }

  const failover = rotationFailoverChain(rotation, version);
  if (failover.length > 0) {
    const labels = failover.map((f) => `${f.agent}@${f.version}`).join(', ');
    process.stderr.write(
      `[agents] routine ${config.name}: credit/rate-limit failover armed → ${labels}\n`,
    );
  }

  return {
    chain: rotation
      ? [rotation.picked, ...rotation.healthy.filter((candidate) => candidate !== rotation!.picked)].map((candidate) => ({
          agent: candidate.agent, version: config.version ?? candidate.version,
          account: candidate.nativeAccount ?? candidate.providerAccount, candidate,
        }))
      : [{ agent, version: config.version ?? version, ...(config.account ? { account: config.account } : {}) }],
    rotation,
    pinned: Boolean(config.version),
  };
}

/**
 * Rewrite `cmd[0]` to the absolute binary for `agent@version` when installed.
 * Bypasses the bare-name shim so a sandboxed HOME / missing default pin cannot
 * surface as "agents: no version of X configured".
 */
export function pinJobBinary(cmd: string[], agent: AgentId, version: string | undefined): string[] {
  if (!version || cmd.length === 0) return cmd;
  if (!isVersionInstalled(agent, version)) return cmd;
  const binary = getBinaryPath(agent, version);
  if (!binary || !fs.existsSync(binary)) return cmd;
  const next = [...cmd];
  next[0] = binary;
  return next;
}

/**
 * Whether a job's command is dispatched through `agents run` (so `cmd[0] === 'agents'`)
 * rather than the agent binary directly. True for workflow jobs and for resume jobs.
 * Such commands must NOT be binary-pinned (pinning rewrites cmd[0] to the agent binary,
 * producing a broken `<binary> run …`) and must not receive a version-pinned spawn env.
 */
/** SSH forwards an account selector for target-local resolution; cloud does not
 * yet provide that provisioning boundary. Native OAuth never crosses devices. */
export async function assertRoutineAccountLocalForPlacement(
  config: Pick<JobConfig, 'name' | 'account'>,
  mode: 'host' | 'cloud',
  deps: { account?: import('../account-registry.js').UnifiedAccount | null; readMeta?: typeof readMeta } = {},
): Promise<void> {
  if (!config.account) return;
  let account = deps.account;
  if (account === undefined) {
    const { findUnifiedAccount } = await import('../account-registry.js');
    account = findUnifiedAccount(config.account, (deps.readMeta ?? readMeta)());
  }
  if (!account) {
    throw new Error(`Routine '${config.name}' account '${config.account}' is unknown.`);
  }
  if (mode === 'cloud' && account?.kind === 'native') {
    throw new Error(`Routine '${config.name}' account '${config.account}' is a device-local ${account.agent} login and cannot run on a ${mode} placement. Use a provider account, or place this routine on the device that holds the login.`);
  }
  if (mode === 'cloud' && account?.kind === 'provider') {
    // RUSH-2689: cloud+provider injection not yet implemented.
    throw new Error(`Routine '${config.name}' account '${config.account}' is a provider credential; cloud placement cannot securely inject it (RUSH-2689). Run this routine locally or on a host that holds the bundle.`);
  }
}

export async function dispatchPlacedJob(
  config: JobConfig,
  target: import('../routines-placement.js').PlacementTarget,
  attempt: RoutineAttempt,
  deps: {
    account?: import('../account-registry.js').UnifiedAccount | null;
    host?: typeof executeJobOnHost;
    cloud?: typeof executeJobOnCloud;
  } = {},
): Promise<RunResult | undefined> {
  if (target.mode !== 'host' && target.mode !== 'cloud') return undefined;
  await assertRoutineAccountLocalForPlacement(config, target.mode, { account: deps.account });
  if (target.mode === 'host') {
    return (deps.host ?? executeJobOnHost)({ ...config, host: target.host }, { detached: false }, attempt);
  }
  return (deps.cloud ?? executeJobOnCloud)(config, { detached: false }, attempt);
}

/**
 * Build the options passed to `dispatchPromptToHost` for a host routine. Split
 * out so the execution boundary is unit-testable: it MUST forward the routine's
 * `account` by name (the remote resolves its own local bundle; no secret copied)
 * — dropping it silently ran the remote under the wrong identity.
 */
export function buildHostDispatchOptions(
  config: JobConfig,
  ctx: { remoteCwd: string | undefined; runDir: string; detached: boolean },
): import('../hosts/run-target.js').HostPromptRun {
  return {
    agent: config.agent!,
    version: config.version,
    strategy: config.strategy,
    prompt: resolveJobPrompt(config),
    mode: normalizeMode(config.mode),
    effort: config.effort,
    model: config.config?.model as string | undefined,
    account: config.account,
    timeout: config.timeout, // enforced by the REMOTE agents run
    remoteCwd: ctx.remoteCwd,
    name: config.name,
    cwd: ctx.runDir,
    follow: !ctx.detached,
  };
}

export function dispatchesViaAgentsRun(config: Pick<JobConfig, 'workflow' | 'resume' | 'agent' | 'account'>): boolean {
  return Boolean(
    config.workflow
    || config.resume
    || (config.agent && isCustomHarnessName(config.agent))
    || (config.account && config.agent),
  );
}

/**
 * Inject a provider account's env into a routine spawn. Native accounts do not
 * belong here — they re-enter `agents run <agent>#<name>` so T5 slot resolution
 * picks the HOME. A provider-pinned routine stays on this path so the durable
 * credential is still in the child env (PHNX-3940 T5 seam / T7).
 */
export function mergeRoutineProviderEnv(
  env: Record<string, string>,
  config: Pick<JobConfig, 'account' | 'agent' | 'workflow' | 'resume'>,
  agent: AgentId,
): Record<string, string> {
  if (dispatchesViaAgentsRun({ ...config, agent })) return env;
  const meta = readMeta();
  const selected = resolveAccountSelection(config.account, agent, meta);
  if (!selected) return env;
  const unified = findUnifiedAccount(selected.id, meta, undefined, agent);
  if (unified?.kind !== 'provider') return env;
  Object.assign(env, resolveCredentialAccount(unified.name, agent).env);
  return env;
}

/**
 * Merge sandbox/base env with the canonical per-version exec env
 * (CLAUDE_CONFIG_DIR / CODEX_HOME / …) so routines share account isolation
 * with `agents run`.
 */
export function buildRoutineSpawnEnv(
  baseEnv: Record<string, string>,
  agent: AgentId,
  version: string | undefined,
  timezone?: string,
  overlayHome?: string,
  candidate?: RotateCandidate,
): Record<string, string> {
  const execEnv = buildExecEnv({
    agent,
    version,
    mode: 'plan',
    effort: 'auto',
    headless: true,
    execHome: candidate?.slotDir,
    env: baseEnv,
  });
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(execEnv)) {
    if (v !== undefined) out[k] = v;
  }
  // CLAUDE_CODE_OAUTH_TOKEN comes in two flavours, and only one is safe for a
  // routine. KEEP a per-account `claude setup-token` (long-lived, NON-rotating,
  // keyed to this home's own account) that buildExecEnv injected from the reserved
  // `auth` bundle (resolveClaudeSetupToken) — that is the durable cure for the
  // single-use-refresh-token revocation storm: a setup-token never rotates, so a
  // scheduled routine can't land on a sibling home's just-rotated-out credential.
  // STRIP an INHERITED ambient value instead: buildExecEnv spreads process.env
  // (exec.ts) and sanitizeProcessEnv leaves credentials, so a daemon env that
  // happens to carry a shared/rotating CLAUDE_CODE_OAUTH_TOKEN would otherwise make
  // every routine run on that one token — the RUSH-1822 fleet-wide-logout path.
  // Distinguish by value: only the resolved setup-token survives.
  // Authoritative: buildExecEnv injects the setup-token but then spreads the caller
  // env over it, so an ambient CLAUDE_CODE_OAUTH_TOKEN would win — re-assert here.
  const setupToken = agent === 'claude' && version
    ? resolveClaudeSetupToken(candidate?.slotDir ?? getVersionHomePath('claude', version))
    : null;
  // A headed device (personal or desktop — the user's own interactive box or a
  // headed always-on box) uses the per-version login for EVERY run, routines
  // included — the setup-token is a worker-only credential (RUSH-2395, mirrors
  // the claude adapter's headed-device branch). On a headed box, only strip an
  // inherited copy of the account's OWN setup-token by value so a leaked ambient
  // value can't override the login; a token the user set deliberately is a
  // different string and survives.
  if (isHeadedDeviceRole(selfConfiguredDeviceRole())) {
    if (setupToken && out.CLAUDE_CODE_OAUTH_TOKEN === setupToken) delete out.CLAUDE_CODE_OAUTH_TOKEN;
  } else if (setupToken) {
    out.CLAUDE_CODE_OAUTH_TOKEN = setupToken;
  } else {
    delete out.CLAUDE_CODE_OAUTH_TOKEN;
  }
  if (agent === 'cursor' && overlayHome) {
    // prepareJobHome links this host's Cursor auth file here. Pin XDG_CONFIG_HOME
    // to the overlay so an ambient value cannot bypass the routine sandbox.
    out.XDG_CONFIG_HOME = path.join(overlayHome, '.config');
  }
  if (overlayHome && agent === 'claude') out.HOME = process.env.AGENTS_REAL_HOME || os.homedir();
  if (overlayHome && agent === 'codex' && !candidate?.slotDir) out.CODEX_HOME = path.join(overlayHome, '.codex');
  if (timezone) out.TZ = timezone;
  return out;
}

/** One spawn attempt result for the single-shot executeJob path. */
interface SpawnAttemptResult {
  exitCode: number | null;
  status: 'completed' | 'failed' | 'timeout';
  error?: string;
  /** Combined log content (stdout+stderr) for rate-limit scanning. */
  logText: string;
  pid: number | null;
}

/**
 * Spawn one attempt, capture logs to `attemptLogPath`, enforce timeout.
 * Rate-limit scanning uses only this attempt's log (not prior failover output).
 * The attempt log is also appended into `combinedLogPath` for a continuous trail.
 */
function spawnJobAttempt(
  cmd: string[],
  env: Record<string, string>,
  attemptLogPath: string,
  timeoutMs: number,
  combinedLogPath?: string,
  cwd: string = os.homedir(),
): Promise<SpawnAttemptResult> {
  // Isolate this attempt's output so detectRateLimit never sees prior attempts.
  fs.writeFileSync(attemptLogPath, '', { mode: 0o600 });
  const stdoutFd = fs.openSync(attemptLogPath, 'a', 0o600);
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), {
      stdio: ['ignore', stdoutFd, stdoutFd],
      ...backgroundSpawnOptions({ cwd, fdStdio: true }),
      env,
    });

    let settled = false;
    const finish = (result: SpawnAttemptResult) => {
      if (settled) return;
      settled = true;
      try { fs.closeSync(stdoutFd); } catch { /* fd already closed */ }
      let logText = '';
      try {
        logText = fs.readFileSync(attemptLogPath, 'utf-8');
      } catch { /* missing log */ }
      if (combinedLogPath) {
        try {
          fs.appendFileSync(combinedLogPath, logText);
        } catch { /* best-effort trail */ }
      }
      resolve({ ...result, logText });
    };

    const timeoutTimer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch { /* process already exited */ }
      setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch { /* process already exited */ }
      }, 5000);
      finish({
        exitCode: null,
        status: 'timeout',
        pid: child.pid || null,
        logText: '',
      });
    }, timeoutMs);

    child.on('exit', (code) => {
      clearTimeout(timeoutTimer);
      finish({
        exitCode: code,
        status: code === 0 ? 'completed' : 'failed',
        pid: child.pid || null,
        logText: '',
      });
    });

    child.on('error', (err) => {
      clearTimeout(timeoutTimer);
      finish({
        exitCode: 1,
        status: 'failed',
        error: err.message,
        pid: child.pid || null,
        logText: '',
      });
    });

    child.unref();
  });
}

/**
 * Execute a job synchronously (waits for completion or timeout before resolving).
 *
 * When `config.loop` is set the job is routed through the loop driver (`runLoop`
 * from loop.ts) instead of a single spawn — same driver as `agents run --loop` and
 * workflow `loop:` blocks (issue #400). The optional `deps` parameter provides
 * injectable seams (runIteration, sleep, writeCheckpoint) used by tests; production
 * callers omit it and get the defaults.
 *
 * Single-shot path: pre-flight version/account selection + mid-run rate-limit
 * failover across healthy same-agent accounts (RUSH-1016).
 */
/**
 * Actor provenance for a routine run (RUSH-2020): `actor` is the routine's
 * CREATOR (carried from the job config), `triggeredBy` is whoever kicked off THIS
 * run (`resolveActor().id` — a person for a manual run, `UNRESOLVED@<host>` for an
 * unattended scheduled fire). Spread into every RunMeta so a fired cron traces
 * back to the person who scheduled it.
 */
function runProvenance(config: JobConfig): { actor?: string; triggeredBy: string } {
  return { ...(config.actor ? { actor: config.actor } : {}), triggeredBy: resolveActor().id };
}

/**
 * Inject the routine creator's actor into a run's base env so the fired agent
 * INHERITS it (the `AGENTS_ACTOR` path in actor.ts) instead of re-resolving to
 * `UNRESOLVED@<host>` on an unattended fire — so its session, events, and commits
 * all attribute to the person who scheduled the routine (RUSH-2020). Mutates and
 * returns the same env object for call-site brevity.
 */
function injectRoutineActor(env: Record<string, string>, config: JobConfig): Record<string, string> {
  if (config.actor && !env.AGENTS_ACTOR) env.AGENTS_ACTOR = config.actor;
  return env;
}

export async function executeJob(
  config: JobConfig,
  deps?: LoopDeps,
  trigger: RoutineTrigger = { kind: 'manual' },
): Promise<RunResult> {
  // Unified attempt: allocate + persist the run record (or a terminal blocked/
  // skipped record) BEFORE placement, version selection, sandbox, or preflight —
  // and hold the active-run claim so a manual run cannot overlap a scheduled one.
  return runWithAttempt(
    config,
    trigger,
    (attempt) => executeJobPlaced(config, deps, attempt),
    (meta) => ({ meta, reportPath: null }),
  );
}

async function executeJobPlaced(config: JobConfig, deps: LoopDeps | undefined, attempt: RoutineAttempt): Promise<RunResult> {
  // Placement (hostStrategy / bare host:) — body may run on another machine
  // over SSH or in the cloud; local version selection / sandbox / spawn then
  // do not apply. Sync callers (manual `routines run`, catchup) follow the
  // remote run to completion when possible.
  {
    const { resolvePlacementTarget } = await import('../routines-placement.js');
    const target = await resolvePlacementTarget(config);
    const placed = await dispatchPlacedJob(config, target, attempt);
    if (placed) return placed;
  }

  // Command-mode: run a plain shell command directly (no agent, no rotation,
  // no pinning, no sandbox overlay). Reuses the run-record machinery so
  // list/runs/overdue keep working.
  if (config.command) {
    return executeCommandJobForeground(config, attempt);
  }

  const launch = await resolveRoutineLaunch(config);
  if (launch.chain[0]?.account) config = { ...config, account: launch.chain[0].account, version: launch.chain[0].version };
  const primaryVersion = launch.chain[0]?.version ?? config.version;

  const timer = createTimer('agent.run', {
    agent: config.agent,
    version: primaryVersion,
    jobName: config.name,
    mode: config.mode,
    ...redactPrompt(config.prompt),
    schedule: config.schedule,
  });

  const resolvedPrompt = resolveJobPrompt(config);

  // Resume must run against the REAL home: `--resume <id>` resolves the session from
  // the agent's config dir, and the sandbox overlay home has only a freshly-generated
  // config with no session store. So a resume job is never sandboxed, regardless of
  // `config.sandbox` (see the resume branch in buildJobCommand).
  // Resume needs the REAL home (session store); a custom harness needs it too —
  // the delegated `agents run <name>` resolves ~/.agents (profiles, setup
  // sentinel, version homes) from HOME, which the overlay would hide. Exec
  // still isolates the run in the host version home it swaps HOME into.
  const useSandbox = config.sandbox !== false && !config.resume && !(config.agent && isCustomHarnessName(config.agent));
  const overlayHome = useSandbox ? prepareJobHome(config, primaryVersion) : undefined;

  const runId = attempt.runId;
  const runDir = getRunDir(config.name, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const baseEnv = injectRoutineActor(
    useSandbox
      ? buildSpawnEnv(overlayHome!, config.env)
      : { ...process.env } as Record<string, string>,
    config,
  );

  // Workflows run via `agents run <workflow>` which delegates to claude under the hood.
  // Use 'claude' as the effective agent for report extraction and metadata when workflow is set.
  // (command jobs branched out earlier, so config.agent is set on the non-workflow path.)
  // Custom harness/profile name (e.g. `deepseek`) stays on harnessName; the
  // HOST CLI is effectiveAgent. The loop path spawns in-process via runLoop
  // and never re-enters `agents run`, so it must stamp harnessName itself
  // (PHNX-2935) — same field commands/exec.ts sets on ExecOptions.
  const harnessName = !config.workflow && config.agent && isCustomHarnessName(config.agent)
    ? config.agent
    : undefined;
  const effectiveAgent: AgentId = config.workflow
    ? 'claude'
    : harnessName
      ? readProfile(harnessName).host.agent
      : config.agent! as AgentId;
  mergeRoutineProviderEnv(baseEnv, config, effectiveAgent);

  // RUSH-2860: if this host holds gh auth, the sandbox child MUST see it.
  if (useSandbox) assertSandboxForwardsHostGhAuth(baseEnv);

  const meta: RunMeta = {
    jobName: config.name,
    runId,
    ...runProvenance(config),
    ...attempt.stamp,
    agent: effectiveAgent,
    version: primaryVersion,
    execHome: launch.chain[0]?.candidate?.slotDir,
    accountKey: launch.chain[0]?.candidate?.accountKey ?? undefined,
    ...(config.workflow ? { workflow: config.workflow } : {}),
    pid: null,
    spawnedAt: Date.now(),
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    exitCode: null,
  };
  writeRunMeta(meta);
  // Baseline the child's transcript dirs BEFORE spawning so archiveRoutineTranscripts
  // copies only THIS run's transcript out of a shared per-version home (RUSH-2271).
  snapshotRoutineTranscriptBase(meta, runDir, overlayHome);

  // Auth preflight: if the resolved account is provably signed out (revoked or
  // unconfigured), record a terminal `blocked`/`agent_auth_failed` run with the
  // re-login repair instead of spawning a doomed run that 401s and burns a
  // session (PHNX-3415). `blocked` (readiness rejection, no body ran) is kept
  // distinct from `failed` (a body ran and errored) per RT-7. Cache-only + fails
  // OPEN — see fireTimeAuthReadiness.
  const preflightVersion = launch.chain[0]?.version;
  // Dynamic import breaks the routine-readiness -> scheduling/routines -> runner cycle.
  const { fireTimeAuthReadiness } = await import('../routine-readiness.js');
  const authBlocker = preflightVersion ? fireTimeAuthReadiness(effectiveAgent, preflightVersion, launch.chain[0]?.candidate) : null;
  if (authBlocker) {
    process.stderr.write(
      `[agents] routine ${config.name}: ${effectiveAgent}@${preflightVersion} ${authBlocker.code} — skipping run (${authBlocker.repair})\n`,
    );
    meta.readiness = authBlocker;
    finalizeRunMeta(meta, 'blocked', null, { errorMessage: `blocked: ${authBlocker.code} — ${authBlocker.message}` });
    writeRunMeta(meta);
    timer.end({ status: 'blocked', runId, error: authBlocker.code });
    archiveRoutineTranscripts(meta, runDir, overlayHome);
    return { meta, reportPath: null };
  }

  const timeoutMs = parseTimeout(config.timeout) || 10 * 60 * 1000;

  // Loop path: delegate to runLoop (same driver as `agents run --loop` / workflow loop:).
  if (config.loop) {
    const spawnEnv = buildRoutineSpawnEnv(baseEnv, effectiveAgent, primaryVersion, config.timezone, overlayHome, launch.chain[0]?.candidate);
    if (config.account && findUnifiedAccount(config.account, readMeta())?.kind === 'provider') {
      Object.assign(spawnEnv, resolveCredentialAccount(config.account, effectiveAgent).env);
    }
    const execOptions: ExecOptions = {
      agent: effectiveAgent,
      harnessName,
      execHome: launch.chain[0]?.candidate?.slotDir,
      // Routine-supported self-updating CLIs (Cursor/Droid) use one global
      // binary; a versioned shim would point at a nonexistent isolated install.
      version: isSelfUpdatingAgent(effectiveAgent) ? undefined : primaryVersion,
      prompt: resolvedPrompt,
      mode: normalizeMode(config.mode),
      effort: config.effort as ExecEffort,
      env: spawnEnv,
      json: true,
      headless: true,
      modeWarningContext: `routine ${config.name}`,
      modeWarningState: {},
      ...(config.config?.model ? { model: config.config.model as string } : {}),
      ...(config.allow?.dirs ? {
        addDirs: config.allow.dirs
          .filter((d) => !d.startsWith('-'))
          .map((d) => d.replace(/^~/, os.homedir())),
      } : {}),
    };
    const { runLoop } = await import('../loop.js');
    const loopResult = await runLoop(execOptions, config.loop, {
      runId,
      runDir,
      agent: effectiveAgent,
      version: primaryVersion,
    }, deps);
    const loopFailed = loopResult.stoppedBy === 'error';
    finalizeRunMeta(
      meta,
      loopFailed ? 'failed' : 'completed',
      loopFailed ? 1 : 0,
      loopFailed ? { errorMessage: `loop stopped: ${loopResult.stoppedBy}` } : undefined,
    );
    writeRunMeta(meta);
    timer.end({ status: meta.status, exitCode: meta.exitCode ?? undefined, runId });
    archiveRoutineTranscripts(meta, runDir, overlayHome);
    return { meta, reportPath: null };
  }

  // Single-shot path: build the command once, then walk the launch chain on
  // rate/usage-limit failures (same detectRateLimit patterns as agents run).
  const baseCmd = buildJobCommand(config, resolvedPrompt, launch.forwardAccount !== false);
  const stdoutPath = path.join(runDir, 'stdout.log');
  // Truncate the log for a clean run; failover attempts append.
  fs.writeFileSync(stdoutPath, '', { mode: 0o600 });

  const chain: RoutineLaunchPlan['chain'] = launch.chain.length > 0
    ? launch.chain
    : [{ agent: effectiveAgent, version: primaryVersion }];

  timer.mark('startup');

  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];
    const attemptAgent = entry.agent;
    const attemptVersion = entry.version;
    const label = attemptVersion ? `${attemptAgent}@${attemptVersion}` : attemptAgent;

    if (i === 0) {
      process.stderr.write(`[agents] routine ${config.name}: running ${label}\n`);
    }

    // A rate-limit failover spawns the NEXT chain entry, whose version/account has
    // its own per-version transcript home. Re-point meta.version at the attempt that
    // is about to run and re-baseline that home, so the archiver reads the transcript
    // where THIS attempt writes it — not chain[0]'s home (RUSH-2271). The pre-loop
    // snapshot already covered chain[0]; this makes every later attempt correct too.
    meta.version = attemptVersion;
    meta.execHome = entry.candidate?.slotDir;
    meta.accountKey = entry.candidate?.accountKey ?? undefined;
    snapshotRoutineTranscriptBase(meta, runDir, overlayHome);

    const attemptConfig = { ...config, version: attemptVersion, account: entry.account ?? config.account };
    const viaAgentsRun = dispatchesViaAgentsRun(attemptConfig);
    if (overlayHome) linkVersionAuth(overlayHome, attemptAgent, attemptVersion);
    const cmd = viaAgentsRun
      ? buildJobCommand(attemptConfig, resolvedPrompt, launch.forwardAccount !== false)
      : pinJobBinary(baseCmd, attemptAgent, attemptVersion);
    const spawnEnv = viaAgentsRun
      ? (() => {
          const e = { ...baseEnv };
          if (config.timezone) e.TZ = config.timezone;
          return e;
        })()
      : buildRoutineSpawnEnv(baseEnv, attemptAgent, attemptVersion, config.timezone, overlayHome);

    // Remaining timeout budget shared across failover attempts.
    const elapsed = Date.now() - Date.parse(meta.startedAt);
    const remaining = Math.max(1_000, timeoutMs - (Number.isFinite(elapsed) ? elapsed : 0));

    const attemptLogPath = path.join(runDir, `stdout.attempt-${i}.log`);
    const attempt = await spawnJobAttempt(cmd, spawnEnv, attemptLogPath, remaining, stdoutPath, routineSpawnCwd(config));
    meta.pid = attempt.pid;
    writeRunMeta(meta);

    if (attempt.status === 'timeout') {
      finalizeRunMeta(meta, 'timeout', null, { errorMessage: 'run timed out' });
      writeRunMeta(meta);
      timer.end({ status: 'timeout', runId });
      const reportPath = extractAndSaveReport(stdoutPath, effectiveAgent, runDir);
      archiveRoutineTranscripts(meta, runDir, overlayHome);
      return { meta, reportPath };
    }

    if (attempt.status === 'completed') {
      // Exit code alone is unreliable for auth: a logged-out Claude can exit 0
      // with a `result` event carrying is_error:true (terminal_reason
      // "completed"). Consult the SAME structural signal the detached path uses
      // so both paths agree — raw text is deliberately NOT used here, so a
      // genuinely-completed run that merely mentions an auth phrase stays a
      // success (processFailed:false).
      if (isAuthFailureFromLog(attempt.logText, effectiveAgent, { processFailed: false })) {
        const reason = authFailureReason(attempt.logText) ?? 'authentication_failed';
        finalizeRunMeta(meta, 'failed', attempt.exitCode ?? 1, { errorMessage: `auth_failed: ${reason}` });
        writeRunMeta(meta);
        timer.end({ status: 'failed', exitCode: meta.exitCode ?? undefined, runId, error: `auth_failed: ${reason}` });
        // Never persist the login-error text as the report.
        archiveRoutineTranscripts(meta, runDir, overlayHome);
        return { meta, reportPath: null };
      }
      finalizeRunMeta(meta, 'completed', 0);
      writeRunMeta(meta);
      timer.end({ status: 'completed', exitCode: 0, runId });
      const reportPath = extractAndSaveReport(stdoutPath, effectiveAgent, runDir);
      archiveRoutineTranscripts(meta, runDir, overlayHome);
      return { meta, reportPath };
    }

    // Failed — cascade only on rate/usage limit when more chain entries remain.
    const isLast = i === chain.length - 1;
    const rateLimited = detectRateLimit(attempt.logText) || (attempt.error ? detectRateLimit(attempt.error) : false);
    if (!isLast && rateLimited) {
      const next = chain[i + 1];
      const nextLabel = next.version ? `${next.agent}@${next.version}` : next.agent;
      process.stderr.write(
        `[agents] routine ${config.name}: ${label} failed with credit/rate limit, trying ${nextLabel}\n`,
      );
      fs.appendFileSync(
        stdoutPath,
        `\n[agents] ${label} hit rate/usage limit — failover → ${nextLabel}\n`,
      );
      continue;
    }

    // Auth failure — the agent is logged out / token revoked. Unlike a rate
    // limit it is not self-healing by failover (every chain entry on the same
    // account fails identically), so rate-limit is classified first (above) and
    // auth only when NOT rate-limited. Classified so the failure is visible and,
    // critically, so the login-error text is never persisted as the report.
    const authFailed = !rateLimited && (
      isAuthFailureFromLog(attempt.logText, effectiveAgent, { processFailed: true }) ||
      (attempt.error ? detectAuthFailure(attempt.error) : false)
    );

    if (attempt.error) {
      process.stderr.write(
        `[agents] routine ${config.name}: spawn failed for ${label}: ${attempt.error}\n`,
      );
    }

    const authReason = authFailed
      ? (authFailureReason(attempt.logText)
          ?? (attempt.error ? authFailureReason(attempt.error) : null)
          ?? 'authentication_failed')
      : null;
    const failureErrorMessage = authReason
      ? `auth_failed: ${authReason}`
      : (attempt.error ?? undefined);

    finalizeRunMeta(meta, 'failed', attempt.exitCode ?? 1, failureErrorMessage ? { errorMessage: failureErrorMessage } : undefined);
    writeRunMeta(meta);
    timer.end({
      status: 'failed',
      exitCode: meta.exitCode ?? undefined,
      runId,
      ...(failureErrorMessage ? { error: failureErrorMessage } : {}),
    });
    // On auth failure the last assistant text IS the login error — never persist
    // it as report.md; it would otherwise be injected into the next run's prompt
    // via {last_report}.
    const reportPath = authFailed ? null : extractAndSaveReport(stdoutPath, effectiveAgent, runDir);
    archiveRoutineTranscripts(meta, runDir, overlayHome);
    return { meta, reportPath };
  }

  // Unreachable: chain is always non-empty, but keep a safe fallback.
  finalizeRunMeta(meta, 'failed', 1);
  writeRunMeta(meta);
  timer.end({ status: 'failed', exitCode: 1, runId });
  return { meta, reportPath: null };
}

/**
 * Dispatch a routine to the agent's native cloud provider (or the configured
 * default). Writes a local run record with `cloudTaskId` so list/runs still
 * work; does not wait for cloud completion on the detached path.
 */
async function executeJobOnCloud(config: JobConfig, opts: { detached: boolean }, attempt: RoutineAttempt): Promise<RunResult> {
  if (config.workflow) {
    throw new Error(`Routine '${config.name}' runs a workflow bundle, which can't execute in the cloud yet — remove 'hostStrategy: cloud' or 'workflow:'.`);
  }
  if (config.loop) {
    throw new Error(`Routine '${config.name}' uses 'loop:', which can't execute in the cloud yet — remove 'hostStrategy: cloud' or 'loop:'.`);
  }
  if (config.command) {
    throw new Error(`Routine '${config.name}' uses 'command:', which can't execute in the cloud yet — remove 'hostStrategy: cloud' or 'command:'.`);
  }
  if (!config.agent) {
    throw new Error(`Routine '${config.name}' hostStrategy: cloud requires an agent`);
  }

  const { resolveProvider } = await import('../cloud/registry.js');
  const { insertTask } = await import('../cloud/store.js');
  const provider = resolveProvider(undefined, config.agent);

  const timer = createTimer('agent.run', {
    agent: config.agent,
    jobName: config.name,
    mode: config.mode,
    placement: 'cloud',
    ...redactPrompt(config.prompt),
    schedule: config.schedule,
  });

  const runId = attempt.runId;
  const runDir = getRunDir(config.name, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const meta: RunMeta = {
    jobName: config.name,
    runId,
    ...runProvenance(config),
    ...attempt.stamp,
    agent: config.agent,
    pid: null,
    spawnedAt: Date.now(),
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    exitCode: null,
  };
  writeRunMeta(meta);

  try {
    const task = await provider.dispatch({
      prompt: resolveJobPrompt(config),
      agent: config.agent,
      repo: config.repo,
      timeout: config.timeout,
      model: config.config?.model as string | undefined,
    });
    try { insertTask(task); } catch { /* store is best-effort */ }
    meta.cloudTaskId = task.id;
    meta.cloudProvider = task.provider;

    // Terminal cloud responses (e.g. antigravity) finalize immediately.
    // Async providers leave the run `running` with the cloud task id for
    // the user to follow via `agents cloud status`.
    if (task.status === 'completed') {
      finalizeRunMeta(meta, 'completed', 0);
    } else if (task.status === 'failed' || task.status === 'cancelled') {
      finalizeRunMeta(meta, 'failed', 1, { errorMessage: task.summary ?? `cloud ${task.status}` });
    }
    // Non-terminal statuses stay `running` for both detached and sync paths;
    // the user follows via `agents cloud status <id>`.
    writeRunMeta(meta);
    timer.end({ status: meta.status, exitCode: meta.exitCode ?? undefined, runId });
    return { meta, reportPath: null };
  } catch (err) {
    finalizeRunMeta(meta, 'failed', 1, { errorMessage: (err as Error).message });
    writeRunMeta(meta);
    timer.end({ status: 'failed', exitCode: 1, runId, error: (err as Error).message });
    throw err;
  }
}

async function executeJobOnHost(config: JobConfig, opts: { detached: boolean }, attempt: RoutineAttempt): Promise<RunResult> {
  if (config.workflow) {
    throw new Error(`Routine '${config.name}' runs a workflow bundle, which can't execute on a host yet — remove 'host:' or 'workflow:'.`);
  }
  if (config.loop) {
    throw new Error(`Routine '${config.name}' uses 'loop:', which can't execute on a host yet — remove 'host:' or 'loop:'.`);
  }
  if (config.command) {
    throw new Error(`Routine '${config.name}' uses 'command:', which can't execute on a host yet — remove 'host:' or 'command:'.`);
  }
  const { resolveHostRunTarget, dispatchPromptToHost } = await import('../hosts/run-target.js');
  const host = await resolveHostRunTarget(config.host!);
  const { evaluateHostActivationReadiness } = await import('../routine-readiness.js');
  const readiness = await evaluateHostActivationReadiness(config);
  if (!readiness.ready) throw new Error(`${readiness.readiness?.code ?? 'not_ready'}: ${readiness.readiness?.message ?? 'target is not ready'}`);
  const remoteCwd = readiness.context.resolvedCwd;

  const timer = createTimer('agent.run', {
    agent: config.agent,
    jobName: config.name,
    mode: config.mode,
    host: host.name,
    ...redactPrompt(config.prompt),
    schedule: config.schedule,
  });

  const runId = attempt.runId;
  const runDir = getRunDir(config.name, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const meta: RunMeta = {
    jobName: config.name,
    runId,
    ...runProvenance(config),
    ...attempt.stamp,
    agent: config.agent,
    pid: null, // no local process — the run lives on the host
    spawnedAt: Date.now(),
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    exitCode: null,
    host: host.name,
  };
  writeRunMeta(meta);

  const { task, exitCode } = await dispatchPromptToHost(host, buildHostDispatchOptions(config, { remoteCwd, runDir, detached: opts.detached }));
  meta.hostTaskId = task.id;

  // Sync path: a real exit code finalizes now. -1 (follow window closed) and
  // the detached path leave the meta `running` for the monitor to reconcile.
  if (!opts.detached && exitCode !== null && exitCode !== undefined && exitCode !== -1) {
    finalizeRunMeta(meta, exitCode === 0 ? 'completed' : 'failed', exitCode);
  }
  writeRunMeta(meta);
  timer.end({ status: meta.status, exitCode: meta.exitCode ?? undefined, runId });
  return { meta, reportPath: null };
}

/** Spawn a job as a detached process and return immediately with run metadata. */

async function executeCommandJobForeground(config: JobConfig, attempt: RoutineAttempt): Promise<RunResult> {
  const timer = createTimer('agent.run', {
    jobName: config.name,
    mode: config.mode,
    schedule: config.schedule,
  });

  const runId = attempt.runId;
  const runDir = getRunDir(config.name, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const stdoutPath = path.join(runDir, 'stdout.log');
  const stdoutFd = fs.openSync(stdoutPath, 'w', 0o600);

  const meta: RunMeta = {
    jobName: config.name,
    runId,
    ...runProvenance(config),
    ...attempt.stamp,
    command: config.command,
    pid: null,
    spawnedAt: Date.now(),
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    exitCode: null,
  };
  writeRunMeta(meta);

  const timeoutMs = parseTimeout(config.timeout) || 10 * 60 * 1000;
  const cmd = buildShellCommand(wrapCommandRoutine(config.command!));
  const env = commandSpawnEnv(config);

  process.stderr.write(`[agents] routine ${config.name}: running command\n`);

  const result = await new Promise<{ exitCode: number | null; status: 'completed' | 'failed' | 'timeout'; error?: string }>((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), {
      stdio: ['ignore', stdoutFd, stdoutFd],
      ...backgroundSpawnOptions({ cwd: routineSpawnCwd(config), fdStdio: true }),
      env,
    });

    meta.pid = child.pid || null;
    writeRunMeta(meta);

    let settled = false;
    const finish = (r: { exitCode: number | null; status: 'completed' | 'failed' | 'timeout'; error?: string }) => {
      if (settled) return;
      settled = true;
      try { fs.closeSync(stdoutFd); } catch { /* fd already closed */ }
      resolve(r);
    };

    const timeoutTimer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch { /* process already exited */ }
      setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch { /* process already exited */ }
      }, 5000);
      finish({ exitCode: null, status: 'timeout' });
    }, timeoutMs);

    child.on('exit', (code) => {
      clearTimeout(timeoutTimer);
      finish({ exitCode: code, status: code === 0 ? 'completed' : 'failed' });
    });

    child.on('error', (err) => {
      clearTimeout(timeoutTimer);
      finish({ exitCode: 1, status: 'failed', error: err.message });
    });
  });

  finalizeRunMeta(
    meta,
    result.status,
    result.exitCode ?? (result.status === 'completed' ? 0 : 1),
    result.error ? { errorMessage: result.error } : undefined,
  );
  writeRunMeta(meta);

  if (result.error) {
    process.stderr.write(`[agents] routine ${config.name}: command spawn failed: ${result.error}\n`);
  }
  timer.end({
    status: meta.status,
    exitCode: meta.exitCode ?? undefined,
    runId,
    ...(result.error ? { error: result.error } : {}),
  });

  return { meta, reportPath: null };
}

/**
 * Optional lifecycle callbacks for a detached routine run. The daemon passes an
 * `onFinish` that fires the branded finish/output notification (RUSH-2030) — it
 * runs from the in-process settle() when the child exits, the only seam that
 * observes the live running→terminal transition (the monitor tick would already
 * see a finalized record and skip it). Never let a hook throw into finalization.
 */
export interface RoutineHooks {
  /** Called once with the finalized meta when the run reaches a terminal state. */
  onFinish?: (meta: RunMeta) => void;
}

/** Invoke a lifecycle hook without letting a caller error break run finalization. */
function safeHook(fn: (() => void) | undefined): void {
  if (!fn) return;
  try { fn(); } catch { /* hooks are best-effort */ }
}

/** Spawn a job as a detached process and return immediately with run metadata. */
export async function executeJobDetached(
  config: JobConfig,
  hooks?: RoutineHooks,
  trigger: RoutineTrigger = { kind: 'manual' },
): Promise<RunMeta> {
  return runWithAttempt(
    config,
    trigger,
    (attempt) => executeJobDetachedClaimed(config, attempt, hooks),
    (meta) => meta,
  );
}

async function executeJobDetachedClaimed(config: JobConfig, attempt: RoutineAttempt, hooks?: RoutineHooks): Promise<RunMeta> {
  // Placement (hostStrategy / bare host:) — dispatch off-box and return; the
  // monitor finalizes host: runs, cloud runs stay terminal when dispatch ends.
  // Either way the in-process onFinish hook does not fire for off-box routines
  // (the monitor tick observes an already-finalized record), so notify-desktop
  // sends the finish notification only for local detached runs below (RUSH-2030).
  {
    const { resolvePlacementTarget } = await import('../routines-placement.js');
    const target = await resolvePlacementTarget(config);
    if (target.mode === 'host' || target.mode === 'cloud') {
      await assertRoutineAccountLocalForPlacement(config, target.mode);
    }
    if (target.mode === 'host') {
      const { meta } = await executeJobOnHost({ ...config, host: target.host }, { detached: true }, attempt);
      if (meta.status !== 'running') emitRoutineEnd(meta);
      return meta;
    }
    if (target.mode === 'cloud') {
      const { meta } = await executeJobOnCloud(config, { detached: true }, attempt);
      if (meta.status !== 'running') emitRoutineEnd(meta);
      return meta;
    }
  }

  // Command-mode: fire a plain shell command detached (no agent, no rotation,
  // no pinning, no sandbox overlay). Still writes a run record so the daemon,
  // list/runs, and overdue tracking keep working.
  if (config.command) {
    return executeCommandJobDetached(config, attempt, hooks);
  }

  // Pre-flight: pick a healthy version/account so the daemon does not launch
  // into a credit-exhausted install. Detached cannot mid-run failover (no exit
  // wait); the next schedule tick re-selects if this attempt still fails.
  const launch = await resolveRoutineLaunch(config);
  if (launch.chain[0]?.account) config = { ...config, account: launch.chain[0].account, version: launch.chain[0].version };
  const version = launch.chain[0]?.version ?? config.version;

  const timer = createTimer('agent.run', {
    agent: config.agent,
    version,
    jobName: config.name,
    mode: config.mode,
    ...redactPrompt(config.prompt),
    schedule: config.schedule,
  });

  const resolvedPrompt = resolveJobPrompt(config);
  let cmd = buildJobCommand(config, resolvedPrompt, launch.forwardAccount !== false);
  // workflow AND resume dispatch through `agents run` — never binary-pin them (pinning
  // rewrites cmd[0] to the agent binary → broken `<binary> run …`).
  if (!dispatchesViaAgentsRun(config) && version && config.agent) {
    cmd = pinJobBinary(cmd, config.agent as AgentId, version);
  }

  // Resume must run against the REAL home: `--resume <id>` resolves the session from
  // the agent's config dir, and the sandbox overlay home has only a freshly-generated
  // config with no session store. So a resume job is never sandboxed, regardless of
  // `config.sandbox` (see the resume branch in buildJobCommand).
  // Resume needs the REAL home (session store); a custom harness needs it too —
  // the delegated `agents run <name>` resolves ~/.agents (profiles, setup
  // sentinel, version homes) from HOME, which the overlay would hide. Exec
  // still isolates the run in the host version home it swaps HOME into.
  const useSandbox = config.sandbox !== false && !config.resume && !(config.agent && isCustomHarnessName(config.agent));
  const overlayHome = useSandbox ? prepareJobHome(config, version) : undefined;

  const runId = attempt.runId;
  const runDir = getRunDir(config.name, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const stdoutPath = path.join(runDir, 'stdout.log');
  const stdoutFd = fs.openSync(stdoutPath, 'w', 0o600);

  const baseEnv = injectRoutineActor(
    useSandbox
      ? buildSpawnEnv(overlayHome!, config.env)
      : { ...process.env } as Record<string, string>,
    config,
  );
  mergeRoutineProviderEnv(baseEnv, config, config.agent! as AgentId);
  const spawnEnv = dispatchesViaAgentsRun(config)
    ? (() => {
        const e = { ...baseEnv };
        if (config.timezone) e.TZ = config.timezone;
        return e;
      })()
    // Non-command path only: config.agent is always set here (command/workflow branch earlier).
    : buildRoutineSpawnEnv(baseEnv, config.agent! as AgentId, version, config.timezone, overlayHome);

  // RUSH-2860: if this host holds gh auth, the sandbox child MUST see it —
  // otherwise monitors runs records ok while every gh call inside fails.
  if (useSandbox) assertSandboxForwardsHostGhAuth(spawnEnv);

  const effectiveAgent: AgentId = config.workflow
    ? 'claude'
    : isCustomHarnessName(config.agent!)
      ? readProfile(config.agent!).host.agent
      : config.agent! as AgentId;

  const meta: RunMeta = {
    jobName: config.name,
    runId,
    ...runProvenance(config),
    ...attempt.stamp,
    agent: effectiveAgent,
    version,
    execHome: launch.chain[0]?.candidate?.slotDir,
    accountKey: launch.chain[0]?.candidate?.accountKey ?? undefined,
    ...(config.workflow ? { workflow: config.workflow } : {}),
    pid: null,
    spawnedAt: Date.now(),
    timeoutMs: parseTimeout(config.timeout) || 10 * 60 * 1000,
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    exitCode: null,
  };
  // Baseline the child's transcript dirs BEFORE spawning so archiveRoutineTranscripts
  // copies only THIS run's transcript out of a shared per-version home (RUSH-2271).
  snapshotRoutineTranscriptBase(meta, runDir, overlayHome);

  // Auth preflight (mirrors executeJob): a provably signed-out resolved account
  // records a terminal `blocked`/`agent_auth_failed` run with the re-login repair
  // instead of spawning a doomed run that 401s and burns a session (PHNX-3415).
  // Cache-only + fails OPEN — see fireTimeAuthReadiness.
  const preflightVersion = launch.chain[0]?.version;
  // Dynamic import breaks the routine-readiness -> scheduling/routines -> runner cycle.
  const { fireTimeAuthReadiness } = await import('../routine-readiness.js');
  const authBlocker = preflightVersion ? fireTimeAuthReadiness(effectiveAgent, preflightVersion, launch.chain[0]?.candidate) : null;
  if (authBlocker) {
    process.stderr.write(
      `[agents] routine ${config.name}: ${effectiveAgent}@${preflightVersion} ${authBlocker.code} — skipping run (${authBlocker.repair})\n`,
    );
    try { fs.closeSync(stdoutFd); } catch { /* already closed */ }
    meta.readiness = authBlocker;
    finalizeRunMeta(meta, 'blocked', null, { errorMessage: `blocked: ${authBlocker.code} — ${authBlocker.message}` });
    writeRunMeta(meta);
    archiveRoutineTranscripts(meta, runDir, overlayHome);
    timer.end({ status: 'blocked', runId, error: authBlocker.code });
    return meta;
  }

  const child = spawn(cmd[0], cmd.slice(1), {
    stdio: ['ignore', stdoutFd, stdoutFd],
    ...backgroundSpawnOptions({ cwd: routineSpawnCwd(config), fdStdio: true }),
    env: spawnEnv,
  });

  let settled = false;
  let timeoutTimer: NodeJS.Timeout | undefined;
  const settle = (status: RunMeta['status'], exitCode: number | null, errorMessage?: string) => {
    if (settled) return;
    settled = true;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    finalizeRunMeta(meta, status, exitCode, errorMessage ? { errorMessage } : undefined);
    writeRunMeta(meta);
    archiveRoutineTranscripts(meta, runDir, overlayHome);
    // Never persist the report on an auth failure — the last assistant text is
    // the login error, which would poison the next run's {last_report} prompt.
    const isAuthFailure = !!errorMessage && errorMessage.startsWith('auth_failed:');
    if (status !== 'timeout' && !isAuthFailure) extractAndSaveReport(stdoutPath, effectiveAgent, runDir);
    timer.end({ status, exitCode: exitCode ?? undefined, runId, ...(errorMessage ? { error: errorMessage } : {}) });
    // Fire the finish/output notification AFTER the report is written so the hook
    // can read report.md (RUSH-2030). Best-effort; never breaks finalization.
    safeHook(hooks?.onFinish ? () => hooks.onFinish!(meta) : undefined);
  };

  timeoutTimer = setTimeout(() => {
    terminateRoutineTree(child.pid ?? null);
    settle('timeout', null, 'exceeded configured timeout');
  }, meta.timeoutMs);

  child.on('exit', (code) => {
    let logText = '';
    try { logText = fs.readFileSync(stdoutPath, 'utf-8'); } catch { /* log unreadable */ }
    // processFailed gates the raw-text fallback so a COMPLETED run (exit 0) that
    // merely mentions an auth phrase is never misclassified; the structural
    // marker still catches an exit-0 auth failure on its own.
    if (isAuthFailureFromLog(logText, effectiveAgent, { processFailed: (code ?? 1) !== 0 })) {
      const reason = authFailureReason(logText) ?? 'authentication_failed';
      settle('failed', code ?? 1, `auth_failed: ${reason}`);
      return;
    }
    const inferred = inferFinalStatusFromLog(stdoutPath, effectiveAgent);
    if (inferred) {
      settle(inferred.status, inferred.exitCode);
    } else {
      settle(code === 0 ? 'completed' : 'failed', code ?? 1);
    }
  });

  child.on('error', (err) => {
    try { fs.closeSync(stdoutFd); } catch { /* fd already closed */ }
    settle('failed', 1, err.message);
    process.stderr.write(`[agents] daemon: spawn failed for job "${config.name}": ${err.message}\n`);
  });

  child.unref();
  try { fs.closeSync(stdoutFd); } catch { /* fd already closed */ }

  meta.pid = child.pid || null;
  writeRunMeta(meta);

  return { ...meta };
}

/**
 * Detached (fire-and-forget) execution for a command-mode routine. Mirrors the
 * agent detached flow: write an initial running record, spawn the shell command
 * un-sandboxed, unref, then record the pid. The daemon does not wait for exit;
 * `monitorRunningJobs` reaps the record on the next tick.
 */
function executeCommandJobDetached(config: JobConfig, attempt: RoutineAttempt, hooks?: RoutineHooks): RunMeta {
  const timer = createTimer('agent.run', {
    jobName: config.name,
    mode: config.mode,
    schedule: config.schedule,
  });

  const runId = attempt.runId;
  const runDir = getRunDir(config.name, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const stdoutPath = path.join(runDir, 'stdout.log');
  const stdoutFd = fs.openSync(stdoutPath, 'w', 0o600);

  // Wrap the shell so the child records its own exit code to <runDir>/exit-code.
  // The in-process `child.on('exit')` below writes the terminal record while the
  // daemon is alive (the common case); the file lets monitorRunningJobs recover
  // the real status if the daemon restarted between spawn and exit. (win32 relies
  // on the exit event only.)
  const exitCodePath = path.join(runDir, 'exit-code');
  // Run the command in a SUBSHELL `( … )` so that if it calls `exit`, only the
  // subshell exits — the outer shell still captures `$?` and writes the file.
  const wrappedCommand = wrapCommandRoutine(config.command!);
  const cmd = process.platform === 'win32'
    ? buildShellCommand(wrappedCommand)
    : ['/bin/sh', '-c',
        `(\n${wrappedCommand}\n)\n__ac_rc=$?; printf '%s' "$__ac_rc" > ${shSingleQuote(exitCodePath)} 2>/dev/null; exit $__ac_rc`];
  const env = commandSpawnEnv(config);

  const meta: RunMeta = {
    jobName: config.name,
    runId,
    ...runProvenance(config),
    ...attempt.stamp,
    command: config.command,
    pid: null,
    spawnedAt: Date.now(),
    timeoutMs: parseTimeout(config.timeout) || 10 * 60 * 1000,
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    exitCode: null,
  };

  const child = spawn(cmd[0], cmd.slice(1), {
    stdio: ['ignore', stdoutFd, stdoutFd],
    ...backgroundSpawnOptions({ cwd: routineSpawnCwd(config), fdStdio: true }),
    env,
  });

  // Record the real terminal status ourselves — the daemon stays alive after this
  // fire-and-forget call, so the exit event fires here. (monitorRunningJobs no
  // longer force-fails command jobs; it reads exit-code only on the restart edge.)
  let settled = false;
  let timeoutTimer: NodeJS.Timeout | undefined;
  const settle = (status: RunMeta['status'], exitCode: number | null, errorMessage?: string) => {
    if (settled) return;
    settled = true;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    finalizeRunMeta(meta, status, exitCode, errorMessage ? { errorMessage } : undefined);
    writeRunMeta(meta);
    timer.end({ status, exitCode: exitCode ?? undefined, runId, ...(errorMessage ? { error: errorMessage } : {}) });
    // Finish notification (RUSH-2030). For command routines the threshold only
    // surfaces failures, decided in routine-notify.ts. Best-effort.
    safeHook(hooks?.onFinish ? () => hooks.onFinish!(meta) : undefined);
  };
  timeoutTimer = setTimeout(() => {
    terminateRoutineTree(child.pid ?? null);
    settle('timeout', null, 'exceeded configured timeout');
  }, meta.timeoutMs);
  child.on('exit', (code) => settle(code === 0 ? 'completed' : 'failed', code ?? 1));
  child.on('error', (err) => {
    settle('failed', 1, err.message);
    process.stderr.write(`[agents] daemon: command spawn failed for job "${config.name}": ${err.message}\n`);
  });

  child.unref();
  try { fs.closeSync(stdoutFd); } catch { /* fd already closed */ }

  meta.pid = child.pid || null;
  writeRunMeta(meta);

  return { ...meta };
}

function extractAndSaveReport(
  stdoutPath: string,
  agentType: AgentId,
  runDir: string
): string | null {
  try {
    const report = extractReport(stdoutPath, agentType);
    if (report) {
      const reportPath = path.join(runDir, 'report.md');
      fs.writeFileSync(reportPath, report, 'utf-8');
      return reportPath;
    }
  } catch (err: any) {
    if (process.env.AGENTS_DEBUG) {
      console.error(`[debug] Could not extract report: ${err.message}`);
    }
  }
  return null;
}

/** Extract the final assistant message from a stream-JSON log file as a markdown report. */
export function extractReport(stdoutPath: string, agentType: AgentId): string | null {
  if (!fs.existsSync(stdoutPath)) return null;

  try {
    const content = fs.readFileSync(stdoutPath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());

    let lastMessage = '';

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);

        if (agentType === 'claude' || agentType === 'cursor') {
          if (parsed.type === 'assistant' && parsed.message?.content) {
            for (const block of parsed.message.content) {
              if (block.type === 'text' && block.text) {
                lastMessage = block.text;
              }
            }
          }
        }

        if (agentType === 'codex') {
          if (parsed.type === 'message' && parsed.content) {
            lastMessage = typeof parsed.content === 'string'
              ? parsed.content
              : JSON.stringify(parsed.content);
          }
        }

        if (agentType === 'gemini') {
          if (parsed.type === 'text' && parsed.text) {
            lastMessage = parsed.text;
          }
        }
      } catch { /* malformed JSONL line */ }
    }

    return lastMessage || null;
  } catch {
    return null;
  }
}

/** Derive the final status of a detached run by reading the agent's stream-json
 *  tail. Detached children fire-and-forget, so we never see their exit code
 *  directly — but Claude's stream-json terminates with a `type: result` line
 *  that carries `is_error`. If we find it, the run completed cleanly (modulo
 *  agent-reported error). If not, the process likely died mid-stream and the
 *  caller should treat the run as failed. */
export function inferFinalStatusFromLog(
  stdoutPath: string,
  agent: AgentId,
): { status: 'completed' | 'failed'; exitCode: number } | null {
  if (!fs.existsSync(stdoutPath)) return null;
  try {
    const content = fs.readFileSync(stdoutPath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());
    // Walk backwards over the last few lines — the result marker is always
    // at the tail. Cap the scan so a huge stdout doesn't iterate forever.
    for (let i = lines.length - 1, scanned = 0; i >= 0 && scanned < 20; i--, scanned++) {
      try {
        const parsed = JSON.parse(lines[i]);
        if ((agent === 'claude' || agent === 'cursor') && parsed.type === 'result') {
          return parsed.is_error
            ? { status: 'failed', exitCode: 1 }
            : { status: 'completed', exitCode: 0 };
        }
      } catch {
        // malformed JSONL line — keep scanning
      }
    }
    return null;
  } catch {
    return null;
  }
}

const MAX_WALL_CLOCK_MS = 24 * 60 * 60 * 1000;

/**
 * Verify that a PID still belongs to the process we spawned, not a recycled
 * OS PID. Uses the recorded `spawnedAt` (epoch ms) from meta.json and
 * compares against the process's actual start time via `ps`. Returns true
 * when the PID is alive AND plausibly ours.
 */
/** Bound the identity `ps` — a hung `ps` must never freeze its caller for long (matches routine-process-cleanup's probe). */
const PS_IDENTITY_TIMEOUT_MS = 5_000;

/**
 * Pure: does a `ps -o etime=` value place the process's birth within 30s of when
 * we recorded spawning it? An empty/unknown reading conservatively reads as ours
 * — never reap a run on a doubtful identity probe.
 */
function etimeIndicatesOurs(etime: string, spawnedAt: number): boolean {
  if (!etime) return true;
  const parts = etime.replace(/-/g, ':').split(':').reverse();
  let uptimeSec = 0;
  if (parts[0]) uptimeSec += parseInt(parts[0], 10);
  if (parts[1]) uptimeSec += parseInt(parts[1], 10) * 60;
  if (parts[2]) uptimeSec += parseInt(parts[2], 10) * 3600;
  if (parts[3]) uptimeSec += parseInt(parts[3], 10) * 86400;
  const processStartMs = Date.now() - uptimeSec * 1000;
  return Math.abs(processStartMs - spawnedAt) < 30_000;
}

/**
 * Synchronous identity check for callers OTHER than the periodic heartbeat tick:
 * the `agents routines list/status` builders and stop-time enumeration (both in
 * short-lived CLI processes), plus the scheduler's fire-time slot-claim
 * (`activeRoutineRun`) and status projection (`isRunGenuinelyInFlight`). Those
 * last two DO run in-process on the daemon's event loop, but are event-driven
 * (they fire when a job is dispatched, not on a fixed cadence) and the `ps` here
 * is now bounded to {@link PS_IDENTITY_TIMEOUT_MS} — they are not the
 * unconditional every-tick scan PHNX-3695 targets. The heartbeat tick's own scan
 * uses the non-blocking {@link isPidOursAsync} instead.
 */
function isPidOurs(pid: number, spawnedAt: number | undefined): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (spawnedAt === undefined) return true;
  if (process.platform === 'win32') return true;
  try {
    const etime = execFileSync('ps', ['-p', String(pid), '-o', 'etime='],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: PS_IDENTITY_TIMEOUT_MS }).trim();
    return etimeIndicatesOurs(etime, spawnedAt);
  } catch {
    return true;
  }
}

/**
 * Async, deadline-bounded twin of {@link isPidOurs} for the daemon's heartbeat
 * tick (`reapExitedRunningJobs`) — the `ps` probe runs on the shared event loop,
 * so it MUST NOT block it (PHNX-3695). Same semantics: dead pid → not ours;
 * no recorded `spawnedAt` or Windows → assume ours; a failed/empty probe reads
 * as ours (conservative — never reap on a doubtful probe).
 */
async function isPidOursAsync(pid: number, spawnedAt: number | undefined): Promise<boolean> {
  if (!isAlive(pid)) return false;
  if (spawnedAt === undefined) return true;
  if (process.platform === 'win32') return true;
  const res = await execFileBounded('ps', ['-p', String(pid), '-o', 'etime='], { timeoutMs: PS_IDENTITY_TIMEOUT_MS });
  if (res.code !== 0) return true; // probe failed → keep the run, same as the sync catch
  return etimeIndicatesOurs(res.stdout.trim(), spawnedAt);
}

/**
 * Finalize one `host:`-placed run by healing its host-task sidecar against the
 * remote `.exit` (lib/hosts/reconcile.ts). Mutates + persists the meta only
 * when the sidecar reached a terminal state.
 */
/** Apply a healed host-task's terminal state to the local run record. Shared by the sync and async host reconcilers. */
function applyHealedHostRun(
  meta: RunMeta,
  healed: { status: string; exitCode?: number | null; finishedAt?: string | null },
  // The routine-end emit acquires the event-log file lock. On the daemon
  // heartbeat tick (finalizeHostRunAsync) that MUST be the async, non-blocking
  // variant, or the synchronous `withFileLock` (lockSync + Atomics.wait, up to
  // 30s under contention) freezes the whole event loop — the exact wedge PHNX-3695
  // targets, on a path guard-no-sync-io does not scan (PHNX-3727). The sync CLI
  // path (finalizeHostRun) keeps the default synchronous emit.
  emit: (m: RunMeta) => void = emitRoutineEnd,
): void {
  if (healed.status !== 'completed' && healed.status !== 'failed') return;
  finalizeRunMeta(
    meta,
    healed.status as 'completed' | 'failed',
    healed.exitCode ?? (healed.status === 'completed' ? 0 : 1),
    { completedAt: healed.finishedAt ?? undefined },
  );
  writeRunMeta(meta);
  emit(meta);
}

function finalizeHostRun(meta: RunMeta): void {
  try {
    const task = loadHostTask(meta.hostTaskId!);
    if (!task) return;
    applyHealedHostRun(meta, reconcileHostTask(task));
  } catch { /* unreachable host or unreadable sidecar — retry next sweep */ }
}

/**
 * Async twin of {@link finalizeHostRun} for the daemon heartbeat tick
 * (PHNX-3695). A `host:`-placed run's remote `.exit` is read over ssh; on the
 * tick that read MUST be async (`reconcileHostTaskAsync` → `sshExecAsync`) or a
 * single 6s ssh timeout freezes the whole event loop — the exact bug class this
 * effort targets, worse than the local `ps` probe.
 */
async function finalizeHostRunAsync(meta: RunMeta): Promise<void> {
  try {
    const task = loadHostTask(meta.hostTaskId!);
    if (!task) return;
    // Tick path: emit through the async, non-blocking file lock (PHNX-3727).
    applyHealedHostRun(meta, await reconcileHostTaskAsync(task), (m) => { void emitRoutineEndAsync(m); });
  } catch { /* unreachable host or unreadable sidecar — retry next sweep */ }
}

/**
 * PIDs of the in-flight detached routine children on THIS device — every local
 * run record still marked `running` whose spawned process is genuinely alive
 * (`isPidOurs`, so a dead-and-reused pid does not count). These are the `unref`'d
 * spawns that survive a daemon exit in their own process group (SING-11a): a
 * takeover must not kill them and `stopDaemon` reports them rather than pretending
 * the process tree is clean (SING-12). Scoped to `getRunsDir()`, which is under
 * this state dir's HOME, so a different state dir's children are invisible here.
 * `host:`-placed runs have no local pid and are excluded.
 */
export function listLiveRoutineChildren(): number[] {
  const runsDir = getRunsDir();
  if (!fs.existsSync(runsDir)) return [];
  const pids: number[] = [];
  let jobDirs: fs.Dirent[];
  try {
    jobDirs = fs.readdirSync(runsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return pids;
  }
  for (const jobDir of jobDirs) {
    const jobRunsPath = path.join(runsDir, jobDir.name);
    let runDirs: fs.Dirent[];
    try {
      runDirs = fs.readdirSync(jobRunsPath, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      continue;
    }
    for (const runDirEntry of runDirs) {
      const metaPath = path.join(jobRunsPath, runDirEntry.name, 'meta.json');
      if (!fs.existsSync(metaPath)) continue;
      try {
        const meta: RunMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        if (meta.status !== 'running' || meta.hostTaskId || !meta.pid) continue;
        if (isPidOurs(meta.pid, meta.spawnedAt)) pids.push(meta.pid);
      } catch { /* unreadable/partial record — skip */ }
    }
  }
  return pids;
}

/**
 * Whether a run record marked `running` is genuinely in flight right now. A
 * `running` status alone is not enough: `writeActiveClaim` stamps a provisional
 * claim as `running` with `pid: null` BEFORE the child spawns, and
 * `monitorRunningJobs()` does not reap a null-pid record (it has no process to
 * probe, and ages it out only past the configured timeout — up to a week). So a
 * daemon crash in that spawn window leaves a `running` record for a run that is
 * not running (RUSH-2640). A caller answering "is one running now?" MUST gate on
 * this, mirroring `listLiveRoutineChildren`'s local-liveness test:
 * - a local child is in flight only while its pid is still ours (alive, same
 *   birth time — a dead-and-reused pid does not count);
 * - a `host:`-placed run has no local pid by design and is in flight until its
 *   remote `.exit` is reconciled (`finalizeHostRun`).
 */
export function isRunGenuinelyInFlight(meta: RunMeta): boolean {
  if (meta.status !== 'running') return false;
  if (meta.hostTaskId) return true;
  if (!meta.pid) return false;
  return isPidOurs(meta.pid, meta.spawnedAt);
}

/**
 * Reconcile ONE `running` record once its process identity is known (`ours` =
 * the recorded pid is still genuinely the child we spawned). Shared verbatim by
 * the synchronous {@link monitorRunningJobs} (off-loop callers) and the async
 * {@link reapExitedRunningJobs} (daemon heartbeat tick) so there is one copy of
 * the finalize/timeout/report logic — only the surrounding directory/`ps` IO
 * differs by sync-vs-async flavor. Caller has already confirmed `meta.status`
 * is `running`. The finalize/report/archive helpers stay synchronous: they run
 * ONLY when a run actually transitions (times out or its process exited), a
 * conditional/rare event, not the every-tick scan the loop-starvation fix
 * (PHNX-3695) targets. The one exception is the `routine.end` EVENT emit, whose
 * file lock CAN block for up to 30s under contention even on that rare path — so
 * the emitter is injected: the off-loop sync caller passes `emitRoutineEnd`
 * (synchronous, so a short-lived CLI process flushes it before exit), the daemon
 * tick passes a fire-and-forget `emitRoutineEndAsync` (the long-lived daemon
 * flushes it, and the shared event loop is never blocked on the lock).
 */
function reconcileRunningRecord(meta: RunMeta, jobRunsPath: string, runDirName: string, ours: boolean, emitEnd: (meta: RunMeta) => void): void {
  // Host-placed runs (meta.hostTaskId) are handled by the caller, sync or async
  // — their remote `.exit` read is ssh I/O that must stay off the daemon tick's
  // event loop (finalizeHostRunAsync). Records reaching here are local-pid runs.
  const runDirPath = path.join(jobRunsPath, runDirName);
  const stdoutPath = path.join(runDirPath, 'stdout.log');

  // Command-mode records carry no agent; there is no stream-json report to
  // parse or extract. Reap them on pid liveness alone.
  const isCommandRun = Boolean(meta.command) || !meta.agent;

  // Age-out runs FIRST, before the null-pid guard below, so a wedged record
  // still marked `running` past its deadline is always finalized — a
  // provisional launcher claim whose daemon crashed before spawning a child
  // (pid null), or an old record whose recorded pid was reused, would
  // otherwise linger as `running` forever (RUSH-2640). Only kill a process
  // group that is genuinely still ours; terminating a reused pid would kill
  // an unrelated process, and a null pid has nothing to kill.
  const wallClockMs = Date.now() - Date.parse(meta.startedAt);
  const timeoutMs = meta.timeoutMs ?? MAX_WALL_CLOCK_MS;
  if (Number.isFinite(wallClockMs) && wallClockMs > timeoutMs) {
    if (meta.pid && ours) terminateRoutineTree(meta.pid);
    finalizeRunMeta(meta, 'timeout', null, { errorMessage: 'exceeded configured timeout' });
    writeRunMeta(meta);
    emitEnd(meta);
    if (!isCommandRun) {
      extractAndSaveReport(stdoutPath, meta.agent! as AgentId, runDirPath);
      archiveRoutineTranscripts(meta, runDirPath);
    }
    return;
  }

  if (!meta.pid) return;

  if (!ours) {
    if (isCommandRun) {
      // Command routines normally record their own terminal status via
      // child.on('exit') (so this record would already be non-'running' and
      // skipped above). Reaching here means the daemon restarted mid-run and
      // missed the exit event — recover the true code from the exit-code file
      // the child wrote; its absence means the child was killed/crashed.
      const ec = readCommandExitCode(runDirPath);
      finalizeRunMeta(meta, ec === 0 ? 'completed' : 'failed', ec);
    } else {
      const inferred = inferFinalStatusFromLog(stdoutPath, meta.agent! as AgentId);
      if (inferred) {
        finalizeRunMeta(meta, inferred.status, inferred.exitCode);
      } else {
        finalizeRunMeta(meta, 'failed', null, { errorMessage: 'process exited before final status could be inferred' });
      }
    }
    writeRunMeta(meta);
    emitEnd(meta);

    if (!isCommandRun) {
      extractAndSaveReport(stdoutPath, meta.agent! as AgentId, runDirPath);
      archiveRoutineTranscripts(meta, runDirPath);
    }
  }
}

/**
 * Scan all runs marked "running" and finalize any whose process has exited.
 *
 * SYNCHRONOUS — for OFF-loop callers only (the `agents routines list/status`
 * builders and CLI best-effort orphan reaps), which run in short-lived CLI
 * processes where a bounded synchronous `ps`/scan cannot starve a served event
 * loop. The daemon's own heartbeat tick MUST use {@link reapExitedRunningJobs}
 * instead — a sync scan there would freeze the shared event loop (PHNX-3695).
 */
export function monitorRunningJobs(): void {
  const runsDir = getRunsDir();
  if (!fs.existsSync(runsDir)) return;

  const jobDirs = fs.readdirSync(runsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory());

  for (const jobDir of jobDirs) {
    const jobRunsPath = path.join(runsDir, jobDir.name);
    let runDirs: fs.Dirent[];
    try {
      runDirs = fs.readdirSync(jobRunsPath, { withFileTypes: true })
        .filter((e) => e.isDirectory());
    } catch (err) {
      // A retention/cleanup pass may remove a job directory after the root
      // snapshot. The next monitor sweep observes the remaining state.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }

    for (const runDirEntry of runDirs) {
      const metaPath = path.join(jobRunsPath, runDirEntry.name, 'meta.json');
      if (!fs.existsSync(metaPath)) continue;

      try {
        const meta: RunMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        if (meta.status !== 'running') continue;
        // `host:`-placed run — no local pid; reconcile against the remote `.exit`.
        if (meta.hostTaskId) { finalizeHostRun(meta); continue; }
        const ours = meta.pid ? isPidOurs(meta.pid, meta.spawnedAt) : false;
        // Sync emit: an off-loop CLI process must flush the event before it exits.
        reconcileRunningRecord(meta, jobRunsPath, runDirEntry.name, ours, emitRoutineEnd);
      } catch { /* corrupt or unreadable meta.json */ }
    }
  }
}

/**
 * Async, non-blocking twin of {@link monitorRunningJobs} for the daemon's
 * heartbeat tick (PHNX-3695). Identical reconciliation via
 * {@link reconcileRunningRecord}, but the directory walk uses `fs/promises` and
 * the pid-identity probe uses the deadline-bounded {@link isPidOursAsync}, so
 * the every-tick scan never freezes the shared event loop — the freeze that
 * left the browser IPC `version` probe unanswered.
 */
export async function reapExitedRunningJobs(): Promise<void> {
  const runsDir = getRunsDir();
  let jobDirs: fs.Dirent[];
  try {
    jobDirs = await fsp.readdir(runsDir, { withFileTypes: true });
  } catch {
    return; // runs dir absent — nothing to reap
  }

  for (const jobDir of jobDirs) {
    if (!jobDir.isDirectory()) continue;
    const jobRunsPath = path.join(runsDir, jobDir.name);
    let runDirs: fs.Dirent[];
    try {
      runDirs = await fsp.readdir(jobRunsPath, { withFileTypes: true });
    } catch {
      // A retention/cleanup pass may remove a job directory after the root
      // snapshot. The next sweep observes the remaining state.
      continue;
    }

    for (const runDirEntry of runDirs) {
      if (!runDirEntry.isDirectory()) continue;
      try {
        const raw = await fsp.readFile(path.join(jobRunsPath, runDirEntry.name, 'meta.json'), 'utf-8');
        const meta: RunMeta = JSON.parse(raw);
        if (meta.status !== 'running') continue;
        // `host:`-placed run — read its remote `.exit` over ssh ASYNC so a slow
        // host never freezes the tick's event loop (PHNX-3695).
        if (meta.hostTaskId) { await finalizeHostRunAsync(meta); continue; }
        const ours = meta.pid ? await isPidOursAsync(meta.pid, meta.spawnedAt) : false;
        // Fire-and-forget async emit: the event-log lock must never block the
        // daemon tick's shared event loop; the long-lived daemon still flushes it.
        reconcileRunningRecord(meta, jobRunsPath, runDirEntry.name, ours, (m) => { void emitRoutineEndAsync(m); });
      } catch { /* corrupt or unreadable meta.json */ }
    }
  }
}
