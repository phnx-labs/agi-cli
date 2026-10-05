
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

/**
 * Record a routine run's auth outcome as a per-account FACT (PHNX-4116). A worker
 * runs entirely through routines and never probes, so an auth failure here — or a
 * clean success that clears a stale failure — is the honest evidence `agents view`
 * renders as `last used ok` / `last auth failure`. Best-effort: resolves the slot
 * from the routine's account name so the fact lands on the right row, and never
 * throws (a run it cannot attribute is simply not recorded).
 */
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
  } catch {  }
}

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

// Only status=running holds the active slot; every terminal record releases it.
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
    if (!run.pid) return run;
    if (isPidOurs(run.pid, run.spawnedAt)) return run;
  }
  return null;
}

export function activeRunSkipStreak(runs: RunMeta[]): number {
  let streak = 0;
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    if (run.status === 'skipped' && run.skipReason === 'active_run') { streak++; continue; }
    break;
  }
  return streak;
}

const SKIP_STREAK_ALERT_THRESHOLD = 3;

// The long-lived daemon never records its own pid as a provisional child claim.
export function launcherClaimPid(): number | null {
  try {
    const daemonPid = parseInt(fs.readFileSync(path.join(getDaemonDir(), 'daemon.pid'), 'utf-8').trim(), 10);
    if (Number.isFinite(daemonPid) && daemonPid === process.pid) return null;
  } catch {  }
  return process.pid;
}

interface RoutineTrigger {
  kind: NonNullable<RunMeta['triggerKind']>;
  scheduledFor?: Date | string;
}

interface RoutineAttempt {
  runId: string;
  stamp: Partial<Pick<RunMeta, 'triggerKind' | 'scheduledFor' | 'project' | 'requestedCwd' | 'resolvedCwd'>>;
}

type AttemptAllocation =
  | { proceed: true; attempt: RoutineAttempt }
  | { proceed: false; terminal: RunMeta };

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

function writeActiveClaim(config: JobConfig, attempt: RoutineAttempt): RunMeta {
  const now = new Date().toISOString();
  const meta: RunMeta = {
    jobName: config.name,
    runId: attempt.runId,
    ...runProvenance(config),
    ...attempt.stamp,
    ...(config.workflow ? { workflow: config.workflow } : config.command ? { command: config.command } : config.agent ? { agent: config.agent } : {}),
    pid: launcherClaimPid(),
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

// Schedule and catchup deliveries atomically claim the same (routine, UTC slot).
function allocateRoutineAttempt(config: JobConfig, trigger: RoutineTrigger): AttemptAllocation {
  const scheduledForIso = trigger.scheduledFor
    ? (typeof trigger.scheduledFor === 'string' ? trigger.scheduledFor : trigger.scheduledFor.toISOString())
    : undefined;

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

// Never signal this process; detached groups and pids are killed only for a birth-time-verified child.
function terminateRoutineTree(pid: number | null): void {
  if (!pid) return;
  if (pid === process.pid) return;
  if (process.platform === 'win32') {
    killTree(pid);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {  }
}

const ROUTINE_TRANSCRIPT_SPECS: Partial<Record<AgentId, Array<{ root: string[]; ext: string }>>> = {
  claude: [{ root: ['.claude', 'projects'], ext: '.jsonl' }],
  codex: [{ root: ['.codex', 'sessions'], ext: '.jsonl' }],
  cursor: [{ root: ['.cursor', 'projects'], ext: '.jsonl' }],
  antigravity: [{ root: ['.gemini', 'antigravity-cli', 'conversations'], ext: '.db' }],
  droid: [{ root: ['.factory', 'sessions'], ext: '.jsonl' }],
  kimi: [
    { root: ['.kimi-code', 'sessions'], ext: '.json' },
    { root: ['.kimi-code', 'sessions'], ext: '.jsonl' },
  ],
  grok: [{ root: ['.grok', 'sessions'], ext: '.json' }],
  muse: [{ root: ['.local', 'share', 'muse', 'sessions'], ext: '.jsonl' }],
};

export function routineSpawnCwd(
  config: Pick<JobConfig, 'name' | 'project' | 'cwd' | 'agent' | 'workflow' | 'command'>,
): string {
  const ctx = resolveJobExecutionContext(config, { mode: 'local' });
  return ctx.absoluteCwd ?? os.homedir();
}

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

export function buildJobCommand(config: JobConfig, resolvedPrompt: string, forwardAccount = true): string[] {
  if (config.workflow) {
    const cmd = ['agents', 'run', config.workflow, resolvedPrompt, '--mode', config.mode];
    if (config.account && forwardAccount) cmd.push('--account', config.account);
    return cmd;
  }

  const agent = config.agent!;

  if (config.resume) {
    const cmd = ['agents', 'run', agent, '--resume', config.resume, resolvedPrompt, '--mode', config.mode];
    if (config.account && forwardAccount) cmd.push('--account', config.account);
    return cmd;
  }

  if (isCustomHarnessName(agent)) {
    const cmd = ['agents', 'run', agent, resolvedPrompt, '--mode', config.mode];
    if (config.account && forwardAccount) cmd.push('--account', config.account);
    return cmd;
  }

  if (config.account && forwardAccount && !findAccount(config.account)) {
    const spec = config.version
      ? `${agent}@${config.version}#${config.account}`
      : `${agent}#${config.account}`;
    return ['agents', 'run', spec, resolvedPrompt, '--mode', config.mode];
  }

  const template = bakeRoutineArgv(agent);
  if (!template) {
    throw new Error(
      `Unsupported agent for daemon jobs: ${agent}. ` +
      `If '${agent}' was a custom harness, its profile no longer exists on this device — ` +
      `recreate it (agents harness add ${agent} ...) or point the routine at another agent.`,
    );
  }

  let cmd = template.map((part) => part.replace('{prompt}', resolvedPrompt));

  const mode = normalizeMode(config.mode);

  const routineAdapter = resolveHarnessAdapter(agent as AgentId);
  if (routineAdapter.routineModeArgs) {
    routineAdapter.routineModeArgs(cmd, { mode, config, resolveHeadlessMode });
    appendModelAndReasoning(cmd, config);
  }

  // A leading dash would turn a YAML directory into an injected harness flag.
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

function appendModelAndReasoning(cmd: string[], config: JobConfig): void {
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

const CONFIG_DIR_RELOCATED_AGENTS = new Set<AgentId>(['claude', 'codex']);

function usesSharedTranscriptHome(agent: AgentId, version: string | undefined): boolean {
  return Boolean(version) && CONFIG_DIR_RELOCATED_AGENTS.has(agent);
}

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

function transcriptBasePath(runDir: string): string {
  return path.join(runDir, '.transcript-base.json');
}

// Shared version homes contain sibling transcripts, so snapshot before spawn and archive only newly-created files.
export function snapshotRoutineTranscriptBase(
  meta: Pick<RunMeta, 'jobName' | 'agent' | 'version'>,
  runDir: string,
  overlayHome?: string,
): void {
  if (!meta.agent) return;
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
  }
}

function readTranscriptBase(runDir: string): Set<string> | null {
  try {
    const arr = JSON.parse(fs.readFileSync(transcriptBasePath(runDir), 'utf-8'));
    if (Array.isArray(arr)) return new Set(arr.filter((x): x is string => typeof x === 'string'));
  } catch {
  }
  return null;
}

export function archiveRoutineTranscripts(
  meta: Pick<RunMeta, 'jobName' | 'runId' | 'agent' | 'version'>,
  runDir: string,
  overlayHome?: string,
): void {
  if (!meta.agent) return;
  const specs = ROUTINE_TRANSCRIPT_SPECS[meta.agent as AgentId];
  if (!specs) return;

  const home = overlayHome ?? getJobHomePath(meta.jobName);
  const shared = usesSharedTranscriptHome(meta.agent as AgentId, meta.version);
  const base = readTranscriptBase(runDir);
  if (shared && base === null) return;

  for (const spec of specs) {
    const destRoot = path.join(runDir, 'sessions', meta.agent, spec.root[spec.root.length - 1]);
    for (const sourceRoot of routineTranscriptSourceRoots(meta.agent as AgentId, meta.version, home, spec)) {
      if (!fs.existsSync(sourceRoot)) continue;
      for (const sourcePath of walkForFiles(sourceRoot, spec.ext, 100_000)) {
        if (base?.has(sourcePath)) continue;
        const rel = path.relative(sourceRoot, sourcePath);
        if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
        const destPath = path.join(destRoot, rel);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        try {
          fs.copyFileSync(sourcePath, destPath);
          fs.chmodSync(destPath, 0o600);
        } catch {
        }
      }
    }
  }
}

function buildShellCommand(command: string): string[] {
  return process.platform === 'win32'
    ? ['cmd', '/c', command]
    : ['/bin/sh', '-c', command];
}

// Command routines intentionally keep real HOME/PATH; only agent routines receive overlay/version-home isolation.
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

function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Bind bare `agents` inside a command routine to the exact binary running this daemon.
function agentsShellFunction(): string {
  const launch = getCliLaunch(['__ac_placeholder__']);
  const parts: string[] = [launch.command];
  if (launch.args.length > 0 && launch.args[0] !== '__ac_placeholder__' && fs.existsSync(launch.args[0])) {
    parts.push(launch.args[0]);
  }
  const invocation = parts.map(shSingleQuote).join(' ');
  return `agents() { ${invocation} "$@"; }`;
}

function wrapCommandRoutine(command: string): string {
  if (process.platform === 'win32') return command;
  return `${agentsShellFunction()}\n${command}`;
}

function readCommandExitCode(runDir: string): number | null {
  try {
    const raw = fs.readFileSync(path.join(runDir, 'exit-code'), 'utf-8').trim();
    if (!/^-?\d+$/.test(raw)) return null;
    return parseInt(raw, 10);
  } catch {
    return null;
  }
}

interface RoutineLaunchPlan {
  chain: FallbackEntry[];
  rotation: RotateResult | null;
  pinned: boolean;
  forwardAccount?: boolean;
}

export function claudeVersionIsAuthenticated(version: string): boolean {
  if (!isVersionInstalled('claude', version)) return true;
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
    return { chain: [], rotation: null, pinned: false };
  }

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
    const unified = findUnifiedAccount(selectedCredential, meta);
    if (unified?.kind !== 'native') (deps.resolveCredentialAccount ?? resolveCredentialAccount)(selectedCredential, agent);
  }
  if (config.account && !explicitCredential) {
    const unified = findUnifiedAccount(config.account, meta, undefined, agent);
    if (unified?.kind === 'native' && unified.agent !== agent) {
      throw new Error(`Routine '${config.name}' account '${config.account}' is a ${unified.agent} login and cannot authenticate ${agent}.`);
    }
    const identity = unified?.kind === 'native' ? unified.identityKey : config.account;
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

  if (exhausted) {
    throw new Error(formatNoHealthyAccountError(agent, strategy, exhausted));
  }

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

export function pinJobBinary(cmd: string[], agent: AgentId, version: string | undefined): string[] {
  if (!version || cmd.length === 0) return cmd;
  if (!isVersionInstalled(agent, version)) return cmd;
  const binary = getBinaryPath(agent, version);
  if (!binary || !fs.existsSync(binary)) return cmd;
  const next = [...cmd];
  next[0] = binary;
  return next;
}

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
    timeout: config.timeout,
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
  const setupToken = agent === 'claude' && version
    ? resolveClaudeSetupToken(getVersionHomePath('claude', version))
    : null;
  if (isHeadedDeviceRole(selfConfiguredDeviceRole())) {
    if (setupToken && out.CLAUDE_CODE_OAUTH_TOKEN === setupToken) delete out.CLAUDE_CODE_OAUTH_TOKEN;
  } else if (setupToken) {
    out.CLAUDE_CODE_OAUTH_TOKEN = setupToken;
  } else {
    delete out.CLAUDE_CODE_OAUTH_TOKEN;
  }
  if (agent === 'cursor' && overlayHome) {
    out.XDG_CONFIG_HOME = path.join(overlayHome, '.config');
  }
  if (overlayHome && agent === 'claude') out.HOME = process.env.AGENTS_REAL_HOME || os.homedir();
  if (overlayHome && agent === 'codex') out.CODEX_HOME = path.join(overlayHome, '.codex');
  if (timezone) out.TZ = timezone;
  return out;
}

interface SpawnAttemptResult {
  exitCode: number | null;
  status: 'completed' | 'failed' | 'timeout';
  error?: string;
  logText: string;
  pid: number | null;
}

function spawnJobAttempt(
  cmd: string[],
  env: Record<string, string>,
  attemptLogPath: string,
  timeoutMs: number,
  combinedLogPath?: string,
  cwd: string = os.homedir(),
): Promise<SpawnAttemptResult> {
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
      try { fs.closeSync(stdoutFd); } catch {  }
      let logText = '';
      try {
        logText = fs.readFileSync(attemptLogPath, 'utf-8');
      } catch {  }
      if (combinedLogPath) {
        try {
          fs.appendFileSync(combinedLogPath, logText);
        } catch {  }
      }
      resolve({ ...result, logText });
    };

    const timeoutTimer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch {  }
      setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {  }
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

function runProvenance(config: JobConfig): { actor?: string; triggeredBy: string } {
  return { ...(config.actor ? { actor: config.actor } : {}), triggeredBy: resolveActor().id };
}

function injectRoutineActor(env: Record<string, string>, config: JobConfig): Record<string, string> {
  if (config.actor && !env.AGENTS_ACTOR) env.AGENTS_ACTOR = config.actor;
  return env;
}

export async function executeJob(
  config: JobConfig,
  deps?: LoopDeps,
  trigger: RoutineTrigger = { kind: 'manual' },
): Promise<RunResult> {
  return runWithAttempt(
    config,
    trigger,
    (attempt) => executeJobPlaced(config, deps, attempt),
    (meta) => ({ meta, reportPath: null }),
  );
}

async function executeJobPlaced(config: JobConfig, deps: LoopDeps | undefined, attempt: RoutineAttempt): Promise<RunResult> {
  {
    const { resolvePlacementTarget } = await import('../routines-placement.js');
    const target = await resolvePlacementTarget(config);
    const placed = await dispatchPlacedJob(config, target, attempt);
    if (placed) return placed;
  }

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
  snapshotRoutineTranscriptBase(meta, runDir, overlayHome);

  const preflightVersion = launch.chain[0]?.version;
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

  if (config.loop) {
    const spawnEnv = buildRoutineSpawnEnv(baseEnv, effectiveAgent, primaryVersion, config.timezone, overlayHome);
    const execOptions: ExecOptions = {
      agent: effectiveAgent,
      harnessName,
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

  const baseCmd = buildJobCommand(config, resolvedPrompt, launch.forwardAccount !== false);
  const stdoutPath = path.join(runDir, 'stdout.log');
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
      if (isAuthFailureFromLog(attempt.logText, effectiveAgent, { processFailed: false })) {
        const reason = authFailureReason(attempt.logText) ?? 'authentication_failed';
        recordRoutineAuthOutcome(attemptAgent, config.account, attemptVersion, { ok: false, verdict: 'revoked', detail: reason });
        finalizeRunMeta(meta, 'failed', attempt.exitCode ?? 1, { errorMessage: `auth_failed: ${reason}` });
        writeRunMeta(meta);
        timer.end({ status: 'failed', exitCode: meta.exitCode ?? undefined, runId, error: `auth_failed: ${reason}` });
        archiveRoutineTranscripts(meta, runDir, overlayHome);
        return { meta, reportPath: null };
      }
      recordRoutineAuthOutcome(attemptAgent, config.account, attemptVersion, { ok: true });
      finalizeRunMeta(meta, 'completed', 0);
      writeRunMeta(meta);
      timer.end({ status: 'completed', exitCode: 0, runId });
      const reportPath = extractAndSaveReport(stdoutPath, effectiveAgent, runDir);
      archiveRoutineTranscripts(meta, runDir, overlayHome);
      return { meta, reportPath };
    }

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
    const reportPath = authFailed ? null : extractAndSaveReport(stdoutPath, effectiveAgent, runDir);
    archiveRoutineTranscripts(meta, runDir, overlayHome);
    return { meta, reportPath };
  }

  finalizeRunMeta(meta, 'failed', 1);
  writeRunMeta(meta);
  timer.end({ status: 'failed', exitCode: 1, runId });
  return { meta, reportPath: null };
}

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
    try { insertTask(task); } catch {  }
    meta.cloudTaskId = task.id;
    meta.cloudProvider = task.provider;

    if (task.status === 'completed') {
      finalizeRunMeta(meta, 'completed', 0);
    } else if (task.status === 'failed' || task.status === 'cancelled') {
      finalizeRunMeta(meta, 'failed', 1, { errorMessage: task.summary ?? `cloud ${task.status}` });
    }
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
    pid: null,
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

  if (!opts.detached && exitCode !== null && exitCode !== undefined && exitCode !== -1) {
    finalizeRunMeta(meta, exitCode === 0 ? 'completed' : 'failed', exitCode);
  }
  writeRunMeta(meta);
  timer.end({ status: meta.status, exitCode: meta.exitCode ?? undefined, runId });
  return { meta, reportPath: null };
}


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
      try { fs.closeSync(stdoutFd); } catch {  }
      resolve(r);
    };

    const timeoutTimer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch {  }
      setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {  }
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

interface RoutineHooks {
  onFinish?: (meta: RunMeta) => void;
}

function safeHook(fn: (() => void) | undefined): void {
  if (!fn) return;
  try { fn(); } catch {  }
}

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

  if (config.command) {
    return executeCommandJobDetached(config, attempt, hooks);
  }

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
  if (!dispatchesViaAgentsRun(config) && version && config.agent) {
    cmd = pinJobBinary(cmd, config.agent as AgentId, version);
  }

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
    : buildRoutineSpawnEnv(baseEnv, config.agent! as AgentId, version, config.timezone, overlayHome);

  // RUSH-2860: if this host holds gh auth, the sandbox child MUST see it —
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
  snapshotRoutineTranscriptBase(meta, runDir, overlayHome);

  const preflightVersion = launch.chain[0]?.version;
  const { fireTimeAuthReadiness } = await import('../routine-readiness.js');
  const authBlocker = preflightVersion ? fireTimeAuthReadiness(effectiveAgent, preflightVersion) : null;
  if (authBlocker) {
    process.stderr.write(
      `[agents] routine ${config.name}: ${effectiveAgent}@${preflightVersion} ${authBlocker.code} — skipping run (${authBlocker.repair})\n`,
    );
    try { fs.closeSync(stdoutFd); } catch {  }
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
    const isAuthFailure = !!errorMessage && errorMessage.startsWith('auth_failed:');
    if (status !== 'timeout' && !isAuthFailure) extractAndSaveReport(stdoutPath, effectiveAgent, runDir);
    timer.end({ status, exitCode: exitCode ?? undefined, runId, ...(errorMessage ? { error: errorMessage } : {}) });
    safeHook(hooks?.onFinish ? () => hooks.onFinish!(meta) : undefined);
  };

  timeoutTimer = setTimeout(() => {
    terminateRoutineTree(child.pid ?? null);
    settle('timeout', null, 'exceeded configured timeout');
  }, meta.timeoutMs);

  child.on('exit', (code) => {
    let logText = '';
    try { logText = fs.readFileSync(stdoutPath, 'utf-8'); } catch {  }
    if (isAuthFailureFromLog(logText, effectiveAgent, { processFailed: (code ?? 1) !== 0 })) {
      const reason = authFailureReason(logText) ?? 'authentication_failed';
      recordRoutineAuthOutcome(effectiveAgent, config.account, meta.version, { ok: false, verdict: 'revoked', detail: reason });
      settle('failed', code ?? 1, `auth_failed: ${reason}`);
      return;
    }
    const inferred = inferFinalStatusFromLog(stdoutPath, effectiveAgent);
    const finalStatus = inferred ? inferred.status : (code === 0 ? 'completed' : 'failed');
    if (finalStatus === 'completed') recordRoutineAuthOutcome(effectiveAgent, config.account, meta.version, { ok: true });
    if (inferred) {
      settle(inferred.status, inferred.exitCode);
    } else {
      settle(code === 0 ? 'completed' : 'failed', code ?? 1);
    }
  });

  child.on('error', (err) => {
    try { fs.closeSync(stdoutFd); } catch {  }
    settle('failed', 1, err.message);
    process.stderr.write(`[agents] daemon: spawn failed for job "${config.name}": ${err.message}\n`);
  });

  child.unref();
  try { fs.closeSync(stdoutFd); } catch {  }

  meta.pid = child.pid || null;
  writeRunMeta(meta);

  return { ...meta };
}

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

  const exitCodePath = path.join(runDir, 'exit-code');
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

  let settled = false;
  let timeoutTimer: NodeJS.Timeout | undefined;
  const settle = (status: RunMeta['status'], exitCode: number | null, errorMessage?: string) => {
    if (settled) return;
    settled = true;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    finalizeRunMeta(meta, status, exitCode, errorMessage ? { errorMessage } : undefined);
    writeRunMeta(meta);
    timer.end({ status, exitCode: exitCode ?? undefined, runId, ...(errorMessage ? { error: errorMessage } : {}) });
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
  try { fs.closeSync(stdoutFd); } catch {  }

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

      } catch {  }
    }

    return lastMessage || null;
  } catch {
    return null;
  }
}

export function inferFinalStatusFromLog(
  stdoutPath: string,
  agent: AgentId,
): { status: 'completed' | 'failed'; exitCode: number } | null {
  if (!fs.existsSync(stdoutPath)) return null;
  try {
    const content = fs.readFileSync(stdoutPath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());
    for (let i = lines.length - 1, scanned = 0; i >= 0 && scanned < 20; i--, scanned++) {
      try {
        const parsed = JSON.parse(lines[i]);
        if ((agent === 'claude' || agent === 'cursor') && parsed.type === 'result') {
          return parsed.is_error
            ? { status: 'failed', exitCode: 1 }
            : { status: 'completed', exitCode: 0 };
        }
      } catch {
      }
    }
    return null;
  } catch {
    return null;
  }
}

const MAX_WALL_CLOCK_MS = 24 * 60 * 60 * 1000;

const PS_IDENTITY_TIMEOUT_MS = 5_000;

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

async function isPidOursAsync(pid: number, spawnedAt: number | undefined): Promise<boolean> {
  if (!isAlive(pid)) return false;
  if (spawnedAt === undefined) return true;
  if (process.platform === 'win32') return true;
  const res = await execFileBounded('ps', ['-p', String(pid), '-o', 'etime='], { timeoutMs: PS_IDENTITY_TIMEOUT_MS });
  if (res.code !== 0) return true;
  return etimeIndicatesOurs(res.stdout.trim(), spawnedAt);
}

function applyHealedHostRun(
  meta: RunMeta,
  healed: { status: string; exitCode?: number | null; finishedAt?: string | null },
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
  } catch {  }
}

async function finalizeHostRunAsync(meta: RunMeta): Promise<void> {
  try {
    const task = loadHostTask(meta.hostTaskId!);
    if (!task) return;
    applyHealedHostRun(meta, await reconcileHostTaskAsync(task), (m) => { void emitRoutineEndAsync(m); });
  } catch {  }
}

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
      } catch {  }
    }
  }
  return pids;
}

export function isRunGenuinelyInFlight(meta: RunMeta): boolean {
  if (meta.status !== 'running') return false;
  if (meta.hostTaskId) return true;
  if (!meta.pid) return false;
  return isPidOurs(meta.pid, meta.spawnedAt);
}

function reconcileRunningRecord(meta: RunMeta, jobRunsPath: string, runDirName: string, ours: boolean, emitEnd: (meta: RunMeta) => void): void {
  const runDirPath = path.join(jobRunsPath, runDirName);
  const stdoutPath = path.join(runDirPath, 'stdout.log');

  const isCommandRun = Boolean(meta.command) || !meta.agent;

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
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }

    for (const runDirEntry of runDirs) {
      const metaPath = path.join(jobRunsPath, runDirEntry.name, 'meta.json');
      if (!fs.existsSync(metaPath)) continue;

      try {
        const meta: RunMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        if (meta.status !== 'running') continue;
        if (meta.hostTaskId) { finalizeHostRun(meta); continue; }
        const ours = meta.pid ? isPidOurs(meta.pid, meta.spawnedAt) : false;
        reconcileRunningRecord(meta, jobRunsPath, runDirEntry.name, ours, emitRoutineEnd);
      } catch {  }
    }
  }
}

export async function reapExitedRunningJobs(): Promise<void> {
  const runsDir = getRunsDir();
  let jobDirs: fs.Dirent[];
  try {
    jobDirs = await fsp.readdir(runsDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const jobDir of jobDirs) {
    if (!jobDir.isDirectory()) continue;
    const jobRunsPath = path.join(runsDir, jobDir.name);
    let runDirs: fs.Dirent[];
    try {
      runDirs = await fsp.readdir(jobRunsPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const runDirEntry of runDirs) {
      if (!runDirEntry.isDirectory()) continue;
      try {
        const raw = await fsp.readFile(path.join(jobRunsPath, runDirEntry.name, 'meta.json'), 'utf-8');
        const meta: RunMeta = JSON.parse(raw);
        if (meta.status !== 'running') continue;
        if (meta.hostTaskId) { await finalizeHostRunAsync(meta); continue; }
        const ours = meta.pid ? await isPidOursAsync(meta.pid, meta.spawnedAt) : false;
        reconcileRunningRecord(meta, jobRunsPath, runDirEntry.name, ours, (m) => { void emitRoutineEndAsync(m); });
      } catch {  }
    }
  }
}
