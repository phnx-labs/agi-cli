
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

import {
  isDaemonRunning,
  signalDaemonReload,
  startDaemon,
  readDaemonPid,
  readDaemonLog,
  getDaemonStatus,
  getDaemonLogPath,
  RedirectedHomeDaemonError,
} from '../lib/daemon/daemon.js';
import { isDaemonServiceEnabled, setDaemonServiceEnabled } from '../lib/daemon-services.js';
import {
  assertSchedulerEnabled,
  assertDaemonEnabled,
  isDaemonEnabled,
  isSchedulerEnabled,
} from '../lib/device-config.js';
import { resolveAgentName, parseAgentVersionSpec, isAgentHardDeprecated, hardDeprecationError, ROUTINE_AGENT_IDS } from '../lib/agents.js';
import { isCustomHarnessName } from '../lib/profiles.js';
import { RUN_STRATEGIES, normalizeRunStrategy } from '../lib/accounting/rotate.js';
import type { AgentId, RunStrategy } from '../lib/types.js';
import { humanizeCron, humanizeNextRun, formatRepoLink, REPO_DISPLAY_MAX } from '../lib/routines-format.js';
import {
  listJobs as listAllJobs,
  deleteJob,
  readJob,
  validateJob,
  writeJob,
  setJobEnabled,
  listRuns,
  routineStats,
  getLatestRun,
  getRunDir,
  getJobPath,
  isCanonicalRoutineSource,
  parseAtTime,
  hasCompletedOneShotRun,
  isOneShotLikeSchedule,
  isOneShotRoutine,
  isPastOneShotRoutine,
  jobRunsOnThisDevice,
  checkJobDeviceEligibility,
  normalizeTriggerEvent,
  parseHostStrategy,
  resolveHostStrategy,
  HOST_STRATEGIES,
  computeProjectGroup,
  computeProjectGroupKind,
  projectGroupKey,
  projectGroupTitle,
  projectGroupOrder,
  normalizeProjects,
  buildRoutineListJson,
  buildRoutineStatusRows,
  fireConditionLabel,
  nextRunForDisplay,
  nextRunLabel,
  localLatestRun,
  listJobsForDisplay,
} from '../lib/scheduling/routines.js';
export { buildRoutineListJson } from '../lib/scheduling/routines.js';
import type { JobConfig, JobTrigger, LinearTriggerEvent, RunMeta, HostStrategy } from '../lib/scheduling/routines.js';
import { listProjectDefs, isSafeProjectName } from '../lib/projects.js';
import { evaluateActivationReadinessLive } from '../lib/routine-readiness.js';
import {
  discoverProjectRoutines,
  findProjectRoutine,
  materialiseProjectRoutine,
  syncProjectRoutines,
  syncAllProjectRoutines,
  resolveProjectRoot,
  displayProjectPath,
  listProjectRoutineFiles,
  type DiscoveredProjectRoutine,
} from '../lib/routines-project.js';
import { fireWebhookJobs, matchJobsToWebhook, type IncomingWebhook, type WebhookSource } from '../lib/triggers/webhook.js';
import { getRoutinesDir } from '../lib/state.js';
import { IS_WINDOWS } from '../lib/platform/index.js';
import { safeJoin } from '../lib/paths.js';
import { executeJob, executeJobDetached, monitorRunningJobs } from '../lib/daemon/runner.js';
import { JobScheduler } from '../lib/scheduler.js';
import { detectOverdueJobs } from '../lib/overdue.js';
import { runCatchup } from '../lib/catchup.js';
import { isInteractiveTerminal, requireInteractiveSelection } from './utils.js';
import { itemPicker } from '../lib/picker.js';
import { Separator } from '@inquirer/core';
import { setHelpSections } from '../lib/help.js';
import { loadDevices, loadDevicesSync } from '../lib/devices/registry.js';
import type { DeviceRegistry } from '../lib/devices/registry.js';
import { machineId, normalizeHost } from '../lib/machine-id.js';
import { addHostOption } from '../lib/hosts/option.js';
import { devicesWithRoutineEnabled } from '../lib/routine-activation.js';
import { spawnSync } from 'node:child_process';
import { getCliLaunch } from '../lib/cli-entry.js';

export function formatRunDuration(startedAt: string, completedAt: string | null): string {
  if (!completedAt) return '';
  const ms = Date.parse(completedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `  · ${sec} sec`;
  const min = Math.round(sec / 60);
  if (min < 60) return `  · ${min} min`;
  const hr = Math.floor(min / 60);
  const rem = min % 60;
  return rem ? `  · ${hr} hr ${rem} min` : `  · ${hr} hr`;
}

function scheduleLabel(job: JobConfig): string {
  let label = fireConditionLabel(job);
  if (isOneShotRoutine(job)) label = `${label} (one-shot)`;
  if (job.endAt) {
    const end = new Date(job.endAt);
    const endLabel = Number.isFinite(end.getTime())
      ? end.toLocaleDateString()
      : job.endAt;
    label = `${label} (until ${endLabel})`;
  }
  return label;
}


function deviceStateLabel(name: string, registry: DeviceRegistry): string | null {
  const profile = registry[normalizeHost(name)] ?? registry[name];
  if (!profile) return 'unknown';
  if (profile.reachability?.reachable === false) return 'offline';
  if (profile.reachability?.reachable === true) return 'online';
  if (profile.tailscale?.online === false) return 'offline';
  if (profile.tailscale?.online === true) return 'online';
  return 'unknown';
}

function titleWithDeviceState(title: string, name: string, registry: DeviceRegistry): string {
  const state = deviceStateLabel(name, registry);
  return state && state !== 'online' ? `${title} (${state})` : title;
}

function placementTag(job: JobConfig): string {
  const strategy = resolveHostStrategy(job);
  if (strategy === 'local') return job.host ? `->${job.host}` : '';
  if (strategy === 'host') return `->${job.host ?? '?'}`;
  if (strategy === 'fleet') return '->fleet';
  return '->cloud';
}

function deviceLabel(job: JobConfig, width?: number): { raw: string; display: string; dim: boolean } {
  const full = [devicesWithRoutineEnabled(job.name).join(','), placementTag(job)]
    .filter(Boolean)
    .join(' ');
  const raw = full.length === 0 ? 'all' : full;
  const display = width && raw.length > width
    ? raw.slice(0, width - 1) + '…'
    : raw;
  return { raw, display, dim: full.length === 0 || !jobRunsOnThisDevice(job) };
}


interface RoutineListGroup {
  key: string;
  title: string;
  jobs: JobConfig[];
  local: boolean;
}

function groupRoutineJobsByDevice(
  jobs: JobConfig[],
  registry: DeviceRegistry,
  self: string = machineId(),
): RoutineListGroup[] {
  const groups = new Map<string, RoutineListGroup>();
  const add = (key: string, title: string, job: JobConfig): void => {
    const existing = groups.get(key);
    if (existing) {
      existing.jobs.push(job);
      return;
    }
    groups.set(key, { key, title, jobs: [job], local: !key.startsWith('device:') });
  };

  for (const job of jobs) {
    const strategy = resolveHostStrategy(job);
    if (strategy === 'cloud') {
      add('cloud', 'Cloud', job);
      continue;
    }
    if (strategy === 'fleet') {
      add('fleet', 'Fleet-wide', job);
      continue;
    }
    if (strategy === 'host') {
      const host = job.host ?? 'unknown-host';
      add(`host:${normalizeHost(host)}`, titleWithDeviceState(`Host: ${host}`, host, registry), job);
      continue;
    }

    const devices = devicesWithRoutineEnabled(job.name);
    if (devices.length === 0) {
      add('disabled', 'Disabled', job);
      continue;
    }
    for (const device of devices) {
      const normalized = normalizeHost(device);
      if (normalized === self) {
        add('this-machine', `This machine (${self})`, job);
      } else {
        add(`device:${normalized}`, titleWithDeviceState(`Device: ${normalized}`, normalized, registry), job);
      }
    }
  }

  const order = (group: RoutineListGroup): number => {
    if (group.key === 'this-machine') return 0;
    if (group.key === 'fleet') return 1;
    if (group.key === 'disabled') return 2;
    if (group.key === 'cloud') return 3;
    if (group.key.startsWith('device:')) return 4;
    if (group.key.startsWith('host:')) return 5;
    return 5;
  };
  return [...groups.values()].sort((a, b) => order(a) - order(b) || a.title.localeCompare(b.title));
}

export function groupRoutineJobsByProject(
  jobs: JobConfig[],
  knownProjectNames: Set<string>,
): RoutineListGroup[] {
  const groups = new Map<string, RoutineListGroup>();
  const add = (key: string, title: string, job: JobConfig): void => {
    const existing = groups.get(key);
    if (existing) {
      existing.jobs.push(job);
      return;
    }
    groups.set(key, { key, title, jobs: [job], local: true });
  };

  const orderByKey = new Map<string, number>();
  for (const job of jobs) {
    const group = computeProjectGroupKind(job.projects, knownProjectNames);
    const key = projectGroupKey(group);
    orderByKey.set(key, projectGroupOrder(group));
    add(key, projectGroupTitle(group), job);
  }

  const order = (group: RoutineListGroup): number => orderByKey.get(group.key) ?? 0;
  return [...groups.values()].sort((a, b) => order(a) - order(b) || a.title.localeCompare(b.title));
}

function collectProject(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

interface RenderRowsOptions {
  jobs: JobConfig[];
  scheduler: JobScheduler;
  overdueSet: Set<string>;
  link: (label: string, url: string | null) => string;
  now: Date;
  local?: boolean;
}

function renderRoutineRows({ jobs, scheduler, overdueSet, link, now, local = true }: RenderRowsOptions): void {
  const NAME_W = 24;
  const AGENT_W = 10;
  const REPO_W = REPO_DISPLAY_MAX;
  const DEVICE_W = 22;
  const SCHED_W = 34;
  const ENABLED_W = 10;
  const NEXT_W = 22;

  const header =
    `  ${'Name'.padEnd(NAME_W)} ${'Agent'.padEnd(AGENT_W)} ${'Repo'.padEnd(REPO_W)} ${'Devices'.padEnd(DEVICE_W)} ${'Schedule'.padEnd(SCHED_W)} ${'Enabled'.padEnd(ENABLED_W)} ${'Next Run'.padEnd(NEXT_W)} Last Status`;
  console.log(chalk.gray(header));
  console.log(chalk.gray('  ' + '-'.repeat(NAME_W + AGENT_W + REPO_W + DEVICE_W + SCHED_W + ENABLED_W + NEXT_W + 20)));

  for (const job of jobs) {
    const nextStr = nextRunLabel(job, scheduler, now);
    const schedStr = scheduleLabel(job);
    const latestRun = local ? localLatestRun(job) : null;
    const lastStatus = latestRun?.status || '-';

    const sourceRepo = job.source?.repo ?? job.repo;
    const sourceLabel = sourceRepo
      ? (job.source?.branch ? `${sourceRepo}@${job.source.branch}` : sourceRepo)
      : null;
    const repoInfo = formatRepoLink(sourceLabel ?? job.repo);
    const repoCell = link(repoInfo.display, repoInfo.href);
    const repoPadding = Math.max(0, REPO_W - repoInfo.display.length);

    const enabledStr = job.enabled ? chalk.green('yes') : chalk.gray('no');
    const enabledWord = job.enabled ? 'yes' : 'no';
    const enabledPad = Math.max(0, ENABLED_W - enabledWord.length);

    const device = deviceLabel(job, DEVICE_W);
    const deviceCell = device.dim ? chalk.gray(device.display) : device.display;
    const devicePad = Math.max(0, DEVICE_W - device.display.length);

    const statusColor =
      lastStatus === 'completed' ? chalk.green
      : lastStatus === 'failed' ? chalk.red
      : lastStatus === 'timeout' ? chalk.yellow
      : lastStatus === 'missed' ? chalk.magenta
      : chalk.gray;

    const overdueTag = overdueSet.has(job.name) ? chalk.yellow(' (overdue)') : '';

    const reason = latestRun ? runFailureReason(latestRun) : null;
    const reasonTag = reason ? chalk.gray(` — ${reason}`) : '';

    const agentLabelPadded = job.command
      ? chalk.magenta('command'.padEnd(10))
      : job.workflow
        ? chalk.magenta(`wf:${job.workflow}`.padEnd(10))
        : (job.agent || '').padEnd(10);
    console.log(
      `  ${chalk.cyan(job.name.padEnd(NAME_W))} ${agentLabelPadded} ${repoCell}${' '.repeat(repoPadding)} ${deviceCell}${' '.repeat(devicePad)} ${schedStr.padEnd(SCHED_W)} ${enabledStr}${' '.repeat(enabledPad)} ${chalk.gray(nextStr.padEnd(NEXT_W))} ${statusColor(lastStatus)}${overdueTag}${reasonTag}`
    );
  }
}

function parseRoutineTrigger(options: Record<string, unknown>): JobTrigger | undefined {
  const raw = typeof options.on === 'string' ? options.on : undefined;
  if (!raw) return undefined;
  const [sourceMaybe, eventMaybe] = raw.includes(':') ? raw.split(':', 2) : ['github', raw];
  if (sourceMaybe === 'github') {
    const event = normalizeTriggerEvent(eventMaybe);
    if (!event) throw new Error(`Unknown GitHub trigger event '${eventMaybe}'`);
    const trigger: JobTrigger = { type: 'github_event', event };
    if (typeof options.repo === 'string') trigger.repo = options.repo;
    if (typeof options.branch === 'string') trigger.branch = options.branch;
    if (typeof options.action === 'string') trigger.action = options.action;
    if (typeof options.label === 'string') trigger.label = options.label;
    return trigger;
  }
  if (sourceMaybe === 'linear') {
    const trigger: JobTrigger = { type: 'linear_event', event: eventMaybe as LinearTriggerEvent };
    if (typeof options.action === 'string') trigger.action = options.action;
    if (typeof options.teamKey === 'string') trigger.teamKey = options.teamKey;
    if (typeof options.label === 'string') trigger.label = options.label;
    if (typeof options.stateTo === 'string') trigger.stateTo = options.stateTo;
    if (typeof options.stateFrom === 'string') trigger.stateFrom = options.stateFrom;
    return trigger;
  }
  throw new Error('--on source must be github or linear');
}

function ensureSchedulerRunning(opts: { quiet?: boolean; stderr?: boolean } = {}): void {
  const log = opts.stderr ? console.error : console.log;
  try {
    assertDaemonEnabled();
    assertSchedulerEnabled();
  } catch (err) {
    console.error(chalk.yellow((err as Error).message));
    return;
  }
  const wasServiceEnabled = isDaemonServiceEnabled('scheduler');
  if (!wasServiceEnabled) setDaemonServiceEnabled('scheduler', true);
  if (isDaemonRunning()) {
    const reloaded = signalDaemonReload();
    if (!reloaded) {
      console.error(chalk.yellow(
        'Scheduler service enabled, but live reload is unavailable. Restart deliberately with: agents daemon restart',
      ));
    } else if (!opts.quiet) {
      log(chalk.gray(wasServiceEnabled ? 'Scheduler reloaded' : 'Scheduler service enabled and reloaded'));
    }
    return;
  }
  let result: { pid: number | null; method: string };
  try {
    result = startDaemon();
  } catch (err) {
    if (err instanceof RedirectedHomeDaemonError) {
      if (!opts.quiet) log(chalk.yellow((err as Error).message));
      return;
    }
    throw err;
  }
  if (opts.quiet) return;
  if (result.pid) {
    log(chalk.green(`Scheduler started (PID: ${result.pid}). It will run in the background and fire routines on schedule.`));
    log(chalk.gray(`Stop anytime with: agents routines stop`));
  } else {
    log(chalk.yellow('Could not start the scheduler. Start it manually with: agents routines start'));
  }
}

function writeJson(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function printSyncResult(sync: {
  projectRoot: string;
  synced: string[];
  skipped: Array<{ name: string; reason: string }>;
  removed: string[];
  errors: Array<{ name: string; error: string }>;
}): void {
  console.log(chalk.bold(displayProjectPath(sync.projectRoot)));
  if (sync.synced.length === 0 && sync.skipped.length === 0 && sync.removed.length === 0 && sync.errors.length === 0) {
    console.log(chalk.gray('  (no project routines)'));
  }
  if (sync.synced.length > 0) {
    console.log(chalk.green(`  synced: ${sync.synced.join(', ')}`));
  }
  if (sync.removed.length > 0) {
    console.log(chalk.gray(`  removed: ${sync.removed.join(', ')}`));
  }
  for (const s of sync.skipped) {
    console.log(chalk.yellow(`  skipped ${s.name}: ${s.reason}`));
  }
  for (const e of sync.errors) {
    console.log(chalk.red(`  error ${e.name}: ${e.error}`));
  }
}

function runMetaJson(run: RunMeta): Record<string, unknown> {
  return {
    jobId: run.jobName,
    jobName: run.jobName,
    runId: run.runId,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    exitCode: run.exitCode,
    errorMessage: run.errorMessage ?? null,
    duration: run.duration ?? null,
  };
}

export function buildRunsJson(runs: RunMeta[]): Record<string, unknown>[] {
  return runs.map(runMetaJson);
}


function isPromptCancelled(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.message.includes('User force closed') ||
      err.name === 'ExitPromptError' ||
      (err as any).code === 'ERR_USE_AFTER_CLOSE')
  );
}

async function pickJob(
  message: string,
  filter?: (job: JobConfig) => boolean,
  alternatives: string[] = [],
  cwd?: string,
): Promise<string | null> {
  let jobs = listAllJobs(cwd);
  if (filter) {
    jobs = jobs.filter(filter);
  }

  if (jobs.length === 0) {
    console.log(chalk.yellow('No jobs available'));
    return null;
  }

  if (!isInteractiveTerminal()) {
    requireInteractiveSelection(message.replace(/:$/, ''), alternatives);
  }

  try {
    const { select } = await import('@inquirer/prompts');
    return await select({
      message,
      choices: jobs.map((job) => ({
        value: job.name,
        name: `${job.name} ${chalk.gray(`(${job.command ? 'command' : job.workflow ? `wf:${job.workflow}` : job.agent}, ${job.schedule ?? fireConditionLabel(job)})`)}`,
      })),
    });
  } catch (err) {
    if (isPromptCancelled(err)) {
      console.log(chalk.gray('Cancelled'));
      return null;
    }
    throw err;
  }
}

async function enableRoutineAction(name: string | undefined): Promise<void> {
  // Project YAML is untrusted and display-only until this explicit materialize/
  // enable action re-runs readiness in the trusted user store.
  if (!name) {
    name = await pickJob('Select routine to enable', (job) => !job.enabled, ['agents routines enable <name>']) ?? undefined;
    if (!name) {
      const available = discoverProjectRoutines();
      if (available.length > 0) {
        console.log(chalk.gray(`Project routines available to enable: ${available.map((r) => r.name).join(', ')}`));
        console.log(chalk.gray('  Enable one by name: agents routines enable <name>'));
      }
      return;
    }
  }

  try {
    if (!readJob(name)) {
      const found = findProjectRoutine(name);
      if (!found) {
        console.log(chalk.red(`No routine named '${name}'.`));
        const available = discoverProjectRoutines();
        if (available.length > 0) {
          console.log(chalk.gray(`  Available project routines: ${available.map((r) => r.name).join(', ')}`));
        }
        process.exit(1);
      }
      if ('ambiguous' in found) {
        console.log(chalk.red(`'${name}' is defined in more than one project: ${found.ambiguous.join(', ')}.`));
        console.log(chalk.gray('  Enable it from inside the project you want, or rename one.'));
        process.exit(1);
      }
      const mat = materialiseProjectRoutine(found.projectRoot, name);
      if ('error' in mat) {
        console.log(chalk.red(`Cannot enable '${name}': ${mat.error}`));
        process.exit(1);
      }
      console.log(chalk.gray(`Materialised '${name}' from ${displayProjectPath(found.projectRoot)}`));
    }

    const job = readJob(name);
    if (job) {
      const readiness = await evaluateActivationReadinessLive(job);
      if (!readiness.ready) {
        const r = readiness.readiness!;
        console.log(chalk.red(`Cannot enable '${name}' — not ready: ${r.code}`));
        console.log(chalk.gray(`  ${r.message}`));
        if (r.repair) console.log(chalk.gray(`  repair: ${r.repair}`));
        console.log(chalk.gray(`  fix it, then: agents routines doctor ${name} --fix`));
        process.exit(1);
      }
    }
    setJobEnabled(name, true);
    console.log(chalk.green(`Routine '${name}' enabled`));
    if (isDaemonRunning()) {
      signalDaemonReload();
      console.log(chalk.gray('Daemon reloaded'));
    }
  } catch (err) {
    console.log(chalk.red((err as Error).message));
    process.exit(1);
  }
}

async function disableRoutineAction(name: string | undefined): Promise<void> {
  if (!name) {
    name = await pickJob('Select routine to disable', (job) => job.enabled, ['agents routines disable <name>']) ?? undefined;
    if (!name) return;
  }

  try {
    if (!readJob(name)) {
      console.log(chalk.red(`No routine named '${name}'.`));
      process.exit(1);
    }
    setJobEnabled(name, false);
    console.log(chalk.green(`Routine '${name}' disabled`));
    if (isDaemonRunning()) {
      signalDaemonReload();
      console.log(chalk.gray('Scheduler reloaded'));
    }
  } catch (err) {
    console.log(chalk.red((err as Error).message));
    process.exit(1);
  }
}

async function parseAndValidateDevices(raw: string): Promise<string[]> {
  const names = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean).map((s) => normalizeHost(s)))];
  if (names.length === 0) {
    console.log(chalk.red('--devices requires at least one non-empty device name'));
    process.exit(1);
  }
  const registry = await loadDevices();
  const registered = new Set(Object.keys(registry).map((k) => normalizeHost(k)));
  const unknown = names.filter((n) => !registered.has(n));
  if (unknown.length > 0) {
    console.log(chalk.red(`Unknown device(s): ${unknown.join(', ')}`));
    console.log(chalk.gray(`Registered: ${[...registered].sort().join(', ') || '(none)'}`));
    console.log(chalk.gray('Enroll devices with: agents devices sync'));
    process.exit(1);
  }
  return names;
}

interface RoutinesListOptions {
  json?: boolean;
  groupBy?: string;
  flat?: boolean;
}

function runRoutinesList(options: RoutinesListOptions): void {
  if (options.groupBy && options.groupBy !== 'device' && options.groupBy !== 'project') {
    console.error(chalk.red(`Unsupported --group-by '${options.groupBy}'. Use: project (default) or device`));
    process.exit(1);
  }
  if (options.json) {
    process.stdout.write(JSON.stringify(buildRoutineListJson()) + '\n');
    return;
  }
  try { monitorRunningJobs(); } catch {  }
  const jobs = listJobsForDisplay(process.cwd());
  if (jobs.length === 0) {
    console.log(chalk.gray('No jobs configured'));
    console.log(chalk.gray('  Add a job: agents routines add <path-to-job.yml>'));
    return;
  }

  const scheduler = new JobScheduler(async () => {});
  scheduler.loadAll();

  const overdueSet = new Set<string>();
  try {
    for (const j of detectOverdueJobs()) overdueSet.add(j.name);
  } catch {
  }

  console.log(chalk.bold('Scheduled Jobs\n'));

  const link = (label: string, url: string | null): string =>
    url && process.stdout.isTTY ? `\x1b]8;;${url}\x07${label}\x1b]8;;\x07` : label;

  const now = new Date();
  if (options.flat) {
    renderRoutineRows({ jobs, scheduler, overdueSet, link, now });
  } else if (options.groupBy === 'device') {
    let registry: DeviceRegistry = {};
    try {
      registry = loadDevicesSync();
    } catch (err) {
      console.error(chalk.yellow(`Could not read device registry: ${(err as Error).message}`));
    }
    const groups = groupRoutineJobsByDevice(jobs, registry);
    for (const group of groups) {
      console.log(chalk.bold(`\n${group.title}`));
      renderRoutineRows({ jobs: group.jobs, scheduler, overdueSet, link, now, local: group.local });
    }
    if (groups.some((group) => !group.local)) {
      console.log();
      console.log(chalk.gray('  Last Status is per-device: rows under another device show "-" — read it there with: agents routines list --device <name>'));
    }
  } else {
    const knownProjectNames = new Set(listProjectDefs().map((p) => p.name));
    const groups = groupRoutineJobsByProject(jobs, knownProjectNames);
    for (const group of groups) {
      console.log(chalk.bold(`\n${group.title}`));
      renderRoutineRows({ jobs: group.jobs, scheduler, overdueSet, link, now });
    }
  }

  if (overdueSet.size > 0) {
    console.log();
    console.log(chalk.yellow(`  ${overdueSet.size} routine(s) overdue — catch up with: agents routines catchup`));
  }

  scheduler.stopAll();
  console.log();
}

function routineMatchesQuery(job: JobConfig, q: string): boolean {
  const kind = job.command ? 'command' : job.workflow ? `wf:${job.workflow}` : job.agent ?? '';
  return [job.name, kind, fireConditionLabel(job), (job.projects ?? []).join(' ')]
    .join(' ')
    .toLowerCase()
    .includes(q);
}

const SKIP_REASON_LABEL: Record<Exclude<NonNullable<RunMeta['skipReason']>, 'active_run'>, string> = {
  duplicate_slot: 'duplicate slot (already fired)',
  wrong_owner: 'pinned to another device',
};

function runIdToStartIso(runId: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(runId);
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

export function runFailureReason(run: RunMeta): string | null {
  if (run.status === 'completed' || run.status === 'running') return null;
  const compact = (s: string): string => {
    const one = s.replace(/\s+/g, ' ').trim();
    return one.length > 80 ? one.slice(0, 79) + '…' : one;
  };
  if (run.skipReason === 'active_run') {
    if (run.activeRunId) {
      const since = runIdToStartIso(run.activeRunId);
      return since
        ? `blocked: run ${run.activeRunId} active since ${since}`
        : `blocked: run ${run.activeRunId} still active`;
    }
    if (run.errorMessage) return compact(run.errorMessage);
    return 'blocked: a prior run is still active';
  }
  if (run.errorMessage) return compact(run.errorMessage);
  if (run.status === 'blocked' && run.readiness) {
    return compact(run.readiness.message || run.readiness.code);
  }
  if (run.skipReason) return SKIP_REASON_LABEL[run.skipReason];
  if (run.status === 'missed') return 'scheduler was not running when it came due';
  if ((run.status === 'failed' || run.status === 'timeout') && run.exitCode !== null && run.exitCode !== undefined) {
    return `exit ${run.exitCode}`;
  }
  return null;
}

function routineBrowserRow(
  job: JobConfig,
  scheduler: JobScheduler,
  overdueSet: Set<string>,
  now: Date,
): string {
  const kind = job.command ? 'command' : job.workflow ? `wf:${job.workflow}` : job.agent ?? '?';
  const name = job.name.length > 24 ? job.name.slice(0, 23) + '…' : job.name.padEnd(24);
  const enabled = job.enabled === false ? chalk.gray('paused') : chalk.green('on');
  const latest = localLatestRun(job);
  const last = latest
    ? latest.status === 'completed'
      ? chalk.green('ok')
      : latest.status === 'failed' || latest.status === 'timeout'
        ? chalk.red(latest.status)
        : chalk.yellow(latest.status)
    : chalk.gray('—');
  const next = overdueSet.has(job.name)
    ? chalk.yellow('overdue')
    : chalk.gray(nextRunLabel(job, scheduler, now));
  return `${chalk.bold(name)} ${chalk.cyan(kind.padEnd(12))} ${enabled.padEnd(6)} ${chalk.gray(scheduleLabel(job)).padEnd(24)} next ${next} · last ${last}`;
}

function buildRoutineDetail(job: JobConfig, scheduler: JobScheduler, now: Date): string {
  const lines: string[] = [];

  lines.push(chalk.bold.underline('Definition'));
  const kind = job.command
    ? `command: ${job.command}`
    : job.workflow
      ? `workflow: ${job.workflow}`
      : `agent: ${job.agent ?? '?'}`;
  lines.push(`  ${kind}`);
  lines.push(`  schedule: ${fireConditionLabel(job)}${isOneShotRoutine(job) ? ' (one-shot)' : ''}`);
  const devices = devicesWithRoutineEnabled(job.name);
  lines.push(`  devices: ${devices.length > 0 ? devices.join(', ') : chalk.gray('none (paused)')}`);
  if (job.timezone) lines.push(`  timezone: ${job.timezone}`);
  if (job.repo) lines.push(`  repo: ${job.repo}`);
  if (job.prompt) {
    const oneLine = job.prompt.replace(/\s+/g, ' ').trim();
    lines.push(`  prompt: ${oneLine.length > 120 ? oneLine.slice(0, 119) + '…' : oneLine}`);
  }

  lines.push('');
  lines.push(chalk.bold.underline('Next fire'));
  const nextDate = nextRunForDisplay(job, scheduler);
  lines.push(`  ${nextRunLabel(job, scheduler, now)}${nextDate ? chalk.gray(`  (${nextDate.toISOString()})`) : ''}`);

  lines.push('');
  lines.push(chalk.bold.underline('Recent runs'));
  const runs = listRuns(job.name).slice(-5);
  if (runs.length === 0) {
    lines.push(chalk.gray('  no runs yet'));
  } else {
    for (const run of runs) {
      const status = run.status === 'completed'
        ? chalk.green(run.status)
        : run.status === 'failed' || run.status === 'timeout'
          ? chalk.red(run.status)
          : chalk.yellow(run.status);
      const dur = run.completedAt ? ` ${formatRunDuration(run.startedAt, run.completedAt)}` : '';
      const reason = runFailureReason(run);
      const why = reason ? chalk.gray(` — ${reason}`) : '';
      lines.push(`  ${run.startedAt}  ${status}${dur}${why}`);
    }
  }

  lines.push('');
  lines.push(chalk.bold.underline('Stats'));
  const stats = routineStats(job.name);
  if (stats.count === 0) {
    lines.push(chalk.gray('  no completed runs'));
  } else {
    lines.push(`  runs ${stats.count} · failed ${stats.failed} · missed ${stats.missed}`);
    lines.push(`  avg ${stats.avgMs}ms · p50 ${stats.p50}ms · p95 ${stats.p95}ms`);
  }

  return lines.join('\n');
}

async function runRoutinesBrowser(options: RoutinesListOptions): Promise<void> {
  if (options.groupBy && options.groupBy !== 'device' && options.groupBy !== 'project') {
    console.error(chalk.red(`Unsupported --group-by '${options.groupBy}'. Use: project (default) or device`));
    process.exit(1);
  }
  try { monitorRunningJobs(); } catch {  }
  const jobs = listJobsForDisplay(process.cwd());
  if (jobs.length === 0) {
    console.log(chalk.gray('No jobs configured'));
    console.log(chalk.gray('  Add a job: agents routines add <path-to-job.yml>'));
    return;
  }

  const scheduler = new JobScheduler(async () => {});
  scheduler.loadAll();
  try {
    const now = new Date();
    const overdueSet = new Set<string>();
    try {
      for (const j of detectOverdueJobs()) overdueSet.add(j.name);
    } catch {  }

    let groups: RoutineListGroup[];
    if (options.groupBy === 'device') {
      let registry: DeviceRegistry = {};
      try { registry = loadDevicesSync(); } catch {  }
      groups = groupRoutineJobsByDevice(jobs, registry);
    } else {
      const knownProjectNames = new Set(listProjectDefs().map((p) => p.name));
      groups = groupRoutineJobsByProject(jobs, knownProjectNames);
    }

    const filter = (query: string): Array<JobConfig | Separator> => {
      const q = query.trim().toLowerCase();
      const rows: Array<JobConfig | Separator> = [];
      for (const group of groups) {
        const matched = q ? group.jobs.filter((j) => routineMatchesQuery(j, q)) : group.jobs;
        if (matched.length === 0) continue;
        rows.push(new Separator(chalk.bold(`── ${group.title} ──`)));
        rows.push(...matched);
      }
      return rows;
    };

    const picked = await itemPicker<JobConfig>({
      message: 'Routines',
      subtitle: chalk.gray('type to filter · ↑↓ navigate · space toggles detail · ⏎ open'),
      items: filter(''),
      filter,
      labelFor: (job) => routineBrowserRow(job, scheduler, overdueSet, now),
      buildPreview: (job) => buildRoutineDetail(job, scheduler, now),
      shortIdFor: (job) => job.name,
      pageSize: 15,
      enterHint: 'open',
      emptyMessage: 'No routines match.',
    });

    if (picked) {
      console.log();
      console.log(chalk.bold(picked.item.name));
      console.log(buildRoutineDetail(picked.item, scheduler, now));
    }
  } finally {
    scheduler.stopAll();
  }
}

export function registerRoutinesCommands(program: Command): void {
  const routinesCmd = program
    .command('routines')
    .description('Schedule agents to run on a cron schedule or at a specific time. The daemon starts at install/upgrade and on setup when daemon.enabled is not false; routines add also ensures it is running.');

  addHostOption(routinesCmd);

  setHelpSections(routinesCmd, {
    examples: `
      # Cron routine: Claude every weekday at 9 AM (scheduler auto-starts)
      agents routines add daily-standup --schedule "0 9 * * 1-5" --agent claude --prompt "Draft standup from git log"

      # One-shot: Codex tomorrow at 2:30 PM, then never again
      agents routines add hotfix-review --at "14:30" --agent codex --prompt "Review hotfix PR #42"

      # Create from YAML (for complex routines with multiple settings)
      agents routines add weekly-report.yml

      # Place the job body on a fleet device / cloud / named host (not --host)
      agents routines add drain --schedule "0 3 * * *" --agent claude --placement fleet --prompt "Drain queue"
      agents routines add review --schedule "0 9 * * 1" --agent claude --placement cloud --prompt "Review open PRs"

      # Pin an exact installed version (same agent@version syntax as agents run)
      agents routines add version-pin --schedule "*/5 * * * *" --agent claude@2.1.207 --cwd /path/to/repo --prompt "Reply OK"

      # Per-routine selection strategy + health-aware fleet placement at each fire
      agents routines add release-shepherd --schedule "*/5 * * * *" --agent claude --strategy balanced --run-on auto --cwd /path/to/repo --prompt "Own the release through verification"

      # Enable a routine (materialises a project routine on first enable)
      agents routines enable security-sweep
      agents routines disable security-sweep

      # List all routines and their next run times
      agents routines list

      # List routines on a specific device
      agents routines list --device yosemite-s0

      # Create a routine restricted to specific devices
      agents routines add nightly --schedule "0 2 * * *" --agent claude --prompt "Summarize today's commits" --devices yosemite-s0,mac-mini

      # Interactively manage which devices may run a routine
      agents routines devices nightly

      # Run a routine right now in the foreground (ignores schedule)
      agents routines run daily-standup

      # Check whether the scheduler is running
      agents routines status

      # Machine-readable scheduler + per-routine status: owner device, last fire, last error, in-flight run
      agents routines status --json
    `,
    notes: `
      A routine is a YAML file that schedules an agent invocation. It specifies:
        - which agent to run (claude, codex, antigravity, ...)
        - when to run (cron schedule or one-shot time)
        - what task to give the agent (the prompt)
        - execution constraints (mode, effort, timeout)

      The always-on agents daemon starts at install/upgrade and on setup (when
      daemon.enabled is not false). Adding a routine also ensures it is running.
      Manage it with 'agents routines start|stop|status'.

      Version / credit failover (same semantics as 'agents run'):
        - Omit 'version:' to let the configured run strategy (default: balanced)
          pick a healthy install and skip accounts that are out of credits or
          rate-limited. Pin with '--agent claude@2.1.x' (or 'version:' in YAML)
          when you want one install only; '--strategy pinned|available|balanced'
          persists a per-routine selection policy that beats the firing box's
          run.<agent>.strategy config.
        - Three distinct device flags: '--devices a,b' is the scheduler FIRING
          allowlist (which daemons may fire this routine); '--run-on <name|auto>'
          is BODY placement (where the fired job executes — 'auto' re-picks a
          healthy device at each fire); the parent '--device' manages the
          routine DEFINITION on another machine.
        - Foreground 'agents routines run' re-dispatches to the next healthy
          same-agent account when a mid-run rate/usage limit is detected.
        - Detached/daemon fires use the pre-flight pick only (next tick re-selects).
        - Diagnostic lines log which account was picked, which were skipped, and
          each failover hop: look for "[agents] routine <name>:" in the run log.
        - Claude auth: a routine authenticates through the pinned account's own
          on-disk login (the same one 'agents run claude' uses on this device).
          The daemon injects no token; if that account's login has expired the
          run is skipped up front with a re-login hint.
    `,
  });

  routinesCmd
    .command('browse', { isDefault: true, hidden: true })
    .description('Interactive routines browser (the default for a bare `agents routines`)')
    .option('--json', 'Emit machine-readable JSON instead of the browser (matches `routines list --json`)')
    .option('--group-by <field>', 'Group by field: project (default) or device', 'project')
    .option('--flat', 'Print the legacy flat table instead of the interactive browser')
    .action(async (options: RoutinesListOptions) => {
      if (options.json || options.flat || !isInteractiveTerminal()) {
        runRoutinesList(options);
        return;
      }
      await runRoutinesBrowser(options);
    });

  routinesCmd
    .command('list')
    .description('See all scheduled jobs, when they run next, and their last execution status')
    .option('--json', 'Emit machine-readable JSON instead of the table (used by the menu bar helper)')
    .option('--group-by <field>', 'Group output by field: project (default) or device', 'project')
    .option('--flat', 'Print the legacy flat table instead of grouped sections')
    .action((options: RoutinesListOptions) => {
      runRoutinesList(options);
    });

  routinesCmd
    .command('add [nameOrPath]')
    .description('Create a new routine from a YAML file or inline flags. Starts the scheduler automatically if it is not already running.')
    .option('-s, --schedule <cron>', 'Cron schedule in standard format (5 fields: minute hour day month weekday)')
    .option('-a, --agent <agent[@version]>', `Which agent runs this routine: ${ROUTINE_AGENT_IDS.join(', ')}, or a custom harness name (agents harness list). An @version pins that exact installed version (same syntax as agents run), persisted as separate agent + version fields; a custom harness pins its own host version.`)
    .option('--strategy <strategy>', `Version/account selection strategy for this routine: ${RUN_STRATEGIES.join(' | ')}. Overrides run.<agent>.strategy from the firing device's config. Conflicts with an @version pin.`)
    .option('--balanced', 'Shortcut for --strategy balanced.')
    .option('--workflow <name>', 'Run an installed workflow (~/.agents/workflows/<name>) via `agents run`. Mutually exclusive with --agent.')
    .option('--command <sh>', 'Run a plain shell command directly (no agent, no auth, no sandbox) — for deterministic housekeeping routines. Mutually exclusive with --agent and --workflow; --prompt is not used.')
    .option('-p, --prompt <prompt>', 'Task instruction for the agent')
    .option('-m, --mode <mode>', "Execution mode: plan (read-only), edit (can write files), auto (the default; more autonomous than edit, mechanism per-harness — see `agents modes <agent>`), or skip (bypass all permission prompts). 'full' accepted as alias for skip.", 'auto')
    .option('-e, --effort <effort>', 'Reasoning effort: low | medium | high | xhigh | max | auto', 'auto')
    .option('-t, --timeout <timeout>', 'Kill the agent if it runs longer than this (e.g., 10m, 2h, 3d, 1w; max 1w)', '10m')
    .option('--timezone <tz>', 'Interpret schedule in this timezone (e.g., America/Los_Angeles)')
    .option('--devices <names>', 'Fleet allowlist (comma-separated): only listed devices schedule and fire this routine. Omit for unrestricted.')
    .option('--run-on <name|auto>', "BODY placement: execute the job body on this machine over SSH (registered host, device, capability tag, or user@host), or 'auto' to pick a healthy, signed-in, unloaded fleet device AT EACH FIRE — the same picker as agents run --device auto. Sets hostStrategy=host ('auto' sets fleet). Distinct from the parent --device (which manages this DEFINITION on another machine) and from --devices (the scheduler firing allowlist).")
    .option('--placement <strategy>', `BODY placement strategy: ${HOST_STRATEGIES.join('|')} (default: local, or host when --run-on is set). Maps to the shared Placement model (local|device|fleet|cloud). Not the same as --device (which manages routines on a remote machine).`)
    .option('--run-cwd <dir>', 'Working directory on the --run-on host (--remote-cwd is taken by the remote-management passthrough)')
    .option('--at <time>', 'One-shot mode: run once at this time (e.g., "14:30" or "2026-02-24 09:00"), then disable')
    .option('--on <source:event>', 'Webhook trigger instead of/in addition to a schedule: github:pull_request or linear:Issue')
    .option('--repo <owner/name>', 'GitHub repo filter for --on github:<event>')
    .option('--branch <name>', 'GitHub branch filter for --on github:<event>')
    .option('--action <name>', 'Webhook action filter for --on triggers (GitHub: labeled/opened; Linear: update)')
    .option('--team-key <key>', 'Linear team key filter for --on linear:<event> (e.g. RUSH)')
    .option('--label <name>', 'Label filter for --on triggers (GitHub label name or Linear issue label)')
    .option('--state-to <name>', 'Linear current-state filter for --on linear:<event> (e.g. Plan)')
    .option('--state-from <name>', 'Linear previous-state filter for --on linear:<event> (e.g. Triage)')
    .option('--end-at <iso>', 'Stop firing on or after this ISO 8601 timestamp (e.g., "2026-12-31T23:59:00Z"); routine auto-disables.')
    .option('--no-catchup', 'Do not run this routine late if its fire is missed (daemon down/asleep). The miss is still recorded. For routines whose value expires with their slot, e.g. a 9am brief.')
    .option('--disabled', 'Create the routine but keep it paused (enable later with resume)')
    .option('--resume <sessionId>', 'At fire time, resume this existing session id (via `agents run <agent> --resume`) instead of starting fresh — the actual session reopens with full context and the prompt becomes its next turn. Powers self-scheduled wake-ups (e.g. /hibernate). Requires --agent claude or codex; runs un-sandboxed (the session store lives in the real home, not the job overlay).')
    .option('--project <name>', 'Associate with a named project (repeatable; use --all-projects for all)', collectProject, [] as string[])
    .option('--all-projects', 'Associate this routine with all defined projects (sets projects: ["*"])')
    .option('--project-anchor <name>', 'Singular EXECUTION anchor: the named project whose base directory the run lands in (distinct from --project, which is grouping metadata). Rootless (Linear-imported) projects anchor a relative --cwd at the target home.')
    .option('--cwd <path>', 'Portable execution directory. Relative values resolve under --project-anchor when usable, otherwise under the execution target $HOME. Supersedes --run-cwd/remoteCwd.')
    .option('--json', 'Emit machine-readable JSON with the created routine id and status')
    .action(async (nameOrPath: string | undefined, options) => {
      const hasInlineFlags = options.schedule || options.agent || options.workflow || options.command || options.prompt || options.at || options.on;

      if (hasInlineFlags) {
        if (!nameOrPath) {
          console.error(chalk.red('Job name is required'));
          console.error(chalk.gray('Usage: agents routines add <name> --schedule "..." --agent <agent> --prompt "..."'));
          process.exit(1);
        }

        if ([options.agent, options.workflow, options.command].filter(Boolean).length > 1) {
          console.error(chalk.red('--agent, --workflow, and --command are mutually exclusive; specify exactly one'));
          process.exit(1);
        }

        let schedule = options.schedule;
        let trigger: JobTrigger | undefined;
        let runOnce = false;
        try {
          trigger = parseRoutineTrigger(options);
        } catch (err) {
          console.error(chalk.red((err as Error).message));
          process.exit(1);
        }

        if (options.at) {
          const parsed = parseAtTime(options.at);
          if (!parsed) {
            console.error(chalk.red(`Invalid --at format: ${options.at}`));
            console.error(chalk.gray('Supported formats: "14:30" or "2026-02-24 09:00"'));
            process.exit(1);
          }
          schedule = parsed.schedule;
          runOnce = parsed.runOnce;
        }
        if (!options.at && isOneShotLikeSchedule(schedule)) {
          runOnce = true;
          console.error(chalk.yellow(
            `Schedule "${schedule}" pins minute, hour, day, and month; treating it as one-shot. Prefer --at for one-time routines.`,
          ));
        }

        if (!schedule && !trigger) {
          console.error(chalk.red('Schedule or trigger is required (use --schedule, --at, or --on)'));
          process.exit(1);
        }

        if (!options.agent && !options.workflow && !options.command) {
          console.error(chalk.red('An agent, workflow, or command is required (use --agent, --workflow, or --command)'));
          process.exit(1);
        }

        let parsedAgent: { agent: AgentId | (string & {}); version?: string } | undefined;
        if (options.agent) {
          if (isCustomHarnessName(options.agent)) {
            parsedAgent = { agent: options.agent };
          } else {
            const parsed = parseAgentVersionSpec(options.agent);
            if ('error' in parsed) {
              console.error(chalk.red(parsed.error));
              process.exit(1);
            }
            parsedAgent = parsed;
            if (isAgentHardDeprecated(parsed.agent)) {
              console.error(chalk.red(hardDeprecationError(parsed.agent)));
              process.exit(1);
            }
          }
        }

        let strategy: RunStrategy | undefined;
        if (options.strategy !== undefined || options.balanced) {
          if (options.strategy !== undefined && options.balanced) {
            console.error(chalk.red('--balanced conflicts with --strategy. Use one strategy override.'));
            process.exit(1);
          }
          if (!options.agent) {
            console.error(chalk.red('--strategy only applies to agent routines (set --agent)'));
            process.exit(1);
          }
          if (options.strategy !== undefined) {
            const normalized = normalizeRunStrategy(options.strategy);
            if (!normalized) {
              console.error(chalk.red(`Invalid strategy: ${options.strategy}. Use ${RUN_STRATEGIES.join(', ')}.`));
              process.exit(1);
            }
            strategy = normalized;
          } else {
            strategy = 'balanced';
          }
          if (parsedAgent?.version) {
            console.error(chalk.red(`--strategy ${strategy} conflicts with the @${parsedAgent.version} pin — an exact pin leaves nothing to select; drop --strategy or the @version pin`));
            process.exit(1);
          }
        }

        if (!options.command && !options.prompt) {
          console.error(chalk.red('Prompt is required (use --prompt)'));
          process.exit(1);
        }

        let devices: string[] | undefined;
        if (options.devices !== undefined) {
          devices = await parseAndValidateDevices(options.devices);
        }

        let projects: string[] | undefined;
        if (options.allProjects) {
          if (options.project && options.project.length > 0) {
            console.error(chalk.red('--all-projects and --project are mutually exclusive'));
            process.exit(1);
          }
          projects = ['*'];
        } else if (options.project && options.project.length > 0) {
          for (const name of options.project as string[]) {
            if (!isSafeProjectName(name)) {
              console.error(chalk.red(`Invalid project name "${name}": must start with a letter or digit, contain only letters, digits, dots, hyphens, or underscores`));
              process.exit(1);
            }
          }
          const deduped = normalizeProjects(options.project as string[]) ?? [];
          const knownProjectNames = new Set(listProjectDefs().map((p) => p.name));
          const unknown = deduped.filter((n: string) => !knownProjectNames.has(n));
          if (unknown.length > 0) {
            console.error(chalk.red(`Unknown project(s): ${unknown.join(', ')}. Define them first with: agents projects add`));
            process.exit(1);
          }
          projects = deduped;
        }

        let hostStrategy: HostStrategy | undefined;
        try {
          hostStrategy = parseHostStrategy(options.placement) ?? undefined;
        } catch (err) {
          console.error(chalk.red((err as Error).message));
          process.exit(1);
        }
        if (options.runOn && !hostStrategy) hostStrategy = options.runOn === 'auto' ? 'fleet' : 'host';
        if (options.runOn === 'auto' && hostStrategy !== 'fleet') {
          console.error(chalk.red("--run-on auto is fleet placement — drop --placement, or use --placement fleet with it"));
          process.exit(1);
        }
        if (hostStrategy === 'host' && !options.runOn) {
          console.error(chalk.red('--placement host requires --run-on <name>'));
          process.exit(1);
        }

        const config: JobConfig = {
          name: nameOrPath,
          ...(schedule ? { schedule } : {}),
          ...(trigger ? { trigger } : {}),
          ...(parsedAgent ? { agent: parsedAgent.agent } : {}),
          ...(parsedAgent?.version ? { version: parsedAgent.version } : {}),
          ...(strategy ? { strategy } : {}),
          ...(options.workflow ? { workflow: options.workflow } : {}),
          ...(options.command ? { command: options.command } : {}),
          mode: options.mode,
          effort: options.effort,
          timeout: options.timeout,
          enabled: !options.disabled,
          prompt: options.prompt ?? '',
          timezone: options.timezone,
          ...(devices ? { devices } : {}),
          ...(options.runOn ? { host: options.runOn } : {}),
          ...(hostStrategy ? { hostStrategy } : {}),
          ...(options.runCwd ? { remoteCwd: options.runCwd } : {}),
          ...(options.projectAnchor ? { project: options.projectAnchor } : {}),
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(runOnce ? { runOnce: true } : {}),
          ...(options.catchup === false ? { catchup: false } : {}),
          ...(options.endAt ? { endAt: options.endAt } : {}),
          ...(options.resume ? { resume: options.resume } : {}),
          ...(projects ? { projects } : {}),
        };

        const errors = validateJob(config);
        if (errors.length > 0) {
          console.error(chalk.red('Validation errors:'));
          for (const err of errors) {
            console.error(chalk.red(`  - ${err}`));
          }
          process.exit(1);
        }

        writeJob(config);
        const deviceMatch = !devices || devices.map(normalizeHost).includes(normalizeHost(machineId()));
        const readiness = await evaluateActivationReadinessLive(config);
        const activate = config.enabled && deviceMatch && readiness.ready;
        setJobEnabled(config.name, activate);
        if (config.enabled && deviceMatch && !readiness.ready) {
          const r = readiness.readiness!;
          if (!options.json) {
            console.log(chalk.yellow(`Saved paused — not ready to activate: ${r.code}`));
            console.log(chalk.gray(`  ${r.message}`));
            if (r.repair) console.log(chalk.gray(`  repair: ${r.repair}`));
            console.log(chalk.gray(`  then:   agents routines enable ${config.name}`));
          }
        }
        if (options.json) {
          writeJson({
            ok: true,
            added: nameOrPath,
            job: config,
            jobId: config.name,
            name: config.name,
            status: activate ? 'added' : 'added_paused',
            enabled: config.enabled,
            activated: activate,
            ready: readiness.ready,
            ...(readiness.readiness ? { readiness: readiness.readiness } : {}),
            schedule: config.schedule ?? null,
            trigger: config.trigger ?? null,
          });
          ensureSchedulerRunning({ quiet: true });
          return;
        }
        console.log(chalk.green(`Job '${nameOrPath}' added`));
        if (runOnce) {
          console.log(chalk.gray(`One-shot job scheduled for: ${options.at}`));
        }

        ensureSchedulerRunning();
      } else {
        if (!nameOrPath) {
          console.error(chalk.red('File path or job name with flags is required'));
          console.error(chalk.gray('Usage: agents routines add <path-to-job.yml>'));
          console.error(chalk.gray('   or: agents routines add <name> --schedule "..." --agent <agent> --prompt "..."'));
          process.exit(1);
        }

        const resolved = path.resolve(nameOrPath);
        if (!fs.existsSync(resolved)) {
          console.error(chalk.red(`File not found: ${resolved}`));
          process.exit(1);
        }

        const content = fs.readFileSync(resolved, 'utf-8');
        let parsed: any;
        try {
          parsed = yaml.parse(content);
        } catch (err) {
          console.error(chalk.red(`Invalid YAML: ${(err as Error).message}`));
          process.exit(1);
        }

        const name = parsed.name || path.basename(resolved).replace(/\.ya?ml$/, '');
        parsed.name = name;

        const errors = validateJob(parsed);
        if (errors.length > 0) {
          console.error(chalk.red('Validation errors:'));
          for (const err of errors) {
            console.error(chalk.red(`  - ${err}`));
          }
          process.exit(1);
        }

        const config: JobConfig = {
          mode: 'auto',
          effort: 'auto',
          timeout: '10m',
          enabled: true,
          ...parsed,
        } as JobConfig;
        if (isOneShotLikeSchedule(config.schedule)) {
          config.runOnce = true;
          console.error(chalk.yellow(
            `Schedule "${config.schedule}" pins minute, hour, day, and month; treating it as one-shot. Prefer --at for one-time routines.`,
          ));
        }

        if (!isCanonicalRoutineSource(resolved, config.name)) writeJob(config);
        const deviceMatch = !config.devices || config.devices.map(normalizeHost).includes(normalizeHost(machineId()));
        const readiness = await evaluateActivationReadinessLive(config);
        const activate = config.enabled && deviceMatch && readiness.ready;
        setJobEnabled(config.name, activate);
        if (config.devices && config.devices.length > 0 && !options.json) {
          console.log(chalk.yellow(`'devices:' pins activation on this box only — it is not propagated to peers.`));
          console.log(chalk.gray(`  pin the fleet with: agents routines devices ${config.name} --set ${config.devices.join(',')}`));
        }
        if (config.enabled && deviceMatch && !readiness.ready && !options.json) {
          const r = readiness.readiness!;
          console.log(chalk.yellow(`Saved paused — not ready to activate: ${r.code}`));
          console.log(chalk.gray(`  ${r.message}`));
          if (r.repair) console.log(chalk.gray(`  repair: ${r.repair}`));
          console.log(chalk.gray(`  then:   agents routines enable ${config.name}`));
        }
        if (options.json) {
          writeJson({
            ok: true,
            added: name,
            job: config,
            jobId: config.name,
            name: config.name,
            status: activate ? 'added' : 'added_paused',
            enabled: config.enabled,
            activated: activate,
            ready: readiness.ready,
            ...(readiness.readiness ? { readiness: readiness.readiness } : {}),
            schedule: config.schedule ?? null,
            trigger: config.trigger ?? null,
          });
          ensureSchedulerRunning({ quiet: true });
          return;
        }
        console.log(chalk.green(`Job '${name}' added`));

        ensureSchedulerRunning();
      }
    });

  routinesCmd
    .command('prune')
    .alias('cleanup')
    .description('Remove expired one-shot routines that already fired and still have a user-layer YAML file.')
    .option('--dry-run', 'Show routines that would be removed without deleting files')
    .action((options: { dryRun?: boolean }) => {
      const jobs = listAllJobs()
        .filter((job) => getJobPath(job.name) !== null)
        .filter((job) => hasCompletedOneShotRun(job));

      if (jobs.length === 0) {
        console.log(chalk.gray('No completed expired one-shot routines to clean up.'));
        return;
      }

      if (options.dryRun) {
        console.log(chalk.bold('Expired one-shot routines eligible for cleanup\n'));
        for (const job of jobs) {
          console.log(`  ${chalk.cyan(job.name)} ${chalk.gray(scheduleLabel(job))}`);
        }
        console.log(chalk.gray(`\nDry run. Remove with: agents routines prune`));
        return;
      }

      let removed = 0;
      for (const job of jobs) {
        if (deleteJob(job.name)) {
          removed++;
          console.log(chalk.green(`Removed ${job.name}`));
        }
      }
      console.log(chalk.gray(`Cleaned up ${removed} expired one-shot routine(s).`));
      try {
        signalDaemonReload();
      } catch {
      }
    });

  routinesCmd
    .command('remove [name]')
    .description('Delete a routine. Stops scheduling future runs; past execution logs remain on disk.')
    .action(async (name: string | undefined) => {
      if (!name) {
        name = await pickJob('Select job to remove', undefined, ['agents routines remove <name>']) ?? undefined;
        if (!name) return;
      }

      const deleted = deleteJob(name);
      if (deleted) {
        console.log(chalk.green(`Job '${name}' removed`));
        if (isDaemonRunning()) {
          signalDaemonReload();
          console.log(chalk.gray('Daemon reloaded'));
        }
      } else {
        console.log(chalk.red(`Job '${name}' not found`));
        process.exit(1);
      }
    });

  routinesCmd
    .command('view [name]')
    .description('Show the full YAML configuration for a routine')
    .action(async (name: string | undefined) => {
      if (!name) {
        name = await pickJob('Select job to view', undefined, ['agents routines view <name>'], process.cwd()) ?? undefined;
        if (!name) return;
      }

      const job = readJob(name, process.cwd());
      if (!job) {
        console.log(chalk.red(`Job '${name}' not found`));
        process.exit(1);
      }

      console.log(chalk.bold(`Job: ${name}\n`));
      console.log(yaml.stringify(job));
    });

  routinesCmd
    .command('edit [name]')
    .description('Edit a prefilled routine transactionally; invalid YAML never replaces the live definition.')
    .option('--yaml', 'Open the raw YAML in $EDITOR (the current edit surface)')
    .option('--state-to <name>', 'Update the Linear current-state filter before opening the editor')
    .option('--state-from <name>', 'Update the Linear previous-state filter before opening the editor')
    .option('--cwd <path>', 'Set the execution directory and save, without opening an editor')
    .option('--project-anchor <name>', 'Set the execution project anchor and save, without opening an editor')
    .option('--agent <agent[@version]>', 'Set the agent (and optional exact version pin) and save, without opening an editor — same syntax as agents run')
    .option('--strategy <strategy>', `Set the per-routine version/account selection strategy (${RUN_STRATEGIES.join(' | ')}) and save. Conflicts with an @version pin.`)
    .action(async (name: string | undefined, options: { stateTo?: string; stateFrom?: string; cwd?: string; projectAnchor?: string; agent?: string; strategy?: string }) => {
      if (!name) {
        name = await pickJob('Select job to edit', undefined, ['agents routines edit <name>']) ?? undefined;
        if (!name) return;
      }

      const existing = readJob(name);
      if (options.cwd !== undefined || options.projectAnchor !== undefined || options.agent !== undefined || options.strategy !== undefined) {
        if (!existing) {
          console.error(chalk.red(`Routine '${name}' not found. Create it first: agents routines add ${name} --schedule "..." --agent claude --prompt "..."`));
          process.exit(1);
        }
        if (options.cwd !== undefined) existing.cwd = options.cwd;
        if (options.projectAnchor !== undefined) existing.project = options.projectAnchor;
        if (options.agent !== undefined) {
          if (isCustomHarnessName(options.agent)) {
            existing.agent = options.agent;
            delete existing.version;
          } else {
            const parsed = parseAgentVersionSpec(options.agent);
            if ('error' in parsed) {
              console.error(chalk.red(parsed.error));
              process.exit(1);
            }
            if (isAgentHardDeprecated(parsed.agent)) {
              console.error(chalk.red(hardDeprecationError(parsed.agent)));
              process.exit(1);
            }
            existing.agent = parsed.agent;
            if (parsed.version) existing.version = parsed.version;
            else delete existing.version;
          }
        }
        if (options.strategy !== undefined) {
          const normalized = normalizeRunStrategy(options.strategy);
          if (!normalized) {
            console.error(chalk.red(`Invalid strategy: ${options.strategy}. Use ${RUN_STRATEGIES.join(', ')}.`));
            process.exit(1);
          }
          existing.strategy = normalized;
        }
        const errors = validateJob(existing);
        if (errors.length > 0) {
          console.error(chalk.red('Validation errors:'));
          for (const err of errors) console.error(chalk.red(`  - ${err}`));
          process.exit(1);
        }
        writeJob(existing);
        const readiness = await evaluateActivationReadinessLive(existing);
        console.log(chalk.green(`Routine '${name}' updated`));
        if (!readiness.ready && readiness.readiness) {
          console.log(chalk.yellow(`Still not ready: ${readiness.readiness.code}`));
          console.log(chalk.gray(`  ${readiness.readiness.message}`));
        } else {
          console.log(chalk.gray(`  enable it with: agents routines enable ${name}`));
        }
        return;
      }
      if (existing && (options.stateTo !== undefined || options.stateFrom !== undefined)) {
        if (!existing.trigger || existing.trigger.type !== 'linear_event') {
          console.error(chalk.red(`'${name}' does not have a Linear trigger; --state-to/--state-from only apply to linear triggers`));
          process.exit(1);
        }
        if (options.stateTo !== undefined) existing.trigger.stateTo = options.stateTo || undefined;
        if (options.stateFrom !== undefined) existing.trigger.stateFrom = options.stateFrom || undefined;
      }

      const jobPath = getJobPath(name);
      const cronDir = getRoutinesDir();
      fs.mkdirSync(cronDir, { recursive: true });
      const targetPath = jobPath || safeJoin(cronDir, `${name}.yml`);
      const editPath = safeJoin(cronDir, `.${name}.edit-${process.pid}.yml`);
      const initial = existing
        ? yaml.stringify(existing)
        : yaml.stringify({
          name,
          schedule: '0 9 * * *',
          agent: 'claude',
          prompt: 'Your prompt here',
        });
      fs.writeFileSync(editPath, initial, { encoding: 'utf-8', mode: 0o600 });

      const editor = process.env.EDITOR || process.env.VISUAL || (IS_WINDOWS ? 'notepad' : 'vi');
      const editorParts = editor.split(/\s+/).filter(Boolean);
      const editorBin = editorParts[0];
      const editorArgs = [...editorParts.slice(1), editPath];

      const { spawn: spawnSync } = await import('child_process');
      const child = spawnSync(editorBin, editorArgs, {
        stdio: 'inherit',
      });

      child.on('close', async (code) => {
        if (code !== 0) {
          fs.rmSync(editPath, { force: true });
          return;
        }
        try {
          const raw = fs.readFileSync(editPath, 'utf-8');
          const job = yaml.parse(raw) as JobConfig;
          const errors = validateJob(job);
          if (errors.length > 0) throw new Error(errors.join('\n'));
          const readiness = await evaluateActivationReadinessLive(job);
          fs.renameSync(editPath, targetPath);
          if (!readiness.ready) setJobEnabled(job.name, false);
          console.log(chalk.green(`\nJob '${name}' saved${readiness.ready ? '' : ' paused (not ready)'}`));
          if (isDaemonRunning()) {
            signalDaemonReload();
            console.log(chalk.gray('Daemon reloaded'));
          }
        } catch (err) {
          fs.rmSync(editPath, { force: true });
          console.error(chalk.red(`\nRoutine not saved: ${(err as Error).message}`));
          process.exitCode = 1;
        }
      });
    });

  routinesCmd
    .command('runs [name]')
    .description('See execution history: run IDs, completion status, and start times (up to last 10 runs)')
    .option('--json', 'Emit machine-readable JSON with run ids and statuses')
    .action(async (name: string | undefined, options: { json?: boolean }) => {
      if (!name) {
        name = await pickJob('Select job to view runs', undefined, ['agents routines runs <name>']) ?? undefined;
        if (!name) return;
      }

      const runs = listRuns(name);
      if (options.json) {
        writeJson({
          jobId: name,
          name,
          runs: buildRunsJson(runs.slice(-10)),
        });
        return;
      }
      if (runs.length === 0) {
        console.log(chalk.yellow(`No runs found for job '${name}'`));
        return;
      }

      console.log(chalk.bold(`Execution History: ${name}\n`));
      for (const run of runs.slice(-10)) {
        const status = run.status === 'completed'
          ? chalk.green(run.status)
          : run.status === 'failed'
            ? chalk.red(run.status)
            : chalk.yellow(run.status);
        const reason = runFailureReason(run);
        const why = reason ? chalk.gray(` — ${reason}`) : '';
        console.log(`  ${run.runId}  ${status}  ${run.startedAt}${why}`);
      }
    });

  routinesCmd
    .command('stats [name]')
    .description('Duration + outcome rollup per job: run count, failed, missed, avg/p50/p95 duration')
    .option('--json', 'Emit machine-readable JSON')
    .action(async (name: string | undefined, options: { json?: boolean }) => {
      if (!name) {
        const jobs = listAllJobs();
        const rows = jobs.map((j) => ({ name: j.name, ...routineStats(j.name) }));
        if (options.json) {
          writeJson({ jobs: rows });
          return;
        }
        if (rows.length === 0) {
          console.log(chalk.gray('No jobs configured'));
          return;
        }
        console.log(chalk.bold('Routine stats\n'));
        const pad = (s: string, w: number) => (s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length));
        console.log(chalk.gray(`  ${pad('JOB', 28)} ${pad('N', 5)} ${pad('FAILED', 7)} ${pad('MISSED', 7)} ${pad('AVG', 7)} ${pad('P50', 7)} P95`));
        for (const r of rows) {
          console.log(`  ${pad(r.name, 28)} ${pad(String(r.count), 5)} ${pad(String(r.failed), 7)} ${pad(String(r.missed), 7)} ${pad(`${r.avgMs}ms`, 7)} ${pad(`${r.p50}ms`, 7)} ${r.p95}ms`);
        }
        return;
      }

      const stats = routineStats(name);
      if (options.json) {
        writeJson({ jobId: name, name, ...stats });
        return;
      }
      if (stats.count === 0) {
        console.log(chalk.yellow(`No runs found for job '${name}'`));
        return;
      }
      console.log(chalk.bold(`Stats: ${name}\n`));
      console.log(`  Runs:     ${stats.count}`);
      console.log(`  Failed:   ${stats.failed}`);
      console.log(`  Missed:   ${stats.missed}`);
      console.log(`  Avg:      ${stats.avgMs}ms`);
      console.log(`  P50:      ${stats.p50}ms`);
      console.log(`  P95:      ${stats.p95}ms`);
    });

  routinesCmd
    .command('run [name]')
    // Run, webhook, and ordinary mutations resolve trusted user/system jobs only;
    // reviewed enable/materialize above is the sole project-routine exception.
    .description('Execute a routine right now in the foreground. Ignores the schedule; useful for testing before enabling.')
    .option('--json', 'Emit machine-readable JSON with the run id and status')
    .action(async (name: string | undefined, options: { json?: boolean }) => {
      if (!name) {
        name = await pickJob('Select job to run', undefined, ['agents routines run <name>']) ?? undefined;
        if (!name) return;
      }

      const job = readJob(name);
      if (!job) {
        if (options.json) {
          writeJson({ error: `Job '${name}' not found` });
          process.exit(1);
        }
        console.error(chalk.red(`Job '${name}' not found`));
        process.exit(1);
      }

      const eligibility = checkJobDeviceEligibility(job);
      if (eligibility) {
        if (options.json) {
          writeJson({ error: eligibility.message, hint: eligibility.suggestion });
          process.exit(1);
        }
        console.error(chalk.red(eligibility.message));
        console.error(chalk.gray(`  ${eligibility.suggestion}`));
        process.exit(1);
      }

      const runLabel = job.command ? 'command' : job.workflow ? `workflow: ${job.workflow}` : `agent: ${job.agent}`;
      const spinner = options.json ? null : ora('Executing...').start();
      if (!options.json) console.log(chalk.bold(`Running job '${name}' (${runLabel}, mode: ${job.mode})\n`));

      try {
        const result = await executeJob(job);
        const logPath = `${getRunDir(name, result.meta.runId)}/stdout.log`;
        const succeeded = result.meta.status === 'completed';
        if (options.json) {
          writeJson({
            ok: succeeded,
            job: name,
            logDir: getRunDir(name, result.meta.runId),
            ...runMetaJson(result.meta),
            logPath,
            reportPath: result.reportPath ?? null,
          });
          if (!succeeded) process.exitCode = 1;
          return;
        }
        if (succeeded) {
          spinner!.succeed(`Job completed (exit code: ${result.meta.exitCode})`);
        } else if (result.meta.status === 'timeout') {
          spinner!.warn(`Job timed out after ${job.timeout}`);
        } else {
          spinner!.fail(`Job failed (exit code: ${result.meta.exitCode})`);
        }

        console.log(chalk.gray(`  Run: ${result.meta.runId}`));
        console.log(chalk.gray(`  Log: ${logPath}`));
        if (result.meta.errorMessage) {
          console.log(chalk.gray(`  Reason: ${result.meta.errorMessage}`));
        }

        if (result.reportPath) {
          console.log(chalk.bold('\nReport:\n'));
          console.log(fs.readFileSync(result.reportPath, 'utf-8'));
        }

        if (!succeeded) process.exitCode = 1;
      } catch (err) {
        if (options.json) {
          writeJson({ error: (err as Error).message });
          process.exit(1);
        }
        spinner!.fail('Execution failed');
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  routinesCmd
    .command('catchup')
    .description('Run any routines that missed their last scheduled fire on demand. The daemon already does this every 5 minutes — use this to force a pass now. Detached: runs in the background under the scheduler.')
    .option('--dry-run', 'Record the misses and list them without running anything')
    .action(async (options) => {
      const overdue = detectOverdueJobs();
      if (overdue.length === 0) {
        console.log(chalk.gray('No missed fires.'));
        return;
      }

      console.log(chalk.bold(`${overdue.length} missed fire(s):\n`));
      for (const job of overdue) {
        const last = job.lastRanAt ? job.lastRanAt.toLocaleString() : 'never';
        console.log(`  ${chalk.cyan(job.name)} — missed ${chalk.gray(job.expectedAt.toLocaleString())}, last ran ${chalk.gray(last)}`);
      }

      if (!options.dryRun && !isDaemonRunning()) {
        try {
          assertDaemonEnabled();
          const started = startDaemon();
          if (started.pid) {
            console.log(chalk.gray(`\nStarted scheduler (PID: ${started.pid}) so catchup runs are monitored.`));
          }
        } catch (err) {
          console.log(chalk.yellow(`\n${(err as Error).message}`));
        }
      }

      console.log(chalk.bold(options.dryRun ? '\nRecording misses...' : '\nTriggering catchup runs...'));
      const outcomes = await runCatchup({ overdue, dryRun: options.dryRun });
      for (const o of outcomes) {
        if (o.result === 'ran') {
          console.log(`  ${o.name} → ${chalk.green('started')} (run: ${o.runId})`);
        } else if (o.result === 'recorded') {
          const why = options.dryRun ? 'dry run' : 'catchup: false';
          console.log(`  ${o.name} → ${chalk.yellow('recorded as missed')} (${why})`);
        } else if (o.result === 'claimed-elsewhere') {
          console.log(`  ${o.name} → ${chalk.gray('already claimed by the scheduler')}`);
        } else {
          console.log(`  ${o.name} → ${chalk.red('failed to start')}: ${o.error}`);
        }
      }
      console.log(chalk.gray('\nTrack progress with: agents routines runs <name>'));
    });

  routinesCmd
    .command('webhook')
    .description('Fire trigger-based routines from a single webhook payload (read from --file or stdin). One-shot: matches and fires, then exits.')
    .option('--source <name>', 'Webhook source: github or linear', 'github')
    .requiredOption('--event <name>', 'Source event name: GitHub X-GitHub-Event value, or Linear payload type')
    .option('--file <path>', 'Read the webhook JSON payload from this file instead of stdin')
    .option('--dry-run', 'Show which routines would fire without firing them')
    .action(async (options: { source?: string; event: string; file?: string; dryRun?: boolean }) => {
      const source = options.source as WebhookSource;
      if (source !== 'github' && source !== 'linear') {
        console.log(chalk.red(`Unknown webhook source "${options.source}". Use github or linear.`));
        process.exit(1);
      }
      let raw: string;
      if (options.file) {
        const resolved = path.resolve(options.file);
        if (!fs.existsSync(resolved)) {
          console.log(chalk.red(`File not found: ${resolved}`));
          process.exit(1);
        }
        raw = fs.readFileSync(resolved, 'utf-8');
      } else {
        if (process.stdin.isTTY) {
          console.log(chalk.red('No payload provided. Pass --file <path> or pipe the webhook JSON on stdin.'));
          process.exit(1);
        }
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        raw = Buffer.concat(chunks).toString('utf-8');
      }

      let payload: Record<string, unknown>;
      try {
        const parsed = raw.trim() ? JSON.parse(raw) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('payload must be a JSON object');
        }
        payload = parsed as Record<string, unknown>;
      } catch (err) {
        console.log(chalk.red(`Invalid webhook payload JSON: ${(err as Error).message}`));
        process.exit(1);
      }

      const webhook: IncomingWebhook = { source, event: options.event, payload };

      if (options.dryRun) {
        const matched = matchJobsToWebhook(listAllJobs(), webhook);
        if (matched.length === 0) {
          console.log(chalk.gray(`No routines match a ${source}:${options.event} event for this payload.`));
          return;
        }
        console.log(chalk.bold(`${matched.length} routine(s) would fire on ${source}:${options.event}:\n`));
        for (const job of matched) {
          console.log(`  ${chalk.cyan(job.name)} — ${fireConditionLabel(job)}`);
        }
        console.log(chalk.gray('\n(dry run — no routines triggered)'));
        return;
      }

      if (!isDaemonRunning()) {
        if (!isDaemonEnabled()) {
          console.log(chalk.yellow(`Daemon is disabled (daemon.enabled=false) — run(s) below fire but are not monitored. Re-enable with: agents daemon enable`));
        } else {
          try {
            const started = startDaemon();
            if (started.pid) {
              console.log(chalk.gray(`Started scheduler (PID: ${started.pid}) so webhook runs are monitored.`));
            }
          } catch (err) {
            if (err instanceof RedirectedHomeDaemonError) {
              console.log(chalk.yellow((err as Error).message));
            } else {
              throw err;
            }
          }
        }
      }

      const fired = await fireWebhookJobs(webhook);
      if (fired.length === 0) {
        console.log(chalk.gray(`No routines match a ${source}:${options.event} event for this payload.`));
        return;
      }

      console.log(chalk.bold(`Fired ${fired.length} routine(s) on ${source}:${options.event}:\n`));
      for (const f of fired) {
        console.log(`  ${chalk.cyan(f.jobName)} → ${chalk.green('started')} (run: ${f.runId})`);
      }
      console.log(chalk.gray('\nTrack progress with: agents routines runs <name>'));
    });

  routinesCmd
    .command('logs [name]')
    .description('Show a run’s concise summary — status + extracted report. --full for the raw stdout stream; --run for a specific past run.')
    .option('-r, --run <runId>', 'Show logs from this run ID instead of the latest')
    .option('-m, --full', 'Show the full raw stdout stream instead of the concise summary')
    .action(async (name: string | undefined, options) => {
      if (!name) {
        name = await pickJob('Select job to view logs', undefined, ['agents routines logs <name>', 'agents routines logs <name> --run <run-id>']) ?? undefined;
        if (!name) return;
      }

      const run = options.run
        ? listRuns(name).find((r) => r.runId === options.run)
        : getLatestRun(name);
      if (!run) {
        console.log(chalk.yellow(options.run ? `No run '${options.run}' for job '${name}'` : `No runs found for job '${name}'`));
        return;
      }
      const runId = run.runId;
      const logPath = path.join(getRunDir(name, runId), 'stdout.log');

      if (options.full) {
        if (!fs.existsSync(logPath)) {
          console.log(chalk.yellow(`Log not found: ${logPath}`));
          return;
        }
        console.log(chalk.gray(`Run: ${runId}\n`));
        console.log(fs.readFileSync(logPath, 'utf-8'));
        return;
      }

      const statusColor = run.status === 'completed' ? chalk.green
        : run.status === 'missed' ? chalk.magenta
        : run.status === 'failed' || run.status === 'timeout' ? chalk.red
        : chalk.yellow;
      console.log(chalk.bold(name) + chalk.gray(`  run ${runId}`));
      console.log(
        statusColor(run.status) +
        chalk.gray(`  ${run.startedAt}`) +
        chalk.gray(formatRunDuration(run.startedAt, run.completedAt)) +
        (run.exitCode !== null && run.exitCode !== undefined ? chalk.gray(`  exit ${run.exitCode}`) : '')
      );
      const logsReason = runFailureReason(run);
      if (logsReason) console.log(chalk.red('reason: ') + chalk.gray(logsReason));
      console.log(chalk.gray('─'.repeat(60)));

      const reportPath = path.join(getRunDir(name, runId), 'report.md');
      if (fs.existsSync(reportPath)) {
        console.log(fs.readFileSync(reportPath, 'utf-8').trimEnd());
        console.log(chalk.gray('\n(pass --full for the raw stdout stream)'));
        return;
      }

      if (fs.existsSync(logPath)) {
        const lines = fs.readFileSync(logPath, 'utf-8').split('\n');
        const tail = lines.slice(-40).join('\n').trimEnd();
        console.log(chalk.gray('(no report extracted — showing the last lines of stdout)'));
        if (tail) console.log(tail);
        console.log(chalk.gray('\n(pass --full for the raw stdout stream)'));
      } else {
        console.log(chalk.gray('(no output captured for this run)'));
      }
    });

  routinesCmd
    .command('report [name]')
    .description('Show the extracted report from the most recent execution. Reports are parsed from agent output on completion.')
    .option('-r, --run <runId>', 'Show report from this run ID instead of the latest')
    .action(async (name: string | undefined, options) => {
      if (!name) {
        name = await pickJob('Select job to view report', undefined, ['agents routines report <name>', 'agents routines report <name> --run <run-id>']) ?? undefined;
        if (!name) return;
      }

      let runId = options.run;
      if (!runId) {
        const latest = getLatestRun(name);
        if (!latest) {
          console.log(chalk.yellow(`No runs found for job '${name}'`));
          return;
        }
        runId = latest.runId;
      }

      const reportPath = path.join(getRunDir(name, runId), 'report.md');
      if (!fs.existsSync(reportPath)) {
        console.log(chalk.yellow(`No report found for run ${runId}`));
        console.log(chalk.gray(`  Reports are extracted from agent output on completion`));
        return;
      }

      console.log(chalk.gray(`Run: ${runId}\n`));
      console.log(fs.readFileSync(reportPath, 'utf-8'));
    });

  routinesCmd
    .command('doctor [name]')
    .description('Check a routine\'s execution-context and harness readiness. Bare or --all checks every routine; --fix applies safe activation repairs (activate a now-ready paused routine; pause a broken active one).')
    .option('--all', 'Check every routine (the default when no name is given)')
    .option('--fix', 'Apply safe, deterministic activation repairs')
    .option('--json', 'Machine-readable output')
    .action(async (name: string | undefined, options: { all?: boolean; fix?: boolean; json?: boolean }) => {
      const all = options.all || !name;
      let targets: JobConfig[];
      if (all) {
        targets = listAllJobs();
      } else {
        const job = readJob(name!);
        if (!job) {
          if (options.json) { writeJson({ ok: false, error: `routine '${name}' not found` }); return; }
          console.error(chalk.red(`Routine '${name}' not found`));
          process.exit(1);
        }
        targets = [job!];
      }

      const thisDevice = normalizeHost(machineId());
      const results = await Promise.all(targets.map(async (job) => {
        const deviceMatch = !job.devices || job.devices.map(normalizeHost).includes(thisDevice);
        const readiness = await evaluateActivationReadinessLive(job);
        let action: 'activated' | 'paused' | undefined;
        if (options.fix && deviceMatch) {
          if (readiness.ready && !job.enabled) { setJobEnabled(job.name, true); action = 'activated'; }
          else if (!readiness.ready && job.enabled) { setJobEnabled(job.name, false); action = 'paused'; }
        }
        return {
          name: job.name,
          ready: readiness.ready,
          active: job.enabled,
          deviceScoped: deviceMatch,
          ...(readiness.readiness ? { readiness: readiness.readiness } : {}),
          ...(action ? { action } : {}),
        };
      }));

      if (options.fix && results.some((r) => r.action) && isDaemonRunning()) {
        signalDaemonReload();
      }

      if (options.json) { writeJson({ ok: true, results }); return; }

      const blocked = results.filter((r) => !r.ready);
      for (const r of results) {
        if (r.ready) {
          console.log(`${chalk.green('✓')} ${r.name}${r.action === 'activated' ? chalk.gray(' (activated)') : ''}`);
        } else {
          const rd = r.readiness!;
          console.log(`${chalk.red('✗')} ${r.name} — ${chalk.yellow(rd.code)}${r.action === 'paused' ? chalk.gray(' (paused)') : ''}`);
          console.log(chalk.gray(`    ${rd.message}`));
          if (rd.repair) console.log(chalk.gray(`    repair: ${rd.repair}`));
        }
      }
      if (blocked.length > 0 && !options.fix) {
        console.log(chalk.gray(`\n${blocked.length} routine${blocked.length === 1 ? '' : 's'} blocked — re-run with --fix to pause them, or apply each repair above.`));
      }
    });

  routinesCmd
    .command('enable [name]')
    .aliases(['resume'])
    .description('Enable a routine so the daemon schedules it. Also materialises a project routine (from the current project or a registered one) on first enable — one step, no separate opt-in.')
    .action(async (name: string | undefined) => {
      await enableRoutineAction(name);
    });

  routinesCmd
    .command('disable [name]')
    .aliases(['pause'])
    .description('Disable a routine. Stops scheduling future runs; turn it back on with: agents routines enable <name>.')
    .action(async (name: string | undefined) => {
      await disableRoutineAction(name);
    });

  routinesCmd
    .command('devices [name]')
    .description('View or change the devices where a routine is enabled. Without flags, opens an interactive picker (requires a TTY).')
    .option('--set <devices>', 'Replace the enabled-device set with this comma-separated list')
    .option('--clear', 'Disable the routine on every registered device')
    .action(async (name: string | undefined, options: { set?: string; clear?: boolean }) => {
      const hasSet = options.set !== undefined;
      if (hasSet && options.clear) {
        console.log(chalk.red('--set and --clear are mutually exclusive'));
        process.exit(1);
      }

      if (!name) {
        name = await pickJob('Select routine', undefined, ['agents routines devices <name>']) ?? undefined;
        if (!name) return;
      }
      const job = readJob(name);
      if (!job) {
        console.log(chalk.red(`Job '${name}' not found`));
        process.exit(1);
      }

      const applyDevices = async (selected: string[]): Promise<void> => {
        const registry = await loadDevices();
        const registered = Object.keys(registry).map(normalizeHost);
        const all = [...new Set([...registered, machineId()].map(normalizeHost))].sort();
        const selectedSet = new Set(selected.map(normalizeHost));
        const unknown = [...selectedSet].filter((device) => !all.includes(device));
        if (unknown.length > 0) throw new Error(`Unknown device${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
        const skipped: Array<{ device: string; action: 'resume' | 'pause' }> = [];
        const failedTargets: string[] = [];
        for (const device of all) {
          const action: 'resume' | 'pause' = selectedSet.has(device) ? 'resume' : 'pause';
          const isTarget = selectedSet.has(device);
          if (device === normalizeHost(machineId())) {
            setJobEnabled(name!, action === 'resume');
            if (isDaemonRunning()) signalDaemonReload();
            continue;
          }
          const launch = getCliLaunch(['routines', action, name!, '--device', device]);
          const result = spawnSync(launch.command, launch.args, { stdio: 'inherit', env: process.env });
          if ((result.status ?? 1) !== 0) {
            if (isTarget) {
              failedTargets.push(device);
            } else {
              skipped.push({ device, action });
            }
          }
        }
        for (const s of skipped) {
          console.log(chalk.yellow(
            `Skipped ${s.action} of '${name}' on ${s.device} (unreachable; will sync when online)`,
          ));
        }
        if (failedTargets.length > 0) {
          const offlineNote = skipped.length > 0
            ? ` (also skipped offline: ${skipped.map((s) => s.device).join(', ')})`
            : '';
          throw new Error(
            `Could not enable '${name}' on: ${failedTargets.join(', ')}${offlineNote}`,
          );
        }
        const offlineNote = skipped.length > 0
          ? ` (${skipped.length} offline device${skipped.length === 1 ? '' : 's'} skipped)`
          : '';
        console.log(chalk.green(selected.length === 0
          ? `Routine '${name}' disabled on every registered device${offlineNote}`
          : `Routine '${name}' enabled on: ${selected.join(', ')}${offlineNote}`));
      };

      if (options.clear) {
        await applyDevices([]);
        return;
      }

      if (hasSet) {
        await applyDevices(await parseAndValidateDevices(options.set!));
        return;
      }

      if (!isInteractiveTerminal()) {
        requireInteractiveSelection('device allowlist', ['agents routines devices <name> --set a,b', 'agents routines devices <name> --clear']);
      }

      const registry = await loadDevices();
      const registeredNames = Object.keys(registry).map((k) => normalizeHost(k)).sort();
      if (registeredNames.length === 0) {
        console.log(chalk.yellow('No devices registered. Enroll with: agents devices sync'));
        return;
      }

      const currentSet = new Set(devicesWithRoutineEnabled(name).map(normalizeHost));

      try {
        const { checkbox } = await import('@inquirer/prompts');
        const selected = await checkbox({
          message: `Devices where '${name}' is enabled (space to toggle, enter to confirm):`,
          choices: registeredNames.map((d) => ({
            value: d,
            name: d,
            checked: currentSet.has(d),
          })),
        });

        await applyDevices(selected);
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.gray('Cancelled'));
          return;
        }
        throw err;
      }
    });


  routinesCmd
    .command('start')
    .description('Enable and reload the scheduler service. Usually unnecessary — it auto-starts when you add your first routine.')
    .action(() => {
      try {
        assertDaemonEnabled();
        assertSchedulerEnabled();
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
      setDaemonServiceEnabled('scheduler', true);
      let result: { pid: number | null; method: string };
      try {
        result = startDaemon();
      } catch (err) {
        if (err instanceof RedirectedHomeDaemonError) {
          console.error(chalk.red((err as Error).message));
          process.exit(1);
        }
        throw err;
      }
      if (result.method === 'already-running') {
        const reloaded = signalDaemonReload();
        console.log(reloaded
          ? chalk.yellow(`Scheduler service enabled (shared daemon PID: ${result.pid}) — reloaded`)
          : chalk.yellow(`Scheduler service enabled, but live reload is unavailable. Restart deliberately with: agents daemon restart`));
      } else if (result.pid) {
        console.log(chalk.green(`Scheduler started (PID: ${result.pid})`));
      } else {
        console.log(chalk.yellow('Scheduler start dispatched but no PID surfaced. Check `agents routines status`.'));
      }
    });

  routinesCmd
    .command('stop')
    .description('Stop only the scheduler service. The shared daemon and its browser, secrets, usage, and monitoring services stay running.')
    .action(() => {
      const daemonRunning = isDaemonRunning();
      setDaemonServiceEnabled('scheduler', false);
      if (daemonRunning && !signalDaemonReload()) {
        console.log(chalk.yellow('Scheduler service disabled, but live reload is unavailable. It will stay off after the next daemon start.'));
        return;
      }
      console.log(daemonRunning
        ? chalk.green('Scheduler service stopped; shared daemon is still running')
        : chalk.yellow('Scheduler service disabled; shared daemon was already stopped'));
    });

  routinesCmd
    .command('status')
    .description('Show scheduler service state, shared-daemon state, enabled routines, and upcoming runs.')
    .option('--json', 'Emit machine-readable scheduler service + device gate + daemon + per-routine status (owner device, last fire, last error, in-flight run)')
    .action((options: { json?: boolean }) => {
      try { monitorRunningJobs(); } catch {  }
      const status = getDaemonStatus();
      const schedulerServiceEnabled = isDaemonServiceEnabled('scheduler');
      const schedulerDeviceEnabled = isSchedulerEnabled();
      const schedulerState = schedulerServiceEnabled && schedulerDeviceEnabled ? status.state : 'stopped';

      if (options.json) {
        const rows = buildRoutineStatusRows();
        writeJson({
          device: machineId(),
          scheduler: {
            state: schedulerState,
            serviceEnabled: schedulerServiceEnabled,
            deviceEnabled: schedulerDeviceEnabled,
            daemonState: status.state,
            pid: status.pid,
            binaryPath: status.binaryPath,
            heartbeat: status.heartbeat
              ? {
                  lastTick: status.heartbeat.lastTick,
                  ageSec: Math.round((Date.now() - Date.parse(status.heartbeat.lastTick)) / 1000),
                }
              : null,
            enabled: rows.filter((r) => r.enabled).length,
            total: rows.length,
          },
          routines: rows,
        });
        return;
      }

      console.log(chalk.bold('Scheduler\n'));
      const stateLabel = schedulerState === 'running'
        ? chalk.green('running')
        : chalk.gray('stopped');
      console.log(`  Status:    ${stateLabel}`);
      console.log(`  Daemon:    ${status.running ? chalk.green('running') : chalk.gray('stopped')}`);
      if (status.pid) console.log(`  PID:       ${status.pid}`);
      if (status.binaryPath) console.log(`  Binary:    ${chalk.gray(status.binaryPath)}`);
      if (status.heartbeat) {
        const ago = Math.round((Date.now() - Date.parse(status.heartbeat.lastTick)) / 1000);
        console.log(`  Heartbeat: ${chalk.gray(`${ago} sec ago`)}`);
      }

      const jobs = listAllJobs();
      const enabled = jobs.filter((j) => j.enabled);
      console.log(`  Routines:  ${enabled.length} enabled / ${jobs.length} total`);

      if (schedulerState === 'running' && enabled.length > 0) {
        const scheduler = new JobScheduler(async () => {});
        scheduler.loadAll();
        const scheduled = scheduler.listScheduled();
        console.log(chalk.bold('\n  Upcoming Runs\n'));
        for (const job of scheduled) {
          const next = job.nextRun ? job.nextRun.toLocaleString() : 'unknown';
          console.log(`    ${chalk.cyan(job.name.padEnd(24))} next: ${chalk.gray(next)}`);
        }
        scheduler.stopAll();
      } else if (schedulerState !== 'running' && jobs.length > 0) {
        console.log(chalk.gray('\n  Start the scheduler to begin firing routines: agents routines start'));
      }
    });

  routinesCmd
    .command('sync [path]')
    .description('Refresh materialised project routines from their .agents/routines/*.yml sources. Definition-only — never changes what is enabled. With no path, refreshes every project you have enabled a routine from. Also runs automatically on daemon reload (SIGHUP).')
    .option('--json', 'Emit machine-readable JSON')
    .action(async (projectPath: string | undefined, options: { json?: boolean }) => {
      if (projectPath) {
        const root = path.resolve(projectPath);
        const sync = syncProjectRoutines(root);
        if (isDaemonRunning()) signalDaemonReload();
        if (options.json) {
          writeJson({ ok: true, ...sync });
          return;
        }
        if (sync.synced.length === 0 && sync.skipped.length === 0 && sync.removed.length === 0 && sync.errors.length === 0) {
          console.log(chalk.gray(`No enabled routines materialised from ${displayProjectPath(root)}.`));
          console.log(chalk.gray('  Enable one with: agents routines enable <name>'));
          return;
        }
        printSyncResult(sync);
        return;
      }

      const all = syncAllProjectRoutines();
      if (isDaemonRunning()) signalDaemonReload();
      if (options.json) {
        writeJson({ ok: true, ...all });
        return;
      }
      if (all.projects.length === 0 && all.missing.length === 0) {
        console.log(chalk.gray('No project routines materialised yet.'));
        console.log(chalk.gray('  Enable one with: agents routines enable <name>'));
        return;
      }
      for (const p of all.projects) printSyncResult(p);
      for (const m of all.missing) {
        console.log(chalk.yellow(`Missing project root for a materialised routine: ${displayProjectPath(m)}`));
      }
    });

  routinesCmd
    .command('scheduler-logs')
    .description('Read scheduler log output (for debugging why a routine did not fire). Use --follow to stream.')
    .option('-n, --lines <number>', 'Show this many recent lines (default: 50)', '50')
    .option('-f, --follow', 'Stream log output in real time (like tail -f)')
    .action(async (options) => {
      if (options.follow) {
        const { followFile } = await import('../lib/log-follow.js');
        const logPath = getDaemonLogPath();
        const recent = readDaemonLog(parseInt(options.lines, 10));
        if (recent) console.log(recent);
        const stop = followFile(logPath, (text) => process.stdout.write(text), { fromEnd: true });
        process.on('SIGINT', () => { stop(); process.exit(0); });
        return;
      }

      const lines = parseInt(options.lines, 10);
      const output = readDaemonLog(lines);
      if (output) {
        console.log(output);
      } else {
        console.log(chalk.gray('No scheduler logs'));
      }
    });

  for (const sub of routinesCmd.commands) {
    addHostOption(sub);
  }
}
