
import type { Command } from 'commander';
import chalk from 'chalk';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { setHelpSections } from '../lib/help.js';
import {
  getDaemonStatus,
  isDaemonRunning,
  readDaemonLog,
  startDaemon,
  stopDaemon,
  signalDaemonReload,
  findSurvivingStateDirDaemons,
  getDaemonLogPath,
  isDaemonAutostartCircuitOpen,
  RedirectedHomeDaemonError,
} from '../lib/daemon/daemon.js';
import { listDaemonRunProcesses } from '../lib/daemon/leaked-daemons.js';
import { getConfigValue, setConfigValue, isDaemonEnabled } from '../lib/device-config.js';
import {
  readSubsystemHealth,
  readAllSubsystemHealth,
  SUBSYSTEM_DAEMON_START,
  type SubsystemHealth,
} from '../lib/daemon-health.js';
import {
  DAEMON_SERVICE_IDS,
  type DaemonServiceId,
  listDaemonServiceStates,
  setDaemonServiceEnabled,
  getDaemonServicesConfigPath,
  queueDaemonServiceRestart,
  readDaemonLogLevel,
  writeDaemonLogLevel,
} from '../lib/daemon-services.js';
import { LOG_LEVELS, levelRank, parseLogLevel } from '../lib/daemon/diagnostics.js';
import { listJobs, getLatestRun } from '../lib/scheduling/routines.js';
import { JobScheduler } from '../lib/scheduler.js';
import { followFile } from '../lib/log-follow.js';
import { parseDuration } from '../lib/hooks/cache.js';
import { registerFunnelCommand } from './funnel.js';
import { registerDaemonIndexCommand } from './daemon-index.js';
import {
  DEFAULT_WEBHOOK_PORT,
  DEFAULT_WEBHOOK_RATE_LIMIT,
  addHostedReceiver,
  getDaemonWebhooksConfigPath,
  hostedReceiverPort,
  readDaemonWebhooksConfig,
  removeHostedReceiver,
  type HostedReceiverConfig,
} from '../lib/daemon-webhooks.js';
import { parseFunnelPort } from '../lib/funnel.js';


function startDaemonClean(): { pid: number | null; method: string } {
  try {
    return startDaemon();
  } catch (err) {
    if (err instanceof RedirectedHomeDaemonError) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }
    throw err;
  }
}

interface DaemonProcess {
  pid: number;
  entry: string | null;
  version: string | null;
  entryMissing: boolean | null;
  uid: number | null;
}

function entryAbsent(p: string): boolean | null {


  try {
    return fs.statSync(p, { throwIfNoEntry: false }) === undefined;
  } catch {
    return null;
  }
}

function entryIsGone(p: DaemonProcess): boolean {
  return p.entry !== null && path.isAbsolute(p.entry) && p.entryMissing === true;
}

function staleDaemons(
  processes: DaemonProcess[],
  ownerPid: number | null,
  registered: Set<number>,
): { actionable: DaemonProcess[]; visible: DaemonProcess[] } {


  const isOurs = (p: DaemonProcess) => p.pid === ownerPid || registered.has(p.pid);
  const myUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const gone = processes.filter(entryIsGone);
  return {
    actionable: gone.filter(isOurs),
    visible: gone.filter((p) => isOurs(p) || (myUid !== null && p.uid === myUid)),
  };
}

function processCwd(pid: number): string | null {
  try { return fs.realpathSync(`/proc/${pid}/cwd`); } catch { return null; }
}

function resolveVersionNear(entryPath: string, pid: number): string | null {
  let resolved = entryPath;
  if (!path.isAbsolute(resolved)) {
    const cwd = processCwd(pid);
    if (!cwd) return null;
    resolved = path.join(cwd, resolved);
  }
  try { resolved = fs.realpathSync(resolved); } catch {  }
  let dir = path.dirname(resolved);
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
      if (typeof pkg.version === 'string') return pkg.version;
    } catch {  }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function entryFromTokens(tokens: string[]): string | null {
  return tokens.length >= 2 ? tokens[tokens.length - 2] : null;
}

function scanDaemonProcesses(): DaemonProcess[] {
  const found: DaemonProcess[] = [];
  for (const p of listDaemonRunProcesses()) {
    const entry = entryFromTokens(p.tokens);
    const version = entry ? resolveVersionNear(entry, p.pid) : null;
    const entryMissing = entry ? entryAbsent(entry) : false;
    found.push({ pid: p.pid, entry, version, entryMissing, uid: p.uid });
  }
  return found;
}

function registryScopedDuplicates(processes: DaemonProcess[], ownerPid: number | null): DaemonProcess[] {
  const exclude = new Set<number>();
  if (ownerPid) exclude.add(ownerPid);
  const registered = new Set(findSurvivingStateDirDaemons(exclude));
  return processes.filter((p) => registered.has(p.pid));
}

function parseEtimeToSeconds(raw: string): number | null {
  const m = raw.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const days = m[1] ? parseInt(m[1], 10) : 0;
  const hours = m[2] ? parseInt(m[2], 10) : 0;
  const mins = parseInt(m[3], 10);
  const secs = parseInt(m[4], 10);
  if ([days, hours, mins, secs].some(isNaN)) return null;
  return ((days * 24 + hours) * 60 + mins) * 60 + secs;
}

export function uptimeSeconds(pid: number): number | null {
  if (process.platform === 'win32') return null;
  try {
    const out = execFileSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf-8' }).trim();
    return parseEtimeToSeconds(out);
  } catch {
    return null;
  }
}

function humanDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}


interface SecretsBrokerHealth {
  reachable: boolean;
  fileBacked: boolean;
  socketPath: string | null;
  heldBundles: number | null;
  record: SubsystemHealth | null;
}

async function probeSecretsBroker(): Promise<SecretsBrokerHealth> {
  const { agentPing, agentStatus, keychainUsesFileFallback } = await import('../lib/secrets-client.js');
  try {
    const ping = await agentPing();
    if (ping.reachable) {
      const entries = await agentStatus();
      return { reachable: true, fileBacked: false, socketPath: null, heldBundles: entries.length, record: null };
    }
  } catch {  }
  let fileBacked = false;
  try { fileBacked = await keychainUsesFileFallback(); } catch {  }
  return { reachable: false, fileBacked, socketPath: null, heldBundles: null, record: null };
}


interface SchedulerSummary {
  routineCount: number;
  enabledCount: number;
  nextFire: Date | null;
  failingCount: number;
}

function schedulerSummary(): SchedulerSummary {
  const jobs = listJobs();
  const enabled = jobs.filter((j) => j.enabled);
  let nextFire: Date | null = null;
  try {
    const scheduler = new JobScheduler(async () => {});
    scheduler.loadAll();
    for (const job of scheduler.listScheduled()) {
      if (job.nextRun && (!nextFire || job.nextRun < nextFire)) nextFire = job.nextRun;
    }
    scheduler.stopAll();
  } catch {  }
  const failingCount = enabled.filter((j) => {
    const last = getLatestRun(j.name);
    return last?.status === 'failed' || last?.status === 'timeout';
  }).length;
  return { routineCount: jobs.length, enabledCount: enabled.length, nextFire, failingCount };
}


function healthLine(label: string, live: boolean, record: SubsystemHealth | null): string {
  if (live) {
    const ok = record?.lastOkAt ? chalk.gray(`(last ok ${record.lastOkAt})`) : '';
    return `  ${chalk.green('healthy')}  ${label} ${ok}`;
  }
  const detail = record && record.consecutiveFailures > 0
    ? chalk.gray(`— ${record.lastError}`)
    : record?.lastOkAt
      ? chalk.gray(`(last ok ${record.lastOkAt})`)
      : '';
  return `  ${chalk.red('down')}  ${label} ${detail}`;
}

export function secretsBrokerHealthLine(secrets: SecretsBrokerHealth): string {
  if (secrets.reachable) {
    return healthLine(`secrets broker  (${secrets.socketPath}, ${secrets.heldBundles} bundle(s) held)`, true, secrets.record);
  }
  if (secrets.fileBacked) {
    return `  ${chalk.cyan('info')}  secrets agent not running (file-backed stores)`;
  }
  return healthLine('secrets broker  (unreachable)', false, secrets.record);
}

async function runStatus(opts: { json?: boolean }): Promise<void> {
  const status = getDaemonStatus();
  const enabled = isDaemonEnabled();
  const state: 'running' | 'stopped' | 'disabled' =
    !status.running && !enabled ? 'disabled' : status.state;
  const pid = status.pid;
  const uptime = pid ? uptimeSeconds(pid) : null;
  const heartbeatAgeMs = status.heartbeat ? Date.now() - Date.parse(status.heartbeat.lastTick) : null;

  const processes = scanDaemonProcesses();
  const owner = pid ? processes.find((p) => p.pid === pid) : undefined;
  const duplicates = registryScopedDuplicates(processes, pid ?? null);
  const registeredPids = new Set(findSurvivingStateDirDaemons(new Set()));
  const staleTiers = staleDaemons(processes, pid ?? null, registeredPids);
  const stale = staleTiers.visible;
  const ownerEntryGone = owner ? entryIsGone(owner) : false;

  const secrets = await probeSecretsBroker();
  const scheduler = schedulerSummary();

  if (opts.json) {
    console.log(JSON.stringify({
      state,
      pid,
      uptimeSeconds: uptime,
      heartbeatAgeMs,
      restarts24h: status.restarts24h,
      lastRestartCause: status.lastRestartCause,
      lastRestartAt: status.lastRestartAt,
      logPath: status.logPath,
      binaryPath: owner?.entry ?? status.binaryPath,
      binaryVersion: owner?.version ?? null,
      binaryMissing: ownerEntryGone,
      duplicates: duplicates.map((d) => ({ pid: d.pid, entry: d.entry, version: d.version })),
      staleBinaries: stale.map((d) => ({
        pid: d.pid,
        entry: d.entry,
        version: d.version,
        actionable: staleTiers.actionable.some((a) => a.pid === d.pid),
      })),
      daemonEnabled: enabled,
      services: {
        secretsBroker: {
          reachable: secrets.reachable,
          socketPath: secrets.socketPath,
          heldBundles: secrets.heldBundles,
          health: secrets.record,
        },
      },
      scheduler: {
        enabled: getConfigValue('scheduler.enabled').value !== false,
        routineCount: scheduler.routineCount,
        enabledCount: scheduler.enabledCount,
        nextFire: scheduler.nextFire ? scheduler.nextFire.toISOString() : null,
        failingCount: scheduler.failingCount,
      },
    }, null, 2));
    return;
  }

  const stateLabel =
    state === 'running' ? chalk.green('running')
    : state === 'disabled' ? chalk.yellow('disabled')
    : chalk.gray('stopped');

  console.log(chalk.bold('Identity\n'));
  console.log(`  State:      ${stateLabel}`);
  if (pid) console.log(`  PID:        ${pid}`);
  if (uptime !== null) console.log(`  Uptime:     ${humanDuration(uptime)}`);
  if (heartbeatAgeMs !== null) console.log(`  Heartbeat:  ${Math.round(heartbeatAgeMs / 1000)}s ago`);
  if (status.restarts24h > 0) {
    const when = status.lastRestartAt ? ` (last ${new Date(status.lastRestartAt).toLocaleString()})` : '';
    console.log(`  Restarts:   ${status.restarts24h} in the last 24h${when}`);
    if (status.lastRestartCause) console.log(`  Last cause: ${chalk.gray(status.lastRestartCause)}`);
  }
  const binaryLabel = owner?.entry ?? status.binaryPath ?? 'unknown';
  console.log(`  Binary:     ${ownerEntryGone ? chalk.red(`${binaryLabel}  (MISSING from disk)`) : chalk.gray(binaryLabel)}`);
  console.log(`  Version:    ${chalk.gray(owner?.version ?? 'unknown')}`);
  console.log(`  Log:        ${chalk.gray(status.logPath)}`);
  if (!enabled) console.log(chalk.yellow(`  daemon.enabled is false — nothing auto-starts it. Explicit start: agents daemon start`));

  if (stale.length > 0) {
    console.log(chalk.red(`\nStale code (${stale.length})\n`));
    const actionablePids = new Set(staleTiers.actionable.map((d) => d.pid));
    for (const d of stale) {
      const mine = pid !== null && d.pid === pid ? ' — this is the daemon above' : '';
      const note = mine || (actionablePids.has(d.pid) ? '' : ' — not this install; shown for visibility');
      console.log(`  PID ${d.pid}  ${chalk.gray(d.entry ?? 'unknown entry')}${chalk.red('  (deleted)')}${chalk.gray(note)}`);
    }
    const advice = [
      '\n  These run code that no longer exists on disk, so a restart fails and their',
      '  behaviour is whatever was loaded when the file was deleted.',
    ];
    if (staleTiers.actionable.length > 0) {
      advice.push(`  Yours: ${chalk.white('agents daemon restart')}   A stray this install owns: ${chalk.white('kill <pid>')}`);
    } else {
      advice.push('  None belong to this install — nothing for you to stop here.');
    }
    console.log(chalk.gray(advice.join('\n')));
  }

  if (duplicates.length > 0) {
    console.log(chalk.red(`\nDuplicates (${duplicates.length})\n`));
    for (const d of duplicates) {
      console.log(`  PID ${d.pid}  ${chalk.gray(d.entry ?? 'unknown entry')} ${d.version ? chalk.gray(`(v${d.version})`) : ''}`);
    }
    console.log(chalk.gray('\n  Only one install should own the daemon. Stop the stray(s): kill <pid>'));
  }

  console.log(chalk.bold('\nHealth\n'));
  console.log(secretsBrokerHealthLine(secrets));

  const schedulerEnabled = getConfigValue('scheduler.enabled').value !== false;
  console.log(`  ${schedulerEnabled ? chalk.green('enabled') : chalk.yellow('disabled')}  scheduler — ${scheduler.enabledCount}/${scheduler.routineCount} routine(s) enabled` +
    (scheduler.nextFire ? `, next ${scheduler.nextFire.toLocaleString()}` : ''));
  if (scheduler.failingCount > 0) {
    console.log(chalk.red(`  ${scheduler.failingCount} routine(s) failing their last run — see: agents routines stats`));
  }
}


interface DaemonServiceRow {
  id: DaemonServiceId;
  title: string;
  description: string;
  enabled: boolean;
  state: string;
  supervised: boolean;
  lastRunMs: number | null;
  lastError: string | null;
  consecutiveFailures: number;
}

function buildServiceRows(daemonRunning: boolean): DaemonServiceRow[] {
  const states = listDaemonServiceStates();
  const healthById = new Map(readAllSubsystemHealth().map((h) => [h.subsystem, h]));
  return states.map((s) => {
    const h = healthById.get(s.id);
    const supervised = h?.state !== undefined;
    const state = daemonRunning
      ? (h?.state ?? (s.enabled ? 'running (unsupervised)' : 'stopped'))
      : 'stopped';
    return {
      id: s.id,
      title: s.title,
      description: s.description,
      enabled: s.enabled,
      state,
      supervised,
      lastRunMs: h?.lastOkAt ? Date.parse(h.lastOkAt) : null,
      lastError: h?.lastError ?? null,
      consecutiveFailures: h?.consecutiveFailures ?? 0,
    };
  });
}

function serviceStateLabel(state: string): string {
  if (state === 'running') return chalk.green('running');
  if (state === 'stopped') return chalk.gray('stopped');
  if (state === 'idle') return chalk.gray('idle');
  return chalk.yellow(state);
}

async function runServices(opts: { json?: boolean }): Promise<void> {
  const secrets = await probeSecretsBroker();
  const rows = buildServiceRows(isDaemonRunning());
  if (opts.json) {
    console.log(JSON.stringify({
      secretsBroker: { reachable: secrets.reachable, socketPath: secrets.socketPath, heldBundles: secrets.heldBundles, health: secrets.record },
      services: rows,
    }, null, 2));
    return;
  }
  console.log(chalk.bold('Daemon services\n'));
  for (const row of rows) {
    const lastRun = row.lastRunMs ? new Date(row.lastRunMs).toLocaleString() : '-';
    console.log(
      `  ${row.id.padEnd(16)} ${serviceStateLabel(row.state).padEnd(20)} `
      + `enabled=${row.enabled ? 'yes' : 'no '}  fails=${row.consecutiveFailures}  last-run=${lastRun}`,
    );
    if (row.lastError) console.log(chalk.gray(`    last-error: ${row.lastError}`));
  }
  console.log(chalk.bold('\nHosted sockets\n'));
  console.log(secretsBrokerHealthLine(secrets));
  console.log(chalk.gray('\nScheduled routines run through `agents routines` — see: agents routines stats'));
  console.log(chalk.gray('agents daemon services enable|disable|restart <id> apply live for supervised services.'));
}


interface DaemonLogEntry {
  ts: string;
  level: string;
  message: string;
  data?: Record<string, unknown>;
}

function parseLogLines(raw: string): DaemonLogEntry[] {
  const out: DaemonLogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry.ts === 'string' && typeof entry.level === 'string') out.push(entry);
    } catch {  }
  }
  return out;
}

function passesFilters(entry: DaemonLogEntry, minLevel: string | undefined, sinceMs: number | undefined): boolean {
  if (minLevel && levelRank(entry.level) < levelRank(minLevel)) return false;
  if (sinceMs !== undefined && Date.parse(entry.ts) < sinceMs) return false;
  return true;
}

function printLogEntry(entry: DaemonLogEntry): void {
  const color = entry.level === 'ERROR' ? chalk.red : entry.level === 'WARN' ? chalk.yellow : chalk.gray;
  console.log(`${chalk.gray(entry.ts)} ${color(entry.level.padEnd(5))} ${entry.message}`);
  if (entry.data && (entry.level === 'ERROR' || entry.level === 'WARN')) console.log(chalk.gray(`      ${JSON.stringify(entry.data)}`));
}

function assertLogLevelOption(level: string | undefined): void {
  if (level !== undefined && !parseLogLevel(level)) {
    throw new Error(`--level must be one of ${LOG_LEVELS.join(', ').toLowerCase()} (got '${level}')`);
  }
}

function runLogLevel(level: string | undefined, opts: { json?: boolean }): void {
  if (level === undefined) {
    const current = readDaemonLogLevel().toLowerCase();
    if (opts.json) console.log(JSON.stringify({ level: current }));
    else console.log(current);
    return;
  }
  const parsed = parseLogLevel(level);
  if (!parsed) throw new Error(`log level must be one of ${LOG_LEVELS.join(', ').toLowerCase()} (got '${level}')`);
  writeDaemonLogLevel(parsed);
  const applied = signalDaemonReload();
  if (opts.json) {
    console.log(JSON.stringify({ level: parsed.toLowerCase(), applied }));
    return;
  }
  console.log(applied
    ? chalk.green(`Daemon log level set to ${parsed.toLowerCase()}.`) + chalk.gray(' Applied live. Follow it: agents daemon logs -f')
    : chalk.yellow(`Daemon log level set to ${parsed.toLowerCase()} in ${getDaemonServicesConfigPath()}, but the reload signal was not delivered; it applies on the next daemon start.`));
}

async function runLogs(opts: { lines?: string; follow?: boolean; level?: string; since?: string; json?: boolean }): Promise<void> {
  assertLogLevelOption(opts.level);
  const sinceMs = opts.since ? Date.now() - (parseDuration(opts.since) ?? 0) * 1000 : undefined;
  const lineCount = opts.lines ? parseInt(opts.lines, 10) : 50;

  if (opts.follow) {
    const logPath = getDaemonLogPath();
    for (const entry of parseLogLines(readDaemonLog(lineCount)).filter((e) => passesFilters(e, opts.level, sinceMs))) {
      if (opts.json) console.log(JSON.stringify(entry));
      else printLogEntry(entry);
    }
    const stop = followFile(logPath, (text) => {
      for (const entry of parseLogLines(text).filter((e) => passesFilters(e, opts.level, sinceMs))) {
        if (opts.json) console.log(JSON.stringify(entry));
        else printLogEntry(entry);
      }
    }, { fromEnd: true });
    process.on('SIGINT', () => { stop(); process.exit(0); });
    return;
  }

  const entries = parseLogLines(readDaemonLog()).filter((e) => passesFilters(e, opts.level, sinceMs)).slice(-lineCount);
  if (entries.length === 0) {
    if (opts.json) console.log('[]');
    else console.log(chalk.gray('No matching log lines'));
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(entries));
    return;
  }
  for (const entry of entries) printLogEntry(entry);
}


async function runDoctor(opts: { json?: boolean }): Promise<void> {
  const status = getDaemonStatus();
  const enabled = isDaemonEnabled();
  const problems: string[] = [];

  if (!status.running && enabled) problems.push('Daemon is not running. Start it: agents daemon start');

  const startHealth = readSubsystemHealth(SUBSYSTEM_DAEMON_START);
  if (isDaemonAutostartCircuitOpen()) {
    problems.push(
      `Daemon auto-start is disabled after ${startHealth?.consecutiveFailures ?? 0} consecutive starts that never reported healthy: ` +
      `${startHealth?.lastError ?? 'no reason recorded'}. Fix the cause, then retry with: agents daemon start`,
    );
  } else if (!status.running && startHealth && startHealth.consecutiveFailures > 0) {
    problems.push(`Daemon start has ${startHealth.consecutiveFailures} consecutive failure(s): ${startHealth.lastError}`);
  }

  const healthProcesses = scanDaemonProcesses();
  const duplicates = registryScopedDuplicates(healthProcesses, status.pid);
  if (duplicates.length > 0) {
    problems.push(`${duplicates.length} duplicate daemon process(es) running: ${duplicates.map((d) => d.pid).join(', ')}. Stop the stray(s).`);
  }

  for (const p of staleDaemons(healthProcesses, status.pid, new Set(findSurvivingStateDirDaemons(new Set()))).actionable) {

    const own = status.pid !== null && p.pid === status.pid;
    problems.push(
      `Daemon pid ${p.pid} runs code deleted from disk (${p.entry}). ` +
      (own ? 'Restart it: agents daemon restart' : 'Stray from a removed install/worktree. Stop it: kill ' + p.pid),
    );
  }

  const secrets = await probeSecretsBroker();
  if (!secrets.reachable) problems.push('Secrets broker is unreachable.');
  if (secrets.record && secrets.record.consecutiveFailures > 0) {
    problems.push(`Secrets broker has ${secrets.record.consecutiveFailures} consecutive failure(s): ${secrets.record.lastError}`);
  }

  const scheduler = schedulerSummary();
  if (scheduler.failingCount > 0) {
    problems.push(`${scheduler.failingCount} routine(s) failing their last run. See: agents routines stats`);
  }

  if (opts.json) {
    console.log(JSON.stringify({ healthy: problems.length === 0, problems }));
    if (problems.length > 0) process.exitCode = 1;
    return;
  }

  if (problems.length === 0) {
    console.log(chalk.green('daemon: healthy'));
    return;
  }
  console.log(chalk.bold(`daemon: ${problems.length} problem(s)\n`));
  for (const p of problems) console.log(`  ${chalk.red('✗')} ${p}`);
  process.exitCode = 1;
}


function requirePositiveInt(raw: string, label: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(chalk.red(`${label} must be a positive integer (got '${raw}').`));
    process.exit(1);
  }
  return parsed;
}

function registerWebhooksSubcommand(parent: Command): void {
  const webhooks = parent
    .command('webhooks')
    .description('Signed webhook receivers this box hosts as a supervised daemon service.')
    .option('--json', 'Emit as JSON')
    .action((opts, command) => {
      runWebhooksList(command.optsWithGlobals().json === true);
    });

  setHelpSections(webhooks, {
    examples: `
      # What this box hosts today
      agents daemon webhooks list

      # Host a receiver on the default port, signing secrets from a bundle
      agents daemon webhooks add --secrets-bundle linear-webhook

      # A second receiver on its own port, publicly exposed via Tailscale Funnel
      agents daemon webhooks add --secrets-bundle gh-webhook --port 8788 --funnel-port 443

      # Apply the change (the running daemon rebinds on restart)
      agents daemon restart

      # Stop hosting the receiver bound to a port
      agents daemon webhooks remove 8788
    `,
    notes: `
      The bundle must hold GITHUB_WEBHOOK_SECRET and/or LINEAR_WEBHOOK_SECRET
      ('agents secrets add <bundle> LINEAR_WEBHOOK_SECRET'). The daemon reads it
      headlessly through the standalone 'secrets' CLI, so a hosted receiver needs
      no AGENTS_SECRETS_PASSPHRASE and no nohup. A LOCKED bundle fails that receiver
      loud in 'agents daemon logs' rather than binding unverified ingress.

      Port is the identity: a second 'add' on the same port edits that receiver.
      Funnel ports are limited by Tailscale to 443, 8443, and 10000.
    `,
  });

  webhooks
    .command('list')
    .description('List the receivers declared for this box.')
    .option('--json', 'Emit as JSON')
    .action((opts, command) => {
      runWebhooksList(command.optsWithGlobals().json === true || opts.json === true);
    });

  webhooks
    .command('add')
    .description('Declare a receiver on this box. Replaces any receiver already on the same port.')
    .requiredOption('--secrets-bundle <name>', 'agents secrets bundle holding GITHUB_WEBHOOK_SECRET and/or LINEAR_WEBHOOK_SECRET')
    .option('-p, --port <n>', `Local bind port (default ${DEFAULT_WEBHOOK_PORT})`)
    .option('--rate-limit <n>', `Accepted deliveries per source per minute (default ${DEFAULT_WEBHOOK_RATE_LIMIT})`)
    .option('--funnel-port <n>', 'Expose publicly on this Tailscale Funnel port (443 | 8443 | 10000)')
    .action((opts: { secretsBundle: string; port?: string; rateLimit?: string; funnelPort?: string }) => {
      const receiver: HostedReceiverConfig = { bundle: opts.secretsBundle };
      if (opts.port !== undefined) receiver.port = requirePositiveInt(opts.port, '--port');
      if (opts.rateLimit !== undefined) receiver.rateLimit = requirePositiveInt(opts.rateLimit, '--rate-limit');
      if (opts.funnelPort !== undefined) {
        try {
          receiver.funnel = { publicPort: parseFunnelPort(opts.funnelPort) };
        } catch (err) {
          console.error(chalk.red((err as Error).message));
          process.exit(1);
        }
      }
      addHostedReceiver(receiver);
      const port = hostedReceiverPort(receiver);
      console.log(chalk.green(`Hosting a webhook receiver on 127.0.0.1:${port}`) + chalk.gray(` (bundle ${receiver.bundle})`));
      if (receiver.funnel) console.log(chalk.gray(`  public: Tailscale Funnel :${receiver.funnel.publicPort} → localhost:${port}`));
      console.log(chalk.gray(`  config: ${getDaemonWebhooksConfigPath()}`));
      console.log(chalk.gray(isDaemonRunning()
        ? '  run `agents daemon restart` to bind it'
        : '  run `agents daemon start` to bind it'));
    });

  webhooks
    .command('remove <port>')
    .description('Stop hosting the receiver bound to this port.')
    .action((portArg: string) => {
      const port = requirePositiveInt(portArg, 'port');
      const removed = removeHostedReceiver(port);
      if (!removed) {
        console.error(chalk.red(`No receiver declared on port ${port}. Run 'agents daemon webhooks list'.`));
        process.exit(1);
      }
      console.log(chalk.green(`Removed the webhook receiver on port ${port}.`));
      if (removed.funnel) {
        console.log(chalk.yellow(`  public ingress is still up on :${removed.funnel.publicPort} — take it down:`));
        console.log(chalk.gray(`    agents daemon funnel down <host> --port ${removed.funnel.publicPort}`));
      }
      if (isDaemonRunning()) console.log(chalk.gray('  run `agents daemon restart` to release the port'));
    });
}

function runWebhooksList(json: boolean): void {
  const { receivers } = readDaemonWebhooksConfig();
  if (json) {
    console.log(JSON.stringify(receivers.map((r) => ({
      bundle: r.bundle,
      port: hostedReceiverPort(r),
      rateLimit: r.rateLimit ?? DEFAULT_WEBHOOK_RATE_LIMIT,
      funnelPort: r.funnel?.publicPort ?? null,
    })), null, 2));
    return;
  }
  if (receivers.length === 0) {
    console.log(chalk.gray('No webhook receivers declared on this box — the daemon binds nothing.'));
    console.log(chalk.gray('Add one: agents daemon webhooks add --secrets-bundle <name>'));
    return;
  }
  console.log(chalk.bold('Hosted webhook receivers'));
  for (const r of receivers) {
    const port = hostedReceiverPort(r);
    const funnel = r.funnel ? chalk.cyan(` public :${r.funnel.publicPort}`) : chalk.gray(' localhost only');
    console.log(`  127.0.0.1:${String(port).padEnd(6)} ${chalk.gray(`bundle ${r.bundle}`)}${funnel}`);
    console.log(chalk.gray(`    endpoints: /hooks/github, /hooks/linear, /hooks/slack · ${r.rateLimit ?? DEFAULT_WEBHOOK_RATE_LIMIT}/min per source`));
  }
  console.log(chalk.gray(`\nConfig: ${getDaemonWebhooksConfigPath()}`));
  console.log(chalk.gray('Changes take effect on the next daemon restart.'));
}


export function registerDaemonCommand(program: Command): void {
  const cmd = program
    .command('daemon')
    .description('The always-on daemon: watchdog, session/usage sync, and the routines scheduler. Bare `agents daemon` shows status.')
    .option('--json', 'Emit as JSON')
    .action(async (opts, command) => {
      await runStatus({ json: command.optsWithGlobals().json === true });
    });

  setHelpSections(cmd, {
    examples: `
      # Identity, duplicates, and per-service health in one view
      agents daemon status

      # Machine-readable status (for scripts / AGI EXT)
      agents daemon status --json

      # Start / stop / restart the daemon process
      agents daemon start
      agents daemon stop
      agents daemon restart

      # Persist the daemon off — nothing auto-starts it until re-enabled
      agents daemon disable
      agents daemon enable

      # Reload config (SIGHUP) without restarting — picks up routine/scheduler-gate changes
      agents daemon reload

      # Every registered service — state, enabled, failures, last error
      agents daemon services

      # Toggle or restart a service live — applies without a daemon restart
      # for supervisor-managed services (account-state, session-index,
      # watchdog, device-probe, self-heal, state-dir-check)
      agents daemon services disable account-state
      agents daemon services enable account-state
      agents daemon services restart account-state

      # Host a signed webhook receiver here, supervised and restarted on crash
      agents daemon webhooks add --secrets-bundle linear-webhook
      agents daemon webhooks list

      # Manage public ingress for daemon-world webhook receivers
      agents daemon funnel status yosemite-s0
      agents daemon funnel up yosemite-s0 --local-port 8787 --port 443

      # Tail the daemon's own log, warnings and up, from the last hour
      agents daemon logs -f --level warn --since 1h

      # Trace every service tick and slow section while diagnosing (applies live)
      agents daemon logs level debug

      # One-shot health check for scripts (non-zero exit on problems)
      agents daemon doctor

      # Session-index maintenance, in the foreground (never starts the daemon)
      agents daemon index optimize
      agents daemon index backfill tools --fleet
    `,
    notes: `
      There is no 'agents daemon jobs' — scheduled work is 'agents routines',
      always. Use 'agents routines stats' for per-routine failure detail.

      'disable' is a persisted kill switch: it stops routines/add,
      routines/start, routines/catchup, and webhook triggers from auto-starting
      the daemon (daemon.enabled: false in ~/.agents/devices/<host>/agents.yaml).
      'agents daemon start' still starts it explicitly, same as
      'systemctl start' on a disabled unit.

      Under a redirected HOME (a test/e2e harness), 'agents daemon start'
      REFUSES to launch: a daemon started there keeps its own pid file under
      the temp home and leaks, invisible to the real install (W4, PHNX-3736).
      'daemon restart' inherits the same guard — it stops first, so run it
      with the same opt-in. A deliberate test launch sets
      AGENTS_ALLOW_TEST_DAEMON=1 — and the harness owns stopping what it
      started. 'agents doctor' flags any leaked daemon that already exists,
      with its HOME and start time.

      'agents daemon services enable|disable|restart <id>' applies live (no
      daemon restart) for supervisor-managed services that were registered at
      boot. The inline scheduler re-evaluates its toggle on every reload as
      well. A boot-disabled service other than webhook-receiver still needs
      an operator 'agents daemon restart'. 'agents
      daemon services' names which case you're in per row.
    `,
  });

  cmd.command('status')
    .description('Identity (state/pid/uptime/binary), duplicate daemons, daemons running deleted code, and per-service health.')
    .option('--json', 'Emit as JSON')
    .action(async (opts, command) => {
      await runStatus({ json: command.optsWithGlobals().json === true });
    });

  cmd.command('start')
    .description('Start the daemon. Bypasses daemon.enabled — this is the deliberate override.')
    .action(() => {
      const result = startDaemonClean();
      if (result.method === 'already-running') {
        console.log(chalk.yellow(`Daemon already running (PID: ${result.pid})`));
      } else if (result.pid) {
        console.log(chalk.green(`Daemon started (PID: ${result.pid}, ${result.method})`));
      } else {
        console.log(chalk.yellow('Daemon start dispatched but no PID surfaced. Check: agents daemon status'));
      }
    });

  cmd.command('stop')
    .description('Stop the daemon.')
    .option('--json', 'Emit the structured stop result (released/surviving resources, detached children).')
    .action((_opts, command) => {
      const asJson = command.optsWithGlobals().json === true;
      if (!isDaemonRunning()) {
        if (asJson) {
          console.log(JSON.stringify(
            { ok: true, stoppedPid: null, escalated: false, released: [], surviving: [], detachedChildren: [] },
            null, 2));
        } else {
          console.log(chalk.yellow('Daemon is not running'));
        }
        return;
      }
      const result = stopDaemon();
      if (asJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(result.ok ? chalk.green('Daemon stopped') : chalk.red('Daemon stop incomplete'));
        for (const r of result.released) console.log(chalk.gray(`  released: ${r}`));
        for (const s of result.surviving) console.log(chalk.red(`  surviving: ${s}`));
        if (result.detachedChildren.length > 0) {
          console.log(chalk.gray(`  detached routine children left running (adopted on next daemon start): ${result.detachedChildren.join(', ')}`));
        }
      }
      if (!result.ok) process.exitCode = 1;
    });

  cmd.command('restart')
    .description('Stop then start the daemon.')
    .action(() => {
      if (isDaemonRunning()) {
        const stop = stopDaemon();
        console.log(stop.ok ? chalk.gray('Daemon stopped') : chalk.red('Daemon stop incomplete'));
        for (const s of stop.surviving) console.log(chalk.red(`  surviving: ${s}`));
      }
      const result = startDaemonClean();
      if (result.pid) console.log(chalk.green(`Daemon started (PID: ${result.pid}, ${result.method})`));
      else console.log(chalk.yellow('Daemon start dispatched but no PID surfaced. Check: agents daemon status'));
    });

  cmd.command('enable')
    .description('Clear the daemon.enabled kill switch. Does not start the daemon by itself.')
    .action(() => {
      setConfigValue('daemon.enabled', true);
      console.log(chalk.green('daemon.enabled: true') + chalk.gray(' — auto-start surfaces (routines add/start/catchup, webhooks) may bring the daemon up again'));
    });

  cmd.command('disable')
    .description('Persist daemon.enabled: false — nothing auto-starts the daemon until re-enabled. Does not stop a running daemon.')
    .action(() => {
      setConfigValue('daemon.enabled', false);
      console.log(chalk.yellow('daemon.enabled: false') + chalk.gray(' — auto-start is off. Explicit start still works: agents daemon start'));
      if (isDaemonRunning()) console.log(chalk.gray('(the daemon is still running — stop it explicitly if you want it down: agents daemon stop)'));
    });

  cmd.command('reload')
    .description('Send SIGHUP to reload jobs and re-evaluate the scheduler.enabled gate, without a restart.')
    .action(() => {
      if (!isDaemonRunning()) {
        console.log(chalk.yellow('Daemon is not running — nothing to reload. Start it: agents daemon start'));
        return;
      }
      const ok = signalDaemonReload();
      console.log(ok ? chalk.green('Daemon reloaded') : chalk.yellow('Reload signal not delivered (unsupported on this platform, or the daemon just exited)'));
    });

  const servicesCmd = cmd
    .command('services')
    .description('Every registered daemon service: live health, enabled state, and live enable/disable/restart.')
    .option('--json', 'Emit as JSON')
    .action(async (opts, command) => {
      await runServices({ json: command.optsWithGlobals().json === true });
    });

  setHelpSections(servicesCmd, {
    examples: `
      # State, enabled, consecutive failures, last error for every service
      agents daemon services

      # Machine-readable — additive: also carries the pre-existing
      # secretsBroker (reachability-only probe, PHNX-3989)/browserIpc
      # hosted-socket fields
      agents daemon services --json

      # Just the enable/disable metadata, no health probe
      agents daemon services list

      # Toggle or restart live — no daemon restart for a supervisor-managed
      # service (account-state, session-index)
      agents daemon services disable account-state
      agents daemon services enable account-state
      agents daemon services restart account-state
    `,
    notes: `
      A service disabled at daemon boot is normally not registered on the
      supervisor, so enabling it needs an operator restart. The inline
      scheduler applies enable/disable on reload; webhook-receiver still
      requires 'agents daemon restart'. Each row in
      the plain-text view names which case it is; 'supervised: true/false' does
      the same in --json.
    `,
  });

  servicesCmd
    .command('list')
    .description('List every daemon service and whether it is enabled.')
    .option('--json', 'Emit as JSON')
    .action(async (opts, command) => {
      const json = command.optsWithGlobals().json === true;
      const states = listDaemonServiceStates();
      if (json) {
        console.log(JSON.stringify(states.map((s) => ({
          id: s.id,
          title: s.title,
          enabled: s.enabled,
          description: s.description,
        })), null, 2));
        return;
      }
      console.log(chalk.bold('Daemon services'));
      for (const s of states) {
        const state = s.enabled ? chalk.green('enabled') : chalk.gray('disabled');
        console.log(`  ${s.id.padEnd(18)} ${state}`);
        console.log(`    ${chalk.gray(s.description)}`);
      }
      console.log(chalk.gray(`\nConfig: ${getDaemonServicesConfigPath()}`));
      console.log(chalk.gray('Changes take effect on the next daemon reload or restart.'));
    });

  function applyServiceToggleLive(service: string): void {
    if (!isDaemonRunning()) return;
    const ok = signalDaemonReload();
    console.log(ok
      ? chalk.gray('Signalled the daemon to apply live. Confirm: agents daemon services')
      : chalk.yellow('Reload signal not delivered — restart the daemon to apply: agents daemon restart'));
  }

  servicesCmd
    .command('enable <service>')
    .description('Enable a daemon service. Applies live for supervised services; a legacy service needs a restart.')
    .action((service: string) => {
      if (!DAEMON_SERVICE_IDS.includes(service as DaemonServiceId)) {
        console.error(chalk.red(`Unknown service '${service}'. Run 'agents daemon services list' for valid services.`));
        process.exit(1);
      }
      setDaemonServiceEnabled(service as DaemonServiceId, true);
      console.log(chalk.green(`Enabled '${service}'.`));
      applyServiceToggleLive(service);
    });

  servicesCmd
    .command('disable <service>')
    .description('Disable a daemon service. Applies live for supervised services; a legacy service needs a restart.')
    .action((service: string) => {
      if (!DAEMON_SERVICE_IDS.includes(service as DaemonServiceId)) {
        console.error(chalk.red(`Unknown service '${service}'. Run 'agents daemon services list' for valid services.`));
        process.exit(1);
      }
      setDaemonServiceEnabled(service as DaemonServiceId, false);
      console.log(chalk.green(`Disabled '${service}'.`));
      applyServiceToggleLive(service);
    });

  servicesCmd
    .command('restart <service>')
    .description('Restart a supervised daemon service live, right now, outside its normal backoff schedule.')
    .action((service: string) => {
      if (!DAEMON_SERVICE_IDS.includes(service as DaemonServiceId)) {
        console.error(chalk.red(`Unknown service '${service}'. Run 'agents daemon services list' for valid services.`));
        process.exit(1);
      }
      if (!isDaemonRunning()) {
        console.log(chalk.yellow('Daemon is not running — nothing to restart. Start it: agents daemon start'));
        process.exit(1);
      }
      queueDaemonServiceRestart(service as DaemonServiceId);
      const ok = signalDaemonReload();
      console.log(ok
        ? chalk.green(`Restart requested for '${service}'.`) + chalk.gray(' Confirm: agents daemon services')
        : chalk.yellow('Reload signal not delivered (unsupported on this platform, or the daemon just exited).'));
    });
  registerWebhooksSubcommand(cmd);
  registerFunnelCommand(cmd);
  registerDaemonIndexCommand(cmd);

  const logsCmd = cmd.command('logs')
    .description('Read the daemon\'s own log: lifecycle, every service tick, slow sections, event-loop stalls, and per-minute vitals (not routine run output).')
    .option('-n, --lines <number>', 'Show this many recent lines', '50')
    .option('-f, --follow', 'Stream new lines as they are written (like tail -f)')
    .option('--level <level>', 'Minimum level to show: debug | info | warn | error')
    .option('--since <dur>', 'Only lines newer than this (e.g. 1h, 30m)')
    .option('--json', 'Emit each line as JSON')
    .action(async (opts, command) => {
      const merged = command.optsWithGlobals();
      await runLogs({ lines: opts.lines, follow: opts.follow, level: opts.level, since: opts.since, json: merged.json === true || opts.json === true });
    });

  logsCmd.command('level [level]')
    .description('Show or set what the daemon writes: debug (every tick and span) | info (default) | warn | error. Applies live.')
    .option('--json', 'Emit as JSON')
    .action((level: string | undefined, opts, command) => {
      runLogLevel(level, { json: command.optsWithGlobals().json === true || opts.json === true });
    });

  setHelpSections(logsCmd, {
    examples: `
      # Why did it restart? Errors carry a snapshot: in-flight ticks, slow sections, vitals
      agents daemon logs --level error --since 1h

      # Event-loop stalls and slow synchronous sections, as they happen
      agents daemon logs -f --level warn

      # Turn on per-tick and per-span tracing while you diagnose, then turn it back off
      agents daemon logs level debug
      agents daemon logs -f --level debug
      agents daemon logs level info

      # Machine-readable, with each line's structured data
      agents daemon logs --since 10m --json
    `,
    notes: `
      Every line is JSON in the daemon log file (agents daemon status shows the path), with
      an optional data object. Event names: tick.slow, tick.failed, tick.breach, loop.stall,
      span.slow, vitals (once a minute), and at debug tick.start, tick.ok, span.
      The level is stored as logLevel in the daemon's services.yaml. Debug writes a line per
      tick and per section synchronously, so leave it on only while diagnosing.
    `,
  });

  cmd.command('doctor')
    .description('One-shot health check: identity, duplicates, hosted services, scheduler. Non-zero exit on problems.')
    .option('--json', 'Emit as JSON')
    .action(async (opts, command) => {
      await runDoctor({ json: command.optsWithGlobals().json === true });
    });
}
