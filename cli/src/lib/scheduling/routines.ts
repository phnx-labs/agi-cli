/**
 * Scheduled job (routine) configuration and run history management.
 *
 * Routines are YAML files in ~/.agents/routines/ that define recurring or
 * one-shot agent tasks. This module handles CRUD operations on job configs,
 * run metadata persistence, prompt variable expansion, and one-shot "at" time
 * scheduling.
 */

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
export interface RoutineStatusRow {
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

/**
 * The per-routine rows behind `agents routines status --json`. Distinct from
 * {@link buildRoutineListJson}: this is the scheduler-truth surface the daemon
 * owns — per routine it names the single owner device, the last fire's outcome
 * and error, and any in-flight spawn — the fields an operator (or the menu bar /
 * ext) needs to answer "did this routine fire, and is one running right now?"
 * that the definition-shaped `list --json` does not carry (PHNX-3215).
 *
 * `monitorRunningJobs()` runs first to reap runs whose process has exited, then
 * `inFlight` is gated on {@link isRunGenuinelyInFlight} — NOT on `status ===
 * 'running'` alone, because a provisional pre-spawn claim is `running` with a
 * null pid that the reaper does not touch (RUSH-2640).
 *
 * The routine set is the schedulable one ({@link listJobs}, the same
 * `getDaemonStatus`/`routines status` counts), not the display set
 * {@link buildRoutineListJson} uses — a scheduler-status surface names what the
 * daemon can actually fire, not discoverable-but-unmaterialised project routines.
 */
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

/**
 * Where a routine's job body executes when the daemon fires it.
 * Distinct from `devices` (which daemon may *fire*) and from the CLI `--device`
 * remote-management passthrough (manage routines *on* another machine).
 */
export type HostStrategy = 'local' | 'host' | 'fleet' | 'cloud';

export const HOST_STRATEGIES: readonly HostStrategy[] = ['local', 'host', 'fleet', 'cloud'] as const;

/**
 * Provenance for a routine that was materialised from a project
 * (`.agents/routines/*.yml` synced into the user layer after opt-in).
 */
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
export const LINEAR_TRIGGER_EVENTS: readonly LinearTriggerEvent[] = [
  'Issue',
  'IssueLabel',
  'Comment',
  'Project',
  'Cycle',
];

/**
 * Map a user-facing `--on` alias to a canonical GitHub trigger event.
 * Accepts the canonical names plus friendly shortcuts (e.g. `pr`, `pr_opened`
 * → `pull_request`, `comment` → `issue_comment`). Returns null when unknown.
 */
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

/**
 * Event-based fire condition for a routine — an alternative (or complement) to
 * `schedule`. Incoming webhooks whose source-specific filters match fire the job
 * through the same dispatch path a cron fire uses. See
 * `src/lib/triggers/webhook.ts`.
 */
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

/**
 * Full configuration for a routine (persisted as YAML).
 *
 * A job fires on a `schedule` (cron), on a `trigger` (event/webhook), or both.
 * `schedule` remains a first-class field; trigger-only jobs omit it and are
 * skipped by the cron scheduler (they fire only via the webhook receiver).
 */
export interface JobConfig {
  name: string;
  /** Cron expression. Optional when `trigger` is set (event-only routine). */
  schedule?: string;
  /** Event/webhook fire condition. Optional when `schedule` is set. */
  trigger?: JobTrigger;
  /**
   * Which agent runs the routine — a native harness id, or the name of a
   * custom harness (`agents harness list`), which the runner delegates to
   * `agents run <name>` the same way workflow jobs are. Optional — omitted
   * for `workflow`/`command` routines. Exactly one of agent/workflow/command
   * must be set.
   */
  agent?: AgentId | (string & {});
  workflow?: string;
  /**
   * A plain shell command run directly instead of an agent/workflow — no LLM,
   * no auth, no rotation, no tokens, no sandbox overlay. For deterministic
   * housekeeping routines (version-check, `npm i -g`, `git pull`, notify).
   * Mutually exclusive with `agent` and `workflow`.
   */
  command?: string;
  // 'full' is accepted as a permanent silent alias for 'skip' (see normalizeMode).
  mode: 'plan' | 'edit' | 'auto' | 'skip' | 'full';
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';
  timeout: string;
  enabled: boolean;
  prompt: string;
  timezone?: string;
  repo?: string;
  /**
   * Singular execution anchor: the named project (`agents projects`) whose base
   * directory the routine's run lands in. Optional. Metadata-only `projects[]`
   * (below) is NEVER used for execution — this field is. Resolution happens on
   * the execution TARGET (`resolveRoutineExecutionContext`, routine-context.ts),
   * never from the daemon's own cwd: a project with a usable `defaultPath`/`root`
   * gives the base directory; a rootless Linear-imported project gives no base,
   * so a bare relative `cwd` then anchors at the target user's `$HOME`.
   *
   * CLI flag is `--project-anchor` (not `--project`, which is the repeatable
   * grouping-metadata flag that writes `projects[]`). The YAML key is the shorter
   * singular `project` because it is unambiguous there.
   */
  project?: string;
  /**
   * Portable execution directory for the routine's run. Optional. A relative
   * value resolves under the `project` base when that base is usable, otherwise
   * under the execution target's `$HOME` (so a Linear-imported rootless project
   * can still name `cwd: src/github.com/acme/app`). A `~/`-anchored value is the
   * target's home-relative path; an absolute path under the target home is
   * normalized to the portable `~/…` form on save. An absolute path outside the
   * home is only allowed for local-pinned routines — host/fleet/cloud placement
   * pauses it as non-portable. Supersedes the legacy `remoteCwd`, which the
   * one-shot migration folds into this field.
   */
  cwd?: string;
  /**
   * Fleet allowlist — restrict this routine to specific devices. When omitted
   * or empty, the routine is unrestricted and fires on every device running the
   * scheduler. When set, only devices whose `machineId()` matches any entry
   * (via `normalizeHost`) schedule, fire, catch up, or count this job as
   * overdue; everywhere else it is inert and `run` refuses with a pointer.
   */
  devices?: string[];
  /**
   * Whether a fire this device missed (daemon down, laptop asleep, wedged event
   * loop) is run late. Defaults to true: croner only schedules forward from
   * "now", so without catch-up a missed fire is simply lost and the routine
   * silently does not run.
   *
   * Set `catchup: false` for a routine whose value is tied to its clock — a
   * 9am standup brief is worthless at 3pm. An opted-out routine still records
   * the miss (a `missed` run), it just is not re-run.
   */
  catchup?: boolean;
  /**
   * When this routine came into existence, ISO 8601. Stamped once by
   * {@link writeJob}, like `actor`.
   *
   * Overdue detection needs it: `detectOverdueJobs` walks back a week for the
   * most recent expected fire, so without a floor a brand-new routine is
   * "overdue" for occurrences that happened before it was written. Harmless
   * when catch-up was a manual command; with auto-catchup it would run every
   * newly created routine once, immediately.
   */
  createdAt?: string;
  /**
   * Environment variables injected into the spawned run, on top of the sandbox
   * overlay's own. Merged by `buildSpawnEnv`, so it applies to both the
   * foreground and detached execution paths.
   */
  env?: Record<string, string>;
  /**
   * Execution placement — run the job body on this machine over SSH (a
   * registered host, device, capability tag, or user@host) instead of locally.
   * Distinct from `devices`: `devices` says which daemon may FIRE the job,
   * `host` says where the dispatched run EXECUTES. CLI flag: `--run-on`
   * (`--device` on routines commands already means "manage routines on that
   * machine" via the remote passthrough).
   *
   * When `hostStrategy` is set, it owns placement semantics; `host` is then
   * only required for `hostStrategy: host` (or when strategy is inferred from
   * a bare `host:` field for back-compat).
   */
  host?: string;
  /**
   * Where the job body should run when the daemon fires it.
   * - `local`  — on the firing machine (default / current behavior)
   * - `host`   — on the named `host` over SSH (maps to `--run-on`)
   * - `fleet`  — pick one online registered device per run (no cross-device
   *              double-fire; the firing pin stays on `devices`)
   * - `cloud`  — dispatch via the agent's native cloud provider
   *
   * CLI flag: `--placement` (not `--device`, which is the remote-management
   * passthrough). Omitted strategy falls back to `host` when `host:` is set,
   * otherwise `local`.
   */
  hostStrategy?: HostStrategy;
  /** Working directory on the host for `host:`-placed runs. */
  remoteCwd?: string;
  /**
   * Provenance for routines materialised from a project
   * (`<project>/.agents/routines/*.yml` → user-layer copy after opt-in).
   * Absent for hand-authored user/system routines.
   */
  source?: JobSource;
  variables?: Record<string, string>;
  sandbox?: boolean;
  allow?: JobAllowConfig;
  config?: Record<string, unknown>;
  version?: string;
  /**
   * Explicit per-routine version/account selection strategy — the same
   * vocabulary as `agents run --strategy` (RUN_STRATEGIES). Overrides
   * `run.<agent>.strategy` from the FIRING device's own agents.yaml
   * (getConfiguredRunStrategy) so a routine's selection policy travels with the
   * definition instead of depending on whichever box happens to fire it.
   * Conflicts with `version:` (an exact pin leaves nothing to select) —
   * validateJob rejects the pair.
   */
  strategy?: RunStrategy;
  /**
   * Pin this routine to a signed-in account by identity (its login email, or its
   * account key) instead of rotating. At launch it resolves to whichever
   * installed version currently holds that account and runs pinned — no
   * `balanced` rotation, no usage-read refresh, no failover onto other accounts.
   *
   * This is the durable way to keep concurrent unattended routines off a *shared*
   * Claude OAuth credential: the refresh token is single-use and rotates
   * server-side on every refresh, so two routines running the same account
   * concurrently (on one box or across the fleet) mutually revoke each other —
   * the `401 OAuth access token has been revoked` storm (RUSH-1957). Give each
   * routine (or each device's routines) a distinct account and no run rotates a
   * credential out from under another.
   *
   * Prefer this over `version:`, which pins a version *number* that is GC'd on
   * the next agent upgrade — when the pinned version disappears the routine
   * silently falls back to `balanced` and the stampede returns.
   */
  account?: string;
  runOnce?: boolean;
  // RFC3339 timestamp; routine auto-disables at the next fire on/after this time.
  endAt?: string;
  /**
   * When set, the job resumes this existing agent session id at fire time
   * (`agents run <agent> --resume <id>`) instead of starting a fresh conversation,
   * so the actual session reopens with full context and `prompt` becomes its next
   * turn. Powers self-scheduled wake-ups (e.g. /hibernate). claude/codex only.
   */
  resume?: string;
  /** When set, executeJob runs this job through the loop driver instead of once. */
  loop?: LoopConfig;
  /**
   * Actor id of whoever CREATED this routine (`resolveActor().id`, stamped by
   * `writeJob` at creation and preserved across edits). Propagated into each
   * fired run's env and RunMeta so an unattended cron traces back to the person
   * who scheduled it, not the `UNRESOLVED@<host>` a live resolve would give.
   * RUSH-2020.
   */
  actor?: string;
  /**
   * Named projects this routine belongs to. Metadata-only: organises the
   * routine under a project group in `agents routines list` and the menu bar;
   * has no effect on scheduling or execution.
   *
   * Special values:
   * - `["*"]` — routine applies to all defined projects (the "All projects" group).
   * - A single name — routine belongs to that specific project.
   * - Multiple names — routine spans several projects ("Cross-project" group).
   * - Absent/empty — routine belongs to no project ("Operations" group).
   */
  projects?: string[];
  /**
   * Set only by `lib/monitors/dispatch.ts` on the one-off job it synthesizes for
   * a monitor's `run` action. Such a job is NOT a routine: it has no definition
   * file, `agents routines` never lists it, and its name can therefore never
   * appear in this device's routine activation manifest
   * (`~/.agents/devices/<machine>/agents.yaml` → `routines:`). Gating it on that
   * manifest refused every monitor action fleet-wide with `wrong_owner` and an
   * empty allowlist (RUSH-2681), so {@link jobRunsOnThisDevice} skips the
   * manifest for it. Exactly-once ownership is already resolved BEFORE dispatch
   * by the monitor's own `device:` pin (`monitorRunsOnThisDevice`,
   * `lib/monitors/config.ts`) — re-gating here was double-gating on the wrong
   * key.
   *
   * Deliberately narrow: a monitor's or webhook handler's `routine` action fires a
   * REAL routine, which keeps its activation gate, so a routine defined but not
   * activated on this device is still refused.
   *
   * Runtime-only, enforced at both ends of the schema boundary: `writeJob`
   * strips it, and `readJobFileResult` refuses a definition that carries it
   * (a hand-authored one would otherwise fire on every box regardless of
   * activation, since the daemon's load path never calls `validateJob`).
   */
  dispatchedBy?: 'monitor' | 'webhook';
}

/**
 * Canonical form of a routine's `projects` field: drop non-string and empty
 * entries and deduplicate while preserving first-seen order. This is the single
 * source of truth for project-name normalization, applied at the schema
 * boundary (`writeJob` before persistence) and at grouping (`computeProjectGroupKind`)
 * so a hand-authored YAML with duplicates (`projects: [myapp, myapp]`) is
 * treated identically to the canonical single-entry form everywhere.
 *
 * Returns `undefined` when nothing survives, so callers can omit the field.
 */
export function normalizeProjects(projects: string[] | undefined): string[] | undefined {
  if (!Array.isArray(projects) || projects.length === 0) return undefined;
  const out = [...new Set(projects.filter((p): p is string => typeof p === 'string' && p !== ''))];
  return out.length === 0 ? undefined : out;
}

/**
 * A routine's project bucket, discriminated by `kind` so buckets are never keyed
 * on their human display label. A named project called literally "Operations" or
 * "Cross-project" is `{ kind: 'named', name }` and can never collide with the
 * `operations` / `cross` special buckets that happen to share those titles.
 */
export type ProjectGroup =
  | { kind: 'named'; name: string }
  | { kind: 'all' }
  | { kind: 'cross' }
  | { kind: 'operations' }
  | { kind: 'unknown' };

/**
 * Classify a routine's `projects` field into a discriminated {@link ProjectGroup}.
 * Duplicates are collapsed first ({@link normalizeProjects}), so `[myapp, myapp]`
 * is a single named project, not a "Cross-project" span.
 *
 * @param projects - The routine's projects array (may be undefined).
 * @param knownProjectNames - The set of currently defined project names (from `listProjectDefs`).
 */
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

/**
 * Stable bucket key for a {@link ProjectGroup}. Named projects key on their name
 * under a `named:` prefix; specials key on their `kind` under a `special:` prefix.
 * The two namespaces can never collide, so a project named "Operations" gets its
 * own bucket separate from the no-project "Operations" special.
 */
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

/**
 * Compute the display group label for a routine's `projects` field.
 *
 * Kept as the label-returning form for the JSON `projectGroup` field and any
 * text consumer; grouping and ordering use the discriminated
 * {@link computeProjectGroupKind}/{@link projectGroupKey} instead so buckets are
 * never keyed on the label.
 *
 * @param projects - The routine's projects array (may be undefined).
 * @param knownProjectNames - The set of currently defined project names (from `listProjectDefs`).
 *
 * Returns one of:
 * - A specific project name — when `projects` has exactly one known name.
 * - `"All projects"` — when `projects` is `["*"]`.
 * - `"Cross-project"` — when `projects` has multiple distinct known entries.
 * - `"Operations"` — when `projects` is absent or empty.
 * - `"Unknown projects"` — when any entry is no longer a defined project (stale).
 */
export function computeProjectGroup(
  projects: string[] | undefined,
  knownProjectNames: Set<string>,
): string {
  return projectGroupTitle(computeProjectGroupKind(projects, knownProjectNames));
}

/** A real-filesystem {@link ContextFsProbe} for readiness checks on this machine. */
export function realFsProbe(): ContextFsProbe {
  return {
    exists: (p) => fs.existsSync(p),
    isDirectory: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
    isWritable: (p) => { try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; } },
  };
}

/** Classify a routine by its body kind — governs the execution-context fallback rules. */
export function jobRoutineKind(config: Pick<JobConfig, 'agent' | 'workflow' | 'command'>): RoutineKind {
  if (config.command) return 'command';
  if (config.workflow) return 'workflow';
  return 'agent';
}

/**
 * Resolve a routine's execution context (working directory + structural/fs
 * readiness) by bridging its `project`/`cwd` fields into the pure
 * {@link resolveRoutineExecutionContext} resolver. Local placement resolves
 * against this machine's `$HOME` with a real filesystem probe; a caller may
 * inject a different target home / probe (e.g. `null` to defer existence for a
 * remote target).
 */
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
  /**
   * Resolved agent version this run launched under. Re-pointed to each failover
   * attempt's version as the single-shot chain advances (runner.ts), so it names
   * the version that actually ran and wrote the transcript. Recorded so
   * `archiveRoutineTranscripts` can find the transcript in the per-version home a
   * config-dir-relocating agent (claude/codex) writes to, and so account
   * attribution can name the home that ran (RUSH-2271). Unset for
   * command/self-updating runs.
   */
  version?: string;
  /** Resolved account home and identity for transcript archival after restart. */
  execHome?: string;
  accountKey?: string;
  workflow?: string;
  /** The shell command that ran, for command-mode routines (no agent). */
  command?: string;
  pid: number | null;
  /** Process birth time (epoch ms) recorded at spawn for pid-reuse detection. */
  spawnedAt?: number;
  /** Configured execution deadline persisted for daemon-restart recovery. */
  timeoutMs?: number;
  /**
   * `missed` is not an execution outcome — it is the record that a scheduled
   * fire never happened (the daemon was down, asleep, or wedged when it came
   * due). Without it a miss leaves no trace at all and the listing keeps
   * showing the previous run's status as if it were current. Written by
   * `claimMissedFire` (catchup.ts), never by the runner.
   *
   * `blocked` and `skipped` are pre-execution terminals that leave a visible
   * record even though no agent process ran (the plan's history contract):
   * - `blocked` — a fire-time readiness rejection (bad context, dead auth,
   *   untrusted workspace). No agent process was spawned. Distinct from `failed`,
   *   which means a process started and failed.
   * - `skipped` — the attempt lost a claim (`skipReason`): a duplicate schedule
   *   slot, an already-active run it would overlap, or a wrong device owner.
   */
  status: 'running' | 'completed' | 'failed' | 'timeout' | 'missed' | 'blocked' | 'skipped';
  /**
   * How this attempt was triggered. Answers "why did this run exist" for a
   * record that may have no transcript (a blocked/skipped attempt).
   */
  triggerKind?: 'schedule' | 'catchup' | 'manual' | 'webhook' | 'event';
  /**
   * The scheduler's intended UTC fire time (ISO), for a `schedule`/`catchup`
   * attempt. The atomic single-fire claim keys on (routine, scheduledFor): a
   * duplicate cron delivery for the same slot resolves to this same run rather
   * than launching a second time.
   */
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
  /**
   * Actor id of the routine's CREATOR (stamped at creation, carried from the job
   * config). Answers "whose scheduled run is this" for an unattended cron fire,
   * where resolving the actor live would only yield `UNRESOLVED@<host>`. RUSH-2020.
   */
  actor?: string;
  /**
   * Actor id that TRIGGERED this particular run (`resolveActor().id` at fire
   * time): a person for a manual `agents routines run`, `UNRESOLVED@<host>` for
   * an unattended scheduled fire. Distinct from {@link actor} (the creator).
   */
  triggeredBy?: string;
}

/**
 * Finalize a run record with a terminal status, computing `duration` from
 * `startedAt` and the completion timestamp. Keeps failure-reason population
 * centralized so every completion path writes the same machine-readable fields.
 */
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

/**
 * True when the job may execute on this machine: no `devices` allowlist (or
 * empty), or the allowlist includes this device. Both sides go through
 * `normalizeHost` so `Yosemite-S0`, `yosemite-s0.tailnet.ts.net`, and
 * `yosemite-s0` all agree. Every fire path (cron scheduler, webhook,
 * catchup/overdue, manual run) gates on this.
 *
 * A monitor- or webhook-dispatched job ({@link JobConfig.dispatchedBy} set) skips
 * the routine activation manifest: it is not a routine, so its name can never be
 * a member and the lookup could only ever answer "not activated here"
 * (RUSH-2681 for monitors; the same hole broke every `run.agent`/`run.workflow`
 * webhook handler, which the receiver logged as `fired` while the run record read
 * `skipped` with an empty allowlist). Ownership was already decided upstream — by
 * the monitor's `device:` pin, or by the one box the webhook was delivered to.
 */
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

/**
 * The ONE device that owns a routine — the single daemon allowed to fire it.
 *
 * `devices` is an allowlist, and every listed device used to fire
 * independently, so a routine pinned to two boxes ran **twice** per schedule:
 * two full agent sessions doing identical work, burning double the quota. On
 * this fleet seven routines were in that state, e.g. `security-sweep` running
 * at 15:30:02 on one box and 15:30:03 on the other, both completing.
 *
 * Ownership is a pure function of the config — the first entry in normalized
 * sort order — so every daemon independently reaches the same answer with no
 * lease, no cross-device coordination, and no split brain when the fleet
 * partitions. A multi-entry pin is a misconfiguration
 * ({@link hasAmbiguousDevicePin}); this keeps such a routine running exactly
 * once instead of silently dropping it, while `validateJob` refuses to create
 * a new one and `agents doctor` surfaces the existing ones.
 *
 * Returns null when the routine is unrestricted (empty or omitted `devices`).
 */
export function routineOwnerDevice(config: Pick<JobConfig, 'devices'>): string | null {
  // A non-array `devices` is a separate validation error; don't throw here and
  // don't double-report it.
  if (!Array.isArray(config.devices)) return null;
  const devices = config.devices.map((d) => normalizeHost(String(d))).filter(Boolean);
  if (devices.length === 0) return null;
  return [...devices].sort()[0];
}

/**
 * Does this routine name more than one distinct device? Such a pin used to mean
 * "fire on each of them"; it now means "fire only on the first", which is
 * almost certainly not what the author intended either way — so it is reported
 * as a misconfiguration rather than silently reinterpreted.
 */
export function hasAmbiguousDevicePin(config: Pick<JobConfig, 'devices'>): boolean {
  if (!Array.isArray(config.devices)) return false;
  const devices = new Set(config.devices.map((d) => normalizeHost(String(d))).filter(Boolean));
  return devices.size > 1;
}

/** One routine whose `devices` names more than one machine, with its resolved owner. */
export interface AmbiguousDevicePin {
  name: string;
  devices: string[];
  /** The device that now fires it — the rest are inert. */
  owner: string;
}

/**
 * Every routine carrying a multi-device pin. Surfaced by `agents doctor` and
 * `agents routines list` so an existing misconfiguration is visible rather than
 * silently reinterpreted: before ownership became singular each of these fired
 * once per listed device, doubling the work and the agent spend.
 */
export function findAmbiguousDevicePins(cwd?: string): AmbiguousDevicePin[] {
  return listJobs(cwd)
    .filter((job) => job.enabled && hasAmbiguousDevicePin(job))
    .map((job) => ({
      name: job.name,
      devices: (job.devices ?? []).map((d) => normalizeHost(d)),
      owner: routineOwnerDevice(job) ?? '',
    }));
}

/**
 * Resolve the effective host strategy for a job.
 * Bare `host:` without an explicit strategy implies `host` (back-compat with
 * pre-hostStrategy YAML). Otherwise default to `local`.
 */
export function resolveHostStrategy(
  config: Pick<JobConfig, 'hostStrategy' | 'host'>,
): HostStrategy {
  if (config.hostStrategy) return config.hostStrategy;
  if (config.host) return 'host';
  return 'local';
}

/**
 * Parse a CLI `--placement` value into a HostStrategy, or null when empty.
 * Throws a human-readable Error for unknown values.
 */
export function parseHostStrategy(raw: string | undefined | null): HostStrategy | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const v = raw.trim().toLowerCase();
  if ((HOST_STRATEGIES as readonly string[]).includes(v)) return v as HostStrategy;
  throw new Error(`Invalid placement '${raw}'. Use one of: ${HOST_STRATEGIES.join(', ')}`);
}

/**
 * Strategies that dispatch the job body off the firing machine. Without a
 * `devices` pin every daemon in the fleet would fire and each would dispatch
 * once — N× duplicate runs. Callers pin to this machine when the user did not
 * set an explicit allowlist.
 */
export function placementRequiresFiringPin(strategy: HostStrategy): boolean {
  return strategy === 'host' || strategy === 'fleet' || strategy === 'cloud';
}

/** Human presentation of a device-affinity mismatch for commands and runner. */
export interface JobEligibilityResult {
  /** Full human message, e.g. "Job 'NAME' can only run on: a, b". */
  message: string;
  /** One-line copy-paste suggestion, e.g. "agents routines run NAME --device a". */
  suggestion: string;
  /** Comma-separated allowed devices label, e.g. "a, b". */
  allowedLabel: string;
  /** First allowed device (normalized), useful for the suggested host. */
  firstHost: string;
}

/**
 * Return null when the job may run here; otherwise return a structured,
 * human-friendly eligibility failure. Centralizes the message/suggestion
 * construction so manual run, executeJob, and executeJobDetached stay in
 * sync. Scheduler/webhook/overdue paths continue to use jobRunsOnThisDevice.
 */
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

/**
 * List all job configs, scanning project > user > system routine dirs.
 * Higher layers shadow lower ones of the same name (first-seen wins): a project
 * routine shadows a user routine, and a user routine shadows a system routine
 * (`~/.agents/.system/routines/`, shipped via gh:phnx-labs/.agents-system).
 * When a same-name project routine wins for inspection, the user-layer
 * `devices` allowlist is overlaid only if the project routine does not declare
 * its own allowlist, so CWD project discovery cannot hide an operational fleet
 * pin or erase a project-authored one.
 * Project discovery is opt-in via `cwd`; the daemon (which calls `listJobs()`
 * with no argument) sees user + system routines.
 */
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

/**
 * Read a single job config by name, checking project > user > system.
 * Same-name project routines keep the user-layer `devices` allowlist only when
 * the project routine does not declare its own allowlist, for the same reason
 * as listJobs().
 * Project discovery is opt-in via `cwd`; daemon callers pass no argument and
 * resolve user + system routines.
 */
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

/**
 * The outcome of reading one routine file: a config, or the reason it is inert.
 * Every `problem` here means the daemon will not run the routine.
 */
export type RoutineReadResult =
  | { config: JobConfig; problem: null }
  | { config: null; problem: string };

/**
 * Read one routine file, preserving WHY it failed.
 *
 * `readJobFile` collapses all four fail-closed paths to `null`, which is right
 * for the loaders (an inert routine must not run) but leaves a broken routine
 * invisible in every view — the one routine an operator most needs to see. Same
 * reading, reason kept, for diagnostic surfaces like `agents inspect --routines`.
 */
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

  // Fail closed on a malformed `devices` too. Ownership treats a non-array as
  // "no pin", and the daemon's load path never calls validateJob — so a YAML
  // typo (`devices: yosemite-s0` instead of a list) would silently promote the
  // routine to fleet-wide and fire it on EVERY box. Inert-and-loud beats
  // unrestricted-and-silent.
  if (Object.prototype.hasOwnProperty.call(parsed, 'devices')
      && parsed.devices !== undefined
      && parsed.devices !== null
      && !Array.isArray(parsed.devices)) {
    return { config: null, problem: '`devices:` must be a list — routine is inert' };
  }

  // Fail closed on `dispatchedBy`. It is a runtime-only marker set by
  // lib/monitors/dispatch.ts on a job that has no definition file, and it makes
  // `jobRunsOnThisDevice` SKIP this device's routine activation manifest. A
  // routine YAML carrying it would therefore fire on every box regardless of
  // activation, on every path (scheduler, overdue, webhook) — the same
  // unrestricted-and-silent outcome the `devices:` guard above exists to
  // prevent, and the daemon's load path never calls validateJob. It is never
  // written back (writeJob deletes it), so its presence here means hand-authored
  // state, not drift.
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

/** Write a job config to disk, omitting fields that match defaults.
 *
 * Updates the one existing supported extension (.yml or .yaml) atomically.
 * New routines are written as .yml. If both extensions exist for the same
 * name, the write fails explicitly so we never choose or drop a sibling.
 */
export function writeJob(config: JobConfig): void {
  ensureAgentsDir();
  // Stamp the creator once (RUSH-2020). An edit re-writes a config loaded from
  // disk, which already carries `actor`, so this preserves the original creator;
  // only a brand-new routine (no actor yet) gets the current resolver.
  if (!config.actor) config.actor = resolveActor().id;
  // Stamped once, on first write, and preserved by every later edit (an edit
  // re-writes a config loaded from disk, which already carries it). This is the
  // floor overdue detection uses so a routine is never judged against fires
  // that predate it.
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
  // Persist projects in canonical form: deduplicated, first-seen order, field
  // omitted when nothing survives. This is the schema boundary, so a routine
  // written from any path (add, edit, enable/disable re-write) lands canonical
  // regardless of how the caller assembled the array.
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

/**
 * Serialize a job config, preserving the on-disk formatting of an existing file.
 *
 * A full `yaml.stringify(config)` re-emits the whole document — restyling every
 * scalar (unquoting `schedule`, re-wrapping the folded `prompt` block, reordering
 * keys). When a routine is only being toggled (pause/resume) or re-pinned
 * (`devices --set`), that rewrites the entire file, leaving the git-backed
 * `~/.agents` tree perpetually dirty so `agents repo pull` refuses to sync across
 * the fleet. To keep the diff to the field that actually changed, we edit the
 * existing document in place and only re-render touched nodes; untouched nodes
 * (notably the large `prompt` block) keep their byte-for-byte formatting.
 *
 * `existingText` is the current file contents, or null for a new file. New,
 * unparseable, and non-mapping documents fall back to canonical `yaml.stringify`.
 */
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

  // `flowCollectionPadding: false` keeps a re-serialized flow sequence in the
  // committed no-padding form (`[a, b]`, not `[ a, b ]`). Routine YAML lives in
  // the same git-backed `~/.agents` repo as agents.yaml, so the same emitter
  // padding would leave the tracked file dirty and block `agents repo pull`
  // fleet-wide (RUSH-2505). Node styles are otherwise preserved.
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
    // The local daemon only knows how to build a command for the agents in
    // ROUTINE_AGENT_IDS (baked from AGENT_COMMANDS in runner.ts) — anything else is a
    // real, installable agent (it passed the ALL_AGENT_IDS check above) but one
    // the daemon can't fire itself, so reject it now instead of accepting the
    // routine and failing at fire time (runner.ts buildJobCommand: "Unsupported
    // agent for daemon jobs"). host/fleet/cloud placement dispatches through
    // `agents run`/a cloud provider instead of this table, so they're exempt.
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

export interface OneShotScheduleParts {
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

/**
 * Context passed to `resolveJobPrompt` when a job is fired by a webhook. Lets
 * prompts use `{{issue.identifier}}`, `{{updatedFrom.state.name}}`, etc.
 */
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

/**
 * Substitute `{{dotted.path}}` placeholders in a string using a webhook context.
 * Missing values are replaced with an empty string.
 */
export function substituteWebhookPrompt(prompt: string, context: WebhookContext): string {
  return prompt.replace(/\{\{([^{}]+)\}\}/g, (_, rawPath: string) => {
    const value = getPath(context, rawPath.trim());
    if (value === undefined || value === null) return '';
    return String(value);
  });
}

/**
 * Substitute `{{dotted.path}}` placeholders in a string destined for a SHELL,
 * quoting every substituted value so payload content cannot break out of it.
 *
 * `run.command` is executed through a shell, and its context is built from an
 * external webhook payload — `issue.title`, `issue.description`, and the GitHub
 * `pull_request` fields are free text any outside contributor can set. Pasting
 * those in raw (as {@link substituteWebhookPrompt} does, correctly, for prompts)
 * turns an operator's `echo {{issue.title}}` into a command-injection sink.
 *
 * The template itself is operator-authored and stays unquoted, so pipes,
 * redirects, and `&&` in the configured command keep working. Only the
 * interpolated values are quoted.
 *
 * POSIX `sh` quoting: wrap in single quotes and close/escape/reopen for any
 * embedded single quote. `exec` uses `cmd.exe` on Windows, which does not
 * honour these rules — see `assertShellSubstitutionSupported`.
 */
export function substituteWebhookCommand(command: string, context: WebhookContext): string {
  return command.replace(/\{\{([^{}]+)\}\}/g, (_, rawPath: string) => {
    const value = getPath(context, rawPath.trim());
    if (value === undefined || value === null) return "''";
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
  });
}

/**
 * Refuse a `run.command` carrying placeholders on a platform whose shell we
 * cannot safely quote for. `child_process.exec` runs through `cmd.exe` on
 * Windows, where POSIX single-quoting is not a quoting mechanism at all, so
 * {@link substituteWebhookCommand} would not contain a hostile value.
 *
 * Fail loud rather than execute something we cannot prove is safe.
 */
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

  // Last report (special handling). Only a COMPLETED run's report is injected —
  // a failed run's report.md is the agent's error text (e.g. a login prompt on
  // an auth failure), and feeding that into the next prompt poisons every
  // subsequent run until a human intervenes.
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

/** Parse a human-readable timeout string (e.g. "10m", "2h", "1h30m", "3d", "1w") into milliseconds.
 *  Accepts combinations of w (weeks), d (days), h (hours), m (minutes).
 *  Returns null if the string is empty, matches nothing, totals zero, or exceeds 1 week.
 */
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

/**
 * Get the most recent COMPLETED run for a job, or null if none has completed.
 * Used to resolve `{last_report}` so a failed run's error text (e.g. an auth
 * login prompt written into report.md) can never be injected into the next
 * run's prompt.
 */
export function getLatestCompletedRun(jobName: string): RunMeta | null {
  const runs = listRuns(jobName);
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i].status === 'completed') return runs[i];
  }
  return null;
}

/** Duration + outcome rollup for a job's run history. */
export interface RoutineStats {
  /** Total run records (any status, including `missed`). */
  count: number;
  failed: number;
  missed: number;
  avgMs: number;
  p50: number;
  p95: number;
}

/**
 * Fold a job's run history (`listRuns`) into a duration + outcome summary.
 * `missed` fires (no process ever ran) carry no `duration` and are excluded
 * from the latency percentiles but still counted in `count`/`missed`.
 */
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

/**
 * Runs directory for a single job, with the (untrusted) job name contained to a
 * single segment beneath the runs dir — same guard as `getJobHomePath`. The name
 * comes from routine YAML and can arrive via a synced config repo; every runs-dir
 * sink (run dir, meta read/write, last-report read) routes through here so a
 * crafted `name` like `../../../../tmp/x` can't `mkdirSync`/write `stdout.log`,
 * `meta.json`, or `report.md` outside `~/.agents/.history/runs`.
 */
export function getJobRunsDir(jobName: string): string {
  return safeJoin(getRunsDir(), jobName);
}

/** Get the filesystem path for a specific run's directory. */
export function getRunDir(jobName: string, runId: string): string {
  return path.join(getJobRunsDir(jobName), runId);
}

/**
 * The run id a scheduled fire is recorded under — derived from its intended UTC
 * fire time so the SAME slot always maps to the SAME run directory. This is what
 * makes the single-fire claim meaningful: a duplicate cron delivery for one slot
 * computes the same id and loses the atomic `mkdir` claim. Shares the derivation
 * with `missedRunId` (catchup.ts) so a missed-then-caught-up fire and a live fire
 * for the same UTC slot are one record.
 */
export function slotRunId(scheduledFor: Date | string): string {
  const iso = typeof scheduledFor === 'string' ? scheduledFor : scheduledFor.toISOString();
  return iso.replace(/[:.]/g, '-');
}

/**
 * Lookback windows for {@link alignedSlotForFire}, narrowest first. A wider
 * window is tried ONLY when the narrower one found no fire, so:
 *  - a dense schedule (every-minute) resolves in the 1-hour window — ~60 steps,
 *    not ~10080 — which matters because the forward-timer path now runs this on
 *    every fire (a live fire is milliseconds past its boundary, so the narrowest
 *    window always contains it);
 *  - a sparse schedule (`0 9 1,13,25 * *` has 12-day gaps; monthly/quarterly/
 *    annual) still resolves, because a fixed short window silently blinded
 *    overdue detection to any cron whose gap exceeded it.
 * A narrower window can only ever find the true most-recent fire ≤ `at` or
 * nothing (never a wrong boundary), so prepending the cheap windows is
 * behavior-preserving for the sparse-schedule overdue path.
 */
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SLOT_LOOKBACK_WINDOWS_MS = [HOUR_MS, DAY_MS, 7 * DAY_MS, 32 * DAY_MS, 93 * DAY_MS, 400 * DAY_MS];

/**
 * The aligned schedule boundary a fire belongs to: the most recent occurrence of
 * `cron` at or before `at`.
 *
 * This is the occurrence IDENTITY that {@link slotRunId} (forward dispatch) and
 * `missedRunId` (catchup.ts) must both key on. croner's `currentRun()` inside a
 * fire callback is the JITTERED wall-clock trigger instant (it carries
 * milliseconds — verified), not the aligned boundary, so keying `slotRunId`
 * directly on it produced a distinct id per delivery: two callbacks for one
 * occurrence each claimed a different run dir and both launched, and a live fire
 * never collided with its catch-up twin (which keys on the aligned
 * `previousExpectedFire`). Flooring both to this boundary is what makes the
 * single-fire claim a structural claim on `(routine, scheduledFor)` (SING-15).
 *
 * croner's `previousRun()` takes no argument and returns null on a freshly
 * constructed instance, so we walk `nextRun(cursor)` forward from a lookback
 * window and keep the last fire still ≤ `at` — the same derivation catchup's
 * overdue detection has always used.
 */
export function alignedSlotForFire(cron: Cron, at: Date): Date | null {
  for (const window of SLOT_LOOKBACK_WINDOWS_MS) {
    let cursor: Date = new Date(at.getTime() - window);
    let last: Date | null = null;
    // Cap iterations: an every-minute schedule yields ≤ 10080 steps over a week;
    // 20k is a paranoia bound against pathological patterns. Only a schedule that
    // found nothing in the narrower window reaches a wider one, and such a
    // schedule is sparse, so the cap is never the binding constraint.
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

/**
 * Atomically CLAIM a run directory. Returns true on a successful claim, false
 * when the directory already exists (another caller — even in a separate process
 * — owns this (routine, slot) pair). The non-recursive `mkdir` is a single
 * filesystem test-and-set on every POSIX filesystem, the same primitive
 * `claimMissedFire` relies on; it holds across processes where an in-process flag
 * or a released lock cannot.
 */
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

/**
 * True when `sourcePath` already IS the canonical user-layer file for `name`.
 *
 * `agents routines add <file>` copies a definition into the routines dir, but
 * users routinely point it at the file that already lives there — the release
 * train's own `~/.agents/routines/release-train.yml`. `writeJob` would then
 * re-serialize that file in place and, per {@link serializeJob}, delete every
 * key absent from the canonical output — silently dropping the legacy
 * `devices:` pin from config tracked in the git-backed `~/.agents` repo
 * (RUSH-2517). Callers use this to skip the write when there is nothing to
 * copy.
 *
 * Compares real paths so a symlinked `~/.agents` (the normal layout) still
 * matches, and falls back to a resolved-path compare when either side cannot be
 * realpath'd.
 */
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

/**
 * Resolve a routine's YAML across EVERY layer `listJobs`/`readJob` read — user
 * then system — not just the user dir.
 *
 * `getJobPath` is user-layer only because its callers write there. Read paths
 * that ask "when did this routine come to exist" need the system layer too:
 * a built-in shipped in the system repo has no user-layer file and no
 * `createdAt`, so a user-layer-only lookup returns null, the overdue floor is
 * skipped, and the routine reads as instantly overdue on first daemon start —
 * exactly the case the floor exists to prevent.
 */
export function resolveJobFilePath(name: string): string | null {
  const userPath = getJobPath(name);
  if (userPath) return userPath;
  for (const ext of ['.yml', '.yaml']) {
    const filePath = safeJoin(getSystemRoutinesDir(), name + ext);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

/**
 * Parse an "at" time string into a one-shot cron expression.
 * Supports formats like:
 * - "9:00" or "09:00" - today at 9:00 AM (or tomorrow if past)
 * - "14:30" - today at 2:30 PM
 * - "2026-02-24 09:00" - specific date and time
 * Returns null if invalid format.
 */
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

/** Check if an installed job's normalized YAML matches the source file. */
export function jobContentMatches(name: string, sourcePath: string): boolean {
  const existing = readJob(name);
  if (!existing) return false;

  try {
    const sourceContent = fs.readFileSync(sourcePath, 'utf-8');
    const sourceJob = yaml.parse(sourceContent);
    if (!sourceJob) return false;

    const existingNormalized = yaml.stringify(existing);
    const fullSource = { ...JOB_DEFAULTS, ...sourceJob, name: sourceJob.name || name };
    const sourceNormalized = yaml.stringify(fullSource);
    return existingNormalized === sourceNormalized;
  } catch {
    return false;
  }
}

/** Install a job by reading and validating a YAML source file. */
export function installJobFromSource(sourcePath: string, name: string): { success: boolean; error?: string } {
  try {
    const content = fs.readFileSync(sourcePath, 'utf-8');
    const parsed = yaml.parse(content);
    if (!parsed) return { success: false, error: 'Invalid YAML' };

    const config: JobConfig = {
      ...JOB_DEFAULTS,
      ...parsed,
      name: parsed.name || name,
    } as JobConfig;

    const errors = validateJob(config);
    if (errors.length > 0) {
      return { success: false, error: errors.join(', ') };
    }

    writeJob(config);
    setJobEnabled(config.name, config.enabled);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
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
