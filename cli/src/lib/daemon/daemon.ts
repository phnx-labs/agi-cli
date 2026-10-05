import { daemonProcessViewAllowed, recordDaemonProcessView } from '../session/process-view.js';

/** Daemon lifecycle management for the routines scheduler: a long-running process holding a
 * JobScheduler, managed via launchd, systemd or a plain detached process. Handles PID tracking,
 * logs, reload (SIGHUP) and graceful shutdown. */

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
// MonitorEngine is now owned by MonitorEngineService (daemon/monitor-engine-service.ts).
import { executeJobDetached, listLiveRoutineChildren } from './runner.js';
import { detectOverdueJobs, notifyOverdue } from '../overdue.js';
import { runCatchup } from '../catchup.js';
import { notifyRoutineStart, notifyRoutineFinish, notifyRoutineStartFailed } from '../routine-notify.js';
import { notifyOwnerRoutineFinish, notifyOwnerRoutineStartFailed } from '../routine-notify-owner.js';
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

/** The live `ServiceSupervisor` for the current `runDaemon()`, or `null` before boot/after
 * shutdown. In-process only; cross-process health goes through `daemon-health.ts`. Exists for a
 * future same-process consumer. */
let activeServiceSupervisor: ServiceSupervisor | null = null;

/** Health for every service currently registered on the live supervisor, or `null` if the daemon isn't running in this process. */
export function getServiceSupervisorHealth(): Record<string, ServiceHealth> | null {
  return activeServiceSupervisor?.health() ?? null;
}

const PID_FILE = 'daemon.pid';
const LIFETIME_FILE = 'daemon.lifetime';
const LOCK_FILE = 'daemon.lock';
const LOG_FILE = 'logs.jsonl';
const HEARTBEAT_FILE = 'heartbeat.json';
const LOG_MAX_SIZE = 5 * 1024 * 1024; // 5 MB
const LOG_ROTATE_COUNT = 3;
const PLIST_NAME = 'com.phnx-labs.agents-daemon';
const SYSTEMD_UNIT = 'agents-daemon.service';

/** Service-manager identifiers of the real install's daemon, never namespaced. A caller under a
 * redirected HOME (test/e2e harness) uses these to recognize the box's production daemon as owned
 * (W4, PHNX-3736). */
export function productionDaemonServiceNames(): { systemdUnit: string; launchdLabel: string } {
  return { systemdUnit: SYSTEMD_UNIT, launchdLabel: PLIST_NAME };
}

/** RUSH-2639 (residual): launchd/systemd route `unload`/`load`/`list` by service identifier alone,
 * so one literal `PLIST_NAME`/`SYSTEMD_UNIT` let an `unload` of a never-loaded plist tear down
 * another job. Namespace the identifier when HOME is redirected. */
export { isolatedHomeSuffix };

/** launchd Label for this process's daemon — namespaced under a redirected HOME. */
export function daemonServiceLabel(): string {
  return namespacedServiceLabel(PLIST_NAME);
}

/** systemd --user unit name for this process's daemon — namespaced under a redirected HOME. */
export function daemonSystemdUnitName(): string {
  const suffix = isolatedHomeSuffix();
  return suffix ? `agents-daemon-sandbox-${suffix}.service` : SYSTEMD_UNIT;
}

// Catch-up cadence + the supervised CatchupService live in catchup-service.ts
// (PHNX-3608): the pass now runs under the ServiceSupervisor with a deadline +
// AbortSignal + circuit breaker instead of a bare setInterval.

/** Cadences for the in-process background ticks, named beside the other tick constants (RUSH-2423).
 * Self-heal, state-dir-check, watchdog and device-probe cadences moved to their own `*-service.ts`
 * files (RUSH-3193 P3); the secrets broker left with the standalone engine (PHNX-3989). */
// Session-index warm interval/deadline live in session-index-service.ts now
// (RUSH-3193 — migrated onto ServiceSupervisor).
const WEDGE_THRESHOLD_TICKS = 3;
const DAEMON_HEARTBEAT_TICK_MS = 60_000;

/** Crash-loop pacing (RUSH-2418, PHNX-4116), two layers: a daemon dying at startup must be paced
 * but never abandoned. 1) The OS supervisor paces and always retries (`ThrottleInterval=30`;
 * `RestartSec=30`, `StartLimitIntervalSec=0`). 2) Foreground auto-starts are bounded. */
const DAEMON_THROTTLE_SECONDS = 30;

/** Consecutive failed starts that disable the implicit auto-start (`ensureDaemonStarted`). Bounds
 * foreground-command auto-starts only; the OS unit restart is unbounded (PHNX-4116), and `agents
 * daemon start` is the override and never gated. */
export const DAEMON_AUTOSTART_FAILURE_LIMIT = 5;

/** What a gate re-evaluation does with the routines scheduler. `scheduler.enabled` is re-evaluated
 * on every SIGHUP so flipping it needs no restart: running+enabled reload; running+!enabled stop;
 * !running+enabled boot; !running+!enabled none. */
type SchedulerGateTransition = 'reload' | 'stop' | 'boot' | 'none';

export function schedulerGateTransition(running: boolean, enabled: boolean): SchedulerGateTransition {
  if (running) return enabled ? 'reload' : 'stop';
  return enabled ? 'boot' : 'none';
}

/** Wrap an async routine so it runs at most once however many callers fire it; the flag is set
 * before the first await. Extracted to be testable (RUSH-2423). A rejected `fn` leaves the guard
 * set, so a failed shutdown is never retried by the next signal; re-examine before reuse. */
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

/** Acquire an exclusive start lock via O_EXCL (no TOCTOU window). Returns a release function, or
 * null if another process holds it. */
function acquireStartLock(): (() => void) | null {
  const lockPath = getLockPath();
  try {
    const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return () => {
      try { fs.unlinkSync(lockPath); } catch { /* already removed */ }
    };
  } catch (err: any) {
    if (err.code === 'EEXIST') {
      // Lock file exists — check if the holder is still alive (stale lock recovery)
      try {
        const holderPid = parseInt(fs.readFileSync(lockPath, 'utf-8').trim(), 10);
        if (!isNaN(holderPid)) {
          try {
            process.kill(holderPid, 0);
            return null; // holder is alive, lock is valid
          } catch {
            // holder is dead, remove stale lock and retry once
            fs.unlinkSync(lockPath);
            return acquireStartLock();
          }
        }
      } catch { /* can't read lock file — treat as held */ }
      return null;
    }
    throw err;
  }
}

/** Stop is a lifecycle mutation like start/claim, so it crosses the same lock. A claim can hold it
 * through the 5s graceful window plus the 2s hard-kill backstop; wait beyond that, then fail loud
 * rather than tear down unlocked. */
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

/** Absolute path to the daemon's structured log. Exported because two commands rebuilt it from a
 * hardcoded `'logs.jsonl'`, so a rename would have pointed them at nothing (RUSH-2423). */
export function getDaemonLogPath(): string {
  return path.join(ensureDaemonDir(), LOG_FILE);
}

function getLaunchdPlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${daemonServiceLabel()}.plist`);
}

function getSystemdUnitPath(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user', daemonSystemdUnitName());
}

/** Read the stored daemon PID from disk. Returns null if not present or invalid. */
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

/** Write the daemon PID to the pid file. */
export function writeDaemonPid(pid: number): void {
  fs.writeFileSync(getPidPath(), String(pid), 'utf-8');
}

/** Remove the daemon PID file. */
export function removeDaemonPid(): void {
  const pidPath = getPidPath();
  if (fs.existsSync(pidPath)) {
    fs.unlinkSync(pidPath);
  }
}

/** Remove the pid registration only while it still names the owner we observed. */
function removeDaemonPidIfOwned(pid: number): boolean {
  if (readDaemonPid() !== pid) return false;
  try { fs.unlinkSync(getPidPath()); } catch { /* already removed */ }
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
  } catch { /* best effort */ }
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
  try { fs.unlinkSync(getHeartbeatPath()); } catch { /* already removed */ }
}

/** A heartbeat is fresh when its last tick is inside the freshness window; a fresh heartbeat with a
 * live pid proves a ticking daemon even if the pid file is lost. No separate "wedged" verdict
 * (PHNX-4116): a supervised deadline breach exits the process and systemd/launchd restart it. */
function isHeartbeatFresh(hb: DaemonHeartbeat): boolean {
  const elapsed = Date.now() - Date.parse(hb.lastTick);
  return elapsed <= WEDGE_THRESHOLD_TICKS * DAEMON_HEARTBEAT_TICK_MS;
}

/** How long stopDaemon waits for a SIGTERMed daemon to exit before escalating. */
const STOP_GRACE_MS = 5000;
/** How long it waits after the hard tree-kill before giving up. */
const STOP_KILL_GRACE_MS = 2000;

/** Resolve the live daemon PID, tolerating a pid-file/heartbeat desync. If the pid file is lost
 * while the daemon ticks, reading only it reports "stopped" and lets claimDaemonInstance() start a
 * second, double-firing daemon. Also trust a fresh heartbeat; only daemon.lock holders repair. */
function resolveLiveDaemonPid(repair: boolean = false): number | null {
  const pid = readDaemonPid();
  const pidIdentity = pid !== null ? daemonProcessIdentity(pid) : 'dead';
  if (pid !== null && pidIdentity === 'daemon') return pid;
  const hb = readHeartbeat();
  if (hb && isHeartbeatFresh(hb) && daemonProcessIdentity(hb.pid) === 'daemon') {
    if (repair && pid !== hb.pid) writeDaemonPid(hb.pid); // lock owner heals the desync
    return hb.pid;
  }
  // A failed command-line inspection is not proof the pid is stale. Leave the
  // registration intact so a sandbox/permission failure cannot erase the only
  // owner record and trigger a duplicate daemon.
  if (repair && pid !== null && pidIdentity !== 'unknown') removeDaemonPidIfOwned(pid);
  return null;
}

/** A live recorded pid whose command identity could not be inspected. */
function unverifiedLiveDaemonPid(): number | null {
  const pid = readDaemonPid();
  if (pid !== null && daemonProcessIdentity(pid) === 'unknown') return pid;
  const hb = readHeartbeat();
  if (hb && isHeartbeatFresh(hb) && daemonProcessIdentity(hb.pid) === 'unknown') return hb.pid;
  return null;
}

/** Whether a daemon is alive via the pid file or a fresh heartbeat (see resolveLiveDaemonPid).
 * Read-only; on desync it tries to acquire daemon.lock and re-observes there before repairing. A
 * contended probe returns its observation without mutating. */
export function isDaemonRunning(): boolean {
  // Fail safe for reporting/start suppression: inability to inspect a live pid
  // is never permission to declare it dead and launch a duplicate.
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

/** Single-instance claim for the foreground entrypoint. `agents __daemon-run` can be reached
 * directly, bypassing startDaemon()'s lock; otherwise it would clobber the live pid and run a
 * second JobScheduler, double-firing routines. LAST-WINS (SING-11, RUSH-2352); false: exit. */
export function claimDaemonInstance(): boolean {
  // A nested caller cannot interpret legacy numeric lock/PID files. Authenticate
  // before acquiring the lock (whose stale-PID cleanup itself mutates state).
  if (!daemonProcessViewAllowed()) {
    console.error('Daemon startup requires the owning process namespace. Automatic reuse of a private-container HOME across namespaces is unsupported; run in its owning namespace or use a fresh HOME.');
    return false;
  }
  // A stop owns this lock through teardown. Waiting is load-bearing: returning false while
  // stopDaemon() holds it lets this replacement exit 0 and the stop finish with no singleton
  // alive. Bounded acquisition also keeps concurrent starts serialized.
  const release = acquireLifecycleLock();
  if (!release) return false;
  try {
    // Recheck under lifecycle serialization; invocation is not provenance.
    if (!daemonProcessViewAllowed()) return false;
    recordDaemonProcessView();
    // Do not overwrite a live-but-uninspectable owner. This is the non-
    // destructive side of the same fail-closed rule stopDaemon applies.
    if (unverifiedLiveDaemonPid() !== null) return false;
    // resolveLiveDaemonPid() also consults a fresh heartbeat, so a live daemon whose pid file was
    // lost is still found and evicted; otherwise this instance and the orphan would both run a
    // JobScheduler and double-fire.
    const existing = resolveLiveDaemonPid(true);
    if (existing !== null && existing !== process.pid) {
      // Evict and WAIT for the incumbent to be provably dead (its handleShutdown releasing the
      // feed-stream hub and monitor sockets) before writing our pid or binding. Binding earlier
      // recreates the two-owners-on-one-socket orphan documented at stopDaemon.
      if (!evictIncumbentDaemon(existing)) return false;
    }
    writeDaemonPid(process.pid);
    return true;
  } finally {
    release();
  }
}

/** SIGTERM a live incumbent and block until it is provably dead so its sockets (feed-stream hub,
 * monitor) are released before the newcomer binds (SING-11); escalates to killTree after the grace
 * window. Passes the positive pid so detached routine children survive (SING-11a). */
function evictIncumbentDaemon(pid: number): boolean {
  const beforeSignal = daemonProcessIdentity(pid);
  if (beforeSignal === 'dead' || beforeSignal === 'other') return true;
  if (beforeSignal === 'unknown') return false;

  if (process.platform === 'win32') {
    // No graceful termination signal on Windows — take the incumbent down and
    // still wait for the kill to land before the caller binds anything (mirrors
    // stopDaemon's win32 branch).
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
  if (waitForExit(pid, STOP_GRACE_MS)) return true; // graceful release complete
  const beforeKill = daemonProcessIdentity(pid);
  if (beforeKill === 'dead' || beforeKill === 'other') return true;
  if (beforeKill === 'unknown') return false;
  killTree(pid); // positive pid: SIGKILL reaches the daemon, not its job children
  if (waitForExit(pid, STOP_KILL_GRACE_MS)) return true;
  const afterKill = daemonProcessIdentity(pid);
  return afterKill === 'dead' || afterKill === 'other';
}

/** Directory that registers every live daemon of THIS device (one per state dir). */
function getDaemonInstancesDir(): string {
  return path.join(getDaemonDir(), 'instances');
}

/** Record this daemon in the device instance registry: a pid-named marker under
 * `<daemonDir>/instances/`. The registry, not a process scan, lets the reaper enumerate the device
 * singleton, since every daemon of one device shares the state dir while test fixtures don't. */
export function registerDaemonInstance(pid: number = process.pid): void {
  if (process.platform === 'win32') return;
  try {
    const dir = getDaemonInstancesDir();
    fs.mkdirSync(dir, { recursive: true });
    // The command line is stored for diagnostics; the filename (pid) is identity.
    fs.writeFileSync(path.join(dir, String(pid)), process.argv.slice(1).join(' '), 'utf-8');
  } catch { /* best effort — the reaper self-heals a missing marker */ }
}

/** Remove this daemon's registry marker on graceful shutdown. */
export function unregisterDaemonInstance(pid: number = process.pid): void {
  if (process.platform === 'win32') return;
  try { fs.rmSync(path.join(getDaemonInstancesDir(), String(pid)), { force: true }); } catch { /* ignore */ }
}

/** Reap stray duplicate daemons of this device: registry entries that are a live `agents
 * __daemon-run` and neither this process nor the pid-file owner. A SIGKILLed predecessor or
 * pid-file race loser would otherwise keep a second scheduler double-firing. No-op on Windows. */
export function reapStrayDaemons(keepPid: number = process.pid): { reaped: number; details: string[] } {
  const details: string[] = [];
  let reaped = 0;
  if (process.platform === 'win32') return { reaped, details };

  const dir = getDaemonInstancesDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { reaped, details }; // no registry yet — nothing to reap
  }

  const ownerPid = resolveLiveDaemonPid();
  const dropMarker = (name: string): void => {
    try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* ignore */ }
  };

  for (const name of entries) {
    const pid = parseInt(name, 10);
    if (isNaN(pid) || String(pid) !== name) continue; // not a pid marker
    if (pid === keepPid || pid === process.pid || pid === ownerPid) continue;

    // Dead registrant → stale marker.
    if (!isAlive(pid)) { dropMarker(name); continue; }

    // Live pid, but guard against pid reuse: only a real `__daemon-run` is ours.
    // Process ARGS are readable cross-platform (unlike ENV on hardened macOS).
    const identity = daemonProcessIdentity(pid);
    if (identity === 'unknown') {
      details.push(`could not verify stray daemon pid ${pid}; marker retained`);
      continue;
    }
    if (identity !== 'daemon') { dropMarker(name); continue; }

    try {
      process.kill(pid, 'SIGTERM');
    } catch { /* already gone between the alive check and the signal */ }
    if (waitForExit(pid, STOP_GRACE_MS)) {
      reaped++;
      details.push(`reaped stray daemon pid ${pid}`);
      dropMarker(name);
      continue;
    }

    // The pid may have been recycled during the grace window. Never hard-kill
    // it unless it still identifies as a daemon; a stale registry marker is all
    // we own when the command identity changed.
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
      // Keep the only marker for a process that survived both signals so the
      // next reaper/doctor can still see it.
      details.push(`stray daemon pid ${pid} survived SIGKILL`);
    }
  }
  return { reaped, details };
}

/** Whether `pid` is a live `agents __daemon-run`, from its command line (`ps` on POSIX,
 * Win32_Process on Windows), which unlike its environment is visible on hardened macOS. Guards
 * every signal against killing an unrelated process that reused the pid. */
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
    // getDaemonLaunch always places __daemon-run last. Matching it anywhere in
    // the command line mistakes an agent prompt or shell script that merely
    // mentions the token for the shared daemon.
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

/** Append a JSONL log entry to the daemon log file (owner-only permissions). */
export function log(level: string, message: string): void {
  const logPath = getDaemonLogPath();
  rotateLogsIfNeeded(logPath);
  const entry = { ts: new Date().toISOString(), level: level.toUpperCase(), message: redactSecrets(message) };
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');
  try { fs.chmodSync(logPath, 0o600); } catch { /* best effort */ }
  // Mirror into the unified event stream so `agents events --module daemon` sees
  // always-on process lifecycle the same way secrets/browser/computer do.
  // Fail soft — the daemon log file remains the primary sink for `daemon logs`.
  try {
    const lvl = level.toUpperCase();
    const event =
      lvl === 'ERROR' || lvl === 'FATAL' ? 'daemon.error' as const
      : lvl === 'START' || /starting|started/i.test(message) ? 'daemon.start' as const
      : lvl === 'STOP' || /stopping|stopped|shutting down/i.test(message) ? 'daemon.stop' as const
      : 'daemon.info' as const;
    // Fire-and-forget the event mirror: `log()` is synchronous on every tick's `ctx.log`, and the
    // mirror's event-log lock could block the loop up to 30s under contention (PHNX-3695). The
    // daemon-log append is the primary sink; the mirror is best-effort.
    void emitAsync(event, {
      module: 'daemon',
      detail: redactSecrets(message).slice(0, 500),
      status: lvl,
    }).catch(() => { /* never crash the daemon on event-log failure */ });
  } catch { /* never crash the daemon on event-log failure */ }
}

/** Keep synchronous signal-handler failures inside the daemon's crash barrier. */
export function guardSignalHandler(handler: () => void, onError: (err: unknown) => void): () => void {
  return () => {
    try {
      handler();
    } catch (err) {
      onError(err);
    }
  };
}

/** Main daemon loop: load jobs, schedule crons, monitor runs, and handle signals. */
/** Anchor the daemon's cwd to a stable path. It inherits its launch cwd (often a git worktree);
 * when that is removed it can't chdir out, so spawned jobs inherit the dead cwd and Bun crashes
 * with `ENOENT`. Re-anchoring to the home dir at startup fixes it. */
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

/** Surface at the daemon's own startup that it was launched from an ephemeral root that will wedge
 * it if removed. Runtime companion to validateDaemonBinary, which only runs on spawn via
 * getDaemonLaunch; a direct `__daemon-run` from a /tmp build is otherwise invisible. */
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

/** Test-home tripwire (PHNX-2545): daemon tests spawn real `__daemon-run` against an isolated /tmp
 * HOME; if the override fails to reach the child it resolves state under the REAL home and ticks
 * against production. With AGENTS_DAEMON_TEST_HOME set, a state dir outside it refuses to boot. */
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

// Module-level periodic maintenance helpers (RUSH-2422), moved out of runDaemon()'s closures so
// they appear in stack traces. Self-heal and state-dir-check moved to supervised services
// (RUSH-3193 P3); the secrets broker left with the standalone engine (PHNX-3989).

export async function runDaemon(): Promise<void> {
  // PHNX-2545 test-home tripwire runs first, before the daemon claims an instance, writes a pid or
  // ticks, so a test daemon that lost its HOME override refuses to touch real state. No-op in
  // production (the marker is never set).
  assertTestDaemonHome();

  // Lifecycle readers and launchers do not run services. Load their code only
  // in the daemon process, before it claims or publishes lifecycle state.
  const [
    { SessionIndexService },
    { SessionSummarizerService },
    { SessionTitleService },
    { MonitorEngineService },
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
    { WebhookReceiverService },
    { HeartbeatService },
    { TmuxReapService },
  ] = await Promise.all([
    import('./session-index-service.js'),
    import('./session-summarizer-service.js'),
    import('./session-title-service.js'),
    import('./monitor-engine-service.js'),
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
    import('./webhook-receiver-service.js'),
    import('./heartbeat-service.js'),
    import('./tmux-reap-service.js'),
  ]);

  // Install the SIGHUP reload boundary BEFORE publishing our PID in claimDaemonInstance(): clients
  // use that PID to request a reload, and POSIX's default SIGHUP action would terminate the
  // process mid-startup (PHNX-3605). Early requests coalesce into one reload after startup.
  let reloadRequestedDuringStartup = false;
  let liveReloadHandler: (() => void) | null = null;
  const dispatchReloadSignal = () => {
    if (liveReloadHandler) liveReloadHandler();
    else reloadRequestedDuringStartup = true;
  };
  if (process.platform !== 'win32') process.on('SIGHUP', dispatchReloadSignal);

  // Single-instance guard (last-wins, SING-11): a direct `__daemon-run` evicts the incumbent.
  // claimDaemonInstance returns false only when a concurrent `__daemon-run` holds the start lock;
  // that peer is the singleton, so this one stands down.
  if (!claimDaemonInstance()) {
    if (process.platform !== 'win32') process.removeListener('SIGHUP', dispatchReloadSignal);
    log('WARN', `Another daemon owns lifecycle state or is mid-takeover; this instance (PID ${process.pid}) is exiting`);
    // Exit cleanly (0) so a service manager treats it as an orderly no-op
    // rather than a failure to restart-flap on.
    process.exit(0);
  }

  // Deterministic integration-test seam for the PID-published/startup-complete
  // signal window above. It is honored only inside an explicitly isolated test
  // HOME; production daemons never pause here.
  const startupDelayRaw = process.env.AGENTS_DAEMON_TEST_STARTUP_DELAY_MS;
  if (process.env.AGENTS_DAEMON_TEST_HOME && startupDelayRaw) {
    const startupDelayMs = Number(startupDelayRaw);
    if (!Number.isInteger(startupDelayMs) || startupDelayMs < 1 || startupDelayMs > 10_000) {
      throw new Error('AGENTS_DAEMON_TEST_STARTUP_DELAY_MS must be an integer from 1 to 10000');
    }
    await new Promise((resolve) => setTimeout(resolve, startupDelayMs));
  }
  // Unlike the pid and heartbeat files, this marker is written exactly once
  // for this daemon lifetime. Status probes deliberately repair those other
  // files, so they cannot prove that the original state dir still exists.
  const lifetimePath = path.join(getDaemonDir(), LIFETIME_FILE);
  const lifetimeToken = `${process.pid}:${Date.now()}`;
  fs.writeFileSync(lifetimePath, lifetimeToken, 'utf-8');
  log('INFO', `Daemon started (PID: ${process.pid})`);

  anchorDaemonCwd();
  warnEphemeralDaemonRoot();

  // Converge the device-config/pins stores (legacy central block / auto-launch.json / tracked-doc
  // pins to per-device docs). Idempotent. The daemon boots via `__daemon-run`, bypassing
  // bootstrap's migration sentinel, so it runs this itself.
  try {
    const { migrateDeviceConfigStores } = await import('../devices/config-migration.js');
    migrateDeviceConfigStores();
  } catch (err) {
    log('WARN', `device config migration failed: ${(err as Error).message}`);
  }

  // Version-skew one-shot (RUSH-2435): retrofit the current pane-died hook onto managed tmux
  // sessions a pre-fix binary left stale. The `tmux-reconcile` poll routine was deleted
  // (RUSH-2495); startup plus `ensureSessionHookRepaired` at attach cover it. Idempotent.
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

  // Per-service toggles live outside device-config so they can be checked by
  // service clients (e.g. secrets) without loading the whole config stack.
  let servicesConfig = readDaemonServicesConfig();
  const isEnabled = (id: DaemonServiceId): boolean => servicesConfig.services[id] !== false;

  // The daemon holds no Claude credential. Routine runs authenticate like an interactive `agents
  // run` via the per-account CLAUDE_CONFIG_DIR login, which refreshes itself per-device; a routine
  // with a dead login is skipped by the auth-health preflight, not given a fallback token.

  // Register in the device instance registry, then reap strays that slipped past the start lock or
  // were orphaned by a hard crash. Register first so a racing peer's reaper sees this pid and this
  // reaper never mistakes itself for a stray.
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

  // Monitor engine, account-state and the feed-stream hub are managed by the ServiceSupervisor
  // (RUSH-3193 P2). The secrets broker (PHNX-3989 OWN-1) and browser IPC (PHNX-4101) moved to
  // their standalone CLIs, which own their lifecycles.
  const supervisor = new ServiceSupervisor();

  if (isEnabled('session-state')) {
    supervisor.register(new SessionStateService(() => supervisor.runNow('session-state')));
  } else log('INFO', 'Live session-state service disabled');

  // The shared feed fan-out. Registered even when disabled at boot so a later
  // `agents daemon services enable feed-stream` brings it up over SIGHUP.
  supervisor.register(new FeedStreamService(), { enabled: isEnabled('feed-stream') });
  if (!isEnabled('feed-stream')) log('INFO', 'Shared feed stream service disabled');

  const monitorEngineSvc = new MonitorEngineService();
  if (isEnabled('monitors')) supervisor.register(monitorEngineSvc);
  else log('INFO', 'Monitor engine disabled');

  // Usage and auth refresh are two INDEPENDENT supervised services (PHNX-3608)
  // so a run of usage-refresh throws is recorded against usage alone and never
  // starves the slower auth refresh — each keeps ticking on its own interval.
  if (isEnabled('account-state')) supervisor.register(new AccountUsageService());
  else log('INFO', 'Account-state service disabled');

  if (isEnabled('account-auth')) supervisor.register(new AccountAuthService());
  else log('INFO', 'Account-auth service disabled');

  // Declare `scheduler` before the CatchupService registration: `supervisor.startAll()` fires each
  // first tick synchronously, so the `catchup` tick reads it before a later `let` would
  // initialise, a real TDZ ReferenceError on every boot (PHNX-3608).
  let scheduler: JobScheduler | null = null;

  // Catch-up recovery under the supervisor (PHNX-3608). The tick self-gates on the scheduler being
  // booted, so it is a cheap no-op (including the first tick, when `scheduler` is null) where
  // `scheduler.enabled` is off.
  if (isEnabled('catchup')) {
    supervisor.register(new CatchupService({
      isSchedulerBooted: () => scheduler !== null,
      runPass: (signal) => catchupPass(signal),
    }));
  } else {
    log('INFO', 'Catch-up recovery service disabled');
  }

  // The browser IPC service and its task reaper belong to the standalone `browser` CLI now
  // (PHNX-4101); agents-cli no longer constructs a BrowserService, binds a socket or reaps tasks.
  // See `commands/browser.ts` and `docs/browser.md`.

  if (isEnabled('session-index')) supervisor.register(new SessionIndexService());
  else log('INFO', 'Session-index warm service disabled');

  // Session summarizer (PHNX-3939) — registered when the service toggle is on,
  // but each tick is a no-op unless the operator also set summarizer.enabled and
  // a model endpoint, so registering it costs nothing while unconfigured.
  if (isEnabled('session-summarizer')) supervisor.register(new SessionSummarizerService());
  else log('INFO', 'Session summarizer service disabled');

  // Attention desktop banners (PHNX-4004): one actionable native banner per new attention key,
  // reader-independent, with the notified-ledger as idempotency truth across restarts.
  if (isEnabled('attention-notify')) supervisor.register(new AttentionNotifyService());
  else log('INFO', 'Attention-notify service disabled');

  // Session titles (PHNX-3797) — generates each session row's headline once,
  // with a cheap model, off the request path.
  if (isEnabled('session-title')) supervisor.register(new SessionTitleService());
  else log('INFO', 'Session-title service disabled');

  // Watchdog, device-probe and self-heal are supervised periodic services (RUSH-3193 P3), gated
  // like the socket services. state-dir-check is registered later, after `handleShutdown` exists.
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

  // scheduler.enabled=false in this machine's device doc means no routines fire here: the
  // scheduler and catchup never start while the daemon keeps its other duties. Re-evaluated on
  // every SIGHUP reload (schedulerGateTransition), so no restart is needed.
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
    // RUSH-2030: branded desktop notification on start (agent/workflow routines; command
    // housekeeping suppressed). Finish comes from onFinish since executeJobDetached finalizes
    // in-process. A notification failure must never break the trigger.
    try { notifyRoutineStart(config); } catch { /* best-effort */ }
    try {
      const meta = await executeJobDetached(config, {
        onFinish: (final) => {
          emitRoutineEnd(final);
          try { notifyRoutineFinish(final); } catch { /* best-effort */ }
          // RUSH-2288: a failed or timed-out routine also reaches the owner's phone (in-process
          // owner channel), not just the desktop. Green runs are silent. Async and swallowed so a
          // delivery hiccup never blocks finish.
          void notifyOwnerRoutineFinish(final)
            .then((r) => {
              if (r.attempts.length && !r.delivered)
                log('WARN', `Owner failure-notify for '${config.name}' reached no channel (tried: ${r.attempts.map((a) => a.channel).join(', ')})`);
            })
            .catch(() => { /* best-effort */ });
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
      // RUSH-2030: the START ping already fired. A pre-spawn failure produces no run record and no
      // onFinish, so send a synthetic "failed to start" finish, else the user is left with an
      // orphaned "Routine started".
      try { notifyRoutineStartFailed(config, message); } catch { /* best-effort */ }
      // RUSH-2288: the pre-spawn failure (e.g. auth_failed) is exactly the one the
      // per-routine `agents send --to owner` prompt can never send — its agent never ran —
      // so the daemon reaches the owner directly.
      void notifyOwnerRoutineStartFailed(config, message)
        .then((r) => {
          if (r.attempts.length && !r.delivered)
            log('WARN', `Owner start-failure notify for '${config.name}' reached no channel (tried: ${r.attempts.map((a) => a.channel).join(', ')})`);
        })
        .catch(() => { /* best-effort */ });
    }
  };

  // `scheduler` is declared earlier (before the CatchupService registration) to
  // avoid a TDZ read during supervisor.startAll — see the comment there.

  // Boot the scheduler at daemon start when the gate allows and again from handleReload when it
  // flips on. Catch-up is the supervised CatchupService (self-gates on `scheduler !== null`); here
  // we kick an immediate pass so a fresh boot doesn't wait a full CATCHUP_TICK_MS.
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

  // Stop the scheduler (gate flipped off on reload). The CatchupService keeps its
  // supervised timer but its tick no-ops once `scheduler` is null.
  function stopScheduler(): void {
    scheduler?.stopAll();
    scheduler = null;
  }

  // Materialise opted-in project routines into the user layer on every start
  // so a fresh daemon picks up project YAML without a separate sync step.
  try {
    const result = syncAllProjectRoutines();
    const n = result.projects.reduce((acc, p) => acc + p.synced.length, 0);
    if (n > 0) log('INFO', `Project routines sync: ${n} job(s) from ${result.projects.length} project(s)`);
  } catch (err) {
    log('WARN', `Project routines sync failed: ${(err as Error).message}`);
  }

  if (schedulerEnabledAtBoot) bootScheduler();

  // Live-session metadata publishing is owned by SessionStateService. Its
  // presence watcher requests an immediate supervised tick when a reader
  // connects; callers consume the journal instead of duplicating the gather.

  // Session-index warm (RUSH-2682) is registered on the supervisor above
  // (RUSH-3193 P2) alongside the socket services.

  // Watchdog and device-probe are WatchdogService / DeviceProbeService on the supervisor
  // (RUSH-3193 P3). Its immediate first tick replaces the old `runDeviceProbeTick()` kickoff,
  // whose 3-minute lag left the menubar showing 20 phantom NEW DEVICES.

  // Monitor engine is now managed by MonitorEngineService on the supervisor
  // (RUSH-3193 P2). Access it via monitorEngineSvc.getEngine() in handleReload.

  // Backlog recovery: an enabled recurring job whose latest expected fire is older than its latest
  // recorded run was missed (sleep, off, crash); croner only schedules forward. Every miss is
  // recorded `missed`, run late unless `catchup: false`. Also timed; deadline-aborted (PHNX-3608).
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
        // Every variant handled explicitly: a catch-all else would log the
        // benign 'claimed-elsewhere' (another process legitimately won the
        // claim) as an ERROR with an undefined reason.
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
            // Compile-time exhaustiveness: a new CatchupOutcome variant fails
            // typecheck here rather than silently landing in the wrong log level,
            // which is exactly how 'claimed-elsewhere' was first missed.
            const unhandled: never = o.result;
            log('ERROR', `Catchup for '${o.name}' returned an unhandled result: ${String(unhandled)}`);
          }
        }
      }
    } catch (err) {
      // Ordinary pass errors are logged, not re-thrown: a transient catchup failure shouldn't
      // count as a service failure. A hang is still caught since the deadline aborts the tick and
      // the supervisor exits the daemon for an OS restart (PHNX-4116).
      log('ERROR', `Catchup pass failed: ${(err as Error).message}`);
    }
  }

  // The browser IPC server and its orphan reap left this daemon with the
  // standalone `browser` CLI (PHNX-4101) — it hosts its own IPC service now.

  // Webhook receivers (RUSH-2548): signed receiver(s) plus funnel, owned by WebhookReceiverService
  // with failure isolation and cleanup. Secrets resolve headlessly via the standalone `secrets`
  // CLI (agentOnly). Binds nothing unless daemon/webhooks.yaml declares one.

  // Resource self-heal is SelfHealService on the supervisor (RUSH-3193 P3); its immediate first
  // tick replaces the old 30s SELF_HEAL_KICKOFF_MS timer (see self-heal-service.ts).

  // The secrets broker's self-heal and keychain-reap ticks (RUSH-1817 / RUSH-2232) moved out with
  // the standalone `secrets` engine (PHNX-3989 OWN-1), which owns its broker lifecycle.

  // RUSH-2501: reap tmux sessions whose panes are all dead. Daemon-only
  // (single executor). Dead managed panes and their orphan helpers are
  // reaped by TmuxReapService.

  // Abandoned browser-task reaping (RUSH-2622) left this daemon with the
  // standalone `browser` CLI (PHNX-4101) — its own `prune` reaper owns it now.

  // RUSH-2367 / RUSH-3193 P3: state-dir-check (self-terminate guard) is
  // registered on the supervisor further below, once `handleShutdown` exists
  // — see the registration site after its declaration for why.

  // RUSH-2418: startup is over; only now clear the auto-start failure streak `ensureDaemonStarted`
  // reads. Clearing at claim time would reset the breaker for a process that dies initializing a
  // subsystem, the crash loop it exists to stop.
  recordSubsystemOk(SUBSYSTEM_DAEMON_START);

  const handleReload = () => {
    log('INFO', 'Reloading jobs (SIGHUP)');
    // Re-read per-service toggles so `agents daemon services enable|disable`
    // followed by `agents daemon reload` is truthful. Most services require a
    // restart to start/stop safely; log those instead of pretending they applied.
    const reloadedConfig = readDaemonServicesConfig();
    const reloadedEnabled = (id: DaemonServiceId): boolean => reloadedConfig.services[id] !== false;
    for (const id of Object.keys(servicesConfig.services) as DaemonServiceId[]) {
      const was = servicesConfig.services[id] !== false;
      const now = reloadedEnabled(id);
      if (was !== now) {
        // The scheduler is not a supervised service — its gate is re-evaluated
        // live later in this handler, so don't tell the user to restart for it.
        if (id === 'scheduler') {
          continue;
        }
        // RUSH-3193 P4: a supervisor-owned service toggles live via supervisor.start/stop, so a
        // disabled `monitors` stops dispatching (PHNX-3608); browser-ipc is registered stopped
        // (PHNX-3605). Others disabled at boot were never registered and need a restart.
        if (supervisor.isRegistered(id)) {
          // A periodic service may be mid-tick when SIGHUP arrives. Queue the transition behind
          // that promise: deadlines detect a wedge but can't cancel arbitrary work, and polling
          // here would add a lifecycle timer outside the supervisor.
          const action = supervisor.awaitIdle(id).then(() => now ? supervisor.start(id) : supervisor.stop(id));
          void action
            .then(() => log('INFO', `Service '${id}' ${now ? 'started' : 'stopped'} live (SIGHUP reload)`))
            .catch((err) => log('WARN', `Service '${id}' live ${now ? 'start' : 'stop'} failed: ${(err as Error).message}`));
        } else {
          log('INFO', `Service '${id}' toggled ${now ? 'on' : 'off'} — restart daemon to apply`);
        }
      }
    }
    // Remember the reloaded state so subsequent reloads log transitions truthfully.
    servicesConfig = reloadedConfig;

    // Drain queued `agents daemon services restart <id>` requests (RUSH-3193 P4).
    for (const id of drainDaemonServiceRestartQueue()) {
      if (supervisor.isRegistered(id)) {
        void supervisor.awaitIdle(id).then(() => supervisor.restartOne(id))
          .then(() => log('INFO', `Service '${id}' restarted live (SIGHUP reload)`))
          .catch((err) => log('WARN', `Service '${id}' live restart failed: ${(err as Error).message}`));
      } else {
        log('WARN', `Restart requested for '${id}' but it is not supervisor-managed on this daemon — restart the daemon instead`);
      }
    }

    // Refresh user-layer copies of opted-in project routines BEFORE the
    // scheduler reloads, so YAML edits under `<project>/.agents/routines/`
    // take effect on the next fire without a manual `routines sync`.
    try {
      const result = syncAllProjectRoutines();
      const n = result.projects.reduce((acc, p) => acc + p.synced.length, 0);
      if (n > 0 || result.missing.length > 0) {
        log('INFO', `Project routines sync: ${n} updated, ${result.missing.length} missing roots`);
      }
    } catch (err) {
      log('WARN', `Project routines sync failed: ${(err as Error).message}`);
    }
    // Re-evaluate the scheduler.enabled gate on reload so flipping it needs no restart; a
    // `routines add` on a re-enabled box signals this reload, which boots the scheduler, so
    // "Scheduler reloaded" is truthful. Also honours the daemon-services toggle.
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
    // Refresh monitor configs when the engine is live and monitors stays enabled (`monitors
    // add/edit` + SIGHUP). The enable/disable transition is handled by the supervisor.start/stop
    // loop above (PHNX-3608); an off-transition leaves getEngine() null so this is skipped.
    const liveMonitorEngine = monitorEngineSvc.getEngine();
    if (liveMonitorEngine && reloadedEnabled('monitors')) {
      try {
        liveMonitorEngine.reload();
      } catch (err) {
        log('ERROR', `Monitor engine reload failed: ${(err as Error).message}`);
      }
    }
  };

  // Structurally single-shot (RUSH-2423). Shutdown is reachable from SIGTERM, SIGINT and
  // StateDirCheckService's `onMissing`, and two can arrive together. It was only incidentally safe
  // (each step idempotent); the guard makes single-shot a property of the function.
  const handleShutdown = singleShot(async () => {
    log('INFO', 'Daemon shutting down');
    // supervisor.stopAll() stops every registered service, including socket
    // hosts, session publishers/indexers, monitor/account work, and every
    // maintenance timer; state-dir-check joins the registry just below.
    await supervisor.stopAll();
    activeServiceSupervisor = null;
    stopScheduler();
    try {
      if (fs.readFileSync(lifetimePath, 'utf-8') === lifetimeToken) fs.unlinkSync(lifetimePath);
    } catch {
      // Already removed with the state dir, or replaced by a newer owner.
    }
    removeDaemonPidIfOwned(process.pid);
    if (readHeartbeat()?.pid === process.pid) removeHeartbeat();
    unregisterDaemonInstance();
    process.exit(0);
  });

  // Register the state-dir self-check (RUSH-2367) after `handleShutdown`, not with the other
  // services: the supervisor fires an immediate first tick on start, which would reference the
  // const in its temporal dead zone if a mismatch were detected.
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
    // Signal callbacks sit outside the supervisor's service barriers. A
    // reload failure must be observable without reaching the process-wide
    // uncaughtException handler and taking down every daemon service.
    try { log('ERROR', `SIGHUP reload failed: ${(err as Error).message}`); } catch { /* logging must not crash the daemon */ }
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

/** Escape a string for safe inclusion in an XML <string> node. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Write a launchd plist or systemd unit with owner-only permissions atomically. `writeFileSync`'s
 * `mode` applies only on create, so unlink any existing manifest first: every write is a fresh
 * 0600 create, closing the TOCTOU window and re-locking a stale world-readable one. */
export function writeOwnerOnlyServiceManifest(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.rmSync(filePath, { force: true });
  fs.writeFileSync(filePath, content, { encoding: 'utf-8', mode: 0o600 });
}

/** Generate a macOS launchd plist for the daemon. It never embeds a Claude OAuth token (the daemon
 * holds no Claude credential). RUSH-2639: launchd doesn't inherit `launchctl load`'s caller
 * environment, so HOME is pinned in the plist. */
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

/** Quote one systemd ExecStart argument without delegating parsing to a shell. */
function systemdExecArg(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Generate a Linux systemd user unit for the daemon. It never embeds a Claude OAuth token (the
 * daemon holds no Claude credential). RUSH-2639: same seam as `generateLaunchdPlist`: HOME is
 * whatever the user's systemd session provides unless the unit pins it. */
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

// Binary-resolution helpers (getAgentsBinPath / isNodeScriptEntry / getCliLaunch)
// live in ./cli-entry.js — a leaf module. Re-exported so existing
// `from './daemon.js'` importers of getAgentsBinPath keep resolving.
export { getAgentsBinPath };

/** Ask the service manager for the daemon's live PID, as a fallback when launchd/systemd report it
 * running before it writes its pid file, so a start never surfaces a null PID. `names` defaults to
 * this process's job; a redirected-HOME caller passes `productionDaemonServiceNames()`. */
export function readServiceManagerPid(
  platform: NodeJS.Platform = os.platform(),
  names?: { systemdUnit: string; launchdLabel: string },
): number | null {
  const resolved = names ?? { systemdUnit: daemonSystemdUnitName(), launchdLabel: daemonServiceLabel() };
  // The registration gate exists so a sandboxed process can't register or tear down jobs in the
  // real service manager. Asking after an explicitly named job is read-only (notably the
  // production unit from a redirected-HOME caller, W4), so it is allowed.
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
  } catch { /* not running / manager unavailable */ }
  return null;
}

/** Thrown when a daemon LAUNCH is attempted under a redirected HOME without the explicit test
 * opt-in (W4, PHNX-3736). `bootstrap.ts` prints it without a stack: it is user-actionable, not an
 * engineering bug. */
export class RedirectedHomeDaemonError extends Error {
  override name = 'RedirectedHomeDaemonError';
}

/** W4 (PHNX-3736): never launch a daemon under a redirected (sandbox/test) HOME without opt-in; its
 * temp-HOME pid file hides it from the real takeover (one ran 4+ days). Seam:
 * AGENTS_ALLOW_TEST_DAEMON=1. Placed after `already-running` so a leaked one can still be stopped. */
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

/** Start the daemon via launchd, systemd, or as a detached process. */
export function startDaemon(agentsBin?: string): { pid: number | null; method: string } {
  // The public launcher must obey the same namespace boundary as its child:
  // even probing/repairing legacy PID state or pruning a lock can mutate it.
  if (!daemonProcessViewAllowed()) throw new Error('Daemon startup requires the owning process namespace. Automatic reuse of a private-container HOME across namespaces is unsupported; run in its owning namespace or use a fresh HOME.');
  if (isDaemonRunning()) {
    const pid = readDaemonPid();
    return { pid, method: 'already-running' };
  }

  assertDaemonLaunchHomeAllowed();

  const releaseLock = acquireStartLock();
  if (!releaseLock) {
    // Another process is already starting the daemon
    const pid = waitForPid(3000);
    return { pid, method: 'already-starting' };
  }

  // Released by startDaemonLocked once the launch is issued, and again here as the backstop for
  // paths that returned earlier. Idempotent so the double call can't unlink a lock a later claimer
  // owns.
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    releaseLock();
  };

  // RUSH-2418: count starts pessimistically and let a daemon that reaches steady state clear the
  // streak (`recordSubsystemOk` at the end of runDaemon's startup). A daemon that spawns then dies
  // returns a real `child.pid`, so only counting observable errors would miss the crash loop.
  recordSubsystemError(SUBSYSTEM_DAEMON_START, 'start issued; no daemon has reported healthy since');
  try {
    return startDaemonLocked(agentsBin ?? getAgentsBinPath(), releaseOnce);
  } catch (err: any) {
    // Replace the provisional reason with the real one — the streak is already
    // counted, this just makes `agents daemon doctor` name the actual cause.
    recordSubsystemErrorReason(SUBSYSTEM_DAEMON_START, `start failed: ${err?.message ?? String(err)}`);
    throw err;
  } finally {
    releaseOnce();
  }
}

/** Is the auto-start circuit breaker open (RUSH-2418)? True once DAEMON_AUTOSTART_FAILURE_LIMIT
 * consecutive starts failed to produce a healthy daemon. Pure read of the persisted health record,
 * which `agents daemon doctor` also reports. */
export function isDaemonAutostartCircuitOpen(): boolean {
  const health = readSubsystemHealth(SUBSYSTEM_DAEMON_START);
  return (health?.consecutiveFailures ?? 0) >= DAEMON_AUTOSTART_FAILURE_LIMIT;
}

/** Bring the always-on daemon up as a side effect of a background-adjacent command (secrets unlock,
 * browser start), not only `routines add` (#415). Delegates to `startDaemon` (honors the start
 * lock). Failures are swallowed, returning null, so it never breaks the foreground command. */
export function ensureDaemonStarted(): { pid: number | null; method: string } | null {
  // RUSH-2354: honor daemon.enabled; a background-adjacent caller must not resurrect a daemon the
  // owner turned off. `agents daemon start` is the override and calls startDaemon() directly.
  if (!isDaemonEnabled()) return null;
  // A live daemon is the answer whatever the failure history says: the breaker gates launching,
  // never reporting. Checked first so a stale streak can't make a healthy daemon read as absent
  // (e.g. secrets/agent.ts).
  if (isDaemonRunning()) return startDaemon();
  // RUSH-3021: never launch a daemon from a redirected HOME; a test CLI could fork one that
  // outlives the test and races its teardown (ENOTEMPTY). Seam:
  // AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME=1. `daemon start` is gated by W4 (PHNX-3736).
  if (!serviceManagerRegistrationAllowed().allowed) return null;
  // RUSH-2418: the auto-start circuit breaker. A daemon dying at startup would be relaunched by
  // every foreground command: a crash loop the OS throttle can't see. After
  // DAEMON_AUTOSTART_FAILURE_LIMIT failures, refuse and say why. `agents daemon start` overrides.
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

/** Issue the launch, then wait for the child's pid. RUSH-2417: the wait must NOT hold the start
 * lock (`claimDaemonInstance` shares `daemon.lock`, so the child would hit EEXIST, falsely
 * "mid-takeover"). Early release is safe: launchd/systemd are singletons, else SING-11 takeover. */
function startDaemonLocked(agentsBin: string, releaseLock: () => void): { pid: number | null; method: string } {
  const platform = os.platform();
  // Same contract on the fallback path: the spawn IS the launch, so the lock is
  // dropped before the child exists rather than in a `finally` the child races.
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
        // The plist carries no credential (RUSH-1759 — the daemon reads the OAuth
        // token itself at startup); still create owner-only atomically to match the
        // detached path and keep the log/PATH surface owner-private.
        writeOwnerOnlyServiceManifest(plistPath, generateLaunchdPlist(agentsBin));

        try {
          execFileSync('launchctl', ['unload', plistPath], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
        } catch { /* not loaded, expected */ }
        // launchctl prints `Load failed:` and exits 0 when the label is stuck from a prior
        // session, so a zero exit isn't proof of success. If no pid appears within the window,
        // give up on launchd and fall through to a plain detached spawn.
        execFileSync('launchctl', ['load', plistPath], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
        // Launch issued — the child needs this lock to claim (RUSH-2417).
        releaseLock();
        const pid = waitForPid(3000) ?? readServiceManagerPid();
        if (pid) return { pid, method: 'launchd' };
        // launchctl claimed success but nothing ran. Fall through.
      } catch {
        // load threw — fall through to detached spawn
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
        // Carries no credential (RUSH-1759 — the daemon reads the OAuth token
        // itself at startup); owner-only to keep the PATH/log surface private.
        writeOwnerOnlyServiceManifest(unitPath, generateSystemdUnit(agentsBin));

        execFileSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf-8' });
        execFileSync('systemctl', ['--user', 'enable', daemonSystemdUnitName()], { encoding: 'utf-8' });
        execFileSync('systemctl', ['--user', 'start', daemonSystemdUnitName()], { encoding: 'utf-8' });

        // Launch issued — the child needs this lock to claim (RUSH-2417).
        releaseLock();
        const pid = waitForPid(3000) ?? readServiceManagerPid();
        if (pid) return { pid, method: 'systemd' };
        // systemctl returned success but no PID surfaced — fall through to a
        // plain detached spawn rather than reporting a null PID.
      } catch {
        // start threw — fall through to detached spawn
      }
    } else {
      process.stderr.write(`[agents] ${reg.reason}\n`);
    }
    return detachedFallback();
  }

  return startDetached({ agentsBin });
}

/** Resolve how to launch the daemon: `node <entry> __daemon-run`. Executing the `.js` relies on a
 * shebang (POSIX), and on Windows a transient console-owning wrapper's exit sends the detached
 * daemon a console-close event that tears it down ~36ms after binding (#556). */
export function getDaemonLaunch(agentsBin: string = getAgentsBinPath()): { command: string; args: string[] } {
  const { warnings } = validateDaemonBinary(agentsBin);
  for (const w of warnings) process.stderr.write(`[agents] ${w}\n`);
  return getCliLaunch(['__daemon-run'], agentsBin);
}

/** Directory of the Node runtime that generated this manifest, kept first on the daemon's PATH so
 * the shim's shebang and child routines resolve the exact Node that installed the service.
 * Replaces a hardcoded nvm path that went stale on upgrade and bricked the fleet. */
function daemonNodeBinDir(): string {
  return path.dirname(process.execPath);
}

/** Login-shell user-bin dirs a service-manager daemon would miss: systemd/launchd pin PATH and
 * never source `~/.profile`, so `~/.rush/bin` and `~/.local/bin` are invisible and the rush owner
 * channel fails `rush CLI not found on PATH` (PHNX-3075). Uses the manifest's HOME (RUSH-2639). */
function daemonUserBinDirs(): string[] {
  const home = serviceManifestHomeEnv().HOME;
  return [path.join(home, '.rush', 'bin'), localBinDir(home)];
}

/** The PATH the daemon manifest pins, in order: the `agents` shim's own dir first, then the Node
 * runtime dir, then login-shell user-bin dirs, then system dirs. The shim dir leads so a scheduled
 * `command` routine shelling out to bare `agents` resolves the running binary, not a stale one. */
function daemonPathValue(agentsBin: string, systemDirs: readonly string[]): string {
  return [...new Set([
    path.dirname(agentsBin),
    daemonNodeBinDir(),
    ...daemonUserBinDirs(),
    ...systemDirs,
  ])].join(':');
}

/** Build the argv to relaunch the `agents` CLI: a `.js` entry runs under node, a compiled binary
 * runs directly. Callers MUST use this, not `[process.execPath, process.argv[1], ...]`: under the
 * standalone binary (#315) argv[1] is the bun virtual entry, read as an unknown subcommand. */
export function getAgentsInvocation(
  subArgs: string[],
  agentsBin: string = getAgentsBinPath(),
): { command: string; args: string[] } {
  return getCliLaunch(subArgs, agentsBin);
}

/** A daemon binary under an ephemeral path (git worktree, `/tmp`, `/var/folders`, `/dev/shm`) is a
 * latent wedge: it resolves job modules by dynamic `import()` rooted at its entry, so removing
 * that directory makes every job ENOENT. Returns the ephemeral kind, or null. */
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
  /** CLI entry to launch (defaults to the running binary). Injectable for tests. */
  agentsBin?: string;
  /** Log file the daemon's stdio is redirected to (defaults to the daemon log). */
  logPath?: string;
  /** Environment for the child (defaults to the daemon's current process env). */
  env?: NodeJS.ProcessEnv;
}

export function startDetached(opts: StartDetachedOptions = {}): { pid: number | null; method: string } {
  const agentsBin = opts.agentsBin ?? getAgentsBinPath();
  const logPath = opts.logPath ?? getDaemonLogPath();
  const logFd = fs.openSync(logPath, 'a');

  const { command, args } = getDaemonLaunch(agentsBin);
  // fdStdio: log-file fds make windowsHide inert (libuv skips CREATE_NO_WINDOW when a stdio fd is
  // inherited), so on Windows the daemon must DETACH to own no console, else a console-close event
  // tears it down when the launcher exits (#556).
  const child = spawn(command, args, {
    stdio: ['ignore', logFd, logFd],
    ...backgroundSpawnOptions({ cwd: os.homedir(), fdStdio: true }),
    env: opts.env ?? process.env,
  });

  // A failed spawn (ENOENT/EACCES) emits 'error' asynchronously; without a
  // listener that would crash the parent as an unhandled EventEmitter error.
  // The synchronous `!child.pid` guard below is what reports the failure loudly.
  child.on('error', () => { /* reported synchronously via the pid guard below */ });

  child.unref();
  fs.closeSync(logFd);

  // `spawn` leaves `pid` undefined only when the process couldn't be created. The old `child.pid
  // || null` let callers report "PID: null" as a started daemon; a start with no PID is a failed
  // start, so fail loudly.
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

/** One piece of daemon state a graceful `handleShutdown` removes and an escalated kill leaves
 * behind (RUSH-2421). */
interface StopResidueArtifact {
  label: string;
  present: boolean;
  /** The file names a live owner, including a stopped target that survived. */
  ownedByLiveOther: boolean;
  reclaim: () => void;
  stillPresent: () => boolean;
}

/** Read the pid a state file claims, or null when absent, unreadable or not pid-shaped. The
 * lifetime marker stores `<pid>:<epochMs>`; the heartbeat stores JSON with a `pid`. */
function claimedPid(read: () => number | null): number | null {
  try { return read(); } catch { return null; }
}

/** The lifetime marker, heartbeat and instance-registry entry, described so stopDaemon can assert
 * them like the sockets. Ownership, not presence, decides: a file naming a live pid that isn't the
 * stopped daemon belongs to a successor or peer and must not be deleted. */
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
    reclaim: () => { try { fs.unlinkSync(lifetimePath); } catch { /* raced with a fresh start */ } },
    stillPresent: () => fs.existsSync(lifetimePath),
  });

  const heartbeatPath = getHeartbeatPath();
  const hb = readHeartbeat();
  artifacts.push({
    label: 'daemon heartbeat',
    present: fs.existsSync(heartbeatPath),
    // A stale heartbeat is not cosmetic: resolveLiveDaemonPid() trusts a FRESH
    // one to re-adopt a daemon whose pid file was lost, so leaving one behind
    // can make a dead daemon read as running.
    ownedByLiveOther: hb !== null && (
      survivors.includes(hb.pid)
      || (hb.pid !== stoppedPid && isAlive(hb.pid))
    ),
    reclaim: () => removeHeartbeat(),
    stillPresent: () => fs.existsSync(heartbeatPath),
  });

  // POSIX-only, matching registerDaemonInstance/unregisterDaemonInstance.
  if (process.platform !== 'win32' && stoppedPid !== null) {
    const markerPath = path.join(getDaemonInstancesDir(), String(stoppedPid));
    artifacts.push({
      label: 'daemon instance registry entry',
      present: fs.existsSync(markerPath),
      // The marker is named by pid but is residue only once that daemon is DEAD; deleting it while
      // it lives erases what `findSurvivingStateDirDaemons` enumerates, so the next stop reports
      // `ok: true`. "Dead" comes from the survivor scan, not `isAlive` (zombies).
      ownedByLiveOther: survivors.includes(stoppedPid),
      reclaim: () => unregisterDaemonInstance(stoppedPid),
      stillPresent: () => fs.existsSync(markerPath),
    });
  }

  return artifacts;
}

/** Structured outcome of stopDaemon (SING-12, RUSH-2355): `ok` only when every held resource is
 * provably released. `surviving` names anything that didn't release and drives a non-zero exit;
 * `detachedChildren` survive deliberately (SING-11a), reported never killed. */
interface DaemonStopResult {
  ok: boolean;
  stoppedPid: number | null;
  escalated: boolean;
  released: string[];
  surviving: string[];
  detachedChildren: number[];
}

/** Live `__daemon-run` processes in THIS state dir's instance registry, excluding `exclude`.
 * State-dir-scoped by construction, so a daemon under a different HOME (test fixture, separate
 * install) is invisible and never a stop/takeover target. POSIX-only; `[]` on Windows (RUSH-2368). */
function findStateDirDaemonProcesses(exclude: Set<number>): { live: number[]; unverified: number[] } {
  const live: number[] = [];
  const unverified: number[] = [];
  if (process.platform === 'win32') return { live, unverified };
  const dir = getDaemonInstancesDir();
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return { live, unverified }; }
  for (const name of entries) {
    const pid = parseInt(name, 10);
    if (isNaN(pid) || String(pid) !== name) continue; // not a pid marker
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

/** Stop the daemon and assert its postcondition (SING-12, RUSH-2355), unloading from
 * launchd/systemd if applicable. After SIGTERM, grace, killTree it verifies no `__daemon-run` for
 * this state dir survives and reclaims stale state files; never reports an unverified stop as ok. */
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

/** daemon.lock is held for this entire read-signal-verify-cleanup transaction. */
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

  // Capture the target and its path-bound resources while lifecycle writers are
  // excluded. resolveLiveDaemonPid(true) rejects a reused/non-daemon pid before
  // any service-manager teardown or direct signal and repairs only under lock.
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
      try { fs.unlinkSync(plistPath); } catch { /* plist already removed */ }
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
      try { fs.unlinkSync(unitPath); } catch { /* unit file already removed */ }
    }
  }

  if (pid) {
    if (process.platform === 'win32') {
      // Windows has no graceful termination signal — terminate the daemon and
      // its job/browser child tree in one shot (taskkill /T), so stop doesn't
      // report success while children keep running.
      if (isLiveDaemon(pid)) {
        killTree(pid);
        escalated = true;
        waitForExit(pid, STOP_KILL_GRACE_MS);
      }
    } else {
      // Revalidate immediately before the signal: the pid may have exited and
      // been reused since the ownership snapshot above.
      if (isLiveDaemon(pid)) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch { /* process already exited */ }

        // Wait for it to actually go. The old setTimeout escalation plus immediate
        // removeDaemonPid() never fired in a short-lived process (npm postinstall), and clearing
        // the pid file early let startDaemon() launch a SECOND daemon (two brokers, one socket).
        if (!waitForExit(pid, STOP_GRACE_MS) && isLiveDaemon(pid)) {
          killTree(pid);
          escalated = true;
          waitForExit(pid, STOP_KILL_GRACE_MS);
        }
      }
    }
  }

  // ── Assert the postcondition (SING-12) ────────────────────────────────────
  // No `__daemon-run` for this state dir may survive the stop.
  const stateDirProcesses = findStateDirDaemonProcesses(new Set([process.pid]));
  const survivors = stateDirProcesses.live;
  const unverifiedSurvivors = stateDirProcesses.unverified;
  // The registry is best-effort and may be missing, so always re-check the
  // direct target as well. This is the only check available on Windows.
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

  // Delete the registration only after the target is provably gone, and only
  // if the file still names that target. A replacement value belongs to a
  // successor (or another writer) and is both preserved and reported.
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

  // The browser IPC socket is the standalone `browser` CLI's now (PHNX-4101):
  // the daemon no longer binds it, so there is nothing to reclaim here. browser-cli
  // owns its own socket lifecycle under `~/.agents/.cache/helpers/browser/`.

  // State files a killed daemon can't clean up (RUSH-2421): handleShutdown removes the lifetime
  // marker, heartbeat and registry entry only on the graceful path, so escalation left them while
  // stop said `ok: true`; a stale heartbeat re-adopts a dead daemon.
  for (const artifact of stopResidueArtifacts(pid, [...survivors, ...unverifiedSurvivors])) {
    if (!artifact.present) { released.push(artifact.label); continue; }
    if (artifact.ownedByLiveOther) { released.push(`${artifact.label} (owned by a live daemon)`); continue; }
    artifact.reclaim();
    if (artifact.stillPresent()) surviving.push(`${artifact.label} not released`);
    else released.push(`${artifact.label} (reclaimed)`);
  }

  // In-flight detached routine children survive on purpose (SING-11a) — report,
  // never kill: severing a live agent mid-run is worse than a daemon restart.
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

/** Current daemon status: running state, PID, enabled job count and the supervised-restart history
 * `agents daemon status` renders (PHNX-4116). No `wedged` state: a stalled daemon exits for a
 * systemd/launchd restart, so it is `running` or `stopped`. */
export function getDaemonStatus(): {
  state: 'running' | 'stopped';
  running: boolean;
  pid: number | null;
  jobCount: number;
  logPath: string;
  binaryPath: string | null;
  heartbeat: DaemonHeartbeat | null;
  /** Supervised restarts in the last 24h (a service breaching its deadline exits the daemon for an OS restart). */
  restarts24h: number;
  /** The most recent supervised-restart cause, or null if none in the last 24h. */
  lastRestartCause: string | null;
  /** ISO timestamp of the most recent supervised restart in the last 24h, or null. */
  lastRestartAt: string | null;
} {
  const running = isDaemonRunning();
  const pid = readDaemonPid();

  let jobCount = 0;
  try {
    jobCount = listAllJobs().filter((j) => j.enabled).length;
  } catch { /* job listing failed */ }

  let binaryPath: string | null = null;
  try {
    binaryPath = getAgentsBinPath();
  } catch { /* resolution failed */ }

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

/** Read the daemon log, optionally limited to the last N lines. */
export function readDaemonLog(lines?: number): string {
  const logPath = getDaemonLogPath();
  if (!fs.existsSync(logPath)) return '(no log file)';

  const content = fs.readFileSync(logPath, 'utf-8');
  if (!lines) return content;

  const allLines = content.split('\n');
  return allLines.slice(-lines).join('\n');
}

/** Send SIGHUP to the daemon to trigger a job reload. */
export function signalDaemonReload(): boolean {
  const pid = readDaemonPid();
  if (!pid) return false;
  if (process.platform === 'win32') {
    // Windows has no SIGHUP, so signal-based live reload isn't available. Sending
    // it would throw; instead report "not reloaded" so callers tell the user to
    // restart the daemon to pick up job changes.
    return false;
  }
  try {
    process.kill(pid, 'SIGHUP');
    return true;
  } catch {
    return false;
  }
}
