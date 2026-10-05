/** Scheduled job (routine) configuration and run history: routines are YAML files in
 * ~/.agents/routines/ defining recurring or one-shot agent tasks. CRUD on configs, run metadata
 * persistence, prompt variable expansion, and one-shot "at" scheduling. */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { Cron } from 'croner';
import { getRoutinesDir, getSystemRoutinesDir, getRunsDir, ensureAgentsDir, getProjectRoutinesDir } from '../state.js';
import * as os from 'os';
import { safeJoin, isSafeSegmentName } from '../paths.js';
import { isSafeProjectName, loadProjectDef, projectBasePath } from '../projects.js';
import { isCustomHarnessName } from '../profiles.js';
import {
  resolveRoutineExecutionContext,
  type ResolvedExecutionContext,
  type ProjectResolution,
  type PlacementMode,
  type RoutineKind,
  type ContextFsProbe,
} from '../routine-context.js';
import { atomicWriteFileSync } from '../fs-atomic.js';
import type { AgentId, RunStrategy } from '../types.js';
import { ALL_AGENT_IDS, ROUTINE_AGENT_IDS } from '../agents.js';
import { RUN_STRATEGIES } from '../accounting/rotate.js';
import type { LoopConfig } from '../loop.js';
import { machineId, normalizeHost } from '../machine-id.js';
import { resolveActor } from '../actor.js';
import { percentile } from '../percentile.js';
import {
  enabledRoutineNames,
  devicesWithRoutineEnabled,
  replaceEnabledRoutines,
  routineEnabledOnThisDevice,
  setRoutineEnabledOnThisDevice,
} from '../routine-activation.js';
import { humanizeCron, humanizeNextRun } from '../routines-format.js';
import { discoverProjectRoutines } from '../routines-project.js';
import { listProjectDefs } from '../projects.js';
import { monitorRunningJobs, isRunGenuinelyInFlight } from '../daemon/runner.js';
import { JobScheduler } from '../scheduler.js';
import { detectOverdueJobs } from '../overdue.js';

export function fireConditionLabel(job: JobConfig): string {
  if (job.schedule) return humanizeCron(job.schedule, job.timezone);
  if (job.trigger) {
    if (job.trigger.type === 'github_event') {
      const scope = job.trigger.repo
        ? ` (${job.trigger.repo}${job.trigger.branch ? `@${job.trigger.branch}` : ''})`
        : '';
      const filters = [
        job.trigger.action ? `action=${job.trigger.action}` : null,
        job.trigger.label ? `label=${job.trigger.label}` : null,
      ].filter(Boolean).join(', ');
      return `on github:${job.trigger.event}${scope}${filters ? ` (${filters})` : ''}`;
    }
    const filters = [
      job.trigger.action ? `action=${job.trigger.action}` : null,
      job.trigger.teamKey ? `team=${job.trigger.teamKey}` : null,
      job.trigger.label ? `label=${job.trigger.label}` : null,
      job.trigger.stateTo ? `stateTo=${job.trigger.stateTo}` : null,
      job.trigger.stateFrom ? `stateFrom=${job.trigger.stateFrom}` : null,
    ].filter(Boolean).join(', ');
    return `on linear:${job.trigger.event}${filters ? ` (${filters})` : ''}`;
  }
  return '-';
}

export function nextRunForDisplay(job: JobConfig, scheduler: JobScheduler): Date | null {
  if (isPastOneShotRoutine(job)) return null;
  return scheduler.getNextRun(job.name);
}

export function nextRunLabel(job: JobConfig, scheduler: JobScheduler, now: Date): string {
  if (isPastOneShotRoutine(job)) return 'expired';
  return humanizeNextRun(scheduler.getNextRun(job.name) ?? null, now, job.timezone);
}

export function localLatestRun(job: JobConfig): RunMeta | null {
  return jobRunsOnThisDevice(job) ? getLatestRun(job.name) : null;
}

export function listJobsForDisplay(cwd?: string): JobConfig[] {
  const jobs = listJobs(cwd);
  const seen = new Set(jobs.map((j) => j.name));
  for (const discovered of discoverProjectRoutines()) {
    if (seen.has(discovered.name)) continue;
    seen.add(discovered.name);
    jobs.push(discovered.config);
  }
  return jobs;
}

export function buildRoutineListJson(): Record<string, unknown>[] {
  try { monitorRunningJobs(); } catch { /* best-effort orphan reap */ }
  const jobs = listJobsForDisplay(process.cwd());
  if (jobs.length === 0) return [];

  const scheduler = new JobScheduler(async () => {});
  scheduler.loadAll();
  try {
    const overdueSet = new Set<string>();
    try {
      for (const job of detectOverdueJobs()) overdueSet.add(job.name);
    } catch {
      // Best-effort indicator; never block the list on detection errors.
    }
    const now = new Date();
    const knownProjectNames = new Set(listProjectDefs().map((project) => project.name));
    return jobs.map((job) => {
      const latestRun = localLatestRun(job);
      const enabledDevices = devicesWithRoutineEnabled(job.name);
      return {
        name: job.name,
        agent: job.agent ?? null,
        workflow: job.workflow ?? null,
        command: job.command ?? null,
        repo: job.repo ?? null,
        schedule: job.schedule ?? null,
        scheduleHuman: fireConditionLabel(job),
        trigger: job.trigger ?? null,
        timezone: job.timezone ?? null,
        devices: enabledDevices,
        enabledDevices,
        host: job.host ?? null,
        hostStrategy: resolveHostStrategy(job),
        source: job.source ?? null,
        sourceRepo: job.source?.repo ?? job.repo ?? null,
        sourceBranch: job.source?.branch ?? null,
        runOnce: Boolean(job.runOnce),
        catchup: job.catchup !== false,
        oneShot: isOneShotRoutine(job),
        expired: isPastOneShotRoutine(job, now),
        runsHere: jobRunsOnThisDevice(job),
        enabled: job.enabled,
        overdue: overdueSet.has(job.name),
        nextRun: nextRunForDisplay(job, scheduler)?.toISOString() ?? null,
        nextRunHuman: nextRunLabel(job, scheduler, now),
        lastStatus: latestRun?.status ?? null,
        exitCode: latestRun?.exitCode ?? null,
        failureReason: latestRun?.errorMessage ?? null,
        lastRunStartedAt: latestRun?.startedAt ?? null,
        lastRunCompletedAt: latestRun?.completedAt ?? null,
        projects: job.projects ?? [],
        projectGroup: computeProjectGroup(job.projects, knownProjectNames),
      };
    });
  } finally {
    scheduler.stopAll();
  }
}

/** One routine's live scheduler-status row for `agents routines status --json`. */
interface RoutineStatusRow {
  name: string;
  /** The single device this routine is pinned to fire on, or null when unpinned. */
  ownerDevice: string | null;
  /** True when `devices:` names more than one device — no single owner (doctor flags it). */
  ambiguousDevicePin: boolean;
  /** Every device this routine is enabled on. */
  enabledDevices: string[];
  /** Whether THIS device is the one that fires the routine. */
  runsHere: boolean;
  enabled: boolean;
  overdue: boolean;
  nextRun: string | null;
  /** Terminal status of the last local fire: completed/failed/timeout/missed/blocked/skipped/running, or null if it never ran here. */
  lastStatus: RunMeta['status'] | null;
  /** The last fire's failure reason, when it did not complete cleanly. Named to match `list --json`'s `failureReason`. */
  failureReason: string | null;
  lastRunStartedAt: string | null;
  lastRunCompletedAt: string | null;
  /** Present only while a run is genuinely in flight on THIS device (a live local child or a host-placed run) — never a provisional pre-spawn claim. */
  inFlight: { runId: string; pid: number | null; startedAt: string; triggerKind: RunMeta['triggerKind'] | null } | null;
}

/** Rows behind `agents routines status --json`: the scheduler-truth surface (owner device, last
 * fire outcome and error, in-flight spawn), unlike definition-shaped `list --json` (PHNX-3215). */
export function buildRoutineStatusRows(): RoutineStatusRow[] {
  try { monitorRunningJobs(); } catch { /* best-effort orphan reap */ }
  const jobs = listJobs();
  if (jobs.length === 0) return [];

  const scheduler = new JobScheduler(async () => {});
  scheduler.loadAll();
  try {
    const overdueSet = new Set<string>();
    try {
      for (const job of detectOverdueJobs()) overdueSet.add(job.name);
    } catch {
      // Best-effort indicator; never block status on detection errors.
    }
    const now = new Date();
    return jobs.map((job) => {
      const latestRun = localLatestRun(job);
      const inFlight = latestRun && isRunGenuinelyInFlight(latestRun)
        ? {
            runId: latestRun.runId,
            pid: latestRun.pid,
            startedAt: latestRun.startedAt,
            triggerKind: latestRun.triggerKind ?? null,
          }
        : null;
      return {
        name: job.name,
        ownerDevice: routineOwnerDevice(job),
        ambiguousDevicePin: hasAmbiguousDevicePin(job),
        enabledDevices: devicesWithRoutineEnabled(job.name),
        runsHere: jobRunsOnThisDevice(job),
        enabled: job.enabled,
        overdue: overdueSet.has(job.name),
        nextRun: nextRunForDisplay(job, scheduler)?.toISOString() ?? null,
        lastStatus: latestRun?.status ?? null,
        failureReason: latestRun?.errorMessage ?? null,
        lastRunStartedAt: latestRun?.startedAt ?? null,
        lastRunCompletedAt: latestRun?.completedAt ?? null,
        inFlight,
      };
    });
  } finally {
    scheduler.stopAll();
  }
}

/** Tool/site/directory allow-list for sandboxed job execution. */
export interface JobAllowConfig {
  tools?: string[];
  sites?: string[];
  dirs?: string[];
}

/** Where a routine's job body executes when the daemon fires it. Distinct from `devices` (which
 * daemon may fire) and the CLI `--device` passthrough (manage routines on another machine). */
export type HostStrategy = 'local' | 'host' | 'fleet' | 'cloud';

export const HOST_STRATEGIES: readonly HostStrategy[] = ['local', 'host', 'fleet', 'cloud'] as const;

/** Provenance for a routine materialised from a project (`.agents/routines/*.yml` synced into the
 * user layer after opt-in). */
export interface JobSource {
  /** Always `project` today; reserved for future layers. */
  kind: 'project';
  /** Absolute path to the project root that owns the YAML. */
  projectPath: string;
  /** GitHub `owner/repo` when the project has a GitHub origin remote. */
  repo?: string;
  /** Branch at last sync (when known). */
  branch?: string;
  /** Short commit SHA at last sync (when known). */
  commit?: string;
}

/** GitHub webhook events a routine can be triggered by. */
export type GithubTriggerEvent = 'pull_request' | 'push' | 'issue_comment' | 'workflow_run';

/** Canonical set of accepted GitHub trigger events — single source for validation. */
export const GITHUB_TRIGGER_EVENTS: readonly GithubTriggerEvent[] = [
  'pull_request',
  'push',
  'issue_comment',
  'workflow_run',
];

/** Linear webhook resource types a routine can be triggered by. */
export type LinearTriggerEvent = 'Issue' | 'IssueLabel' | 'Comment' | 'Project' | 'Cycle';

/** Canonical set of accepted Linear trigger events — single source for validation. */
const LINEAR_TRIGGER_EVENTS: readonly LinearTriggerEvent[] = [
  'Issue',
  'IssueLabel',
  'Comment',
  'Project',
  'Cycle',
];

/** Map a user-facing `--on` alias to a canonical GitHub trigger event (canonical names plus
 * shortcuts like `pr`, `comment`); null when unknown. */
export function normalizeTriggerEvent(input: string): GithubTriggerEvent | null {
  const key = input.trim().toLowerCase();
  const aliases: Record<string, GithubTriggerEvent> = {
    pull_request: 'pull_request',
    pr: 'pull_request',
    pr_opened: 'pull_request',
    pull: 'pull_request',
    push: 'push',
    issue_comment: 'issue_comment',
    comment: 'issue_comment',
    workflow_run: 'workflow_run',
    workflow: 'workflow_run',
  };
  return aliases[key] ?? null;
}

/** Event-based fire condition for a routine, an alternative or complement to `schedule`: webhooks
 * whose filters match fire the job through the same dispatch path as a cron fire. See
 * `src/lib/triggers/webhook.ts`. */
export interface GithubJobTrigger {
  type: 'github_event';
  event: GithubTriggerEvent;
  /** `owner/name` — when set, only payloads for this repo match. */
  repo?: string;
  /** git branch (ref short name) — when set, only payloads for this branch match. */
  branch?: string;
  /** GitHub webhook action, e.g. `opened`, `synchronize`, or `labeled`. */
  action?: string;
  /** Required GitHub label name. For `pull_request.labeled`, this is the added label. */
  label?: string;
}

export interface LinearJobTrigger {
  type: 'linear_event';
  event: LinearTriggerEvent;
  /** Linear action, e.g. `create`, `update`, `remove`. */
  action?: string;
  /** Issue identifier prefix such as `RUSH`; useful when one webhook spans teams. */
  teamKey?: string;
  /** Required issue label name. */
  label?: string;
  /** Fire on a transition INTO this Linear state (e.g. `Plan`): the current state
   *  must match AND the delivery's `updatedFrom` must record a state change, so a
   *  later edit that leaves the issue in this state does not re-fire (RUSH-2539). */
  stateTo?: string;
  /** Previous Linear state name that must match (e.g. `Triage`). */
  stateFrom?: string;
}

export type JobTrigger = GithubJobTrigger | LinearJobTrigger;

/** Full routine configuration (persisted as YAML). A job fires on a `schedule` (cron), a `trigger`
 * (event/webhook), or both; trigger-only jobs omit `schedule` and the cron scheduler skips them. */
export interface JobConfig {
  name: string;
  /** Cron expression. Optional when `trigger` is set (event-only routine). */
  schedule?: string;
  /** Event/webhook fire condition. Optional when `schedule` is set. */
  trigger?: JobTrigger;
  /** Which agent runs the routine: a native harness id or a custom harness name (delegated to
   * `agents run <name>` like workflows). Omitted for `workflow`/`command` routines; exactly one of
   * agent/workflow/command must be set. */
  agent?: AgentId | (string & {});
  workflow?: string;
  /** A plain shell command run directly instead of an agent/workflow: no LLM, auth, rotation, tokens
   * or sandbox overlay. For deterministic housekeeping (version-check, `git pull`, notify).
   * Exclusive with `agent` and `workflow`. */
  command?: string;
  // 'full' is accepted as a permanent silent alias for 'skip' (see normalizeMode).
  mode: 'plan' | 'edit' | 'auto' | 'skip' | 'full';
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';
  timeout: string;
  enabled: boolean;
  prompt: string;
  timezone?: string;
  repo?: string;
  /** Singular execution anchor: the named project whose base dir the run lands in, resolved on the
   * execution TARGET (routine-context.ts), never the daemon's cwd. Metadata-only `projects[]` is
   * never used for execution. CLI flag `--project-anchor` (`--project` writes `projects[]`). */
  project?: string;
  /** Portable execution dir. A relative value resolves under the `project` base if usable, else the
   * target's `$HOME`; `~/` is target-home-relative; an absolute path under home is normalized to
   * `~/...` on save. Absolute outside home is local-pinned only (else paused non-portable). */
  cwd?: string;
  /** Fleet allowlist restricting this routine to specific devices. Omitted or empty: fires on every
   * scheduling device. Set: only devices whose `machineId()` matches (via `normalizeHost`)
   * schedule, fire, catch up or count it overdue; elsewhere it is inert and `run` refuses. */
  devices?: string[];
  /** Whether a fire this device missed (daemon down, asleep) runs late. Default true: croner
   * schedules only forward, so a miss would silently vanish. `catchup: false` suits clock-bound
   * routines (a 9am brief is worthless at 3pm); the miss is still recorded as a `missed` run. */
  catchup?: boolean;
  /** ISO 8601 creation time, stamped once by {@link writeJob}. Overdue detection needs it as a
   * floor: `detectOverdueJobs` walks back a week, so a new routine would be "overdue" for fires
   * before it existed, and auto-catchup would run it immediately. */
  createdAt?: string;
  /** Environment variables injected into the spawned run on top of the sandbox overlay's own; merged
   * by `buildSpawnEnv`, so it covers both foreground and detached execution. */
  env?: Record<string, string>;
  /** Execution placement: run the job body over SSH on this machine (registered host, device,
   * capability tag or user@host). Distinct from `devices` (which daemon FIRES). CLI flag `--run-on`
   * (`--device` means managing routines on that machine). Required only for `hostStrategy. */
  host?: string;
  /** Where the job body runs: `local` (firing machine, default), `host` (named host over SSH),
   * `fleet` (one online device per run; firing pin stays on `devices`), `cloud` (the agent's native
   * cloud provider). CLI flag `--placement`. Omitted: `host` if `host:` is set, else `local`. */
  hostStrategy?: HostStrategy;
  /** Working directory on the host for `host:`-placed runs. */
  remoteCwd?: string;
  /** Provenance for routines materialised from a project (user-layer copy after opt-in); absent for
   * hand-authored user/system routines. */
  source?: JobSource;
  variables?: Record<string, string>;
  sandbox?: boolean;
  allow?: JobAllowConfig;
  config?: Record<string, unknown>;
  version?: string;
  /** Per-routine version/account selection strategy, same vocabulary as `agents run --strategy`.
   * Overrides the firing device's `run.<agent>.strategy` so the policy travels with the definition.
   * Conflicts with `version:` (a pin leaves nothing to select); validateJob rejects both. */
  strategy?: RunStrategy;
  /** Pin this routine to a signed-in account by identity (email or key) instead of rotating; at
   * launch it resolves to the version holding that account. Distinct accounts keep concurrent
   * routines off a shared single-use OAuth refresh token (RUSH-1957). Prefer over `version:`. */
  account?: string;
  runOnce?: boolean;
  // RFC3339 timestamp; routine auto-disables at the next fire on/after this time.
  endAt?: string;
  /** When set, the job resumes this agent session id (`agents run <agent> --resume <id>`) instead of
   * a fresh conversation, with `prompt` as the next turn. Powers self-scheduled wake-ups (e.g.
   * /hibernate). claude/codex only. */
  resume?: string;
  /** When set, executeJob runs this job through the loop driver instead of once. */
  loop?: LoopConfig;
  /** Actor id of whoever CREATED this routine (`resolveActor().id`, stamped by `writeJob`, kept
   * across edits), propagated into each run's env and RunMeta so an unattended cron traces to its
   * scheduler, not `UNRESOLVED@<host>` (RUSH-2020). */
  actor?: string;
  /** Named projects this routine belongs to; metadata only (grouping in `agents routines list` and
   * the menu bar), no effect on scheduling. `["*"]` is all projects; one name is that project;
   * several is "Cross-project"; absent is "Operations". */
  projects?: string[];
  /** Set only by `lib/monitors/dispatch.ts` on the one-off job synthesized for a monitor `run`;
   * it is never in the activation manifest, so gating on that refused every monitor action
   * (RUSH-2681). Runtime-only: writeJob strips it; readJobFileResult refuses a file with it. */
  dispatchedBy?: 'monitor' | 'webhook';
}

/** Canonical form of `projects`: drop non-string and empty entries, dedupe in first-seen order. The
 * single source of truth for normalization, applied at `writeJob` and grouping so duplicates in
 * hand-written YAML behave like the single entry. Undefined when nothing survives. */
export function normalizeProjects(projects: string[] | undefined): string[] | undefined {
  if (!Array.isArray(projects) || projects.length === 0) return undefined;
  const out = [...new Set(projects.filter((p): p is string => typeof p === 'string' && p !== ''))];
  return out.length === 0 ? undefined : out;
}

/** A routine's project bucket, discriminated by `kind` so buckets never key on display labels: a
 * project literally named "Operations" or "Cross-project" is `{ kind: 'named' }` and can't collide
 * with the special buckets. */
type ProjectGroup =
  | { kind: 'named'; name: string }
  | { kind: 'all' }
  | { kind: 'cross' }
  | { kind: 'operations' }
  | { kind: 'unknown' };

/** Classify a routine's `projects` into a discriminated {@link ProjectGroup}. Duplicates collapse
 * first ({@link normalizeProjects}), so `[myapp, myapp]` is one named project. `knownProjectNames`
 * is the set from `listProjectDefs`. */
export function computeProjectGroupKind(
  projects: string[] | undefined,
  knownProjectNames: Set<string>,
): ProjectGroup {
  const norm = normalizeProjects(projects);
  if (!norm) return { kind: 'operations' };
  if (norm.length === 1 && norm[0] === '*') return { kind: 'all' };
  const hasUnknown = norm.some((p) => p !== '*' && !knownProjectNames.has(p));
  if (hasUnknown) return { kind: 'unknown' };
  if (norm.length === 1) return { kind: 'named', name: norm[0] };
  return { kind: 'cross' };
}

/** Human display title for a {@link ProjectGroup}. */
export function projectGroupTitle(group: ProjectGroup): string {
  switch (group.kind) {
    case 'named': return group.name;
    case 'all': return 'All projects';
    case 'cross': return 'Cross-project';
    case 'operations': return 'Operations';
    case 'unknown': return 'Unknown projects';
  }
}

/** Stable bucket key for a {@link ProjectGroup}: `named:` prefix for projects, `special:` for
 * specials. The namespaces can't collide, so a project named "Operations" differs from the
 * no-project special. */
export function projectGroupKey(group: ProjectGroup): string {
  return group.kind === 'named' ? `named:${group.name}` : `special:${group.kind}`;
}

/** Sort rank for a {@link ProjectGroup}: named projects first, then specials in a fixed order. */
export function projectGroupOrder(group: ProjectGroup): number {
  switch (group.kind) {
    case 'named': return 0;
    case 'all': return 1;
    case 'cross': return 2;
    case 'operations': return 3;
    case 'unknown': return 4;
  }
}

/** Display group label for `projects`, for JSON `projectGroup` and text consumers (grouping uses
 * {@link computeProjectGroupKind}). One known name: that name; `["*"]`: "All projects"; several:
 * "Cross-project"; none: "Operations"; any stale entry: "Unknown projects". */
export function computeProjectGroup(
  projects: string[] | undefined,
  knownProjectNames: Set<string>,
): string {
  return projectGroupTitle(computeProjectGroupKind(projects, knownProjectNames));
}

/** A real-filesystem {@link ContextFsProbe} for readiness checks on this machine. */
function realFsProbe(): ContextFsProbe {
  return {
    exists: (p) => fs.existsSync(p),
    isDirectory: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
    isWritable: (p) => { try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; } },
  };
}

/** Classify a routine by its body kind — governs the execution-context fallback rules. */
function jobRoutineKind(config: Pick<JobConfig, 'agent' | 'workflow' | 'command'>): RoutineKind {
  if (config.command) return 'command';
  if (config.workflow) return 'workflow';
  return 'agent';
}

/** Resolve a routine's execution context by bridging `project`/`cwd` into {@link
 * resolveRoutineExecutionContext}. Local placement uses this machine's `$HOME` and a real
 * filesystem probe. */
export function resolveJobExecutionContext(
  config: Pick<JobConfig, 'name' | 'project' | 'cwd' | 'agent' | 'workflow' | 'command'>,
  opts: { targetHome?: string; mode?: PlacementMode; probe?: ContextFsProbe | null; projectResolution?: ProjectResolution } = {},
): ResolvedExecutionContext {
  const targetHome = opts.targetHome ?? os.homedir();
  const mode = opts.mode ?? 'local';
  const probe = opts.probe === null
    ? undefined
    : (opts.probe ?? (mode === 'local' ? realFsProbe() : undefined));
  let projectResolution: ProjectResolution | undefined = opts.projectResolution;
  if (config.project !== undefined && projectResolution === undefined) {
    const def = loadProjectDef(config.project);
    projectResolution = def
      ? { defined: true, base: projectBasePath(def, true) } // portable (~/) base form
      : { defined: false };
  }
  return resolveRoutineExecutionContext({
    name: config.name,
    project: config.project,
    cwd: config.cwd,
    kind: jobRoutineKind(config),
    mode,
    targetHome,
    projectResolution,
    probe,
  });
}

/** Metadata for a single job execution, persisted as JSON in the run directory. */
export interface RunMeta {
  jobName: string;
  runId: string;
  agent?: AgentId | (string & {});  // undefined at runtime for workflow and command jobs; a custom-harness job records the harness name (host/cloud placement) or its resolved host agent (local placement)
  /** Resolved agent version the run launched under, re-pointed at each failover attempt (runner.ts)
   * so it names the version that ran and wrote the transcript. Lets `archiveRoutineTranscripts`
   * find it in the per-version home and attribute the account (RUSH-2271). */
  version?: string;
  workflow?: string;
  /** The shell command that ran, for command-mode routines (no agent). */
  command?: string;
  pid: number | null;
  /** Process birth time (epoch ms) recorded at spawn for pid-reuse detection. */
  spawnedAt?: number;
  /** Configured execution deadline persisted for daemon-restart recovery. */
  timeoutMs?: number;
  /** `missed` is not an execution outcome: it records that a scheduled fire never happened (daemon
   * down/asleep), written by `claimMissedFire` (catchup.ts), else a miss leaves no trace. `blocked`
   * is a fire-time readiness rejection with no process spawned. */
  status: 'running' | 'completed' | 'failed' | 'timeout' | 'missed' | 'blocked' | 'skipped';
  /** How this attempt was triggered, answering "why did this run exist" for records with no
   * transcript (blocked/skipped attempts). */
  triggerKind?: 'schedule' | 'catchup' | 'manual' | 'webhook' | 'event';
  /** The scheduler's intended UTC fire time (ISO) for a schedule/catchup attempt. The atomic
   * single-fire claim keys on (routine, scheduledFor), so a duplicate cron delivery for the same
   * slot resolves to the same run. */
  scheduledFor?: string;
  /** Resolved execution context (routine-context.ts), recorded before preflight. */
  project?: string;
  requestedCwd?: string;
  resolvedCwd?: string;
  readiness?: { code: string; message: string; repair?: string };
  /** Why a `skipped` attempt launched nothing. */
  skipReason?: 'duplicate_slot' | 'active_run' | 'wrong_owner';
  /** The run this attempt deferred to (the winning duplicate slot / active run). */
  activeRunId?: string;
  startedAt: string;
  completedAt: string | null;
  exitCode: number | null;
  /** Machine-readable failure reason when the run did not complete successfully. */
  errorMessage?: string;
  /** Wall-clock duration of the run in milliseconds (set when the run finishes). */
  duration?: number;
  /** Set for `host:`-placed runs — where the job body executes (no local pid). */
  host?: string;
  /** The host-task sidecar id backing a `host:` run; the daemon monitor
   *  finalizes the run by reconciling it against the remote `.exit`. */
  hostTaskId?: string;
  /** Cloud provider task id when `hostStrategy: cloud` dispatched the run. */
  cloudTaskId?: string;
  /** Cloud provider id when the run was cloud-dispatched. */
  cloudProvider?: string;
  /** Actor id of the routine's CREATOR (stamped at creation), answering "whose scheduled run is
   * this" for an unattended fire, where a live resolve would give `UNRESOLVED@<host>` (RUSH-2020). */
  actor?: string;
  /** Actor id that TRIGGERED this run: a person for a manual `agents routines run`,
   * `UNRESOLVED@<host>` for an unattended fire. Distinct from {@link actor} (the creator). */
  triggeredBy?: string;
}

/** Finalize a run record with a terminal status, computing `duration` from `startedAt`; keeps
 * failure-reason population centralized so every completion path writes the same machine-readable
 * fields. */
export function finalizeRunMeta(
  meta: RunMeta,
  status: RunMeta['status'],
  exitCode: number | null,
  opts?: { errorMessage?: string; completedAt?: string },
): void {
  meta.status = status;
  meta.exitCode = exitCode;
  meta.completedAt = opts?.completedAt ?? new Date().toISOString();
  const started = Date.parse(meta.startedAt);
  const completed = Date.parse(meta.completedAt);
  meta.duration = Number.isFinite(started) && Number.isFinite(completed) && completed >= started
    ? completed - started
    : 0;
  if (opts?.errorMessage) {
    meta.errorMessage = opts.errorMessage;
  } else {
    delete meta.errorMessage;
  }
}

/** True when the job may run here: no `devices` allowlist, or it includes this device (both via
 * `normalizeHost`). Every fire path gates on this. A monitor/webhook-dispatched job
 * (`dispatchedBy`) skips the activation manifest, since it isn't a routine (RUSH-2681). */
export function jobRunsOnThisDevice(config: Pick<JobConfig, 'name' | 'devices' | 'dispatchedBy'>): boolean {
  if (config.dispatchedBy === undefined) {
    const activated = routineEnabledOnThisDevice(config.name);
    if (activated !== null) return activated;
  }
  const owner = routineOwnerDevice(config);
  // Unrestricted: no pin means fleet-wide by design (`watchdog`, `check-updates`).
  if (owner === null) return true;
  return owner === machineId();
}

/** The ONE device that owns a routine: the single daemon allowed to fire it. `devices` used to fire
 * on every listed device (seven routines ran twice, e.g. `security-sweep`). Ownership is the first
 * entry in normalized sort order, so every daemon agrees with no lease or split brain. */
export function routineOwnerDevice(config: Pick<JobConfig, 'devices'>): string | null {
  // A non-array `devices` is a separate validation error; don't throw here and
  // don't double-report it.
  if (!Array.isArray(config.devices)) return null;
  const devices = config.devices.map((d) => normalizeHost(String(d))).filter(Boolean);
  if (devices.length === 0) return null;
  return [...devices].sort()[0];
}

/** Does this routine name more than one distinct device? Such a pin once meant "fire on each" and
 * now means "only the first", likely not what the author meant either way, so it is reported as a
 * misconfiguration rather than silently reinterpreted. */
export function hasAmbiguousDevicePin(config: Pick<JobConfig, 'devices'>): boolean {
  if (!Array.isArray(config.devices)) return false;
  const devices = new Set(config.devices.map((d) => normalizeHost(String(d))).filter(Boolean));
  return devices.size > 1;
}

/** One routine whose `devices` names more than one machine, with its resolved owner. */
interface AmbiguousDevicePin {
  name: string;
  devices: string[];
  /** The device that now fires it — the rest are inert. */
  owner: string;
}

/** Every routine with a multi-device pin, surfaced by `agents doctor` and `agents routines list` so
 * the misconfiguration is visible; before ownership became singular each fired once per listed
 * device, doubling work and spend. */
export function findAmbiguousDevicePins(cwd?: string): AmbiguousDevicePin[] {
  return listJobs(cwd)
    .filter((job) => job.enabled && hasAmbiguousDevicePin(job))
    .map((job) => ({
      name: job.name,
      devices: (job.devices ?? []).map((d) => normalizeHost(d)),
      owner: routineOwnerDevice(job) ?? '',
    }));
}

/** Effective host strategy for a job: a bare `host:` without a strategy implies `host` (back-compat
 * with pre-hostStrategy YAML), otherwise `local`. */
export function resolveHostStrategy(
  config: Pick<JobConfig, 'hostStrategy' | 'host'>,
): HostStrategy {
  if (config.hostStrategy) return config.hostStrategy;
  if (config.host) return 'host';
  return 'local';
}

/** Parse a CLI `--placement` value into a HostStrategy, or null when empty; throws a readable Error
 * for unknown values. */
export function parseHostStrategy(raw: string | undefined | null): HostStrategy | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const v = raw.trim().toLowerCase();
  if ((HOST_STRATEGIES as readonly string[]).includes(v)) return v as HostStrategy;
  throw new Error(`Invalid placement '${raw}'. Use one of: ${HOST_STRATEGIES.join(', ')}`);
}

/** Strategies that dispatch the body off the firing machine. Without a `devices` pin every fleet
 * daemon would fire and dispatch once (N duplicate runs), so callers pin to this machine when the
 * user set no allowlist. */
export function placementRequiresFiringPin(strategy: HostStrategy): boolean {
  return strategy === 'host' || strategy === 'fleet' || strategy === 'cloud';
}

/** Human presentation of a device-affinity mismatch for commands and runner. */
interface JobEligibilityResult {
  /** Full human message, e.g. "Job 'NAME' can only run on: a, b". */
  message: string;
  /** One-line copy-paste suggestion, e.g. "agents routines run NAME --device a". */
  suggestion: string;
  /** Comma-separated allowed devices label, e.g. "a, b". */
  allowedLabel: string;
  /** First allowed device (normalized), useful for the suggested host. */
  firstHost: string;
}

/** Null when the job may run here, else a structured, readable eligibility failure. Centralizes
 * message construction so manual run, executeJob and executeJobDetached stay in sync;
 * scheduler/webhook/overdue paths use jobRunsOnThisDevice. */
export function checkJobDeviceEligibility(
  config: Pick<JobConfig, 'name' | 'devices' | 'dispatchedBy'>,
): JobEligibilityResult | null {
  if (jobRunsOnThisDevice(config)) return null;
  const allowed = (config.devices ?? []).map((d) => normalizeHost(d));
  const allowedLabel = allowed.join(', ');
  // The owner is the lowest normalized name, not the first entry as written —
  // suggesting allowed[0] on an unsorted list points at a device that will
  // refuse the run for exactly the same reason.
  const firstHost = routineOwnerDevice(config) ?? allowed[0] ?? 'HOST';
  const message = `Job '${config.name}' can only run on: ${allowedLabel}`;
  const suggestion = `agents routines run ${config.name} --device ${firstHost}`;
  return { message, suggestion, allowedLabel, firstHost };
}

/** Default values applied to every job config when fields are omitted. */
const JOB_DEFAULTS: Partial<JobConfig> = {
  mode: 'auto',
  effort: 'auto',
  timeout: '10m',
  enabled: true,
};

function overlayUserRoutineDevices(job: JobConfig, userJob: JobConfig | null): JobConfig {
  if (job.devices !== undefined) return job;
  if (!userJob) return job;
  const merged = { ...job };
  if (userJob.devices && userJob.devices.length > 0) {
    merged.devices = userJob.devices;
  } else {
    delete merged.devices;
  }
  return merged;
}

/** List all job configs across project > user > system routine dirs; higher layers shadow same-named
 * lower ones (system ships via gh:phnx-labs/.agents-system). A winning project routine inherits the
 * user-layer `devices` allowlist unless it declares its own. Project discovery is opt-in via `cwd`. */
export function listJobs(cwd?: string): JobConfig[] {
  ensureAgentsDir();
  const seen = new Set<string>();
  const jobs: JobConfig[] = [];

  const userDir = getRoutinesDir();
  const dirs: Array<{ scope: 'project' | 'user' | 'system'; path: string }> = [];
  if (cwd) {
    const projectDir = getProjectRoutinesDir(cwd);
    if (projectDir) dirs.push({ scope: 'project', path: projectDir });
  }
  dirs.push({ scope: 'user', path: userDir });
  dirs.push({ scope: 'system', path: getSystemRoutinesDir() });

  for (const { scope, path: dir } of dirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
    for (const file of files) {
      let job = readJobFile(path.join(dir, file));
      if (!job) continue;
      if (scope === 'project') {
        job = overlayUserRoutineDevices(job, readJobFromDir(userDir, job.name));
      }
      if (seen.has(job.name)) continue;
      seen.add(job.name);
      jobs.push(job);
    }
  }

  return jobs.map(applyDeviceActivation);
}

/** Read one job config by name, project > user > system. A same-name project routine keeps the
 * user-layer `devices` allowlist only if it declares none (as in listJobs). Project discovery is
 * opt-in via `cwd`. */
export function readJob(name: string, cwd?: string): JobConfig | null {
  ensureAgentsDir();
  const userDir = getRoutinesDir();
  const dirs: Array<{ scope: 'project' | 'user' | 'system'; path: string }> = [];
  if (cwd) {
    const projectDir = getProjectRoutinesDir(cwd);
    if (projectDir) dirs.push({ scope: 'project', path: projectDir });
  }
  dirs.push({ scope: 'user', path: userDir });
  dirs.push({ scope: 'system', path: getSystemRoutinesDir() });

  for (const { scope, path: dir } of dirs) {
    const job = readJobFromDir(dir, name);
    if (job) {
      if (scope === 'project') return applyDeviceActivation(overlayUserRoutineDevices(job, readJobFromDir(userDir, name)));
      return applyDeviceActivation(job);
    }
  }
  return null;
}

function applyDeviceActivation(job: JobConfig): JobConfig {
  const activated = routineEnabledOnThisDevice(job.name);
  return activated === null ? job : { ...job, enabled: activated };
}

function readJobFromDir(dir: string, name: string): JobConfig | null {
  for (const ext of ['.yml', '.yaml']) {
    const filePath = safeJoin(dir, name + ext);
    if (fs.existsSync(filePath)) {
      return readJobFile(filePath);
    }
  }
  return null;
}

/** The outcome of reading one routine file: a config, or the reason it is inert. Every `problem`
 * means the daemon won't run the routine. */
type RoutineReadResult =
  | { config: JobConfig; problem: null }
  | { config: null; problem: string };

/** Read one routine file, keeping WHY it failed. `readJobFile` collapses the fail-closed paths to
 * `null`, right for loaders but it hides a broken routine in every view; this keeps the reason for
 * diagnostics like `agents inspect --routines`. */
export function readJobFileResult(filePath: string): RoutineReadResult {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    return { config: null, problem: `unreadable: ${(err as Error).message}` };
  }

  let parsed: { [key: string]: unknown } | null;
  try {
    parsed = yaml.parse(content);
  } catch (err) {
    return { config: null, problem: `invalid YAML: ${(err as Error).message.split('\n')[0]}` };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { config: null, problem: 'not a YAML map' };
  }

  // Fail closed on the legacy singular `device` key. A routine that still
  // carries it after v12 startup migration is unmigrated state and must be
  // treated as unavailable/inert rather than unrestricted.
  if (Object.prototype.hasOwnProperty.call(parsed, 'device')) {
    return { config: null, problem: 'legacy `device:` key — inert until migrated to `devices:`' };
  }

  // Fail closed on a malformed `devices` too: ownership treats a non-array as "no pin" and the load
  // path never calls validateJob, so a typo (`devices: yosemite-s0`) would silently make the
  // routine fleet-wide. Inert-and-loud beats unrestricted-and-silent.
  if (Object.prototype.hasOwnProperty.call(parsed, 'devices')
      && parsed.devices !== undefined
      && parsed.devices !== null
      && !Array.isArray(parsed.devices)) {
    return { config: null, problem: '`devices:` must be a list — routine is inert' };
  }

  // Fail closed on `dispatchedBy`: a runtime-only marker for jobs with no definition file that
  // makes `jobRunsOnThisDevice` skip the activation manifest. A routine YAML carrying it would
  // fire on every box regardless of activation.
  if (Object.prototype.hasOwnProperty.call(parsed, 'dispatchedBy')) {
    return { config: null, problem: '`dispatchedBy:` is a runtime-only monitor/webhook marker, not a routine field — routine is inert' };
  }

  return {
    config: {
      ...JOB_DEFAULTS,
      ...parsed,
      name: parsed.name || path.basename(filePath).replace(/\.ya?ml$/, ''),
      // Before a device manifest exists, preserve only explicit legacy state.
      // A new built-in definition with no `enabled:` field stays opt-in until
      // setup materializes this host's routines list.
      enabled: Object.prototype.hasOwnProperty.call(parsed, 'enabled') ? parsed.enabled !== false : false,
    } as JobConfig,
    problem: null,
  };
}

function readJobFile(filePath: string): JobConfig | null {
  return readJobFileResult(filePath).config;
}

/** Write a job config, omitting default-valued fields. Updates the one existing extension (.yml or
 * .yaml) atomically; new routines are .yml. If both extensions exist for a name, the write fails
 * rather than choose or drop a sibling. */
export function writeJob(config: JobConfig): void {
  ensureAgentsDir();
  // Stamp the creator once (RUSH-2020). An edit re-writes a config loaded from
  // disk, which already carries `actor`, so this preserves the original creator;
  // only a brand-new routine (no actor yet) gets the current resolver.
  if (!config.actor) config.actor = resolveActor().id;
  // Stamped once on first write and preserved by edits: the floor overdue detection uses so a
  // routine is never judged against fires that predate it.
  if (!config.createdAt) config.createdAt = new Date().toISOString();
  const jobsDir = getRoutinesDir();
  const ymlPath = safeJoin(jobsDir, config.name + '.yml');
  const yamlPath = safeJoin(jobsDir, config.name + '.yaml');
  const ymlExists = fs.existsSync(ymlPath);
  const yamlExists = fs.existsSync(yamlPath);

  if (ymlExists && yamlExists) {
    throw new Error(
      `Routine '${config.name}' has both .yml and .yaml files; resolve the ambiguity before editing.`,
    );
  }

  const filePath = ymlExists ? ymlPath : yamlExists ? yamlPath : ymlPath;

  const output: Record<string, unknown> = { ...config };
  if (output.mode === 'auto') delete output.mode;
  if (output.effort === 'auto') delete output.effort;
  if (output.timeout === '10m') delete output.timeout;
  delete output.enabled;
  if (output.runOnce === false || output.runOnce === undefined) delete output.runOnce;
  if (output.catchup === true || output.catchup === undefined) delete output.catchup;
  delete output.devices;
  // Runtime-only monitor marker — a definition on disk must never carry it (see
  // the read-side guard in readJobFileResult), so strip it at the one schema
  // boundary rather than trusting every caller.
  delete output.dispatchedBy;
  // Persist `projects` canonically (deduped, first-seen order, omitted if empty). This is the
  // schema boundary, so routines written from any path (add, edit, enable/disable) land canonical.
  const normProjects = normalizeProjects(output.projects as string[] | undefined);
  if (normProjects) output.projects = normProjects;
  else delete output.projects;

  let existingText: string | null = null;
  if (ymlExists || yamlExists) {
    try {
      existingText = fs.readFileSync(filePath, 'utf-8');
    } catch {
      existingText = null;
    }
  }
  atomicWriteFileSync(filePath, serializeJob(output, existingText));
}

/** Serialize a job config preserving an existing file's formatting. A full `yaml.stringify` restyles
 * every scalar and the folded `prompt`, so a pause/resume or `devices --set` would leave the git-
 * backed `~/.agents` tree dirty and block `agents repo pull` fleet-wide. */
export function serializeJob(output: Record<string, unknown>, existingText: string | null): string {
  if (existingText == null) return yaml.stringify(output);

  const doc = yaml.parseDocument(existingText);
  if (doc.errors.length > 0 || !yaml.isMap(doc.contents)) return yaml.stringify(output);

  const existing = (doc.toJS() ?? {}) as Record<string, unknown>;

  // Update or add only the keys that actually changed; leave the rest untouched
  // so their original formatting is preserved.
  for (const [key, value] of Object.entries(output)) {
    if (JSON.stringify(existing[key]) !== JSON.stringify(value)) doc.set(key, value);
  }
  // Drop keys that no longer belong (e.g. an omitted default, or `devices`
  // cleared back to fleet-wide).
  for (const key of Object.keys(existing)) {
    if (!(key in output)) doc.delete(key);
  }

  // `flowCollectionPadding: false` keeps re-serialized flow sequences in the committed no-padding
  // form (`[a, b]`). Routine YAML lives in the git-backed `~/.agents` repo, so padding would dirty
  // the file and block `agents repo pull` (RUSH-2505).
  return doc.toString({ flowCollectionPadding: false });
}

/** Delete a job config file by name. Returns true if the file existed. */
export function deleteJob(name: string): boolean {
  const jobsDir = getRoutinesDir();
  for (const ext of ['.yml', '.yaml']) {
    const filePath = safeJoin(jobsDir, name + ext);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
  }
  return false;
}

/** Enable or disable a job by name. */
export function setJobEnabled(name: string, enabled: boolean): void {
  const job = readJob(name);
  if (!job) throw new Error(`Job '${name}' not found`);
  const legacyEnabled = enabledRoutineNames() === null
    ? listJobs().filter((candidate) => candidate.enabled && jobRunsOnThisDevice(candidate)).map((candidate) => candidate.name)
    : [];
  setRoutineEnabledOnThisDevice(name, enabled, legacyEnabled);
}

/** Materialize legacy definition state into this device's activation manifest. */
export function migrateLegacyRoutineActivation(): boolean {
  if (enabledRoutineNames() !== null) return false;
  // Legacy activation migration preserves FILE-BACKED routines' old
  // `enabled:`/`devices:` state into the device manifest. A box with zero
  // routines never grows a manifest here (nothing enabled or pinned to seed).
  const jobs = listJobs();
  if (!jobs.some((job) => job.enabled || Array.isArray(job.devices))) return false;
  replaceEnabledRoutines(
    jobs.filter((job) => job.enabled && jobRunsOnThisDevice(job)).map((job) => job.name),
  );
  return true;
}

/** Validate a partial job config, returning a list of human-readable errors. */
export function validateJob(config: Partial<JobConfig>): string[] {
  const errors: string[] = [];

  if (!config.name || typeof config.name !== 'string') {
    errors.push('name is required');
  } else if (!isSafeSegmentName(config.name)) {
    // The name becomes a filesystem path segment (overlay HOME under the
    // routines dir). Reject separators, '.'/'..', and null bytes so a synced
    // config can't traverse out of ~/.agents/routines.
    errors.push(
      `invalid name ${JSON.stringify(config.name)}: must be a single path segment ` +
      `(no '/', '\\\\', or null bytes, and not '.' or '..')`,
    );
  }
  const hasSchedule = Boolean(config.schedule && typeof config.schedule === 'string');
  const hasTrigger = config.trigger !== undefined;
  if (!hasSchedule && !hasTrigger) {
    errors.push('schedule (cron expression) or trigger is required');
  }
  if (config.schedule !== undefined) {
    if (typeof config.schedule !== 'string') {
      errors.push('schedule must be a cron expression string');
    } else {
      // Validate cron expression is parseable
      try {
        new Cron(config.schedule);
      } catch {
        errors.push(`invalid cron expression: "${config.schedule}"`);
      }
    }
  }
  if (config.trigger !== undefined) {
    errors.push(...validateTrigger(config.trigger));
  }
  const hasAgent = Boolean(config.agent && typeof config.agent === 'string');
  const hasWorkflow = Boolean(config.workflow && typeof config.workflow === 'string');
  const hasCommand = Boolean(config.command && typeof config.command === 'string');
  const strategy = resolveHostStrategy(config);
  const set = [hasAgent, hasWorkflow, hasCommand].filter(Boolean).length;
  if (set === 0) {
    errors.push('exactly one of agent, workflow, or command is required');
  } else if (set > 1) {
    errors.push('exactly one of agent, workflow, or command may be set (not more)');
  }
  if (config.command !== undefined && (typeof config.command !== 'string' || config.command.trim() === '')) {
    errors.push('command must be a non-empty shell command string');
  }
  if (hasAgent && config.agent && !ALL_AGENT_IDS.includes(config.agent as AgentId) && !isCustomHarnessName(config.agent)) {
    errors.push(`agent must be one of: ${ALL_AGENT_IDS.join(', ')}, or a custom harness (agents harness list)`);
  } else if (
    hasAgent && config.agent && strategy === 'local' &&
    !ROUTINE_AGENT_IDS.includes(config.agent) &&
    // A custom harness is exempt from the local-daemon command table: the
    // runner delegates it to `agents run <name>`, the same path workflow
    // jobs take, so no ROUTINE_AGENT_COMMANDS template is needed.
    !isCustomHarnessName(config.agent)
  ) {
    // The local daemon can build commands only for agents in ROUTINE_AGENT_IDS (baked from
    // AGENT_COMMANDS in runner.ts); others pass ALL_AGENT_IDS but fail at fire time ("Unsupported
    // agent for daemon jobs"), so reject now.
    errors.push(
      `agent '${config.agent}' is not supported by the local routine daemon; use one of: ` +
      `${ROUTINE_AGENT_IDS.join(', ')} (or set hostStrategy: host/fleet/cloud to run it elsewhere)`,
    );
  }
  if (hasWorkflow && config.workflow) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(config.workflow)) {
      errors.push('workflow must be a lowercase alphanumeric name (hyphens and underscores allowed, e.g. autodev)');
    }
  }
  if (config.resume !== undefined) {
    // Only claude/codex support native `--resume`; other agents would emit a resume
    // flag they don't understand. Resume reopens an agent session, so it is
    // incompatible with workflow and loop jobs (which have no single session to reopen).
    const RESUMABLE_AGENTS = ['claude', 'codex'];
    if (typeof config.resume !== 'string' || config.resume.trim() === '') {
      errors.push('resume must be a non-empty session id string');
    }
    if (hasWorkflow) {
      errors.push('resume cannot be combined with workflow (resume reopens an existing agent session)');
    }
    if (config.loop) {
      errors.push('resume cannot be combined with loop');
    }
    if (hasAgent && config.agent && !RESUMABLE_AGENTS.includes(config.agent)) {
      errors.push(`resume is only supported for agents with native --resume (${RESUMABLE_AGENTS.join(', ')}); got '${config.agent}'`);
    }
  }
  if (config.strategy !== undefined) {
    if (!RUN_STRATEGIES.includes(config.strategy)) {
      errors.push(`strategy must be one of: ${RUN_STRATEGIES.join(', ')}`);
    }
    if (!hasAgent) {
      errors.push('strategy only applies to agent routines (drop it for workflow/command routines)');
    }
    if (config.version) {
      errors.push(`strategy ${config.strategy} conflicts with version ${config.version} — an exact pin leaves nothing to select; drop strategy or the version pin`);
    }
  }
  if (config.mode && !['plan', 'edit', 'auto', 'skip', 'full'].includes(config.mode)) {
    errors.push("mode must be plan, edit, auto, or skip ('full' accepted as alias for skip)");
  }
  if (config.effort && !['low', 'medium', 'high', 'xhigh', 'max', 'auto'].includes(config.effort)) {
    errors.push('effort must be low, medium, high, xhigh, max, or auto');
  }
  // command routines run a plain shell and never build a prompt; agent/workflow routines require one.
  if (!hasCommand && (!config.prompt || typeof config.prompt !== 'string')) {
    errors.push('prompt is required');
  }
  if (config.timeout && !parseTimeout(config.timeout)) {
    errors.push('timeout must be like 10m, 2h, 3d, 1w (max 1w)');
  }
  if (config.endAt !== undefined) {
    if (typeof config.endAt !== 'string' || !isParseableDate(config.endAt)) {
      errors.push('endAt must be a parseable ISO 8601 / RFC3339 timestamp (e.g., 2026-12-31T23:59:00Z)');
    }
  }
  if ((config as Record<string, unknown>).device !== undefined) {
    errors.push('singular "device" key is no longer supported — replace with devices: [<name>] (an array)');
  }
  if (config.hostStrategy !== undefined) {
    if (!HOST_STRATEGIES.includes(config.hostStrategy)) {
      errors.push(`hostStrategy must be one of: ${HOST_STRATEGIES.join(', ')}`);
    }
  }
  if (config.host !== undefined) {
    if (typeof config.host !== 'string' || config.host.trim() === '') {
      errors.push('host must be a non-empty machine name (a registered host, device, capability tag, or user@host)');
    }
  }
  if (strategy === 'host' && (!config.host || config.host.trim() === '')) {
    errors.push("hostStrategy: host requires host: (set via --run-on or host: in YAML)");
  }
  // `host: auto` is fire-time fleet placement (resolveDeviceAuto), never a
  // literal SSH target — it is only meaningful under hostStrategy: fleet.
  if (config.host === 'auto' && strategy !== 'fleet') {
    errors.push("host: auto requires hostStrategy: fleet (set via --run-on auto) — 'auto' is a fire-time device pick, not a machine name");
  }
  // Remote placement (host/fleet/cloud) can't carry workflow/loop/command yet —
  // those live on the firing machine.
  if (strategy === 'host' || strategy === 'fleet' || strategy === 'cloud') {
    if (config.workflow) {
      errors.push(`${strategy} placement can't be combined with workflow: yet — run the workflow locally or convert it to a plain prompt`);
    }
    if (config.loop) {
      errors.push(`${strategy} placement can't be combined with loop: yet (the loop driver and its signal files live on the firing machine)`);
    }
    if (config.command) {
      errors.push(`${strategy} placement can't be combined with command: yet (a plain shell command has no agent to place remotely)`);
    }
  }
  if (config.remoteCwd !== undefined && strategy !== 'host' && strategy !== 'fleet') {
    errors.push('remoteCwd only applies to host/fleet-placed routines — set hostStrategy: host|fleet, or drop it');
  }
  if (config.project === null) {
    errors.push('project is null — quote YAML values that look like null literals');
  } else if (config.project !== undefined && (typeof config.project !== 'string' || config.project.trim() === '')) {
    errors.push('project (the singular execution anchor) must be a non-empty project name');
  }
  if (config.cwd === null) {
    errors.push('cwd is null — a bare ~ is YAML null; quote it as "~" for the home directory');
  } else if (config.cwd !== undefined && (typeof config.cwd !== 'string' || config.cwd.trim() === '')) {
    errors.push('cwd (the portable execution directory) must be a non-empty path string');
  }
  // `remoteCwd` is the legacy host-placement path; `cwd` is its canonical
  // replacement. The two split path semantics, so they must never coexist — the
  // one-shot migration folds remoteCwd into cwd, and a conflicting pair pauses.
  if (config.cwd !== undefined && config.remoteCwd !== undefined) {
    errors.push('cwd and remoteCwd both set — remoteCwd is the legacy form of cwd; keep only cwd');
  }
  if (config.source !== undefined) {
    if (!config.source || typeof config.source !== 'object') {
      errors.push('source must be an object');
    } else {
      if (config.source.kind !== 'project') {
        errors.push("source.kind must be 'project'");
      }
      if (typeof config.source.projectPath !== 'string' || config.source.projectPath.trim() === '') {
        errors.push('source.projectPath must be a non-empty absolute path');
      }
    }
  }
  if (config.devices !== undefined) {
    if (!Array.isArray(config.devices)) {
      errors.push('devices must be an array of device names (as shown by `agents devices`)');
    } else {
      for (const d of config.devices) {
        if (typeof d !== 'string' || d.trim() === '') {
          errors.push('each entry in devices must be a non-empty device name');
          break;
        }
      }
    }
  }
  // A routine belongs to exactly one device. Listing several used to fire it
  // once per device — duplicate work, duplicate spend — and making them elect
  // one owner at runtime would need cross-device coordination nobody wants.
  if (hasAmbiguousDevicePin(config)) {
    errors.push(
      `devices lists ${new Set((config.devices as string[]).map((d) => normalizeHost(String(d)))).size} devices; a routine runs on exactly one. ` +
      'Pin the single device that should own it, e.g. devices: [yosemite-s0]. ' +
      'Omit devices entirely for a routine that genuinely belongs on every machine.',
    );
  }
  if (config.catchup !== undefined && typeof config.catchup !== 'boolean') {
    errors.push('catchup must be a boolean (false to skip running a missed fire late)');
  }
  if (config.projects !== undefined) {
    if (!Array.isArray(config.projects)) {
      errors.push('projects must be an array of project names (or ["*"] for all projects)');
    } else if (config.projects.length === 1 && config.projects[0] === '*') {
      // ["*"] is valid: "all projects" sentinel
    } else if (config.projects.includes('*')) {
      errors.push('projects: "*" (all projects) must be the sole entry');
    } else {
      for (const p of config.projects) {
        if (typeof p !== 'string' || p.trim() === '') {
          errors.push('each entry in projects must be a non-empty project name');
          break;
        }
        if (!isSafeProjectName(p)) {
          errors.push(`invalid project name "${p}": must start with a letter or digit, contain only letters, digits, dots, hyphens, or underscores`);
          break;
        }
      }
    }
  }
  return errors;
}

/** Validate a job trigger block, returning a list of human-readable errors. */
export function validateTrigger(trigger: unknown): string[] {
  const errors: string[] = [];
  if (!trigger || typeof trigger !== 'object') {
    return ['trigger must be an object'];
  }
  const t = trigger as Partial<JobTrigger>;
  if (t.type !== 'github_event' && t.type !== 'linear_event') {
    errors.push("trigger.type must be 'github_event' or 'linear_event'");
    return errors;
  }
  if (t.type === 'github_event') {
    const github = t as Partial<GithubJobTrigger>;
    if (!github.event || !GITHUB_TRIGGER_EVENTS.includes(github.event as GithubTriggerEvent)) {
      errors.push(`trigger.event must be one of: ${GITHUB_TRIGGER_EVENTS.join(', ')}`);
    }
    if (github.repo !== undefined && (typeof github.repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(github.repo))) {
      errors.push('trigger.repo must be in owner/name form');
    }
    if (github.branch !== undefined && typeof github.branch !== 'string') {
      errors.push('trigger.branch must be a string');
    }
    if (github.action !== undefined && typeof github.action !== 'string') {
      errors.push('trigger.action must be a string');
    }
    if (github.label !== undefined && typeof github.label !== 'string') {
      errors.push('trigger.label must be a string');
    }
    return errors;
  }
  const linear = t as Partial<LinearJobTrigger>;
  if (!linear.event || !LINEAR_TRIGGER_EVENTS.includes(linear.event as LinearTriggerEvent)) {
    errors.push(`trigger.event must be one of: ${LINEAR_TRIGGER_EVENTS.join(', ')}`);
  }
  if (linear.action !== undefined && typeof linear.action !== 'string') {
    errors.push('trigger.action must be a string');
  }
  if (linear.teamKey !== undefined && (typeof linear.teamKey !== 'string' || !/^[A-Z][A-Z0-9]*$/.test(linear.teamKey))) {
    errors.push('trigger.teamKey must be an uppercase Linear team key');
  }
  if (linear.label !== undefined && typeof linear.label !== 'string') {
    errors.push('trigger.label must be a string');
  }
  if (linear.stateTo !== undefined && typeof linear.stateTo !== 'string') {
    errors.push('trigger.stateTo must be a string');
  }
  if (linear.stateFrom !== undefined && typeof linear.stateFrom !== 'string') {
    errors.push('trigger.stateFrom must be a string');
  }
  return errors;
}

function isParseableDate(value: string): boolean {
  if (!value.trim()) return false;
  const ts = Date.parse(value);
  return Number.isFinite(ts);
}

/** True when a job's endAt has already elapsed. False when endAt is unset or in the future. */
export function isPastEndAt(config: Pick<JobConfig, 'endAt'>, now: Date = new Date()): boolean {
  if (!config.endAt) return false;
  const end = Date.parse(config.endAt);
  if (!Number.isFinite(end)) return false;
  return now.getTime() >= end;
}

interface OneShotScheduleParts {
  minute: number;
  hour: number;
  day: number;
  month: number;
}

export function parseOneShotLikeSchedule(schedule: string | undefined | null): OneShotScheduleParts | null {
  if (!schedule) return null;
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minuteRaw, hourRaw, dayRaw, monthRaw, weekdayRaw] = parts;
  if (weekdayRaw !== '*') return null;
  if (![minuteRaw, hourRaw, dayRaw, monthRaw].every((p) => /^\d+$/.test(p))) return null;

  const minute = parseInt(minuteRaw, 10);
  const hour = parseInt(hourRaw, 10);
  const day = parseInt(dayRaw, 10);
  const month = parseInt(monthRaw, 10);
  if (minute < 0 || minute > 59) return null;
  if (hour < 0 || hour > 23) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  return { minute, hour, day, month };
}

export function isOneShotLikeSchedule(schedule: string | undefined | null): boolean {
  return parseOneShotLikeSchedule(schedule) !== null;
}

export function isOneShotRoutine(config: Pick<JobConfig, 'schedule' | 'runOnce'>): boolean {
  return Boolean(config.runOnce || isOneShotLikeSchedule(config.schedule));
}

function zonedParts(date: Date, timezone: string): OneShotScheduleParts & { year: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string): number => parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  };
}

function zonedDateToUtc(year: number, parts: OneShotScheduleParts, timezone: string): Date | null {
  const targetUtc = Date.UTC(year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
  let candidate = new Date(targetUtc);
  for (let i = 0; i < 4; i++) {
    const actual = zonedParts(candidate, timezone);
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0, 0);
    const delta = actualUtc - targetUtc;
    if (delta === 0) break;
    candidate = new Date(candidate.getTime() - delta);
  }
  const verify = zonedParts(candidate, timezone);
  if (
    verify.year !== year ||
    verify.month !== parts.month ||
    verify.day !== parts.day ||
    verify.hour !== parts.hour ||
    verify.minute !== parts.minute
  ) {
    return null;
  }
  return candidate;
}

export function oneShotScheduleFireDate(
  schedule: string | undefined | null,
  now: Date = new Date(),
  timezone?: string,
): Date | null {
  const parts = parseOneShotLikeSchedule(schedule);
  if (!parts) return null;

  if (timezone) {
    try {
      const year = zonedParts(now, timezone).year;
      return zonedDateToUtc(year, parts, timezone);
    } catch {
      return null;
    }
  }

  const fireAt = new Date(now.getFullYear(), parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
  if (
    fireAt.getFullYear() !== now.getFullYear() ||
    fireAt.getMonth() !== parts.month - 1 ||
    fireAt.getDate() !== parts.day ||
    fireAt.getHours() !== parts.hour ||
    fireAt.getMinutes() !== parts.minute
  ) {
    return null;
  }
  return fireAt;
}

export function isPastOneShotRoutine(
  config: Pick<JobConfig, 'schedule' | 'runOnce' | 'timezone'>,
  now: Date = new Date(),
): boolean {
  if (!isOneShotRoutine(config)) return false;
  const fireAt = oneShotScheduleFireDate(config.schedule, now, config.timezone);
  return Boolean(fireAt && now.getTime() >= fireAt.getTime());
}

export function hasCompletedOneShotRun(
  config: Pick<JobConfig, 'name' | 'schedule' | 'runOnce' | 'timezone'>,
  now: Date = new Date(),
): boolean {
  if (!isPastOneShotRoutine(config, now)) return false;
  const fireAt = oneShotScheduleFireDate(config.schedule, now, config.timezone);
  if (!fireAt) return false;
  const latest = getLatestRun(config.name);
  if (!latest || latest.status === 'running') return false;
  const startedAt = Date.parse(latest.startedAt);
  return Number.isFinite(startedAt) && startedAt >= fireAt.getTime() - 60_000;
}

export function shouldPurgeCompletedOneShotRoutine(
  config: Pick<JobConfig, 'name' | 'schedule' | 'runOnce' | 'timezone'>,
  now: Date = new Date(),
): boolean {
  return hasCompletedOneShotRun(config, now);
}

/** Context passed to `resolveJobPrompt` when a webhook fires a job, so prompts can use
 * `{{issue.identifier}}`, `{{updatedFrom.state.name}}`, etc. */
export interface WebhookContext {
  source: string;
  event: string;
  action?: string;
  issue?: unknown;
  updatedFrom?: unknown;
  pull_request?: unknown;
  repository?: unknown;
}

function getPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Substitute `{{dotted.path}}` placeholders using a webhook context; missing values become an empty
 * string. */
export function substituteWebhookPrompt(prompt: string, context: WebhookContext): string {
  return prompt.replace(/\{\{([^{}]+)\}\}/g, (_, rawPath: string) => {
    const value = getPath(context, rawPath.trim());
    if (value === undefined || value === null) return '';
    return String(value);
  });
}

/** Substitute `{{dotted.path}}` placeholders in a string destined for a SHELL, quoting every value.
 * `run.command` runs through a shell with a context from an external webhook, whose `issue.title`
 * and PR fields are free text; raw pasting would be a command-injection sink. */
export function substituteWebhookCommand(command: string, context: WebhookContext): string {
  return command.replace(/\{\{([^{}]+)\}\}/g, (_, rawPath: string) => {
    const value = getPath(context, rawPath.trim());
    if (value === undefined || value === null) return "''";
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
  });
}

/** Refuse a `run.command` with placeholders on platforms whose shell we can't safely quote: `exec`
 * uses `cmd.exe` on Windows, where POSIX single-quoting doesn't contain a hostile value. Fail loud
 * rather than run something unprovably safe. */
export function assertShellSubstitutionSupported(
  command: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'win32' && /\{\{[^{}]+\}\}/.test(command)) {
    throw new Error(
      'run.command with {{…}} placeholders is not supported on Windows: the values come from an ' +
        'untrusted webhook payload and cmd.exe cannot be quoted safely. Use run.prompt, or a ' +
        'command with no placeholders.',
    );
  }
}

/** Expand built-in and user-defined template variables in a job's prompt string. */
export function resolveJobPrompt(config: JobConfig, context?: WebhookContext): string {
  const now = new Date();
  const tz = config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // Compute date/day/time in the job's configured timezone
  // Use Intl.DateTimeFormat to get the weekday name directly in the target timezone
  const localDayName = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(now);
  const localDay = days.includes(localDayName) ? localDayName : days[now.getDay()];
  const localDate = now.toLocaleDateString('en-CA', { timeZone: tz }); // en-CA gives YYYY-MM-DD
  const localTime = now.toLocaleTimeString('en-GB', { timeZone: tz, hour12: false }); // HH:MM:SS

  let prompt = config.prompt;

  // Built-in variables (timezone-aware)
  prompt = prompt.replace(/\{day\}/g, localDay);
  prompt = prompt.replace(/\{date\}/g, localDate);
  prompt = prompt.replace(/\{time\}/g, localTime);
  prompt = prompt.replace(/\{job_name\}/g, config.name);

  // User-defined variables
  if (config.variables) {
    for (const [key, value] of Object.entries(config.variables)) {
      prompt = prompt.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }
  }

  // Webhook-driven variables ({{issue.identifier}}, {{updatedFrom.state.name}}, ...)
  if (context) {
    prompt = substituteWebhookPrompt(prompt, context);
  }

  // Last report: only a COMPLETED run's report is injected. A failed run's report.md is the agent's
  // error text (e.g. a login prompt), and feeding it into the next prompt would poison every later
  // run until a human intervenes.
  const latestRun = getLatestCompletedRun(config.name);
  if (latestRun) {
    const reportPath = path.join(getJobRunsDir(config.name), latestRun.runId, 'report.md');
    if (fs.existsSync(reportPath)) {
      const report = fs.readFileSync(reportPath, 'utf-8');
      prompt = prompt.replace(/\{last_report\}/g, report);
    } else {
      prompt = prompt.replace(/\{last_report\}/g, '(no previous report)');
    }
  } else {
    prompt = prompt.replace(/\{last_report\}/g, '(no previous report)');
  }

  return prompt;
}

/** Parse a timeout string ("10m", "2h", "1h30m", "3d", "1w") into milliseconds, accepting w/d/h/m
 * combinations; null if empty, matching nothing, totaling zero, or exceeding 1 week. */
export function parseTimeout(timeout: string): number | null {
  const match = timeout.match(/^(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/);
  if (!match) return null;

  const weeks = parseInt(match[1] || '0', 10);
  const days = parseInt(match[2] || '0', 10);
  const hours = parseInt(match[3] || '0', 10);
  const minutes = parseInt(match[4] || '0', 10);

  const ms = ((weeks * 7 + days) * 24 * 60 + hours * 60 + minutes) * 60 * 1000;
  if (ms <= 0) return null;

  const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000; // 604800000
  if (ms > ONE_WEEK_MS) return null;

  return ms;
}

/** List all run metadata entries for a job, sorted chronologically. */
export function listRuns(jobName: string): RunMeta[] {
  const jobRunsDir = getJobRunsDir(jobName);
  if (!fs.existsSync(jobRunsDir)) return [];

  const entries = fs.readdirSync(jobRunsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const runs: RunMeta[] = [];
  for (const runId of entries) {
    const meta = readRunMeta(jobName, runId);
    if (meta) runs.push(meta);
  }
  return runs;
}

/** Get the most recent run for a job, or null if never run. */
export function getLatestRun(jobName: string): RunMeta | null {
  const runs = listRuns(jobName);
  return runs.length > 0 ? runs[runs.length - 1] : null;
}

/** Most recent COMPLETED run for a job, or null. Used for `{last_report}` so a failed run's error
 * text (e.g. an auth login prompt in report.md) can never reach the next run's prompt. */
export function getLatestCompletedRun(jobName: string): RunMeta | null {
  const runs = listRuns(jobName);
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i].status === 'completed') return runs[i];
  }
  return null;
}

/** Duration + outcome rollup for a job's run history. */
interface RoutineStats {
  /** Total run records (any status, including `missed`). */
  count: number;
  failed: number;
  missed: number;
  avgMs: number;
  p50: number;
  p95: number;
}

/** Fold a job's run history into a duration + outcome summary. `missed` fires (no process ran) carry
 * no `duration` and are excluded from latency percentiles but still counted in `count`/`missed`. */
export function routineStats(jobName: string): RoutineStats {
  const runs = listRuns(jobName);
  const failed = runs.filter((r) => r.status === 'failed' || r.status === 'timeout').length;
  const missed = runs.filter((r) => r.status === 'missed').length;
  const durations = runs
    .map((r) => r.duration)
    .filter((d): d is number => typeof d === 'number' && Number.isFinite(d))
    .sort((a, b) => a - b);
  const avgMs = durations.length > 0
    ? Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length)
    : 0;
  return {
    count: runs.length,
    failed,
    missed,
    avgMs,
    p50: Math.round(percentile(durations, 50)),
    p95: Math.round(percentile(durations, 95)),
  };
}

/** Persist run metadata to its run directory as meta.json. */
export function writeRunMeta(meta: RunMeta): void {
  ensureAgentsDir();
  const runDir = path.join(getJobRunsDir(meta.jobName), meta.runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
}

/** Read run metadata from disk. Returns null if missing or corrupt. */
export function readRunMeta(jobName: string, runId: string): RunMeta | null {
  const metaPath = path.join(getJobRunsDir(jobName), runId, 'meta.json');
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as RunMeta;
  } catch {
    return null;
  }
}

/** Runs directory for one job, with the untrusted job name (from possibly synced routine YAML)
 * contained to one segment under the runs dir, like `getJobHomePath`. Every runs-dir sink routes
 * here so a crafted `name` can't write outside `~/.agents/.history/runs`. */
export function getJobRunsDir(jobName: string): string {
  return safeJoin(getRunsDir(), jobName);
}

/** Get the filesystem path for a specific run's directory. */
export function getRunDir(jobName: string, runId: string): string {
  return path.join(getJobRunsDir(jobName), runId);
}

/** The run id a scheduled fire is recorded under, derived from its intended UTC fire time so the
 * SAME slot maps to the SAME run dir: a duplicate cron delivery computes the same id and loses the
 * atomic `mkdir` claim. Shares derivation with `missedRunId` (catchup.ts). */
export function slotRunId(scheduledFor: Date | string): string {
  const iso = typeof scheduledFor === 'string' ? scheduledFor : scheduledFor.toISOString();
  return iso.replace(/[:.]/g, '-');
}

/** Lookback windows for {@link alignedSlotForFire}, narrowest first; a wider one only if the
 * narrower finds no fire. Dense schedules resolve in 1 hour (~60 steps), as this runs every fire;
 * sparse ones (12-day gaps, monthly) still resolve, so overdue detection sees them. */
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SLOT_LOOKBACK_WINDOWS_MS = [HOUR_MS, DAY_MS, 7 * DAY_MS, 32 * DAY_MS, 93 * DAY_MS, 400 * DAY_MS];

/** The aligned schedule boundary a fire belongs to: the latest occurrence of `cron` at or before
 * `at`, the identity both {@link slotRunId} and `missedRunId` must key on. croner's `currentRun()`
 * is the jittered instant, so keying on it made two deliveries claim different run dirs (SING-15). */
export function alignedSlotForFire(cron: Cron, at: Date): Date | null {
  for (const window of SLOT_LOOKBACK_WINDOWS_MS) {
    let cursor: Date = new Date(at.getTime() - window);
    let last: Date | null = null;
    // Cap iterations: an every-minute schedule yields at most 10080 steps a week; 20k is a paranoia
    // bound. Only sparse schedules reach wider windows, so the cap never binds.
    for (let i = 0; i < 20000; i++) {
      const next = cron.nextRun(cursor);
      if (!next || next.getTime() > at.getTime()) break;
      last = next;
      cursor = next;
    }
    if (last) return last;
  }
  return null;
}

/** Atomically CLAIM a run directory: true on success, false if it exists (another caller, even
 * another process, owns this (routine, slot)). A non-recursive `mkdir` is one filesystem test-and-
 * set on POSIX, as `claimMissedFire` relies on. */
export function claimRunSlot(jobName: string, runId: string): boolean {
  const runDir = getRunDir(jobName, runId);
  fs.mkdirSync(path.dirname(runDir), { recursive: true });
  try {
    fs.mkdirSync(runDir); // non-recursive: throws EEXIST if already claimed
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/** Discover routine YAML files in a repository's routines/ directory. */
export function discoverJobsFromRepo(repoPath: string): Array<{ name: string; path: string }> {
  const jobsPath = path.join(repoPath, 'routines');
  if (!fs.existsSync(jobsPath)) return [];

  return fs.readdirSync(jobsPath)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => ({
      name: f.replace(/\.ya?ml$/, ''),
      path: path.join(jobsPath, f),
    }));
}

/** Check whether a job with the given name exists on disk. */
export function jobExists(name: string): boolean {
  return readJob(name) !== null;
}

/** True when `sourcePath` already IS the canonical user-layer file for `name`. `agents routines add
 * <file>` on `~/.agents/routines/release-train.yml` would re-serialize in place and drop the legacy
 * `devices:` pin from git-tracked config (RUSH-2517); callers skip the write. */
export function isCanonicalRoutineSource(sourcePath: string, name: string): boolean {
  const jobsDir = getRoutinesDir();
  const real = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const source = real(sourcePath);
  return ['.yml', '.yaml'].some((ext) => real(safeJoin(jobsDir, name + ext)) === source);
}

/** Get the filesystem path of a job's YAML config file, or null if not found. */
export function getJobPath(name: string): string | null {
  const jobsDir = getRoutinesDir();
  for (const ext of ['.yml', '.yaml']) {
    const filePath = safeJoin(jobsDir, name + ext);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }
  return null;
}

/** Resolve a routine's YAML across EVERY layer `listJobs`/`readJob` read (user then system), not
 * just the user dir. A built-in in the system repo has no user-layer file or `createdAt`, so a
 * user-only lookup skips the overdue floor and the routine reads as instantly overdue. */
export function resolveJobFilePath(name: string): string | null {
  const userPath = getJobPath(name);
  if (userPath) return userPath;
  for (const ext of ['.yml', '.yaml']) {
    const filePath = safeJoin(getSystemRoutinesDir(), name + ext);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

/** Parse an "at" time into a one-shot cron expression: "9:00" (today, or tomorrow if past), "14:30",
 * or "2026-02-24 09:00". Null if invalid. */
export function parseAtTime(atTime: string): { schedule: string; runOnce: boolean } | null {
  // Try parsing as "HH:MM" format
  const timeMatch = atTime.match(/^(\d{1,2}):(\d{2})$/);
  if (timeMatch) {
    const hour = parseInt(timeMatch[1], 10);
    const minute = parseInt(timeMatch[2], 10);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

    const now = new Date();
    let targetDate = new Date();
    targetDate.setHours(hour, minute, 0, 0);

    // If the time has already passed today, schedule for tomorrow
    if (targetDate <= now) {
      targetDate.setDate(targetDate.getDate() + 1);
    }

    const day = targetDate.getDate();
    const month = targetDate.getMonth() + 1;
    // Cron format: minute hour day month *
    return { schedule: `${minute} ${hour} ${day} ${month} *`, runOnce: true };
  }

  // Try parsing as "YYYY-MM-DD HH:MM" format
  const dateTimeMatch = atTime.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (dateTimeMatch) {
    const year = parseInt(dateTimeMatch[1], 10);
    const month = parseInt(dateTimeMatch[2], 10);
    const day = parseInt(dateTimeMatch[3], 10);
    const hour = parseInt(dateTimeMatch[4], 10);
    const minute = parseInt(dateTimeMatch[5], 10);

    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

    // Note: croner doesn't support year, so we just use month/day
    // The job will fire on that date each year unless removed
    return { schedule: `${minute} ${hour} ${day} ${month} *`, runOnce: true };
  }

  return null;
}

/** List all job names that have run directories. */
export function listJobsWithRuns(): string[] {
  const runsDir = getRunsDir();
  if (!fs.existsSync(runsDir)) return [];
  return fs.readdirSync(runsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

/** Count total runs across all jobs. */
export function countAllRuns(): number {
  let total = 0;
  for (const jobName of listJobsWithRuns()) {
    total += listRuns(jobName).length;
  }
  return total;
}

/** Preview runs that would be pruned (keeping only the most recent `keep` per job). */
export function previewRunsPrune(keep: number): Array<{ jobName: string; runId: string; startedAt: string }> {
  const toPrune: Array<{ jobName: string; runId: string; startedAt: string }> = [];
  for (const jobName of listJobsWithRuns()) {
    const runs = listRuns(jobName);
    if (runs.length > keep) {
      const toRemove = runs.slice(0, runs.length - keep);
      for (const run of toRemove) {
        toPrune.push({ jobName, runId: run.runId, startedAt: run.startedAt });
      }
    }
  }
  return toPrune;
}

/** Delete old runs, keeping only the most recent `keep` per job. Returns bytes freed and run count. */
export function pruneRuns(keep: number): { deleted: number; bytesFreed: number } {
  let deleted = 0;
  let bytesFreed = 0;

  for (const jobName of listJobsWithRuns()) {
    const runs = listRuns(jobName);
    if (runs.length <= keep) continue;

    const toRemove = runs.slice(0, runs.length - keep);
    for (const run of toRemove) {
      const runDir = getRunDir(jobName, run.runId);
      bytesFreed += getDirSize(runDir);
      fs.rmSync(runDir, { recursive: true, force: true });
      deleted++;
    }
  }

  return { deleted, bytesFreed };
}

function getDirSize(dirPath: string): number {
  if (!fs.existsSync(dirPath)) return 0;
  let size = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      size += getDirSize(fullPath);
    } else {
      try {
        size += fs.statSync(fullPath).size;
      } catch { /* ignore */ }
    }
  }
  return size;
}
