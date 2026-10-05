/** Routine job runner: builds agent CLI commands, spawns them (sandboxed or not), logs stdout,
 * enforces timeouts. Version/account selection mirrors `agents run`; same-agent failover on rate
 * limits applies to foreground `executeJob` only. */

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
import { findAccount, findUnifiedAccount, listNativeAccounts, resolveAccountSelection, resolveCredentialAccount } from '../account-registry.js';
import { recordRunAuthOutcome, type RunAuthOutcome } from '../auth-health.js';

/** Record a routine run's auth outcome as a per-account fact (PHNX-4116), rendered by `agents
 * view`. Best-effort: never throws; a run it cannot attribute to an account slot is not recorded. */
function recordRoutineAuthOutcome(
  agent: AgentId,
  accountName: string | undefined,
  version: string | undefined,
  outcome: RunAuthOutcome,
): void {
  try {
    const accountId = accountName
      ? listNativeAccounts(readMeta()).find((a) => a.agent === agent && a.name === accountName)?.id ?? null
      : null;
    recordRunAuthOutcome({ agent, accountId, version: version ?? null, account: accountName, outcome });
  } catch { /* best-effort */ }
}

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

/** The prior run still holding this routine's active-run slot, or null. Only a `running` record
 * holds it; every terminal status releases it immediately (RUSH-2640), so a daemon-pid terminal
 * record cannot wedge the slot. A `running` record past its own timeout never holds it. */
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

/** Count of consecutive trailing `skipped`/`active_run` records: a routine refused because a prior
 * run still owns the slot. A growing streak means the routine stopped firing and must be surfaced.
 * `runs` is oldest to newest. */
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

/** The pid to stamp on a launcher's provisional claim, or null when the launcher is the routines
 * daemon. The daemon outlives every run, so recording its pid keeps `isPidOurs` true forever and
 * aims the reaper at the daemon itself (RUSH-2640). */
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
interface RoutineTrigger {
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

/** Reject placement/body combinations the runner cannot execute (host+workflow, cloud+command, ...)
 * before the attempt is allocated. Mirrors the guards in `executeJobOnHost`/`executeJobOnCloud`;
 * `validateJob` rejects the same at add/edit time. */
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
    // The launcher owns this provisional claim until the child replaces it with its own pid, so a
    // short-lived foreground launcher crash is recoverable. The daemon records no pid here (see
    // launcherClaimPid); doing so wedged the slot and mis-aimed the reaper (RUSH-2640).
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

/** Allocate a routine attempt before any placement/version/sandbox/dispatch work so every rejected,
 * skipped or blocked fire leaves one terminal record. Runs inside withRoutineLock. Order:
 * single-fire (duplicate cron slot returns the original), non-overlap, readiness (`blocked`). */
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

  // Check deprecation alone, not ROUTINE_AGENT_IDS membership: a retired harness leaves the
  // command table, and the legacy routine must still get a visible 'blocked' record, not a generic
  // buildJobCommand failure (RUSH-2202).
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

/** Warn once, on the daemon's stderr, when a routine has been refused its slot for
 * SKIP_STREAK_ALERT_THRESHOLD consecutive scheduled runs. Fires only when the streak first reaches
 * the threshold, so a stalled routine surfaces once (RUSH-2640). */
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

/** Claim one routine attempt under the short launch lock, then execute after releasing it, so a
 * concurrent entry point skips instead of waiting on a foreground run. `run` is the dispatch,
 * invoked only when the attempt proceeds; `wrapTerminal` adapts a pre-spawn terminal record. */
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
  // Never take this process down: both kills below are unconditional SIGKILLs, so a RunMeta naming
  // the reaper's own pid (reused pid, fixture) would kill itself and its group. daemon.ts:457
  // already refuses to evict `process.pid`. Skipping the kill still lets the caller finalize.
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

/** Where each agent's transcript files live under an overlay HOME, mirroring `SESSION_ROOT_SPECS`
 * (session/discover.ts); a flat root+ext pair is all `archiveRoutineTranscripts` needs. `opencode`
 * is absent on purpose: `SESSION_ROOT_SPECS` has no entry (its transcripts live in one SQLite db). */
const ROUTINE_TRANSCRIPT_SPECS: Partial<Record<AgentId, Array<{ root: string[]; ext: string }>>> = {
  claude: [{ root: ['.claude', 'projects'], ext: '.jsonl' }],
  codex: [{ root: ['.codex', 'sessions'], ext: '.jsonl' }],
  cursor: [{ root: ['.cursor', 'projects'], ext: '.jsonl' }],
  antigravity: [{ root: ['.gemini', 'antigravity-cli', 'conversations'], ext: '.db' }],
  droid: [{ root: ['.factory', 'sessions'], ext: '.jsonl' }],
  // Kimi splits a session across state.json (title/timestamps) and agents/main/wire.jsonl (the
  // conversation), per session/discover.ts:4382. Both extensions are needed; .json alone archives
  // only metadata and drops every message.
  kimi: [
    { root: ['.kimi-code', 'sessions'], ext: '.json' },
    { root: ['.kimi-code', 'sessions'], ext: '.jsonl' },
  ],
  grok: [{ root: ['.grok', 'sessions'], ext: '.json' }],
  // Muse: ~/.local/share/muse/sessions/YYYY/MM/DD/<uuid>/session.jsonl
  muse: [{ root: ['.local', 'share', 'muse', 'sessions'], ext: '.jsonl' }],
};

/** Working directory for a routine's local child, from its explicit `project`/`cwd` anchor via
 * resolveJobExecutionContext; never inferred from `repo`, never the daemon's launch cwd. A command
 * routine with neither field, or an unresolved/blocked agent context, lands in `$HOME`. */
export function routineSpawnCwd(
  config: Pick<JobConfig, 'name' | 'project' | 'cwd' | 'agent' | 'workflow' | 'command'>,
): string {
  const ctx = resolveJobExecutionContext(config, { mode: 'local' });
  return ctx.absoluteCwd ?? os.homedir();
}

/** Bake the daemon-job argv skeleton from AGENT_COMMANDS (base / promptFlag / jsonFlags /
 * modeFlags). Exceptions: kimi uses the long `--prompt` form with no mode flag; claude puts
 * `--verbose` before the prompt. Undefined for agents outside ROUTINE_AGENT_IDS. */
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
  // Workflow branch: delegate to `agents run <workflow>`, which handles subagent injection and
  // WORKFLOW.md orchestration. Model selection comes from the workflow frontmatter, so
  // appendModelAndReasoning is skipped; no --timeout since the runner enforces SIGTERM/SIGKILL.
  if (config.workflow) {
    const cmd = ['agents', 'run', config.workflow, resolvedPrompt, '--mode', config.mode];
    if (config.account && forwardAccount) cmd.push('--account', config.account);
    return cmd;
  }

  // Past the workflow branch this is an agent (or resume) job — command jobs never
  // reach buildJobCommand (execute*Job branches out first), and validateJob guarantees agent.
  const agent = config.agent!;

  // Resume branch: reopen an existing session via `agents run <agent> --resume <id>` with
  // `resolvedPrompt` as its next turn, so a self-scheduled wake (e.g. /hibernate) is handled by
  // the session that scheduled it, with its full prior context.
  if (config.resume) {
    const cmd = ['agents', 'run', agent, '--resume', config.resume, resolvedPrompt, '--mode', config.mode];
    if (config.account && forwardAccount) cmd.push('--account', config.account);
    return cmd;
  }

  // Custom-harness branch: delegate to `agents run <name>`, which owns profile resolution (host
  // binary, model env, provider auth). The profile pins its own version and auth, so no command
  // template, binary pinning, or account-env injection applies.
  if (isCustomHarnessName(agent)) {
    const cmd = ['agents', 'run', agent, resolvedPrompt, '--mode', config.mode];
    if (config.account && forwardAccount) cmd.push('--account', config.account);
    return cmd;
  }

  // Native slot accounts share one managed binary version, so dispatch through `agents run
  // <agent>#<name>` to let spawn-time resolution select the slot. `--account` is an agents-cli
  // flag the harness would reject. Provider/durable-pinned accounts stay on the argv + env path.
  if (config.account && forwardAccount && !findAccount(config.account)) {
    const spec = config.version
      ? `${agent}@${config.version}#${config.account}`
      : `${agent}#${config.account}`;
    return ['agents', 'run', spec, resolvedPrompt, '--mode', config.mode];
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

  // Per-harness routine launch-arg quirks live in the harness adapter; the runner appends
  // model/reasoning flags after. Agents with no routine quirk have no adapter override and skip
  // both.
  const routineAdapter = resolveHarnessAdapter(agent as AgentId);
  if (routineAdapter.routineModeArgs) {
    routineAdapter.routineModeArgs(cmd, { mode, config, resolveHeadlessMode });
    appendModelAndReasoning(cmd, config);
  }

  // allow.dirs maps to harness-specific grants: Codex is handled above (workspace_roots);
  // Claude/Kimi/Cursor take --add-dir; Grok gets rules. Reject a leading '-' so routine YAML
  // cannot smuggle an argv flag past the sandbox as an allow.dirs entry.
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

/** Append the agent's canonical model flag and reasoning flags (config.config.reasoning via
 * models.ts) to a command. Pass-through resolution: warns on stderr when the model is missing from
 * the installed catalog, but never blocks. */
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

/** Agents whose config dir `buildExecEnv` relocates out of the sandbox overlay HOME into the
 * per-version home (CLAUDE_CONFIG_DIR / CODEX_HOME), so the archiver must read transcripts there.
 * Limited to claude and codex, the only ones indexable as origin='routine'. */
const CONFIG_DIR_RELOCATED_AGENTS = new Set<AgentId>(['claude', 'codex']);

/** Whether this run's transcript lands in a SHARED per-version home (accumulating every
 *  session that version+account ever ran) rather than the run's own disposable overlay. */
function usesSharedTranscriptHome(agent: AgentId, version: string | undefined): boolean {
  return Boolean(version) && CONFIG_DIR_RELOCATED_AGENTS.has(agent);
}

/** Directories the child actually writes a transcript to, matching `buildExecEnv` (exec.ts) so the
 * archiver cannot drift: the per-version home for relocated agents, else the overlay HOME. Codex
 * may use a SUN_LEN-safe short home on macOS, so both candidates are returned. */
function routineTranscriptSourceRoots(
  agent: AgentId,
  version: string | undefined,
  overlayHome: string,
  spec: { root: string[] },
): string[] {
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

/** Record every transcript file already in the child's transcript dirs before spawn. In a shared
 * per-version home this baseline lets the archiver copy only this run's file instead of
 * mis-tagging sibling sessions as `origin='routine'`. */
export function snapshotRoutineTranscriptBase(
  meta: Pick<RunMeta, 'jobName' | 'agent' | 'version'>,
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
    for (const root of routineTranscriptSourceRoots(meta.agent as AgentId, meta.version, home, spec)) {
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
  meta: Pick<RunMeta, 'jobName' | 'runId' | 'agent' | 'version'>,
  runDir: string,
  overlayHome?: string,
): void {
  if (!meta.agent) return;
  // A host/cloud custom-harness run records the harness name, which has no
  // transcript spec — the null-specs guard below skips it, as before.
  const specs = ROUTINE_TRANSCRIPT_SPECS[meta.agent as AgentId];
  if (!specs) return;

  const home = overlayHome ?? getJobHomePath(meta.jobName);
  const shared = usesSharedTranscriptHome(meta.agent as AgentId, meta.version);
  const base = readTranscriptBase(runDir);
  // A shared per-version home holds every session that version+account ran, so without a
  // per-run baseline we cannot tell this run's transcript from a sibling's — copy nothing
  // rather than mis-tag them all. A disposable overlay is this run's alone, so copy all.
  if (shared && base === null) return;

  for (const spec of specs) {
    const destRoot = path.join(runDir, 'sessions', meta.agent, spec.root[spec.root.length - 1]);
    for (const sourceRoot of routineTranscriptSourceRoots(meta.agent as AgentId, meta.version, home, spec)) {
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

/** Build the argv for a command-mode routine: the shell string runs directly through the platform
 * shell, with no agent binary, rotation, or sandbox. */
function buildShellCommand(command: string): string[] {
  return process.platform === 'win32'
    ? ['cmd', '/c', command]
    : ['/bin/sh', '-c', command];
}

/** Real (un-sandboxed) env for a command routine, which needs the actual $HOME/$PATH (`npm i -g`,
 * `git pull`); only TZ is injected when pinned. The current binary's directory is prepended to
 * PATH so bare `agents` resolves to the same install. */
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

/** Build a POSIX shell function forwarding `agents <sub...>` to the binary currently running, so
 * command routines do not hit a stale install shadowing it in PATH (RUSH-2431). Uses getCliLaunch
 * so it works for JS installs and compiled standalone binaries. */
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

/** Wrap a command-routine shell string so bare `agents` resolves to the current binary: an `agents`
 * shell function on POSIX; unchanged on Windows, where commandSpawnEnv prepends the binary's
 * directory to PATH. */
function wrapCommandRoutine(command: string): string {
  if (process.platform === 'win32') return command;
  return `${agentsShellFunction()}\n${command}`;
}

/** Detached command routines write their exit code to `<runDir>/exit-code` (see
 * executeCommandJobDetached); `monitorRunningJobs` reads it to recover the status after a daemon
 * restart. Null when the file is absent or unparseable (child killed before writing it). */
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
interface RoutineLaunchPlan {
  /** Ordered attempts: primary first, then same-agent failover accounts. */
  chain: FallbackEntry[];
  /** Full rotation result when strategy selected among healthy accounts; null when pinned. */
  rotation: RotateResult | null;
  /** True when `config.version` pinned the target (no rotation). */
  pinned: boolean;
  /** When true, `buildJobCommand` appends `--account`: native slot accounts share one
   * managed-install version, so the pin must be forwarded. False only when the caller opts out. */
  forwardAccount?: boolean;
}

/** Claude's own local auth check; unlike account metadata it cannot mistake identity for a usable login. */
export function claudeVersionIsAuthenticated(version: string): boolean {
  if (!isVersionInstalled('claude', version)) return true; // synthetic/unit plans are validated at spawn
  const binary = getBinaryPath('claude', version);
  if (!binary) return false;
  const home = getVersionHomePath('claude', version);
  try {
    const raw = execFileSync(binary, ['auth', 'status', '--json'], {
      encoding: 'utf8',
      timeout: 5_000,
      env: { ...process.env, HOME: process.env.AGENTS_REAL_HOME || os.homedir(), CLAUDE_CONFIG_DIR: path.join(home, '.claude') },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(raw).loggedIn === true;
  } catch {
    return false;
  }
}

/** Resolve the version/account chain for a routine like `agents run`: honor an explicit `version:`
 * pin, else use the run strategy (default `balanced`) to skip exhausted accounts pre-flight and
 * build a same-agent failover chain for mid-run rate limits. Workflows are left to `agents run`. */
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
    claudeVersionIsAuthenticated?: typeof claudeVersionIsAuthenticated;
  } = {},
): Promise<RoutineLaunchPlan> {
  if (config.workflow) {
    return { chain: [], rotation: null, pinned: false };
  }
  if (config.agent && isCustomHarnessName(config.agent)) {
    // A custom harness pins its own version/auth in the profile, so there is no chain to resolve;
    // `agents run <name>` owns it.
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
  if (selectedCredential) {
    // A default/binding may resolve to a native account — never route that
    // through the provider credential path (it has no bundle to resolve).
    const unified = findUnifiedAccount(selectedCredential, meta);
    if (unified?.kind !== 'native') (deps.resolveCredentialAccount ?? resolveCredentialAccount)(selectedCredential, agent);
  }
  if (config.account && !explicitCredential) {
    // A native routine account is named by its durable name but the version matcher keys on
    // identity (email/accountKey), so translate first and refuse a login from another harness.
    // Scope the lookup to the routine's harness: unscoped, `identityLabel` matched the first row.
    const unified = findUnifiedAccount(config.account, meta, undefined, agent);
    if (unified?.kind === 'native' && unified.agent !== agent) {
      throw new Error(`Routine '${config.name}' account '${config.account}' is a ${unified.agent} login and cannot authenticate ${agent}.`);
    }
    const identity = unified?.kind === 'native' ? unified.identityKey : config.account;
    // Prefer the full candidate so a slot-sourced native account (shared
    // managed-install `version`) still carries its name for `--account`.
    const accountVersion = deps.resolveAccountVersion
      ? await deps.resolveAccountVersion(agent, identity)
      : (await (deps.resolveAccountCandidate ?? resolveAccountCandidate)(agent, identity))?.version ?? null;
    if (accountVersion) {
      if (config.version && config.version !== accountVersion) {
        throw new Error(
          `Routine '${config.name}' account '${config.account}' is signed in at ${agent}@${accountVersion}, not pinned ${agent}@${config.version}.`,
        );
      }
      return {
        chain: [{ agent, version: config.version ?? accountVersion }],
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
  if (config.version) {
    const version = config.version;
    if (!isVersionInstalled(agent, version)) {
      process.stderr.write(
        `[agents] routine ${config.name}: pinned ${agent}@${version} is not installed\n`,
      );
    }
    return {
      chain: [{ agent, version }],
      rotation: null,
      pinned: true,
      ...(config.account ? { forwardAccount: explicitCredential } : {}),
    };
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
      // Entirely stale usage (PHNX-2526): an unattended routine has no picker, so it fails loud
      // below rather than launch on a stale number. Do not log `rotation.picked` as a pick; it is
      // the refused stale candidate, kept only for the failover chain.
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

  // Zero healthy accounts must not fall back to the default pin: that is the exhausted account an
  // unattended routine would hammer every tick (RUSH-2132). Throwing fails the run nonzero; the
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
    version = resolveVersion(agent, cwd) ?? undefined;
  }
  if (agent === 'claude' && version) {
    const checkClaudeAuth = deps.claudeVersionIsAuthenticated ?? claudeVersionIsAuthenticated;
    const authenticatedHealthy = rotation?.healthy.filter((candidate) => checkClaudeAuth(candidate.version));
    const authenticated = authenticatedHealthy?.find((candidate) => candidate.version === version) ?? authenticatedHealthy?.[0];
    if (rotation && (!authenticated || authenticatedHealthy!.length === 0)) {
      throw new Error(`Routine '${config.name}' found no authenticated Claude account; run \`claude /login\` for an installed version or pin a provider profile.`);
    }
    if (!rotation && !checkClaudeAuth(version)) {
      throw new Error(`Routine '${config.name}' found no authenticated Claude account at claude@${version}; run \`claude /login\` for that version or remove the pin.`);
    }
    if (rotation && authenticated) {
      const rejected = rotation.healthy.filter((candidate) => !authenticatedHealthy!.includes(candidate));
      if (rejected.length > 0 || rotation.picked !== authenticated) {
        rotation = { ...rotation, picked: authenticated, healthy: authenticatedHealthy!, excluded: [...rotation.excluded, ...rejected] };
      }
      version = authenticated.version;
    }
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
    chain: [{ agent, version }, ...failover],
    rotation,
    pinned: false,
  };
}

/** Rewrite `cmd[0]` to the absolute binary for `agent@version` when installed, bypassing the
 * bare-name shim so a sandboxed HOME or missing default pin cannot fail with "no version
 * configured". */
export function pinJobBinary(cmd: string[], agent: AgentId, version: string | undefined): string[] {
  if (!version || cmd.length === 0) return cmd;
  if (!isVersionInstalled(agent, version)) return cmd;
  const binary = getBinaryPath(agent, version);
  if (!binary || !fs.existsSync(binary)) return cmd;
  const next = [...cmd];
  next[0] = binary;
  return next;
}

/** Whether a job's command goes through `agents run` (`cmd[0] === 'agents'`): workflow and resume
 * jobs. Such commands must not be binary-pinned (that yields a broken `<binary> run ...`) or get a
 * version-pinned spawn env. */
/** Assert a routine's account can be dispatched to the resolved placement before any off-box
 * dispatch. Native accounts are rejected for host and cloud (device-local credential);
 * provider+cloud is rejected (no secure bundle injection); provider+host is allowed. */
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
  if (account?.kind === 'native') {
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

/** Build the options passed to `dispatchPromptToHost` for a host routine. It must forward the
 * routine's `account` by name (the remote resolves its own bundle, no secret copied); dropping it
 * silently ran the remote under the wrong identity. */
export function buildHostDispatchOptions(
  config: JobConfig,
  ctx: { remoteCwd: string | undefined; runDir: string; detached: boolean },
): import('../hosts/run-target.js').HostPromptRun {
  return {
    agent: config.agent!,
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
    || (config.account && config.agent && !findAccount(config.account)),
  );
}

/** Inject a provider account's env into a routine spawn. Native accounts re-enter `agents run
 * <agent>#<name>` so slot resolution picks the HOME; provider-pinned routines stay on this path so
 * the durable credential is in the child env (PHNX-3940). */
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

/** Merge sandbox/base env with the per-version exec env (CLAUDE_CONFIG_DIR / CODEX_HOME / ...) so
 * routines share account isolation with `agents run`. */
export function buildRoutineSpawnEnv(
  baseEnv: Record<string, string>,
  agent: AgentId,
  version: string | undefined,
  timezone?: string,
  overlayHome?: string,
): Record<string, string> {
  const execEnv = buildExecEnv({
    agent,
    version,
    mode: 'plan',
    effort: 'auto',
    headless: true,
    env: baseEnv,
  });
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(execEnv)) {
    if (v !== undefined) out[k] = v;
  }
  // Keep a per-account `claude setup-token` injected by buildExecEnv (long-lived, non-rotating, so
  // a routine cannot land on a sibling home's rotated-out credential). Strip an inherited ambient
  // CLAUDE_CODE_OAUTH_TOKEN: it would put every routine on one rotating token (RUSH-1822).
  const setupToken = agent === 'claude' && version
    ? resolveClaudeSetupToken(getVersionHomePath('claude', version))
    : null;
  // A headed device uses the per-version login for every run, routines included; the setup-token
  // is worker-only (RUSH-2395). On a headed box only strip an inherited copy of the account's own
  // setup-token by value; a token the user set deliberately survives.
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
  if (overlayHome && agent === 'codex') out.CODEX_HOME = path.join(overlayHome, '.codex');
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

/** Spawn one attempt, log to `attemptLogPath`, enforce the timeout. Rate-limit scanning uses only
 * this attempt's log; the log is also appended to `combinedLogPath` for a continuous trail. */
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

/** Execute a job synchronously, waiting for completion or timeout. With `config.loop` set it goes
 * through `runLoop` (loop.ts), the same driver as `agents run --loop` (issue #400). The
 * single-shot path does pre-flight account selection plus mid-run rate-limit failover (RUSH-1016). */
/** Actor provenance for a routine run (RUSH-2020): `actor` is the routine's creator, `triggeredBy`
 * is whoever started this run (`UNRESOLVED@<host>` for an unattended fire). Spread into every
 * RunMeta so a cron fire traces to the person who scheduled it. */
function runProvenance(config: JobConfig): { actor?: string; triggeredBy: string } {
  return { ...(config.actor ? { actor: config.actor } : {}), triggeredBy: resolveActor().id };
}

/** Inject the routine creator's actor into the run's base env so the fired agent inherits it
 * (`AGENTS_ACTOR`, actor.ts) rather than resolving to `UNRESOLVED@<host>` (RUSH-2020). Mutates and
 * returns the same env object. */
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
  // Placement (hostStrategy / bare host:): the body may run on another machine over SSH or in the
  // cloud, so local version selection, sandbox and spawn do not apply. Sync callers follow the
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

  // Resume must use the real home: `--resume <id>` reads the session store from the agent's config
  // dir, which the sandbox overlay lacks, so a resume job is never sandboxed. A custom harness
  // needs it too: the delegated `agents run <name>` resolves ~/.agents from HOME.
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

  // Workflows delegate to claude, so 'claude' is the effective agent for report extraction when
  // workflow is set; command jobs branched out earlier. A custom harness name stays on
  // harnessName; the loop path never re-enters `agents run`, so it stamps harnessName (PHNX-2935).
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

  // Auth preflight: a provably signed-out account records a terminal `blocked`/`agent_auth_failed`
  // run with the re-login repair instead of a doomed 401 run (PHNX-3415). `blocked` (no body ran)
  // stays distinct from `failed` per RT-7. Cache-only and fails open.
  const preflightVersion = launch.chain[0]?.version;
  // Dynamic import breaks the routine-readiness -> scheduling/routines -> runner cycle.
  const { fireTimeAuthReadiness } = await import('../routine-readiness.js');
  const authBlocker = preflightVersion ? fireTimeAuthReadiness(effectiveAgent, preflightVersion) : null;
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
    const spawnEnv = buildRoutineSpawnEnv(baseEnv, effectiveAgent, primaryVersion, config.timezone, overlayHome);
    const execOptions: ExecOptions = {
      agent: effectiveAgent,
      harnessName,
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

  const chain: FallbackEntry[] = launch.chain.length > 0
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

    // A rate-limit failover spawns the next chain entry, which has its own per-version transcript
    // home. Re-point meta.version and re-baseline that home so the archiver reads where this
    // attempt writes, not chain[0]'s home (RUSH-2271).
    meta.version = attemptVersion;
    snapshotRoutineTranscriptBase(meta, runDir, overlayHome);

    const viaAgentsRun = dispatchesViaAgentsRun(config);
    if (overlayHome) linkVersionAuth(overlayHome, attemptAgent, attemptVersion);
    const cmd = viaAgentsRun
      ? baseCmd
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
      // Exit code alone is unreliable for auth: a logged-out Claude can exit 0 with a `result`
      // event carrying is_error:true. Use the same structural signal as the detached path; raw
      // text is not used, so a completed run that merely mentions an auth phrase stays a success.
      if (isAuthFailureFromLog(attempt.logText, effectiveAgent, { processFailed: false })) {
        const reason = authFailureReason(attempt.logText) ?? 'authentication_failed';
        recordRoutineAuthOutcome(attemptAgent, config.account, attemptVersion, { ok: false, verdict: 'revoked', detail: reason });
        finalizeRunMeta(meta, 'failed', attempt.exitCode ?? 1, { errorMessage: `auth_failed: ${reason}` });
        writeRunMeta(meta);
        timer.end({ status: 'failed', exitCode: meta.exitCode ?? undefined, runId, error: `auth_failed: ${reason}` });
        // Never persist the login-error text as the report.
        archiveRoutineTranscripts(meta, runDir, overlayHome);
        return { meta, reportPath: null };
      }
      // A clean routine completion is real auth evidence — record it so a worker's
      // token reads `last used ok` and a stale failure fact is cleared (PHNX-4116).
      recordRoutineAuthOutcome(attemptAgent, config.account, attemptVersion, { ok: true });
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

    // Auth failure (logged out / token revoked) is not healed by failover, so classify rate-limit
    // first and auth only when not rate-limited. Classifying it keeps the failure visible and
    // stops the login-error text being persisted as the report.
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

    if (authFailed) recordRoutineAuthOutcome(attemptAgent, config.account, attemptVersion, { ok: false, verdict: 'revoked', detail: authReason ?? undefined });
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

/** Dispatch a routine to the agent's native cloud provider (or the configured default). Writes a
 * local run record with `cloudTaskId`; does not wait for cloud completion on the detached path. */
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

/** Optional lifecycle callbacks for a detached routine run. The daemon's `onFinish` fires the
 * finish/output notification (RUSH-2030) from the in-process settle(), the only seam that sees the
 * running-to-terminal transition. A hook must never throw into finalization. */
interface RoutineHooks {
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
  // Placement: dispatch off-box and return; the monitor finalizes host: runs, cloud runs stay
  // terminal when dispatch ends. The in-process onFinish hook does not fire for off-box routines,
  // so the finish notification is sent only for local detached runs (RUSH-2030).
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

  // Resume must use the real home: `--resume <id>` reads the session store from the agent's config
  // dir, which the sandbox overlay lacks, so a resume job is never sandboxed. A custom harness
  // needs it too: `agents run <name>` resolves ~/.agents from HOME.
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

  // Auth preflight (mirrors executeJob): a provably signed-out account records a terminal
  // `blocked`/`agent_auth_failed` run instead of a doomed 401 run (PHNX-3415). Cache-only and
  // fails open; see fireTimeAuthReadiness.
  const preflightVersion = launch.chain[0]?.version;
  // Dynamic import breaks the routine-readiness -> scheduling/routines -> runner cycle.
  const { fireTimeAuthReadiness } = await import('../routine-readiness.js');
  const authBlocker = preflightVersion ? fireTimeAuthReadiness(effectiveAgent, preflightVersion) : null;
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
      recordRoutineAuthOutcome(effectiveAgent, config.account, meta.version, { ok: false, verdict: 'revoked', detail: reason });
      settle('failed', code ?? 1, `auth_failed: ${reason}`);
      return;
    }
    const inferred = inferFinalStatusFromLog(stdoutPath, effectiveAgent);
    const finalStatus = inferred ? inferred.status : (code === 0 ? 'completed' : 'failed');
    // A clean completion clears any stale auth-failure fact for this account.
    if (finalStatus === 'completed') recordRoutineAuthOutcome(effectiveAgent, config.account, meta.version, { ok: true });
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

/** Detached (fire-and-forget) execution for a command routine: write a running record, spawn the
 * shell un-sandboxed, unref, record the pid. The daemon does not wait; `monitorRunningJobs` reaps
 * the record on the next tick. */
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

  // Wrap the shell so the child writes its own exit code to <runDir>/exit-code. `child.on('exit')`
  // records the terminal state while the daemon is alive; the file lets monitorRunningJobs recover
  // the status after a daemon restart (win32 relies on the exit event only).
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

      } catch { /* malformed JSONL line */ }
    }

    return lastMessage || null;
  } catch {
    return null;
  }
}

/** Derive the final status of a detached run from the tail of the agent's stream-json. Its exit
 * code is never seen, but Claude's stream ends with a `type: result` line carrying `is_error`; if
 * absent, the process likely died mid-stream and the run is failed. */
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

/** Verify a PID still belongs to the process we spawned, not a recycled one, by comparing the
 * recorded `spawnedAt` (epoch ms) with the process start time from `ps`. True when the PID is
 * alive and plausibly ours. */
/** Bound the identity `ps` — a hung `ps` must never freeze its caller for long (matches routine-process-cleanup's probe). */
const PS_IDENTITY_TIMEOUT_MS = 5_000;

/** Pure: does a `ps -o etime=` value place the process's birth within 30s of the recorded spawn?
 * An empty or unknown reading counts as ours, so a run is never reaped on a doubtful probe. */
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

/** Synchronous identity check for callers other than the heartbeat tick: `agents routines
 * list/status`, stop-time enumeration, and the fire-time slot claim. Those are event-driven and
 * the `ps` is bounded by PS_IDENTITY_TIMEOUT_MS, unlike the every-tick scan (PHNX-3695). */
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

/** Async, deadline-bounded twin of isPidOurs for the heartbeat tick (`reapExitedRunningJobs`); the
 * `ps` probe must not block the shared event loop (PHNX-3695). Dead pid is not ours; no
 * `spawnedAt` or Windows assumes ours; a failed or empty probe reads as ours. */
async function isPidOursAsync(pid: number, spawnedAt: number | undefined): Promise<boolean> {
  if (!isAlive(pid)) return false;
  if (spawnedAt === undefined) return true;
  if (process.platform === 'win32') return true;
  const res = await execFileBounded('ps', ['-p', String(pid), '-o', 'etime='], { timeoutMs: PS_IDENTITY_TIMEOUT_MS });
  if (res.code !== 0) return true; // probe failed → keep the run, same as the sync catch
  return etimeIndicatesOurs(res.stdout.trim(), spawnedAt);
}

/** Finalize one `host:`-placed run by healing its host-task sidecar against the remote `.exit`
 * (lib/hosts/reconcile.ts). Mutates and persists the meta only when the sidecar reached a terminal
 * state. */
/** Apply a healed host-task's terminal state to the local run record. Shared by the sync and async host reconcilers. */
function applyHealedHostRun(
  meta: RunMeta,
  healed: { status: string; exitCode?: number | null; finishedAt?: string | null },
  // The routine-end emit takes the event-log file lock. On the heartbeat tick it must be the async
  // variant: the sync `withFileLock` (up to 30s under contention) freezes the event loop
  // (PHNX-3695, PHNX-3727). The sync CLI path (finalizeHostRun) keeps the synchronous default.
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

/** Async twin of finalizeHostRun for the heartbeat tick (PHNX-3695). The remote `.exit` is read
 * over ssh and must be async (`reconcileHostTaskAsync`), or one 6s ssh timeout freezes the whole
 * event loop. */
async function finalizeHostRunAsync(meta: RunMeta): Promise<void> {
  try {
    const task = loadHostTask(meta.hostTaskId!);
    if (!task) return;
    // Tick path: emit through the async, non-blocking file lock (PHNX-3727).
    applyHealedHostRun(meta, await reconcileHostTaskAsync(task), (m) => { void emitRoutineEndAsync(m); });
  } catch { /* unreachable host or unreadable sidecar — retry next sweep */ }
}

/** PIDs of in-flight detached routine children on this device: `running` local records whose
 * process is genuinely alive (`isPidOurs`). They survive a daemon exit in their own group
 * (SING-11a), so a takeover must not kill them and `stopDaemon` reports them (SING-12). */
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

/** Whether a `running` record is genuinely in flight; callers MUST gate on it. A provisional claim
 * is `running` with `pid: null` and isn't reaped, so a crash leaves a phantom (RUSH-2640). Local:
 * pid still ours; `host:` run: until its remote `.exit` is reconciled. */
export function isRunGenuinelyInFlight(meta: RunMeta): boolean {
  if (meta.status !== 'running') return false;
  if (meta.hostTaskId) return true;
  if (!meta.pid) return false;
  return isPidOurs(meta.pid, meta.spawnedAt);
}

/** Reconcile one `running` record once its process identity is known. Shared by sync
 * monitorRunningJobs and async reapExitedRunningJobs so finalize/timeout/report logic has one
 * copy. routine.end emitter is injected: async on the daemon tick, as its lock blocks (PHNX-3695). */
function reconcileRunningRecord(meta: RunMeta, jobRunsPath: string, runDirName: string, ours: boolean, emitEnd: (meta: RunMeta) => void): void {
  // Host-placed runs (meta.hostTaskId) are handled by the caller, sync or async
  // — their remote `.exit` read is ssh I/O that must stay off the daemon tick's
  // event loop (finalizeHostRunAsync). Records reaching here are local-pid runs.
  const runDirPath = path.join(jobRunsPath, runDirName);
  const stdoutPath = path.join(runDirPath, 'stdout.log');

  // Command-mode records carry no agent; there is no stream-json report to
  // parse or extract. Reap them on pid liveness alone.
  const isCommandRun = Boolean(meta.command) || !meta.agent;

  // Age-out runs first, before the null-pid guard, so a wedged `running` record past its deadline
  // is always finalized (a provisional claim whose daemon crashed, or a reused pid) (RUSH-2640).
  // Kill a process group only when it is still ours.
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
      // Command routines normally record their own status via child.on('exit'). Reaching here
      // means the daemon restarted mid-run and missed it, so recover the code from the exit-code
      // file; its absence means the child was killed or crashed.
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

/** Scan all `running` runs and finalize any whose process has exited. Synchronous, for off-loop
 * callers only (`agents routines list/status`, CLI orphan reaps); the daemon tick must use
 * reapExitedRunningJobs (PHNX-3695). */
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

/** Async, non-blocking twin of monitorRunningJobs for the heartbeat tick (PHNX-3695): same
 * reconcileRunningRecord, but `fs/promises` and the deadline-bounded isPidOursAsync, so the
 * every-tick scan never freezes the event loop. */
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
