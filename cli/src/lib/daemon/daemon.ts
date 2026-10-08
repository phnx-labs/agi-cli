import { daemonProcessViewAllowed, recordDaemonProcessView } from '../session/process-view.js';


import { spawn, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getDaemonDir } from '../state.js';
import { isolatedHomeSuffix, namespacedServiceLabel, serviceManifestHomeEnv, serviceManagerRegistrationAllowed } from '../service-manifest.js';
import { isAlive, killTree, backgroundSpawnOptions, waitForExit } from '../platform/index.js';
import { listJobs as listAllJobs, type JobConfig } from '../scheduling/routines.js';
import { syncAllProjectRoutines } from '../routines-project.js';
import { JobScheduler } from '../scheduler.js';
import { executeJobDetached, listLiveRoutineChildren } from './runner.js';
import { detectOverdueJobs, notifyOverdue } from '../overdue.js';
import { runCatchup } from '../catchup.js';
import { notifyRoutineStart, notifyRoutineFinish, notifyRoutineStartFailed } from '../routine-notify.js';
import { notifyOwnerRoutineFinish, notifyOwnerRoutineStartFailed } from '../routine-notify-owner.js';
import { describeOwnerResult } from '../owner-notify.js';
import { redactSecrets } from '../redact.js';
import { getAgentsBinPath, getCliLaunch, BUN_VIRTUAL_ROOT } from '../cli-entry.js';
import { localBinDir } from '../platform/posixpath.js';
import { isSchedulerEnabled, assertSchedulerEnabled, isDaemonEnabled } from '../device-config.js';
import { recordSubsystemOk, recordSubsystemError, recordSubsystemErrorReason, readSubsystemHealth, readRecentDaemonRestarts, SUBSYSTEM_DAEMON_START } from '../daemon-health.js';
import { ServiceSupervisor } from './supervisor.js';
import type { ServiceHealth } from './service.js';
import { emit, emitAsync, emitRoutineEnd } from '../feed/events.js';
import { readDaemonServicesConfig, isDaemonServiceEnabled, drainDaemonServiceRestartQueue, type DaemonServiceId } from '../daemon-services.js';
import { sleepSync } from '../fs-atomic.js';

let activeServiceSupervisor: ServiceSupervisor | null = null;

export function getServiceSupervisorHealth(): Record<string, ServiceHealth> | null {
  return activeServiceSupervisor?.health() ?? null;
}

const PID_FILE = 'daemon.pid';
const LIFETIME_FILE = 'daemon.lifetime';
const LOCK_FILE = 'daemon.lock';
const LOG_FILE = 'logs.jsonl';
const HEARTBEAT_FILE = 'heartbeat.json';
const LOG_MAX_SIZE = 5 * 1024 * 1024;
const LOG_ROTATE_COUNT = 3;
const PLIST_NAME = 'com.phnx-labs.agents-daemon';
const SYSTEMD_UNIT = 'agents-daemon.service';

// Redirected HOME instances namespace manager ids because launchd/systemd key by label/unit, not manifest path; tests must never unload production.
export function productionDaemonServiceNames(): { systemdUnit: string; launchdLabel: string } {
  return { systemdUnit: SYSTEMD_UNIT, launchdLabel: PLIST_NAME };
}

export { isolatedHomeSuffix };

export function daemonServiceLabel(): string {
  return namespacedServiceLabel(PLIST_NAME);
}

export function daemonSystemdUnitName(): string {
  const suffix = isolatedHomeSuffix();
  return suffix ? `agents-daemon-sandbox-${suffix}.service` : SYSTEMD_UNIT;
}


const WEDGE_THRESHOLD_TICKS = 3;
const DAEMON_HEARTBEAT_TICK_MS = 60_000;

const DAEMON_THROTTLE_SECONDS = 30;

export const DAEMON_AUTOSTART_FAILURE_LIMIT = 5;

// A scheduler gate reload has exactly four truthful outcomes: boot, reload, stop, or remain dark.
type SchedulerGateTransition = 'reload' | 'stop' | 'boot' | 'none';

export function schedulerGateTransition(running: boolean, enabled: boolean): SchedulerGateTransition {
  if (running) return enabled ? 'reload' : 'stop';
  return enabled ? 'boot' : 'none';
}

// Latch before the first await and never retry after rejection: daemon shutdown is single-shot.
export function singleShot(fn: () => Promise<void>): () => Promise<void> {
  let ran = false;
  return async () => {
    if (ran) return;
    ran = true;
    await fn();
  };
}

function ensureDaemonDir(): string {
  const dir = getDaemonDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getPidPath(): string {
  return path.join(ensureDaemonDir(), PID_FILE);
}

function getLockPath(): string {
  return path.join(ensureDaemonDir(), LOCK_FILE);
}

// Start, claim, and stop share this O_EXCL lifecycle lock; unreadable live identity is unverified, never stale.
function acquireStartLock(): (() => void) | null {
  const lockPath = getLockPath();
  try {
    const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return () => {
      try { fs.unlinkSync(lockPath); } catch {  }
    };
  } catch (err: any) {
    if (err.code === 'EEXIST') {
      try {
        const holderPid = parseInt(fs.readFileSync(lockPath, 'utf-8').trim(), 10);
        if (!isNaN(holderPid)) {
          try {
            process.kill(holderPid, 0);
            return null;
          } catch {
            fs.unlinkSync(lockPath);
            return acquireStartLock();
          }
        }
      } catch {  }
      return null;
    }
    throw err;
  }
}

const STOP_LOCK_WAIT_MS = 10_000;
const STOP_LOCK_POLL_MS = 50;

function acquireLifecycleLock(): (() => void) | null {
  const deadline = Date.now() + STOP_LOCK_WAIT_MS;
  for (;;) {
    const release = acquireStartLock();
    if (release) return release;
    if (Date.now() >= deadline) return null;
    sleepSync(Math.min(STOP_LOCK_POLL_MS, deadline - Date.now()));
  }
}

export function getDaemonLogPath(): string {
  return path.join(ensureDaemonDir(), LOG_FILE);
}

function getLaunchdPlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${daemonServiceLabel()}.plist`);
}

function getSystemdUnitPath(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user', daemonSystemdUnitName());
}

export function readDaemonPid(daemonDir?: string): number | null {
  const pidPath = daemonDir ? path.join(daemonDir, PID_FILE) : getPidPath();
  if (!fs.existsSync(pidPath)) return null;
  try {
    const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function writeDaemonPid(pid: number): void {
  fs.writeFileSync(getPidPath(), String(pid), 'utf-8');
}

export function removeDaemonPid(): void {
  const pidPath = getPidPath();
  if (fs.existsSync(pidPath)) {
    fs.unlinkSync(pidPath);
  }
}

// Remove registration only while it still names the owner observed by this cleanup.
function removeDaemonPidIfOwned(pid: number): boolean {
  if (readDaemonPid() !== pid) return false;
  try { fs.unlinkSync(getPidPath()); } catch {  }
  return readDaemonPid() !== pid;
}

interface DaemonHeartbeat {
  lastTick: string;
  pid: number;
}

function getHeartbeatPath(): string {
  return path.join(ensureDaemonDir(), HEARTBEAT_FILE);
}

export function writeHeartbeat(pid: number = process.pid): void {
  const hb: DaemonHeartbeat = { lastTick: new Date().toISOString(), pid };
  try {
    fs.writeFileSync(getHeartbeatPath(), JSON.stringify(hb), 'utf-8');
  } catch {  }
}

export function readHeartbeat(): DaemonHeartbeat | null {
  try {
    const raw = fs.readFileSync(getHeartbeatPath(), 'utf-8');
    const hb = JSON.parse(raw) as DaemonHeartbeat;
    if (!hb.lastTick || !hb.pid) return null;
    return hb;
  } catch {
    return null;
  }
}

export function removeHeartbeat(): void {
  try { fs.unlinkSync(getHeartbeatPath()); } catch {  }
}

function isHeartbeatFresh(hb: DaemonHeartbeat): boolean {
  const elapsed = Date.now() - Date.parse(hb.lastTick);
  return elapsed <= WEDGE_THRESHOLD_TICKS * DAEMON_HEARTBEAT_TICK_MS;
}

const STOP_GRACE_MS = 5000;
const STOP_KILL_GRACE_MS = 2000;

// A fresh heartbeat may repair a lost pid record; unknown identity is preserved so inspection failure cannot create a second daemon.
function resolveLiveDaemonPid(repair: boolean = false): number | null {
  const pid = readDaemonPid();
  const pidIdentity = pid !== null ? daemonProcessIdentity(pid) : 'dead';
  if (pid !== null && pidIdentity === 'daemon') return pid;
  const hb = readHeartbeat();
  if (hb && isHeartbeatFresh(hb) && daemonProcessIdentity(hb.pid) === 'daemon') {
    if (repair && pid !== hb.pid) writeDaemonPid(hb.pid);
    return hb.pid;
  }
  if (repair && pid !== null && pidIdentity !== 'unknown') removeDaemonPidIfOwned(pid);
  return null;
}

function unverifiedLiveDaemonPid(): number | null {
  const pid = readDaemonPid();
  if (pid !== null && daemonProcessIdentity(pid) === 'unknown') return pid;
  const hb = readHeartbeat();
  if (hb && isHeartbeatFresh(hb) && daemonProcessIdentity(hb.pid) === 'unknown') return hb.pid;
  return null;
}

export function isDaemonRunning(): boolean {
  if (unverifiedLiveDaemonPid() !== null) return true;
  const recordedPid = readDaemonPid();
  const livePid = resolveLiveDaemonPid();
  if (recordedPid === livePid) return livePid !== null;

  const release = acquireStartLock();
  if (!release) return livePid !== null;
  try {
    return resolveLiveDaemonPid(true) !== null;
  } finally {
    release();
  }
}

export function claimDaemonInstance(): boolean {
  if (!daemonProcessViewAllowed()) {
    console.error('Daemon startup requires the owning process namespace. Automatic reuse of a private-container HOME across namespaces is unsupported; run in its owning namespace or use a fresh HOME.');
    return false;
  }
  const release = acquireLifecycleLock();
  if (!release) return false;
  try {
    if (!daemonProcessViewAllowed()) return false;
    recordDaemonProcessView();
    if (unverifiedLiveDaemonPid() !== null) return false;
    const existing = resolveLiveDaemonPid(true);
    if (existing !== null && existing !== process.pid) {
      if (!evictIncumbentDaemon(existing)) return false;
    }
    writeDaemonPid(process.pid);
    return true;
  } finally {
    release();
  }
}

function evictIncumbentDaemon(pid: number): boolean {
  const beforeSignal = daemonProcessIdentity(pid);
  if (beforeSignal === 'dead' || beforeSignal === 'other') return true;
  if (beforeSignal === 'unknown') return false;

  if (process.platform === 'win32') {
    killTree(pid);
    if (waitForExit(pid, STOP_KILL_GRACE_MS)) return true;
    const afterKill = daemonProcessIdentity(pid);
    return afterKill === 'dead' || afterKill === 'other';
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    const afterSignal = daemonProcessIdentity(pid);
    return afterSignal === 'dead' || afterSignal === 'other';
  }
  if (waitForExit(pid, STOP_GRACE_MS)) return true;
  const beforeKill = daemonProcessIdentity(pid);
  if (beforeKill === 'dead' || beforeKill === 'other') return true;
  if (beforeKill === 'unknown') return false;
  killTree(pid);
  if (waitForExit(pid, STOP_KILL_GRACE_MS)) return true;
  const afterKill = daemonProcessIdentity(pid);
  return afterKill === 'dead' || afterKill === 'other';
}

function getDaemonInstancesDir(): string {
  return path.join(getDaemonDir(), 'instances');
}

export function registerDaemonInstance(pid: number = process.pid): void {
  if (process.platform === 'win32') return;
  try {
    const dir = getDaemonInstancesDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, String(pid)), process.argv.slice(1).join(' '), 'utf-8');
  } catch {  }
}

export function unregisterDaemonInstance(pid: number = process.pid): void {
  if (process.platform === 'win32') return;
  try { fs.rmSync(path.join(getDaemonInstancesDir(), String(pid)), { force: true }); } catch {  }
}

export function reapStrayDaemons(keepPid: number = process.pid): { reaped: number; details: string[] } {
  const details: string[] = [];
  let reaped = 0;
  if (process.platform === 'win32') return { reaped, details };

  const dir = getDaemonInstancesDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { reaped, details };
  }

  const ownerPid = resolveLiveDaemonPid();
  const dropMarker = (name: string): void => {
    try { fs.rmSync(path.join(dir, name), { force: true }); } catch {  }
  };

  for (const name of entries) {
    const pid = parseInt(name, 10);
    if (isNaN(pid) || String(pid) !== name) continue;
    if (pid === keepPid || pid === process.pid || pid === ownerPid) continue;

    if (!isAlive(pid)) { dropMarker(name); continue; }

    const identity = daemonProcessIdentity(pid);
    if (identity === 'unknown') {
      details.push(`could not verify stray daemon pid ${pid}; marker retained`);
      continue;
    }
    if (identity !== 'daemon') { dropMarker(name); continue; }

    try {
      process.kill(pid, 'SIGTERM');
    } catch {  }
    if (waitForExit(pid, STOP_GRACE_MS)) {
      reaped++;
      details.push(`reaped stray daemon pid ${pid}`);
      dropMarker(name);
      continue;
    }

    const beforeKill = daemonProcessIdentity(pid);
    if (beforeKill === 'unknown') {
      details.push(`could not reverify stray daemon pid ${pid}; marker retained`);
      continue;
    }
    if (beforeKill !== 'daemon') {
      dropMarker(name);
      continue;
    }
    killTree(pid);
    if (waitForExit(pid, STOP_KILL_GRACE_MS)) {
      reaped++;
      details.push(`reaped stray daemon pid ${pid} (escalated)`);
      dropMarker(name);
    } else {
      details.push(`stray daemon pid ${pid} survived SIGKILL`);
    }
  }
  return { reaped, details };
}

type DaemonProcessIdentity = 'daemon' | 'other' | 'dead' | 'unknown';

function daemonProcessIdentity(pid: number): DaemonProcessIdentity {
  if (!isAlive(pid)) return 'dead';
  try {
    const out = process.platform === 'win32'
      ? execFileSync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
          { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5000 },
        )
      : execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
    return /(?:^|\s)["']?__daemon-run["']?\s*$/.test(out.trim()) ? 'daemon' : 'other';
  } catch {
    return 'unknown';
  }
}

export function isLiveDaemon(pid: number): boolean {
  return daemonProcessIdentity(pid) === 'daemon';
}

function rotateLogsIfNeeded(logPath: string): void {
  try {
    const stat = fs.statSync(logPath);
    if (stat.size < LOG_MAX_SIZE) return;
    for (let i = LOG_ROTATE_COUNT - 1; i >= 1; i--) {
      const older = `${logPath}.${i}`;
      const newer = i === 1 ? logPath : `${logPath}.${i - 1}`;
      if (fs.existsSync(newer)) fs.renameSync(newer, older);
    }
    if (fs.existsSync(logPath)) fs.renameSync(logPath, `${logPath}.1`);
  } catch {}
}

export function log(level: string, message: string): void {
  const logPath = getDaemonLogPath();
  rotateLogsIfNeeded(logPath);
  const entry = { ts: new Date().toISOString(), level: level.toUpperCase(), message: redactSecrets(message) };
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');
  try { fs.chmodSync(logPath, 0o600); } catch {  }
  try {
    const lvl = level.toUpperCase();
    const event =
      lvl === 'ERROR' || lvl === 'FATAL' ? 'daemon.error' as const
      : lvl === 'START' || /starting|started/i.test(message) ? 'daemon.start' as const
      : lvl === 'STOP' || /stopping|stopped|shutting down/i.test(message) ? 'daemon.stop' as const
      : 'daemon.info' as const;
    void emitAsync(event, {
      module: 'daemon',
      detail: redactSecrets(message).slice(0, 500),
      status: lvl,
    }).catch(() => {  });
  } catch {  }
}

export function guardSignalHandler(handler: () => void, onError: (err: unknown) => void): () => void {
  return () => {
    try {
      handler();
    } catch (err) {
      onError(err);
    }
  };
}

export function anchorDaemonCwd(): string | null {
  const home = os.homedir();
  try {
    process.chdir(home);
    return home;
  } catch (err) {
    log('WARN', `Could not anchor daemon cwd to ${home}: ${(err as Error).message}`);
    return null;
  }
}

export function warnEphemeralDaemonRoot(resolveBin: () => string = getAgentsBinPath): string | null {
  try {
    const bin = resolveBin();
    const ephemeralRoot = describeEphemeralDaemonRoot(bin);
    if (!ephemeralRoot) return null;
    const message =
      `Daemon launched from ${ephemeralRoot} (${bin}); if that directory is removed, ` +
      `every routine will fail with ENOENT on its module imports. Run the daemon from the ` +
      `globally installed binary instead (npm i -g @phnx-labs/agents-cli), then restart it.`;
    log('WARN', message);
    return message;
  } catch (err) {
    log('WARN', `Could not check daemon launch root: ${(err as Error).message}`);
    return null;
  }
}

export function assertTestDaemonHome(
  daemonDir: string = getDaemonDir(),
  testHome: string | undefined = process.env.AGENTS_DAEMON_TEST_HOME,
): void {
  if (!testHome) return;
  const root = path.resolve(testHome);
  const dir = path.resolve(daemonDir);
  if (dir !== root && !dir.startsWith(root + path.sep)) {
    const msg =
      `Daemon test-home tripwire (PHNX-2545): AGENTS_DAEMON_TEST_HOME is ${root}, but this ` +
      `daemon's state dir resolved to ${dir} — the isolated HOME override did not reach this ` +
      `__daemon-run child, so it would schedule against the real host. Refusing to start.`;
    log('ERROR', msg);
    throw new Error(msg);
  }
}


export async function runDaemon(): Promise<void> {
  assertTestDaemonHome();

  const [
    { SessionIndexService },
    { SessionSummarizerService },
    { SessionTitleService },
    { AccountUsageService, AccountAuthService },
    { CatchupService },
    { WatchdogService },
    { DeviceProbeService },
    { SelfHealService },
    { SelfUpdateService },
    { HarnessUpdateService },
    { AuthSyncService },
    { UsageSyncService },
    { StateDirCheckService },
    { SessionStateService },
    { FeedStreamService },
    { AttentionNotifyService },
    { OwnerDeviceDeliveryService },
    { RecordingsService },
    { WebhookReceiverService },
    { HeartbeatService },
    { TmuxReapService },
  ] = await Promise.all([
    import('./session-index-service.js'),
    import('./session-summarizer-service.js'),
    import('./session-title-service.js'),
    import('./account-state-daemon-service.js'),
    import('./catchup-service.js'),
    import('./watchdog-service.js'),
    import('./device-probe-service.js'),
    import('./self-heal-service.js'),
    import('./self-update-service.js'),
    import('./harness-update-service.js'),
    import('./auth-sync-service.js'),
    import('./usage-sync-service.js'),
    import('./state-dir-check-service.js'),
    import('./session-state-service.js'),
    import('./feed-stream-service.js'),
    import('./attention-notify-service.js'),
    import('./owner-device-delivery-service.js'),
    import('../recordings/service.js'),
    import('./webhook-receiver-service.js'),
    import('./heartbeat-service.js'),
    import('./tmux-reap-service.js'),
  ]);

  let reloadRequestedDuringStartup = false;
  let liveReloadHandler: (() => void) | null = null;
  const dispatchReloadSignal = () => {
    if (liveReloadHandler) liveReloadHandler();
    else reloadRequestedDuringStartup = true;
  };
  if (process.platform !== 'win32') process.on('SIGHUP', dispatchReloadSignal);

  if (!claimDaemonInstance()) {
    if (process.platform !== 'win32') process.removeListener('SIGHUP', dispatchReloadSignal);
    log('WARN', `Another daemon owns lifecycle state or is mid-takeover; this instance (PID ${process.pid}) is exiting`);
    process.exit(0);
  }

  const startupDelayRaw = process.env.AGENTS_DAEMON_TEST_STARTUP_DELAY_MS;
  if (process.env.AGENTS_DAEMON_TEST_HOME && startupDelayRaw) {
    const startupDelayMs = Number(startupDelayRaw);
    if (!Number.isInteger(startupDelayMs) || startupDelayMs < 1 || startupDelayMs > 10_000) {
      throw new Error('AGENTS_DAEMON_TEST_STARTUP_DELAY_MS must be an integer from 1 to 10000');
    }
    await new Promise((resolve) => setTimeout(resolve, startupDelayMs));
  }
  const lifetimePath = path.join(getDaemonDir(), LIFETIME_FILE);
  const lifetimeToken = `${process.pid}:${Date.now()}`;
  fs.writeFileSync(lifetimePath, lifetimeToken, 'utf-8');
  log('INFO', `Daemon started (PID: ${process.pid})`);

  anchorDaemonCwd();
  warnEphemeralDaemonRoot();

  try {
    const { migrateDeviceConfigStores } = await import('../devices/config-migration.js');
    migrateDeviceConfigStores();
  } catch (err) {
    log('WARN', `device config migration failed: ${(err as Error).message}`);
  }

  try {
    const { reconcileSessionHooks } = await import('../tmux/session.js');
    const { isTmuxInstalled } = await import('../tmux/binary.js');
    if (isTmuxInstalled()) {
      const r = await reconcileSessionHooks();
      if (r.reconciled > 0) log('INFO', `tmux: retrofitted pane-died hook on ${r.reconciled}/${r.scanned} session(s)`);
    }
  } catch (err) {
    log('WARN', `tmux hook reconcile failed: ${(err as Error).message}`);
  }

  let servicesConfig = readDaemonServicesConfig();
  const isEnabled = (id: DaemonServiceId): boolean => servicesConfig.services[id] !== false;


  registerDaemonInstance();
  try {
    const strays = reapStrayDaemons();
    if (strays.reaped > 0) {
      log('WARN', `Reaped ${strays.reaped} stray daemon process(es)`);
      for (const d of strays.details) log('WARN', `  ${d}`);
    }
  } catch (err) {
    log('ERROR', `Stray daemon reaper failed: ${(err as Error).message}`);
  }

  const supervisor = new ServiceSupervisor();

  if (isEnabled('session-state')) {
    supervisor.register(new SessionStateService(() => supervisor.runNow('session-state')));
  } else log('INFO', 'Live session-state service disabled');

  supervisor.register(new FeedStreamService(), { enabled: isEnabled('feed-stream') });
  if (!isEnabled('feed-stream')) log('INFO', 'Shared feed stream service disabled');

  supervisor.register(new RecordingsService(), { enabled: isEnabled('recordings') });
  if (!isEnabled('recordings')) log('INFO', 'CleanShot recordings service disabled');

  if (isEnabled('account-state')) supervisor.register(new AccountUsageService());
  else log('INFO', 'Account-state service disabled');

  if (isEnabled('account-auth')) supervisor.register(new AccountAuthService());
  else log('INFO', 'Account-auth service disabled');

  let scheduler: JobScheduler | null = null;

  if (isEnabled('catchup')) {
    supervisor.register(new CatchupService({
      isSchedulerBooted: () => scheduler !== null,
      runPass: (signal) => catchupPass(signal),
    }));
  } else {
    log('INFO', 'Catch-up recovery service disabled');
  }


  if (isEnabled('session-index')) supervisor.register(new SessionIndexService());
  else log('INFO', 'Session-index warm service disabled');

  if (isEnabled('session-summarizer')) supervisor.register(new SessionSummarizerService());
  else log('INFO', 'Session summarizer service disabled');

  if (isEnabled('attention-notify')) supervisor.register(new AttentionNotifyService());
  else log('INFO', 'Attention-notify service disabled');

  if (process.platform === 'darwin') {
    if (isEnabled('owner-device-delivery')) supervisor.register(new OwnerDeviceDeliveryService());
    else log('INFO', 'Owner device-delivery service disabled');
  }

  if (isEnabled('session-title')) supervisor.register(new SessionTitleService());
  else log('INFO', 'Session-title service disabled');

  if (isEnabled('watchdog')) supervisor.register(new WatchdogService());
  else log('INFO', 'Watchdog service disabled');

  if (isEnabled('device-probe')) supervisor.register(new DeviceProbeService());
  else log('INFO', 'Device-probe service disabled');

  if (isEnabled('self-heal')) supervisor.register(new SelfHealService());
  else log('INFO', 'Self-heal service disabled');

  if (isEnabled('self-update')) supervisor.register(new SelfUpdateService());
  else log('INFO', 'Self-update service disabled');

  if (isEnabled('harness-update')) supervisor.register(new HarnessUpdateService());
  else log('INFO', 'Harness-update service disabled');

  if (isEnabled('auth-sync')) supervisor.register(new AuthSyncService());
  else log('INFO', 'Auth-sync service disabled');

  if (isEnabled('usage-sync')) supervisor.register(new UsageSyncService());
  else log('INFO', 'Usage-sync service disabled');

  if (isEnabled('webhook-receiver')) supervisor.register(new WebhookReceiverService());
  else log('INFO', 'Webhook receiver service disabled');

  if (isEnabled('daemon-heartbeat')) supervisor.register(new HeartbeatService(() => writeHeartbeat()));
  else log('INFO', 'Daemon heartbeat service disabled');

  if (isEnabled('tmux-reap')) supervisor.register(new TmuxReapService());
  else log('INFO', 'Tmux reap service disabled');

  await supervisor.startAll({ log });
  activeServiceSupervisor = supervisor;

  const schedulerEnabledAtBoot = isSchedulerEnabled() && isEnabled('scheduler');
  if (!schedulerEnabledAtBoot) {
    try {
      assertSchedulerEnabled();
    } catch (err) {
      log('WARN', (err as Error).message);
    }
    if (!isEnabled('scheduler')) log('INFO', 'Scheduler service disabled; no routines will fire');
  }

  const triggerJob = async (config: JobConfig, ctx?: { scheduledFor?: Date }) => {
    const jobLabel = config.command
      ? 'command'
      : config.workflow
        ? `workflow: ${config.workflow}`
        : `agent: ${config.agent}`;
    log('INFO', `Triggering job '${config.name}' (${jobLabel})`);
    emit('routine.start', {
      module: 'routine',
      name: config.name,
      kind: config.command ? 'command' : config.workflow ? 'workflow' : 'agent',
      ...(config.agent ? { agent: config.agent } : {}),
      ...(config.workflow ? { workflow: config.workflow } : {}),
    });
    try { notifyRoutineStart(config); } catch {  }
    try {
      const meta = await executeJobDetached(config, {
        onFinish: (final) => {
          emitRoutineEnd(final);
          try { notifyRoutineFinish(final); } catch {  }
          void notifyOwnerRoutineFinish(final)
            .then((r) => {
              if (r && r.suppressed === null && r.delivered.length + r.queued.length === 0)
                log('WARN', `Owner failure-notify for '${config.name}' reached no channel: ${describeOwnerResult(r)}`);
            })
            .catch((err: Error) => log('WARN', `Owner failure-notify for '${config.name}' failed: ${err.message}`));
        },
      }, { kind: 'schedule', scheduledFor: ctx?.scheduledFor });
      log('INFO', `Job '${config.name}' spawned (run: ${meta.runId}, PID: ${meta.pid})`);
    } catch (err) {
      const message = (err as Error).message;
      log('ERROR', `Job '${config.name}' failed to spawn: ${message}`);
      emitRoutineEnd({
        jobName: config.name,
        status: 'failed',
        detail: redactSecrets(message).slice(0, 500),
      });
      try { notifyRoutineStartFailed(config, message); } catch {  }
      void notifyOwnerRoutineStartFailed(config, message, ctx?.scheduledFor)
        .then((r) => {
          if (r.suppressed === null && r.delivered.length + r.queued.length === 0)
            log('WARN', `Owner start-failure notify for '${config.name}' reached no channel: ${describeOwnerResult(r)}`);
        })
        .catch((err: Error) => log('WARN', `Owner start-failure notify for '${config.name}' failed: ${err.message}`));
    }
  };


  function bootScheduler(): void {
    scheduler = new JobScheduler(triggerJob);
    scheduler.loadAll();
    const scheduled = scheduler.listScheduled();
    log('INFO', `Loaded ${scheduled.length} jobs`);
    for (const job of scheduled) {
      log('INFO', `  ${job.name} -> next: ${job.nextRun?.toISOString() || 'unknown'}`);
    }
    if (supervisor.isRegistered('catchup')) supervisor.runNow('catchup');
  }

  function stopScheduler(): void {
    scheduler?.stopAll();
    scheduler = null;
  }

  try {
    const result = syncAllProjectRoutines();
    const n = result.projects.reduce((acc, p) => acc + p.synced.length, 0);
    if (n > 0) log('INFO', `Project routines sync: ${n} job(s) from ${result.projects.length} project(s)`);
  } catch (err) {
    log('WARN', `Project routines sync failed: ${(err as Error).message}`);
  }

  if (schedulerEnabledAtBoot) bootScheduler();





  async function catchupPass(signal?: AbortSignal): Promise<void> {
    try {
      const overdue = detectOverdueJobs();
      if (overdue.length === 0) return;
      log('WARN', `${overdue.length} routine(s) missed their fire:`);
      for (const job of overdue) {
        const last = job.lastRanAt ? job.lastRanAt.toISOString() : 'never';
        log('WARN', `  ${job.name} -- expected ${job.expectedAt.toISOString()}, last ran ${last}`);
      }
      if (signal?.aborted) return;
      notifyOverdue(overdue);
      const outcomes = await runCatchup({ overdue });
      for (const o of outcomes) {
        switch (o.result) {
          case 'ran':
            log('INFO', `Caught up '${o.name}' (run: ${o.runId})`);
            break;
          case 'recorded':
            log('INFO', `Recorded missed fire for '${o.name}' (catchup disabled)`);
            break;
          case 'claimed-elsewhere':
            log('INFO', `Missed fire for '${o.name}' already claimed by another catchup`);
            break;
          case 'error':
            log('ERROR', `Catchup for '${o.name}' failed: ${o.error}`);
            break;
          default: {
            const unhandled: never = o.result;
            log('ERROR', `Catchup for '${o.name}' returned an unhandled result: ${String(unhandled)}`);
          }
        }
      }
    } catch (err) {
      log('ERROR', `Catchup pass failed: ${(err as Error).message}`);
    }
  }








  // Clear the start-failure streak only after every startup subsystem is live.
  recordSubsystemOk(SUBSYSTEM_DAEMON_START);

  const handleReload = () => {
    log('INFO', 'Reloading jobs (SIGHUP)');
    const reloadedConfig = readDaemonServicesConfig();
    const reloadedEnabled = (id: DaemonServiceId): boolean => reloadedConfig.services[id] !== false;
    for (const id of Object.keys(servicesConfig.services) as DaemonServiceId[]) {
      const was = servicesConfig.services[id] !== false;
      const now = reloadedEnabled(id);
      if (was !== now) {
        if (id === 'scheduler') {
          continue;
        }
        if (supervisor.isRegistered(id)) {
          const action = supervisor.awaitIdle(id).then(() => now ? supervisor.start(id) : supervisor.stop(id));
          void action
            .then(() => log('INFO', `Service '${id}' ${now ? 'started' : 'stopped'} live (SIGHUP reload)`))
            .catch((err) => log('WARN', `Service '${id}' live ${now ? 'start' : 'stop'} failed: ${(err as Error).message}`));
        } else {
          log('INFO', `Service '${id}' toggled ${now ? 'on' : 'off'} — restart daemon to apply`);
        }
      }
    }
    servicesConfig = reloadedConfig;

    for (const id of drainDaemonServiceRestartQueue()) {
      if (supervisor.isRegistered(id)) {
        void supervisor.awaitIdle(id).then(() => supervisor.restartOne(id))
          .then(() => log('INFO', `Service '${id}' restarted live (SIGHUP reload)`))
          .catch((err) => log('WARN', `Service '${id}' live restart failed: ${(err as Error).message}`));
      } else {
        log('WARN', `Restart requested for '${id}' but it is not supervisor-managed on this daemon — restart the daemon instead`);
      }
    }

    try {
      const result = syncAllProjectRoutines();
      const n = result.projects.reduce((acc, p) => acc + p.synced.length, 0);
      if (n > 0 || result.missing.length > 0) {
        log('INFO', `Project routines sync: ${n} updated, ${result.missing.length} missing roots`);
      }
    } catch (err) {
      log('WARN', `Project routines sync failed: ${(err as Error).message}`);
    }
    const schedulerEnabledNow = isSchedulerEnabled() && reloadedEnabled('scheduler');
    const transition = schedulerGateTransition(scheduler !== null, schedulerEnabledNow);
    if (transition === 'boot') {
      log('INFO', 'scheduler.enabled is now on — booting the scheduler');
      bootScheduler();
    } else if (transition === 'stop') {
      log('WARN', 'scheduler.enabled is now off — stopping the scheduler; no routines will fire on this device');
      stopScheduler();
    } else if (transition === 'reload') {
      scheduler!.reloadAll();
      const reloaded = scheduler!.listScheduled();
      log('INFO', `Reloaded ${reloaded.length} jobs`);
    }
  };

  // Cleanup removes lifetime, pid, heartbeat, and registry state only when each still belongs to this instance.
  const handleShutdown = singleShot(async () => {
    log('INFO', 'Daemon shutting down');
    await supervisor.stopAll();
    activeServiceSupervisor = null;
    stopScheduler();
    try {
      if (fs.readFileSync(lifetimePath, 'utf-8') === lifetimeToken) fs.unlinkSync(lifetimePath);
    } catch {
    }
    removeDaemonPidIfOwned(process.pid);
    if (readHeartbeat()?.pid === process.pid) removeHeartbeat();
    unregisterDaemonInstance();
    process.exit(0);
  });

  if (isEnabled('state-dir-check')) {
    supervisor.register(new StateDirCheckService({
      lifetimePath,
      lifetimeToken,
      onMissing: () => { void handleShutdown(); },
    }));
    await supervisor.start('state-dir-check');
  } else {
    log('INFO', 'State-dir self-check disabled');
  }

  liveReloadHandler = guardSignalHandler(handleReload, (err) => {
    try { log('ERROR', `SIGHUP reload failed: ${(err as Error).message}`); } catch {  }
  });
  if (reloadRequestedDuringStartup) {
    reloadRequestedDuringStartup = false;
    log('INFO', 'Applying service reload requested while the daemon was starting');
    liveReloadHandler();
  }
  process.on('SIGTERM', () => handleShutdown());
  process.on('SIGINT', () => handleShutdown());

  await new Promise(() => {});
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Manifests are owner-only and carry only the canonical HOME/AGENTS_REAL_HOME/PATH surface.
export function writeOwnerOnlyServiceManifest(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.rmSync(filePath, { force: true });
  fs.writeFileSync(filePath, content, { encoding: 'utf-8', mode: 0o600 });
}

export function generateLaunchdPlist(
  agentsBin: string = getAgentsBinPath(),
): string {
  const launch = getDaemonLaunch(agentsBin);
  const logPath = getDaemonLogPath();
  const { HOME: home, AGENTS_REAL_HOME: realHome } = serviceManifestHomeEnv();

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${daemonServiceLabel()}</string>
  <key>ProgramArguments</key>
  <array>
${[launch.command, ...launch.args].map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>${DAEMON_THROTTLE_SECONDS}</integer>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${daemonPathValue(agentsBin, ['/usr/local/bin', '/usr/bin', '/bin', '/opt/homebrew/bin', `${os.homedir()}/.bun/bin`])}</string>
    <key>HOME</key>
    <string>${xmlEscape(home)}</string>
    <key>AGENTS_REAL_HOME</key>
    <string>${xmlEscape(realHome)}</string>
  </dict>
</dict>
</plist>`;
}

function systemdExecArg(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function generateSystemdUnit(
  agentsBin: string = getAgentsBinPath(),
): string {
  const launch = getDaemonLaunch(agentsBin);
  const execStart = [launch.command, ...launch.args].map(systemdExecArg).join(' ');
  const { HOME: home, AGENTS_REAL_HOME: realHome } = serviceManifestHomeEnv();

  return `[Unit]
Description=Agents Daemon - Scheduled Job Runner
After=network.target
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=${execStart}
Restart=always
RestartSec=${DAEMON_THROTTLE_SECONDS}
KillMode=process
Environment=PATH=${daemonPathValue(agentsBin, ['/usr/local/bin', '/usr/bin', '/bin'])}
Environment=HOME=${home}
Environment=AGENTS_REAL_HOME=${realHome}

[Install]
WantedBy=default.target`;
}

export { getAgentsBinPath };

export function readServiceManagerPid(
  platform: NodeJS.Platform = os.platform(),
  names?: { systemdUnit: string; launchdLabel: string },
): number | null {
  const resolved = names ?? { systemdUnit: daemonSystemdUnitName(), launchdLabel: daemonServiceLabel() };
  if (names === undefined && !serviceManagerRegistrationAllowed().allowed) return null;
  try {
    if (platform === 'linux') {
      const out = execFileSync('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', resolved.systemdUnit],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const pid = parseInt(out, 10);
      return !isNaN(pid) && pid > 0 ? pid : null;
    }
    if (platform === 'darwin') {
      const out = execFileSync('launchctl', ['list', resolved.launchdLabel],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      const m = out.match(/"PID"\s*=\s*(\d+)/);
      if (m) {
        const pid = parseInt(m[1], 10);
        return pid > 0 ? pid : null;
      }
    }
  } catch {  }
  return null;
}

export class RedirectedHomeDaemonError extends Error {
  override name = 'RedirectedHomeDaemonError';
}

// A redirected HOME daemon is invisible to production takeover and can outlive its sandbox, so explicit test opt-in is required.
function assertDaemonLaunchHomeAllowed(): void {
  const suffix = isolatedHomeSuffix();
  if (!suffix) return;
  if (process.env.AGENTS_ALLOW_TEST_DAEMON === '1') return;
  throw new RedirectedHomeDaemonError(
    `refusing to start the daemon under a redirected HOME (sandbox-${suffix}): ` +
    `a daemon launched here keeps its own pid file under ${process.env.HOME}, invisible to the real ` +
    `install's pid-file takeover, and outlives whatever launched it (PHNX-3736). ` +
    `For a deliberate test/e2e launch set AGENTS_ALLOW_TEST_DAEMON=1 — and stop the daemon when done.`,
  );
}

export function startDaemon(agentsBin?: string): { pid: number | null; method: string } {
  if (!daemonProcessViewAllowed()) throw new Error('Daemon startup requires the owning process namespace. Automatic reuse of a private-container HOME across namespaces is unsupported; run in its owning namespace or use a fresh HOME.');
  if (isDaemonRunning()) {
    const pid = readDaemonPid();
    return { pid, method: 'already-running' };
  }

  assertDaemonLaunchHomeAllowed();

  const releaseLock = acquireStartLock();
  if (!releaseLock) {
    const pid = waitForPid(3000);
    return { pid, method: 'already-starting' };
  }

  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    releaseLock();
  };

  recordSubsystemError(SUBSYSTEM_DAEMON_START, 'start issued; no daemon has reported healthy since');
  try {
    return startDaemonLocked(agentsBin ?? getAgentsBinPath(), releaseOnce);
  } catch (err: any) {
    recordSubsystemErrorReason(SUBSYSTEM_DAEMON_START, `start failed: ${err?.message ?? String(err)}`);
    throw err;
  } finally {
    releaseOnce();
  }
}

export function isDaemonAutostartCircuitOpen(): boolean {
  const health = readSubsystemHealth(SUBSYSTEM_DAEMON_START);
  return (health?.consecutiveFailures ?? 0) >= DAEMON_AUTOSTART_FAILURE_LIMIT;
}

export function ensureDaemonStarted(): { pid: number | null; method: string } | null {
  if (!isDaemonEnabled()) return null;
  if (isDaemonRunning()) return startDaemon();
  if (!serviceManagerRegistrationAllowed().allowed) return null;
  if (isDaemonAutostartCircuitOpen()) {
    process.stderr.write(
      `[agents] daemon auto-start disabled after ${DAEMON_AUTOSTART_FAILURE_LIMIT} consecutive failed starts. ` +
      `Run 'agents daemon doctor' to diagnose, or 'agents daemon start' to retry anyway.\n`,
    );
    return null;
  }
  try {
    return startDaemon();
  } catch {
    return null;
  }
}

// Release the start lock before the child claims it; manager success is not health until pid/heartbeat proof appears.
function startDaemonLocked(agentsBin: string, releaseLock: () => void): { pid: number | null; method: string } {
  const platform = os.platform();
  const detachedFallback = (): { pid: number | null; method: string } => {
    releaseLock();
    return startDetached({ agentsBin });
  };

  const reg = serviceManagerRegistrationAllowed();

  if (platform === 'darwin') {
    if (reg.allowed) {
      try {
        const plistPath = getLaunchdPlistPath();
        const plistDir = path.dirname(plistPath);
        if (!fs.existsSync(plistDir)) {
          fs.mkdirSync(plistDir, { recursive: true });
        }
        writeOwnerOnlyServiceManifest(plistPath, generateLaunchdPlist(agentsBin));

        try {
          execFileSync('launchctl', ['unload', plistPath], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
        } catch {  }
        execFileSync('launchctl', ['load', plistPath], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
        releaseLock();
        const pid = waitForPid(3000) ?? readServiceManagerPid();
        if (pid) return { pid, method: 'launchd' };
      } catch {
      }
    } else {
      process.stderr.write(`[agents] ${reg.reason}\n`);
    }
    return detachedFallback();
  }

  if (platform === 'linux') {
    if (reg.allowed) {
      try {
        const unitPath = getSystemdUnitPath();
        const unitDir = path.dirname(unitPath);
        if (!fs.existsSync(unitDir)) {
          fs.mkdirSync(unitDir, { recursive: true });
        }
        writeOwnerOnlyServiceManifest(unitPath, generateSystemdUnit(agentsBin));

        execFileSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf-8' });
        execFileSync('systemctl', ['--user', 'enable', daemonSystemdUnitName()], { encoding: 'utf-8' });
        execFileSync('systemctl', ['--user', 'start', daemonSystemdUnitName()], { encoding: 'utf-8' });

        releaseLock();
        const pid = waitForPid(3000) ?? readServiceManagerPid();
        if (pid) return { pid, method: 'systemd' };
      } catch {
      }
    } else {
      process.stderr.write(`[agents] ${reg.reason}\n`);
    }
    return detachedFallback();
  }

  return startDetached({ agentsBin });
}

export function getDaemonLaunch(agentsBin: string = getAgentsBinPath()): { command: string; args: string[] } {
  const { warnings } = validateDaemonBinary(agentsBin);
  for (const w of warnings) process.stderr.write(`[agents] ${w}\n`);
  return getCliLaunch(['__daemon-run'], agentsBin);
}

function daemonNodeBinDir(): string {
  return path.dirname(process.execPath);
}

function daemonUserBinDirs(): string[] {
  const home = serviceManifestHomeEnv().HOME;
  return [path.join(home, '.rush', 'bin'), localBinDir(home)];
}

function daemonPathValue(agentsBin: string, systemDirs: readonly string[]): string {
  return [...new Set([
    path.dirname(agentsBin),
    daemonNodeBinDir(),
    ...daemonUserBinDirs(),
    ...systemDirs,
  ])].join(':');
}

export function getAgentsInvocation(
  subArgs: string[],
  agentsBin: string = getAgentsBinPath(),
): { command: string; args: string[] } {
  return getCliLaunch(subArgs, agentsBin);
}

export function describeEphemeralDaemonRoot(binPath: string): string | null {
  if (/[/\\]\.agents[/\\]worktrees[/\\]/.test(binPath)) return 'a git worktree';
  if (/^(?:\/private)?\/tmp[/\\]|^(?:\/private)?\/var\/folders[/\\]|^\/dev\/shm[/\\]/.test(binPath)) {
    return 'a temporary directory';
  }
  return null;
}

export function validateDaemonBinary(binPath: string): { warnings: string[] } {
  const warnings: string[] = [];
  if (BUN_VIRTUAL_ROOT.test(binPath)) {
    throw new Error(
      `Refusing to supervise daemon: resolved binary is a bun virtual path (${binPath}). ` +
      `Install agents globally (npm i -g @phnx-labs/agents-cli) and restart.`,
    );
  }
  const ephemeralRoot = describeEphemeralDaemonRoot(binPath);
  if (ephemeralRoot) {
    warnings.push(
      `Warning: daemon binary is inside ${ephemeralRoot} (${binPath}). ` +
      `Deleting it will wedge the daemon. Use the globally installed binary instead.`,
    );
  }
  if (!fs.existsSync(binPath) && !/\.(c|m)?js$/.test(binPath)) {
    warnings.push(`Warning: daemon binary does not exist on disk (${binPath}).`);
  }
  return { warnings };
}

interface StartDetachedOptions {
  agentsBin?: string;
  logPath?: string;
  env?: NodeJS.ProcessEnv;
}

export function startDetached(opts: StartDetachedOptions = {}): { pid: number | null; method: string } {
  const agentsBin = opts.agentsBin ?? getAgentsBinPath();
  const logPath = opts.logPath ?? getDaemonLogPath();
  const logFd = fs.openSync(logPath, 'a');

  const { command, args } = getDaemonLaunch(agentsBin);
  const child = spawn(command, args, {
    stdio: ['ignore', logFd, logFd],
    ...backgroundSpawnOptions({ cwd: os.homedir(), fdStdio: true }),
    env: opts.env ?? process.env,
  });

  child.on('error', () => {  });

  child.unref();
  fs.closeSync(logFd);

  if (!child.pid) {
    throw new Error(`Failed to start daemon: spawning '${command}' produced no PID (binary missing or not executable?)`);
  }
  return { pid: child.pid, method: 'detached' };
}

function waitForPid(timeoutMs: number): number | null {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pid = readDaemonPid();
    if (pid) return pid;
    const waitUntil = Date.now() + 200;
    while (Date.now() < waitUntil) {}
  }
  return readDaemonPid();
}

interface StopResidueArtifact {
  label: string;
  present: boolean;
  ownedByLiveOther: boolean;
  reclaim: () => void;
  stillPresent: () => boolean;
}

function claimedPid(read: () => number | null): number | null {
  try { return read(); } catch { return null; }
}

export function stopResidueArtifacts(stoppedPid: number | null, survivors: number[] = []): StopResidueArtifact[] {
  const artifacts: StopResidueArtifact[] = [];

  const lifetimePath = path.join(getDaemonDir(), LIFETIME_FILE);
  const lifetimeOwner = claimedPid(() => {
    const raw = fs.readFileSync(lifetimePath, 'utf-8').split(':')[0];
    const n = parseInt(raw, 10);
    return isNaN(n) ? null : n;
  });
  artifacts.push({
    label: 'daemon lifetime marker',
    present: fs.existsSync(lifetimePath),
    ownedByLiveOther: lifetimeOwner !== null && (
      survivors.includes(lifetimeOwner)
      || (lifetimeOwner !== stoppedPid && isAlive(lifetimeOwner))
    ),
    reclaim: () => { try { fs.unlinkSync(lifetimePath); } catch {  } },
    stillPresent: () => fs.existsSync(lifetimePath),
  });

  const heartbeatPath = getHeartbeatPath();
  const hb = readHeartbeat();
  artifacts.push({
    label: 'daemon heartbeat',
    present: fs.existsSync(heartbeatPath),
    ownedByLiveOther: hb !== null && (
      survivors.includes(hb.pid)
      || (hb.pid !== stoppedPid && isAlive(hb.pid))
    ),
    reclaim: () => removeHeartbeat(),
    stillPresent: () => fs.existsSync(heartbeatPath),
  });

  if (process.platform !== 'win32' && stoppedPid !== null) {
    const markerPath = path.join(getDaemonInstancesDir(), String(stoppedPid));
    artifacts.push({
      label: 'daemon instance registry entry',
      present: fs.existsSync(markerPath),
      ownedByLiveOther: survivors.includes(stoppedPid),
      reclaim: () => unregisterDaemonInstance(stoppedPid),
      stillPresent: () => fs.existsSync(markerPath),
    });
  }

  return artifacts;
}

interface DaemonStopResult {
  ok: boolean;
  stoppedPid: number | null;
  escalated: boolean;
  released: string[];
  surviving: string[];
  detachedChildren: number[];
}

function findStateDirDaemonProcesses(exclude: Set<number>): { live: number[]; unverified: number[] } {
  const live: number[] = [];
  const unverified: number[] = [];
  if (process.platform === 'win32') return { live, unverified };
  const dir = getDaemonInstancesDir();
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return { live, unverified }; }
  for (const name of entries) {
    const pid = parseInt(name, 10);
    if (isNaN(pid) || String(pid) !== name) continue;
    if (exclude.has(pid)) continue;
    const identity = daemonProcessIdentity(pid);
    if (identity === 'daemon') live.push(pid);
    else if (identity === 'unknown') unverified.push(pid);
  }
  return { live, unverified };
}

export function findSurvivingStateDirDaemons(exclude: Set<number>): number[] {
  return findStateDirDaemonProcesses(exclude).live;
}

// Stop crosses the same lifecycle lock as start and claim, preventing teardown from racing takeover.
export function stopDaemon(): DaemonStopResult {
  const releaseLock = acquireLifecycleLock();
  if (!releaseLock) {
    return {
      ok: false,
      stoppedPid: null,
      escalated: false,
      released: [],
      surviving: [`daemon lifecycle lock remained held for ${STOP_LOCK_WAIT_MS}ms`],
      detachedChildren: listLiveRoutineChildren(),
    };
  }
  try {
    return stopDaemonLocked();
  } finally {
    releaseLock();
  }
}

// Cleanup compares device+inode so a successor's newly-created path is never unlinked as stale residue.
interface PathIdentity {
  dev: number;
  ino: number;
}

function readPathIdentity(filePath: string): PathIdentity | null {
  try {
    const stat = fs.lstatSync(filePath);
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

function pathIdentityMatches(filePath: string, expected: PathIdentity): boolean {
  const current = readPathIdentity(filePath);
  return current !== null && current.dev === expected.dev && current.ino === expected.ino;
}

function stopDaemonLocked(): DaemonStopResult {
  const platform = os.platform();
  const released: string[] = [];
  const surviving: string[] = [];
  let escalated = false;
  const reg = serviceManagerRegistrationAllowed();

  const unverifiedPid = unverifiedLiveDaemonPid();
  if (unverifiedPid !== null) {
    return {
      ok: false,
      stoppedPid: null,
      escalated: false,
      released,
      surviving: [`daemon pid ${unverifiedPid} is live but its __daemon-run identity could not be verified`],
      detachedChildren: listLiveRoutineChildren(),
    };
  }

  const pid = resolveLiveDaemonPid(true);

  if (platform === 'darwin') {
    const plistPath = getLaunchdPlistPath();
    if (fs.existsSync(plistPath)) {
      if (reg.allowed) {
        try {
          execFileSync('launchctl', ['unload', plistPath], { encoding: 'utf-8' });
        } catch (err: any) {
          if (process.env.AGENTS_DEBUG) {
            console.error(`[debug] launchctl unload failed: ${err.message}`);
          }
        }
      } else {
        process.stderr.write(`[agents] ${reg.reason}\n`);
      }
      try { fs.unlinkSync(plistPath); } catch {  }
    }
  }

  if (platform === 'linux') {
    if (reg.allowed) {
      try {
        execFileSync('systemctl', ['--user', 'stop', daemonSystemdUnitName()], { encoding: 'utf-8' });
        execFileSync('systemctl', ['--user', 'disable', daemonSystemdUnitName()], { encoding: 'utf-8' });
      } catch (err: any) {
        if (process.env.AGENTS_DEBUG) {
          console.error(`[debug] systemctl stop failed: ${err.message}`);
        }
      }
    } else {
      process.stderr.write(`[agents] ${reg.reason}\n`);
    }
    const unitPath = getSystemdUnitPath();
    if (fs.existsSync(unitPath)) {
      try { fs.unlinkSync(unitPath); } catch {  }
    }
  }

  if (pid) {
    if (process.platform === 'win32') {
      if (isLiveDaemon(pid)) {
        killTree(pid);
        escalated = true;
        waitForExit(pid, STOP_KILL_GRACE_MS);
      }
    } else {
      if (isLiveDaemon(pid)) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {  }

        if (!waitForExit(pid, STOP_GRACE_MS) && isLiveDaemon(pid)) {
          killTree(pid);
          escalated = true;
          waitForExit(pid, STOP_KILL_GRACE_MS);
        }
      }
    }
  }

  const stateDirProcesses = findStateDirDaemonProcesses(new Set([process.pid]));
  const survivors = stateDirProcesses.live;
  const unverifiedSurvivors = stateDirProcesses.unverified;
  if (pid && !survivors.includes(pid) && !unverifiedSurvivors.includes(pid)) {
    const identity = daemonProcessIdentity(pid);
    if (identity === 'daemon') survivors.push(pid);
    else if (identity === 'unknown') unverifiedSurvivors.push(pid);
  }
  if (survivors.length > 0) {
    for (const s of survivors) surviving.push(`__daemon-run pid ${s} still alive`);
  }
  for (const s of unverifiedSurvivors) {
    surviving.push(`daemon pid ${s} is live but its __daemon-run identity could not be verified`);
  }
  const targetStillOwnsResources = pid !== null
    && (survivors.includes(pid) || unverifiedSurvivors.includes(pid));
  if (pid && !targetStillOwnsResources) {
    released.push('daemon process');
  }

  const currentPid = readDaemonPid();
  if (pid !== null && !targetStillOwnsResources) {
    if (removeDaemonPidIfOwned(pid)) released.push('daemon pid registration');
    else if (currentPid === null) released.push('daemon pid registration');
    else surviving.push(`daemon pid registration changed to ${currentPid} during stop`);
  } else if (pid === null && currentPid === null) {
    released.push('daemon pid registration');
  } else if (pid === null && currentPid !== null) {
    surviving.push(`daemon pid registration changed to ${currentPid} during stop`);
  }


  for (const artifact of stopResidueArtifacts(pid, [...survivors, ...unverifiedSurvivors])) {
    if (!artifact.present) { released.push(artifact.label); continue; }
    if (artifact.ownedByLiveOther) { released.push(`${artifact.label} (owned by a live daemon)`); continue; }
    artifact.reclaim();
    if (artifact.stillPresent()) surviving.push(`${artifact.label} not released`);
    else released.push(`${artifact.label} (reclaimed)`);
  }

  const detachedChildren = listLiveRoutineChildren();

  return {
    ok: surviving.length === 0,
    stoppedPid: pid,
    escalated,
    released,
    surviving,
    detachedChildren,
  };
}

export function getDaemonStatus(): {
  state: 'running' | 'stopped';
  running: boolean;
  pid: number | null;
  jobCount: number;
  logPath: string;
  binaryPath: string | null;
  heartbeat: DaemonHeartbeat | null;
  restarts24h: number;
  lastRestartCause: string | null;
  lastRestartAt: string | null;
} {
  const running = isDaemonRunning();
  const pid = readDaemonPid();

  let jobCount = 0;
  try {
    jobCount = listAllJobs().filter((j) => j.enabled).length;
  } catch {  }

  let binaryPath: string | null = null;
  try {
    binaryPath = getAgentsBinPath();
  } catch {  }

  const recentRestarts = readRecentDaemonRestarts(Date.now() - 24 * 60 * 60 * 1000);
  const lastRestart = recentRestarts.length > 0 ? recentRestarts[recentRestarts.length - 1] : null;

  return {
    state: running ? 'running' : 'stopped',
    running,
    pid,
    jobCount,
    logPath: getDaemonLogPath(),
    binaryPath,
    heartbeat: readHeartbeat(),
    restarts24h: recentRestarts.length,
    lastRestartCause: lastRestart ? `${lastRestart.subsystem}: ${lastRestart.cause}` : null,
    lastRestartAt: lastRestart ? lastRestart.at : null,
  };
}

export function readDaemonLog(lines?: number): string {
  const logPath = getDaemonLogPath();
  if (!fs.existsSync(logPath)) return '(no log file)';

  const content = fs.readFileSync(logPath, 'utf-8');
  if (!lines) return content;

  const allLines = content.split('\n');
  return allLines.slice(-lines).join('\n');
}

export function signalDaemonReload(): boolean {
  const pid = readDaemonPid();
  if (!pid) return false;
  if (process.platform === 'win32') {
    return false;
  }
  try {
    process.kill(pid, 'SIGHUP');
    return true;
  } catch {
    return false;
  }
}
