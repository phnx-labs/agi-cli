
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
  try { monitorRunningJobs(); } catch {  }
  const jobs = listJobsForDisplay(process.cwd());
  if (jobs.length === 0) return [];

  const scheduler = new JobScheduler(async () => {});
  scheduler.loadAll();
  try {
    const overdueSet = new Set<string>();
    try {
      for (const job of detectOverdueJobs()) overdueSet.add(job.name);
    } catch {
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

interface RoutineStatusRow {
  name: string;
  ownerDevice: string | null;
  ambiguousDevicePin: boolean;
  enabledDevices: string[];
  runsHere: boolean;
  enabled: boolean;
  overdue: boolean;
  nextRun: string | null;
  lastStatus: RunMeta['status'] | null;
  failureReason: string | null;
  lastRunStartedAt: string | null;
  lastRunCompletedAt: string | null;
  inFlight: { runId: string; pid: number | null; startedAt: string; triggerKind: RunMeta['triggerKind'] | null } | null;
}

export function buildRoutineStatusRows(): RoutineStatusRow[] {
  try { monitorRunningJobs(); } catch {  }
  const jobs = listJobs();
  if (jobs.length === 0) return [];

  const scheduler = new JobScheduler(async () => {});
  scheduler.loadAll();
  try {
    const overdueSet = new Set<string>();
    try {
      for (const job of detectOverdueJobs()) overdueSet.add(job.name);
    } catch {
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

export interface JobAllowConfig {
  tools?: string[];
  sites?: string[];
  dirs?: string[];
}

export type HostStrategy = 'local' | 'host' | 'fleet' | 'cloud';

export const HOST_STRATEGIES: readonly HostStrategy[] = ['local', 'host', 'fleet', 'cloud'] as const;

export interface JobSource {
  kind: 'project';
  projectPath: string;
  repo?: string;
  branch?: string;
  commit?: string;
}

export type GithubTriggerEvent = 'pull_request' | 'push' | 'issue_comment' | 'workflow_run';

export const GITHUB_TRIGGER_EVENTS: readonly GithubTriggerEvent[] = [
  'pull_request',
  'push',
  'issue_comment',
  'workflow_run',
];

export type LinearTriggerEvent = 'Issue' | 'IssueLabel' | 'Comment' | 'Project' | 'Cycle';

const LINEAR_TRIGGER_EVENTS: readonly LinearTriggerEvent[] = [
  'Issue',
  'IssueLabel',
  'Comment',
  'Project',
  'Cycle',
];

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

export interface GithubJobTrigger {
  type: 'github_event';
  event: GithubTriggerEvent;
  repo?: string;
  branch?: string;
  action?: string;
  label?: string;
}

export interface LinearJobTrigger {
  type: 'linear_event';
  event: LinearTriggerEvent;
  action?: string;
  teamKey?: string;
  label?: string;
  stateTo?: string;
  stateFrom?: string;
}

export type JobTrigger = GithubJobTrigger | LinearJobTrigger;

export interface JobConfig {
  name: string;
  schedule?: string;
  trigger?: JobTrigger;
  agent?: AgentId | (string & {});
  workflow?: string;
  command?: string;
  mode: 'plan' | 'edit' | 'auto' | 'skip' | 'full';
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';
  timeout: string;
  enabled: boolean;
  prompt: string;
  timezone?: string;
  repo?: string;
  project?: string;
  cwd?: string;
  devices?: string[];
  catchup?: boolean;
  createdAt?: string;
  env?: Record<string, string>;
  host?: string;
  hostStrategy?: HostStrategy;
  remoteCwd?: string;
  source?: JobSource;
  variables?: Record<string, string>;
  sandbox?: boolean;
  allow?: JobAllowConfig;
  config?: Record<string, unknown>;
  version?: string;
  strategy?: RunStrategy;
  account?: string;
  runOnce?: boolean;
  endAt?: string;
  resume?: string;
  loop?: LoopConfig;
  actor?: string;
  projects?: string[];
  dispatchedBy?: 'monitor' | 'webhook';
}

export function normalizeProjects(projects: string[] | undefined): string[] | undefined {
  if (!Array.isArray(projects) || projects.length === 0) return undefined;
  const out = [...new Set(projects.filter((p): p is string => typeof p === 'string' && p !== ''))];
  return out.length === 0 ? undefined : out;
}

type ProjectGroup =
  | { kind: 'named'; name: string }
  | { kind: 'all' }
  | { kind: 'cross' }
  | { kind: 'operations' }
  | { kind: 'unknown' };

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

export function projectGroupTitle(group: ProjectGroup): string {
  switch (group.kind) {
    case 'named': return group.name;
    case 'all': return 'All projects';
    case 'cross': return 'Cross-project';
    case 'operations': return 'Operations';
    case 'unknown': return 'Unknown projects';
  }
}

export function projectGroupKey(group: ProjectGroup): string {
  return group.kind === 'named' ? `named:${group.name}` : `special:${group.kind}`;
}

export function projectGroupOrder(group: ProjectGroup): number {
  switch (group.kind) {
    case 'named': return 0;
    case 'all': return 1;
    case 'cross': return 2;
    case 'operations': return 3;
    case 'unknown': return 4;
  }
}

export function computeProjectGroup(
  projects: string[] | undefined,
  knownProjectNames: Set<string>,
): string {
  return projectGroupTitle(computeProjectGroupKind(projects, knownProjectNames));
}

function realFsProbe(): ContextFsProbe {
  return {
    exists: (p) => fs.existsSync(p),
    isDirectory: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
    isWritable: (p) => { try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; } },
  };
}

function jobRoutineKind(config: Pick<JobConfig, 'agent' | 'workflow' | 'command'>): RoutineKind {
  if (config.command) return 'command';
  if (config.workflow) return 'workflow';
  return 'agent';
}

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
      ? { defined: true, base: projectBasePath(def, true) }
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

export interface RunMeta {
  jobName: string;
  runId: string;
  agent?: AgentId | (string & {});
  version?: string;
  workflow?: string;
  command?: string;
  pid: number | null;
  spawnedAt?: number;
  timeoutMs?: number;
  status: 'running' | 'completed' | 'failed' | 'timeout' | 'missed' | 'blocked' | 'skipped';
  triggerKind?: 'schedule' | 'catchup' | 'manual' | 'webhook' | 'event';
  scheduledFor?: string;
  project?: string;
  requestedCwd?: string;
  resolvedCwd?: string;
  readiness?: { code: string; message: string; repair?: string };
  skipReason?: 'duplicate_slot' | 'active_run' | 'wrong_owner';
  activeRunId?: string;
  startedAt: string;
  completedAt: string | null;
  exitCode: number | null;
  errorMessage?: string;
  duration?: number;
  host?: string;
  hostTaskId?: string;
  cloudTaskId?: string;
  cloudProvider?: string;
  actor?: string;
  triggeredBy?: string;
}

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

export function jobRunsOnThisDevice(config: Pick<JobConfig, 'name' | 'devices' | 'dispatchedBy'>): boolean {
  if (config.dispatchedBy === undefined) {
    const activated = routineEnabledOnThisDevice(config.name);
    if (activated !== null) return activated;
  }
  const owner = routineOwnerDevice(config);
  if (owner === null) return true;
  return owner === machineId();
}

export function routineOwnerDevice(config: Pick<JobConfig, 'devices'>): string | null {
  if (!Array.isArray(config.devices)) return null;
  const devices = config.devices.map((d) => normalizeHost(String(d))).filter(Boolean);
  if (devices.length === 0) return null;
  return [...devices].sort()[0];
}

export function hasAmbiguousDevicePin(config: Pick<JobConfig, 'devices'>): boolean {
  if (!Array.isArray(config.devices)) return false;
  const devices = new Set(config.devices.map((d) => normalizeHost(String(d))).filter(Boolean));
  return devices.size > 1;
}

interface AmbiguousDevicePin {
  name: string;
  devices: string[];
  owner: string;
}

export function findAmbiguousDevicePins(cwd?: string): AmbiguousDevicePin[] {
  return listJobs(cwd)
    .filter((job) => job.enabled && hasAmbiguousDevicePin(job))
    .map((job) => ({
      name: job.name,
      devices: (job.devices ?? []).map((d) => normalizeHost(d)),
      owner: routineOwnerDevice(job) ?? '',
    }));
}

export function resolveHostStrategy(
  config: Pick<JobConfig, 'hostStrategy' | 'host'>,
): HostStrategy {
  if (config.hostStrategy) return config.hostStrategy;
  if (config.host) return 'host';
  return 'local';
}

export function parseHostStrategy(raw: string | undefined | null): HostStrategy | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const v = raw.trim().toLowerCase();
  if ((HOST_STRATEGIES as readonly string[]).includes(v)) return v as HostStrategy;
  throw new Error(`Invalid placement '${raw}'. Use one of: ${HOST_STRATEGIES.join(', ')}`);
}

export function placementRequiresFiringPin(strategy: HostStrategy): boolean {
  return strategy === 'host' || strategy === 'fleet' || strategy === 'cloud';
}

interface JobEligibilityResult {
  message: string;
  suggestion: string;
  allowedLabel: string;
  firstHost: string;
}

export function checkJobDeviceEligibility(
  config: Pick<JobConfig, 'name' | 'devices' | 'dispatchedBy'>,
): JobEligibilityResult | null {
  if (jobRunsOnThisDevice(config)) return null;
  const allowed = (config.devices ?? []).map((d) => normalizeHost(d));
  const allowedLabel = allowed.join(', ');
  const firstHost = routineOwnerDevice(config) ?? allowed[0] ?? 'HOST';
  const message = `Job '${config.name}' can only run on: ${allowedLabel}`;
  const suggestion = `agents routines run ${config.name} --device ${firstHost}`;
  return { message, suggestion, allowedLabel, firstHost };
}

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

type RoutineReadResult =
  | { config: JobConfig; problem: null }
  | { config: null; problem: string };

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

  if (Object.prototype.hasOwnProperty.call(parsed, 'device')) {
    return { config: null, problem: 'legacy `device:` key — inert until migrated to `devices:`' };
  }

  if (Object.prototype.hasOwnProperty.call(parsed, 'devices')
      && parsed.devices !== undefined
      && parsed.devices !== null
      && !Array.isArray(parsed.devices)) {
    return { config: null, problem: '`devices:` must be a list — routine is inert' };
  }

  if (Object.prototype.hasOwnProperty.call(parsed, 'dispatchedBy')) {
    return { config: null, problem: '`dispatchedBy:` is a runtime-only monitor/webhook marker, not a routine field — routine is inert' };
  }

  return {
    config: {
      ...JOB_DEFAULTS,
      ...parsed,
      name: parsed.name || path.basename(filePath).replace(/\.ya?ml$/, ''),
      enabled: Object.prototype.hasOwnProperty.call(parsed, 'enabled') ? parsed.enabled !== false : false,
    } as JobConfig,
    problem: null,
  };
}

function readJobFile(filePath: string): JobConfig | null {
  return readJobFileResult(filePath).config;
}

export function writeJob(config: JobConfig): void {
  ensureAgentsDir();
  if (!config.actor) config.actor = resolveActor().id;
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
  delete output.dispatchedBy;
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

export function serializeJob(output: Record<string, unknown>, existingText: string | null): string {
  if (existingText == null) return yaml.stringify(output);

  const doc = yaml.parseDocument(existingText);
  if (doc.errors.length > 0 || !yaml.isMap(doc.contents)) return yaml.stringify(output);

  const existing = (doc.toJS() ?? {}) as Record<string, unknown>;

  for (const [key, value] of Object.entries(output)) {
    if (JSON.stringify(existing[key]) !== JSON.stringify(value)) doc.set(key, value);
  }
  for (const key of Object.keys(existing)) {
    if (!(key in output)) doc.delete(key);
  }

  return doc.toString({ flowCollectionPadding: false });
}

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

export function setJobEnabled(name: string, enabled: boolean): void {
  const job = readJob(name);
  if (!job) throw new Error(`Job '${name}' not found`);
  const legacyEnabled = enabledRoutineNames() === null
    ? listJobs().filter((candidate) => candidate.enabled && jobRunsOnThisDevice(candidate)).map((candidate) => candidate.name)
    : [];
  setRoutineEnabledOnThisDevice(name, enabled, legacyEnabled);
}

export function migrateLegacyRoutineActivation(): boolean {
  if (enabledRoutineNames() !== null) return false;
  const jobs = listJobs();
  if (!jobs.some((job) => job.enabled || Array.isArray(job.devices))) return false;
  replaceEnabledRoutines(
    jobs.filter((job) => job.enabled && jobRunsOnThisDevice(job)).map((job) => job.name),
  );
  return true;
}

export function validateJob(config: Partial<JobConfig>): string[] {
  const errors: string[] = [];

  if (!config.name || typeof config.name !== 'string') {
    errors.push('name is required');
  } else if (!isSafeSegmentName(config.name)) {
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
    !isCustomHarnessName(config.agent)
  ) {
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
  if (config.host === 'auto' && strategy !== 'fleet') {
    errors.push("host: auto requires hostStrategy: fleet (set via --run-on auto) — 'auto' is a fire-time device pick, not a machine name");
  }
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

export function substituteWebhookPrompt(prompt: string, context: WebhookContext): string {
  return prompt.replace(/\{\{([^{}]+)\}\}/g, (_, rawPath: string) => {
    const value = getPath(context, rawPath.trim());
    if (value === undefined || value === null) return '';
    return String(value);
  });
}

export function substituteWebhookCommand(command: string, context: WebhookContext): string {

  return command.replace(/\{\{([^{}]+)\}\}/g, (_, rawPath: string) => {
    const value = getPath(context, rawPath.trim());
    if (value === undefined || value === null) return "''";
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
  });
}

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

export function resolveJobPrompt(config: JobConfig, context?: WebhookContext): string {
  const now = new Date();
  const tz = config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  const localDayName = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(now);
  const localDay = days.includes(localDayName) ? localDayName : days[now.getDay()];
  const localDate = now.toLocaleDateString('en-CA', { timeZone: tz });
  const localTime = now.toLocaleTimeString('en-GB', { timeZone: tz, hour12: false });

  let prompt = config.prompt;

  prompt = prompt.replace(/\{day\}/g, localDay);
  prompt = prompt.replace(/\{date\}/g, localDate);
  prompt = prompt.replace(/\{time\}/g, localTime);
  prompt = prompt.replace(/\{job_name\}/g, config.name);

  if (config.variables) {
    for (const [key, value] of Object.entries(config.variables)) {
      prompt = prompt.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }
  }

  if (context) {
    prompt = substituteWebhookPrompt(prompt, context);
  }

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

export function parseTimeout(timeout: string): number | null {
  const match = timeout.match(/^(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/);
  if (!match) return null;

  const weeks = parseInt(match[1] || '0', 10);
  const days = parseInt(match[2] || '0', 10);
  const hours = parseInt(match[3] || '0', 10);
  const minutes = parseInt(match[4] || '0', 10);

  const ms = ((weeks * 7 + days) * 24 * 60 + hours * 60 + minutes) * 60 * 1000;
  if (ms <= 0) return null;

  const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  if (ms > ONE_WEEK_MS) return null;

  return ms;
}

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

export function getLatestRun(jobName: string): RunMeta | null {
  const runs = listRuns(jobName);
  return runs.length > 0 ? runs[runs.length - 1] : null;
}

export function getLatestCompletedRun(jobName: string): RunMeta | null {
  const runs = listRuns(jobName);
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i].status === 'completed') return runs[i];
  }
  return null;
}

interface RoutineStats {
  count: number;
  failed: number;
  missed: number;
  avgMs: number;
  p50: number;
  p95: number;
}

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

export function writeRunMeta(meta: RunMeta): void {
  ensureAgentsDir();
  const runDir = path.join(getJobRunsDir(meta.jobName), meta.runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
}

export function readRunMeta(jobName: string, runId: string): RunMeta | null {
  const metaPath = path.join(getJobRunsDir(jobName), runId, 'meta.json');
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as RunMeta;
  } catch {
    return null;
  }
}

export function getJobRunsDir(jobName: string): string {
  return safeJoin(getRunsDir(), jobName);
}

export function getRunDir(jobName: string, runId: string): string {
  return path.join(getJobRunsDir(jobName), runId);
}

export function slotRunId(scheduledFor: Date | string): string {
  const iso = typeof scheduledFor === 'string' ? scheduledFor : scheduledFor.toISOString();
  return iso.replace(/[:.]/g, '-');
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SLOT_LOOKBACK_WINDOWS_MS = [HOUR_MS, DAY_MS, 7 * DAY_MS, 32 * DAY_MS, 93 * DAY_MS, 400 * DAY_MS];

export function alignedSlotForFire(cron: Cron, at: Date): Date | null {

  for (const window of SLOT_LOOKBACK_WINDOWS_MS) {
    let cursor: Date = new Date(at.getTime() - window);
    let last: Date | null = null;
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

export function claimRunSlot(jobName: string, runId: string): boolean {

  const runDir = getRunDir(jobName, runId);
  fs.mkdirSync(path.dirname(runDir), { recursive: true });
  try {
    fs.mkdirSync(runDir);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

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

export function jobExists(name: string): boolean {
  return readJob(name) !== null;
}

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

export function resolveJobFilePath(name: string): string | null {
  const userPath = getJobPath(name);
  if (userPath) return userPath;
  for (const ext of ['.yml', '.yaml']) {
    const filePath = safeJoin(getSystemRoutinesDir(), name + ext);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

export function parseAtTime(atTime: string): { schedule: string; runOnce: boolean } | null {
  const timeMatch = atTime.match(/^(\d{1,2}):(\d{2})$/);
  if (timeMatch) {
    const hour = parseInt(timeMatch[1], 10);
    const minute = parseInt(timeMatch[2], 10);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

    const now = new Date();
    let targetDate = new Date();
    targetDate.setHours(hour, minute, 0, 0);

    if (targetDate <= now) {
      targetDate.setDate(targetDate.getDate() + 1);
    }

    const day = targetDate.getDate();
    const month = targetDate.getMonth() + 1;
    return { schedule: `${minute} ${hour} ${day} ${month} *`, runOnce: true };
  }

  const dateTimeMatch = atTime.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (dateTimeMatch) {
    const year = parseInt(dateTimeMatch[1], 10);
    const month = parseInt(dateTimeMatch[2], 10);
    const day = parseInt(dateTimeMatch[3], 10);
    const hour = parseInt(dateTimeMatch[4], 10);
    const minute = parseInt(dateTimeMatch[5], 10);

    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

    return { schedule: `${minute} ${hour} ${day} ${month} *`, runOnce: true };
  }

  return null;
}

export function listJobsWithRuns(): string[] {
  const runsDir = getRunsDir();
  if (!fs.existsSync(runsDir)) return [];
  return fs.readdirSync(runsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

export function countAllRuns(): number {
  let total = 0;
  for (const jobName of listJobsWithRuns()) {
    total += listRuns(jobName).length;
  }
  return total;
}

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
      } catch {  }
    }
  }
  return size;
}
