/**
 * Daemon lifecycle management for the routines scheduler.
 *
 * The daemon is a long-running process that holds a JobScheduler and
 * triggers jobs on their cron schedules. It can be managed via launchd
 * (macOS), systemd (Linux), or as a plain detached process. PID tracking,
 * log output, reload (SIGHUP), and graceful shutdown are handled here.
 */

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
import { BrowserService } from '../browser/service.js';
import { getSocketPath as getBrowserIpcSocketPath } from '../browser/ipc.js';
import { secretsBrokerSocketPath, brokerPidAlive } from '../secrets/agent.js';
import { redactSecrets } from '../redact.js';
import { getAgentsBinPath, getCliLaunch, BUN_VIRTUAL_ROOT } from '../cli-entry.js';
import { localBinDir } from '../platform/posixpath.js';
import { isSchedulerEnabled, assertSchedulerEnabled, isDaemonEnabled } from '../device-config.js';
import { recordSubsystemOk, recordSubsystemError, recordSubsystemErrorReason, readSubsystemHealth, SUBSYSTEM_DAEMON_START } from '../daemon-health.js';
import { ServiceSupervisor } from './supervisor.js';
import { SessionIndexService } from './session-index-service.js';
import { SecretsBrokerService } from './secrets-broker-service.js';
import { MonitorEngineService } from './monitor-engine-service.js';
import { AccountUsageService, AccountAuthService } from './account-state-daemon-service.js';
import { CatchupService } from './catchup-service.js';
import { BrowserIPCService } from './browser-ipc-service.js';
import { WatchdogService } from './watchdog-service.js';
import { DeviceProbeService } from './device-probe-service.js';
import { SelfHealService } from './self-heal-service.js';
import { SelfUpdateService } from './self-update-service.js';
import { KeychainReapService } from './keychain-reap-service.js';
import { AuthSyncService } from './auth-sync-service.js';
import { UsageSyncService } from './usage-sync-service.js';
import { StateDirCheckService } from './state-dir-check-service.js';
import { SessionStateService } from './session-state-service.js';
import { WebhookReceiverService } from './webhook-receiver-service.js';
import { HeartbeatService } from './heartbeat-service.js';
import { TmuxReapService } from './tmux-reap-service.js';
import { BrowserTaskReapService } from './browser-task-reap-service.js';
import type { ServiceHealth } from './service.js';
import { emit, emitRoutineEnd } from '../feed/events.js';
import { readDaemonServicesConfig, isDaemonServiceEnabled, drainDaemonServiceRestartQueue, type DaemonServiceId } from '../daemon-services.js';
import { sleepSync } from '../fs-atomic.js';

/**
 * The live `ServiceSupervisor` for the current `runDaemon()` invocation, or
 * `null` before boot / after shutdown. In-process only — a separate `agents
 * daemon status` process cannot see this; per-service health that must
 * survive across processes goes through `daemon-health.ts` instead (which
 * `ServiceSupervisor` already writes on every tick). This getter exists so a
 * FUTURE same-process consumer (e.g. a `daemon services` live-status IPC
 * handler) can read the supervisor's richer state (`parked`, not just
 * ok/error) without needing its own reference to `runDaemon()`'s locals.
 */
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

/**
 * RUSH-2639 (residual): launchd/systemd route `unload`/`load`/`list` by the
 * service identifier ALONE, never by the plist/unit file's path. Baking the
 * caller's HOME into the plist content (the earlier RUSH-2639 fix, above)
 * keeps the STARTED daemon inside its sandbox, but every hermetic-test
 * instance and every real interactive install still share the one literal
 * `PLIST_NAME`/`SYSTEMD_UNIT` string. `startDaemonLocked`'s own `unload`
 * before `load` is written to be a no-op ("not loaded, expected") for a
 * plist that has never been loaded — but confirmed on darwin: when a
 * DIFFERENT plist is already loaded under that same label, `unload
 * <this-instance's-own-never-loaded-path>` still tears down the OTHER job
 * (verified directly against real launchctl with two throwaway plists
 * sharing one label — the second job's own `unload` silently kills the
 * first, still alive under a different path). On a machine running several
 * hermetic test forks at once (CI) — or a developer's own suite next to
 * their real always-on daemon — that "other job" is a live daemon with
 * DIFFERENT baked-in state.
 *
 * Namespace the identifier itself whenever HOME has been redirected away
 * from the account's real home. `os.userInfo().homedir` reads the OS/passwd
 * record directly and ignores `$HOME` (unlike `os.homedir()`, which honors
 * it), so comparing the two detects exactly this redirection — true for
 * every hermetic test process, false for every real interactive/production
 * invocation, so a real user's daemon keeps registering under the unchanged
 * production identifier.
 *
 * The rule itself now lives in `service-manifest.ts` — the daemon was the first
 * manifest to need it, not the only one — and is re-exported here because it is
 * part of this module's published surface.
 */
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

/**
 * Cadences for the in-process background ticks, named here beside the other
 * tick constants rather than left as inline literals at their `setInterval`
 * (RUSH-2423). Self-heal, keychain-reap, state-dir-check, watchdog, and
 * device-probe cadences moved to their own `*-service.ts` files (RUSH-3193
 * P3, alongside session-index/account-state/etc.) — see those files for the
 * per-service trade-offs (self-heal's 6h/cheap-to-be-late repair cadence,
 * keychain-reap's 5min `ps`-shell cost bound, state-dir-check's env override
 * for tests, watchdog/device-probe's shared 3min in-process housekeeping
 * cadence, NOT a routine — RUSH-2495).
 *
 * - **Broker self-heal** is a bare `agentPing`, and the failure it recovers
 *   from wedges every keychain-backed secret on the box, so it runs minutely.
 */
// BROKER_SELF_HEAL_TICK_MS moved to secrets-broker-service.ts (RUSH-3193 P2).
// Session-index warm interval/deadline live in session-index-service.ts now
// (RUSH-3193 — migrated onto ServiceSupervisor).
const WEDGE_THRESHOLD_TICKS = 3;
const DAEMON_HEARTBEAT_TICK_MS = 60_000;

/**
 * Crash-loop prevention (RUSH-2418). Three layers, because none of them alone
 * bounds a daemon that dies during startup:
 *
 * 1. **The OS supervisor paces the respawn.** `KeepAlive` with no
 *    `ThrottleInterval` lets launchd relaunch on its ~10s default, so a daemon
 *    that dies while booting is restarted six times a minute forever — the exact
 *    failure the menu-bar helper hit (`menubar/install-menubar.ts`: 38 orphaned
 *    `agents doctor` children, load average 490). systemd's `Restart=always`
 *    with no `StartLimit*` is the same uncapped loop.
 * 2. **`StartLimitBurst` gives systemd a real cap** — after this many starts
 *    inside the interval the unit is put in `failed` and stops respawning, so a
 *    genuinely broken install stops burning the box and `systemctl --user status`
 *    names it. launchd has no burst equivalent; the throttle is its whole answer.
 * 3. **The application-level circuit breaker** below stops *auto*-starts from
 *    re-entering the loop from the other direction — a foreground command that
 *    calls `ensureDaemonStarted()` on every invocation.
 */
const DAEMON_THROTTLE_SECONDS = 30;
const DAEMON_START_LIMIT_INTERVAL_SECONDS = 300;
const DAEMON_START_LIMIT_BURST = 5;

/**
 * How many consecutive failed daemon starts disable the *implicit* auto-start
 * (`ensureDaemonStarted`). Matches `DAEMON_START_LIMIT_BURST` so the two layers
 * give up together rather than one silently masking the other. `agents daemon
 * start` is the deliberate override and is never gated by this.
 */
export const DAEMON_AUTOSTART_FAILURE_LIMIT = 5;

/**
 * RUSH-1817: decide whether the daemon should (re)take over hosting the secrets
 * broker. The startup host decision is one-shot; this drives the periodic
 * self-heal re-check. Take over ONLY when the daemon is not already hosting AND
 * no healthy broker answers a ping — i.e. a standalone the daemon deferred to at
 * start has since died or crash-looped. Never take over while our in-process
 * broker is hosting, and never clobber a reachable (healthy) broker.
 */
export function shouldTakeOverBroker(isHosting: boolean, brokerReachable: boolean): boolean {
  return !isHosting && !brokerReachable;
}

/**
 * What a gate re-evaluation must do with the routines scheduler. The daemon
 * re-evaluates `scheduler.enabled` on every SIGHUP reload so flipping the key
 * takes effect without a daemon restart (and `routines add`'s reload signal on
 * a re-enabled box boots the scheduler — the reload is truthful, not a no-op).
 *
 *   running + enabled   → reload (the normal SIGHUP path)
 *   running + !enabled  → stop  (gate flipped off since boot)
 *   !running + enabled  → boot  (gate flipped on since boot)
 *   !running + !enabled → none  (stay dark)
 */
export type SchedulerGateTransition = 'reload' | 'stop' | 'boot' | 'none';

export function schedulerGateTransition(running: boolean, enabled: boolean): SchedulerGateTransition {
  if (running) return enabled ? 'reload' : 'stop';
  return enabled ? 'boot' : 'none';
}

/**
 * Wrap an async routine so it runs AT MOST ONCE, however many callers fire it.
 *
 * Extracted rather than left as a `let shuttingDown = false` inside runDaemon so
 * the property can actually be tested (RUSH-2423). The daemon's shutdown is
 * reachable from SIGTERM, SIGINT, and the state-dir self-check, but a real
 * shutdown completes in ~26ms, so the re-entrant window is not reachable from
 * outside the process — an end-to-end "send three signals" test passes with the
 * guard removed and proves nothing. The mechanism is what is testable, so the
 * mechanism is what is separated out.
 *
 * The flag is set synchronously before the first `await`, which is what makes
 * this safe: two callers in the same tick cannot both get past it.
 *
 * A rejected `fn` leaves the guard SET — one attempt is all there is, and the
 * rejection propagates to the caller that made it. That is right for shutdown
 * (a failed shutdown must not be silently retried by the next signal) but is
 * the thing to re-examine before giving this a second consumer.
 */
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

/**
 * Acquire an exclusive start lock. Returns a release function on success,
 * or null if another process already holds the lock. Uses O_EXCL to
 * atomically create the file — no TOCTOU window.
 */
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

/**
 * Stop is a lifecycle mutation just like start/claim, so it must cross the same
 * lock. A claim can legitimately hold the lock through the incumbent's 5s
 * graceful window plus the 2s hard-kill backstop; wait beyond that complete
 * takeover window before failing loud instead of running teardown unlocked.
 */
const STOP_LOCK_WAIT_MS = 10_000;
const STOP_LOCK_POLL_MS = 50;

function acquireStopLock(): (() => void) | null {
  const deadline = Date.now() + STOP_LOCK_WAIT_MS;
  for (;;) {
    const release = acquireStartLock();
    if (release) return release;
    if (Date.now() >= deadline) return null;
    sleepSync(Math.min(STOP_LOCK_POLL_MS, deadline - Date.now()));
  }
}

/**
 * Absolute path to the daemon's structured log.
 *
 * Exported because two commands rebuilt the same path from a hardcoded
 * `'logs.jsonl'` literal (`commands/daemon.ts`, `commands/routines.ts`), so
 * renaming the file would have silently pointed them at nothing (RUSH-2423).
 * One definition, three callers.
 */
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
export function readDaemonPid(): number | null {
  const pidPath = getPidPath();
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

export interface DaemonHeartbeat {
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

/**
 * A heartbeat is "fresh" when its last tick falls inside the wedge window — the
 * same threshold isDaemonWedged() uses to decide a still-present daemon has gone
 * unresponsive. A fresh heartbeat whose pid is alive is proof of a live, ticking
 * daemon even when the pid file has been lost.
 */
function isHeartbeatFresh(hb: DaemonHeartbeat): boolean {
  const elapsed = Date.now() - Date.parse(hb.lastTick);
  return elapsed <= WEDGE_THRESHOLD_TICKS * DAEMON_HEARTBEAT_TICK_MS;
}

export function isDaemonWedged(): boolean {
  const pid = readDaemonPid();
  if (!pid) return false;
  if (!isLiveDaemon(pid)) return false;
  const hb = readHeartbeat();
  if (!hb) return false;
  if (hb.pid !== pid) return false;
  return !isHeartbeatFresh(hb);
}

/** How long stopDaemon waits for a SIGTERMed daemon to exit before escalating. */
const STOP_GRACE_MS = 5000;
/** How long it waits after the hard tree-kill before giving up. */
const STOP_KILL_GRACE_MS = 2000;

/**
 * Resolve the PID of the live daemon, tolerant of a pid-file/heartbeat desync.
 *
 * The daemon writes the pid file once (on claim/start) but rewrites the
 * heartbeat every tick. If the pid file is lost while the daemon keeps ticking
 * — e.g. an earlier isDaemonRunning() found a stale/reused/dead pid and cleared
 * the file, or it was removed out from under a live daemon — the pid file reads
 * empty even though a daemon is genuinely alive and firing jobs. Reading only
 * the pid file then reports "stopped" for a running scheduler, and (worse) lets
 * claimDaemonInstance() start a SECOND daemon that double-fires every routine.
 *
 * So: trust the pid file only when its pid is a live `__daemon-run`; otherwise
 * trust a FRESH heartbeat whose pid passes the same identity check. Callers that
 * already own daemon.lock may request repair, re-adopting the heartbeat pid or
 * removing the exact stale pid they observed. Read-only liveness probes never
 * mutate shared state outside that lock.
 */
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

/**
 * Check whether a daemon is alive — via the pid file, or a fresh heartbeat when
 * the pid file has been lost (see resolveLiveDaemonPid). The observation itself
 * is read-only; when it finds desync it opportunistically acquires daemon.lock
 * and repeats the observation there before repairing. A contended probe still
 * returns the observed liveness without mutating another lifecycle operation's
 * state.
 */
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

/**
 * Single-instance claim for the daemon foreground entrypoint.
 *
 * `agents __daemon-run` is reachable directly — a manual invocation, or a
 * service-manager restart that races a still-alive predecessor — bypassing the
 * start lock in startDaemon(). Without this guard runDaemon() would call
 * writeDaemonPid() unconditionally, clobber a live daemon's recorded PID, and
 * run a second JobScheduler concurrently, so every cron routine fires twice.
 *
 * LAST-WINS takeover (SING-11, RUSH-2352): when a live daemon already owns the
 * pid file, this does NOT defer to it — it evicts the incumbent and becomes the
 * survivor, so a second install can never leave two daemons running. Returns true
 * and records our PID once the incumbent is provably dead (its resources
 * released). Returns false when another `__daemon-run` currently holds the
 * O_EXCL start lock, or when the incumbent cannot be safely identified/evicted,
 * in which case the caller must exit without touching further state.
 * The read-evict-write is serialized behind the same start lock startDaemon()
 * uses, so two `_run` processes can't both claim in the window between the
 * liveness check and the write.
 */
export function claimDaemonInstance(): boolean {
  const release = acquireStartLock();
  // acquireStartLock() returns null only when another __daemon-run currently
  // holds the O_EXCL lock — a dead holder's lock is reclaimed and retried inside
  // acquireStartLock, so null means a *live* claimer is mid-claim. Bail rather
  // than run the read-evict-write unlocked: otherwise two first-start processes
  // could each see no pid file (before either writes one) and both claim,
  // running the concurrent JobScheduler this guard exists to prevent. The live
  // claimer we bailed for becomes the singleton, so last-wins still holds.
  if (!release) return false;
  try {
    // Do not overwrite a live-but-uninspectable owner. This is the non-
    // destructive side of the same fail-closed rule stopDaemon applies.
    if (unverifiedLiveDaemonPid() !== null) return false;
    // resolveLiveDaemonPid() also consults a fresh heartbeat, so a live daemon
    // whose pid file was lost is still found and evicted — otherwise a missing
    // pid file would let both this instance AND the orphaned incumbent run a
    // JobScheduler at once and double-fire every routine.
    const existing = resolveLiveDaemonPid(true);
    if (existing !== null && existing !== process.pid) {
      // Evict, and WAIT for the incumbent to be provably dead — its graceful
      // handleShutdown releasing the browser IPC binding and the secrets broker
      // socket — before we write our pid and (later, in runDaemon) bind our own.
      // Binding before the release recreates the two-brokers-on-one-socket orphan
      // documented at stopDaemon below, so the pid file is not written until the
      // prior owner is gone.
      if (!evictIncumbentDaemon(existing)) return false;
    }
    writeDaemonPid(process.pid);
    return true;
  } finally {
    release();
  }
}

/**
 * SIGTERM a live incumbent daemon and block until it is provably dead, so its
 * graceful handleShutdown has released the browser IPC binding and the secrets
 * broker socket BEFORE the newcomer binds anything of its own (SING-11). Escalates
 * to killTree after the grace window. Passes the POSITIVE pid so the kill reaches
 * only the incumbent daemon — never its detached routine children, which run in
 * their own process groups and must survive takeover (SING-11a); the new daemon
 * re-adopts them via monitorRunningJobs. Synchronous to match claimDaemonInstance's
 * read-evict-write, which runs under the O_EXCL start lock; mirrors stopDaemon's
 * grace-then-escalate shape and constants exactly, because the same
 * proof-of-release requirement applies.
 */
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

/**
 * Record this daemon in the device's instance registry — a marker file named by
 * pid under `<daemonDir>/instances/`. The registry, not a process scan, is how
 * the reaper enumerates the device singleton: because the dir lives INSIDE the
 * state dir (`AGENTS_DAEMON_DIR` ?? `<HOME>/.agents/.cache/helpers/daemon`), every
 * daemon of one device — however it was launched — registers in the same place,
 * while a genuinely separate install/home or a test fixture registers under its
 * own state dir and is invisible here. This is what fixes the two-entry pile-up:
 * the compiled `dist/bin/agents` binary and the `node <shim>` JS entry have
 * different `process.argv[1]`, so the old launch-entry-scoped `ps` match never
 * reaped across them and duplicates accumulated (78 observed on one box), every
 * routine double-firing. Best-effort — the reaper self-heals a missing/stale
 * marker, and reading another process's ENV to key on the state dir directly is
 * not portable (hardened macOS hides it from `ps`), so identity rides the shared
 * on-disk registry instead. No-op on Windows (POSIX-only reaper).
 */
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

/**
 * Reap stray duplicate daemons of THIS device — every registrant in the instance
 * registry that is a live `agents __daemon-run` and is neither this process nor
 * the current pid-file owner. A predecessor SIGKILLed/OOM-ed without cleanup, or a
 * duplicate that lost the pid-file write race, would otherwise keep a second
 * scheduler alive and double-fire jobs even after claimDaemonInstance() hands the
 * pid file to the survivor. Also garbage-collects markers whose pid is dead or was
 * reused by an unrelated process. No-op on Windows (POSIX-only).
 */
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

/**
 * Whether `pid` is a live `agents __daemon-run` process. Reads the process's
 * command line (`ps` on POSIX, Win32_Process on Windows), which — unlike its
 * environment — is visible on hardened macOS too. Guards every signal boundary
 * against killing an unrelated process that reused a recorded daemon pid.
 */
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
    emit(event, {
      module: 'daemon',
      detail: redactSecrets(message).slice(0, 500),
      status: lvl,
    });
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
/**
 * Anchor the daemon's working directory to a stable, always-present path.
 *
 * The daemon is long-lived and inherits whatever cwd it was launched from — often
 * a git worktree (e.g. a `.agents/worktrees/<slug>/` a session happened to be in).
 * When that directory is later removed (`git worktree remove`, `rm -rf`), the
 * daemon keeps the deleted inode as its cwd — a process cannot chdir out of a
 * deleted directory on its own — and every job it spawns inherits the dead cwd
 * (`spawnJobAttempt` and command runs pass no explicit `cwd`, so the child uses
 * the parent's). Bun then fails `getcwd()` during startup and every routine crashes
 * at 0 seconds with `ENOENT: Bun could not find a file` before the agent even runs.
 *
 * Re-anchoring to the home directory once, at daemon startup, makes the daemon
 * immune regardless of how it was launched (systemd unit, launchd, or a manual
 * `agents __daemon-run` from any directory). Returns the resolved cwd, or null if
 * anchoring failed (logged, non-fatal).
 */
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

/**
 * Surface, at the daemon's OWN startup, that it was launched from an ephemeral
 * root that will wedge it if the directory is removed. This is the runtime
 * companion to the launch-time check in validateDaemonBinary (which only runs
 * when the daemon is *spawned* via getDaemonLaunch): a direct
 * `agents __daemon-run` from a temp or worktree build — e.g. a review/verify
 * checkout under /tmp — never passes through that path, so without this the
 * wedge risk stays invisible until jobs start ENOENT-ing on their dynamic
 * imports. Best-effort and non-fatal; the cwd is already handled by
 * anchorDaemonCwd, but a deleted module root can only be flagged, not repaired.
 *
 * `resolveBin` is injectable (defaults to getAgentsBinPath) so the wiring — the
 * predicate call, the WARN, and the non-fatal guard around a throwing resolver —
 * is testable. Returns the warning message it logged, or null when the launch
 * root is stable (or could not be resolved).
 */
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

/**
 * Test-home tripwire (PHNX-2545). The routines/daemon test suite spawns real
 * `agents __daemon-run` processes against an isolated /tmp HOME. If that HOME
 * override fails to reach the child — an `env: {...process.env}` spawn that
 * forgot to set it, a login shell that reset HOME — the daemon resolves its
 * state dir under the operator's REAL home and its scheduler/watchdog then tick
 * against shared production state. That is the exact leak the ticket reports:
 * real test daemons found alive on a fleet box, each a second live scheduler
 * racing the legitimate one, in violation of the execution-singularity spec.
 *
 * A test that spawns a daemon sets AGENTS_DAEMON_TEST_HOME to the isolated home
 * it provisioned. When that marker is present, this daemon's resolved state dir
 * MUST sit under it; otherwise the daemon refuses to boot — failing loud before
 * it claims an instance, writes a pid, or fires a single tick (the throw is
 * caught in index.ts's `__daemon-run` handler, logged, and exits non-zero) —
 * rather than running in the wrong directory against the real host. In
 * production the marker is never set, so this is a no-op there.
 *
 * `daemonDir`/`testHome` are injectable so the pure guard is unit-testable
 * without spawning a process; the defaults read the live daemon dir and env.
 */
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

// ---------------------------------------------------------------------------
// Module-level periodic maintenance helpers (RUSH-2422)
//
// These were inline closures inside runDaemon(). Moved here so they are
// named in stack traces, readable without scrolling through runDaemon's
// 500-line body, and not recreated on every function invocation.
//
// self-heal and keychain-reap moved to SelfHealService / KeychainReapService
// on the ServiceSupervisor (RUSH-3193 P3) — the supervisor's own per-tick
// deadline + inFlight guard replaces their local `healing`/`reapingKeychain`
// flags. state-dir-check moved to StateDirCheckService (RUSH-3193 P3),
// registered after `handleShutdown` is declared — see its registration site
// below. runBrokerSelfHeal was moved into SecretsBrokerService (RUSH-3193 P2).
// ---------------------------------------------------------------------------

export async function runDaemon(): Promise<void> {
  // PHNX-2545 test-home tripwire — FIRST, before this daemon claims an instance,
  // writes a pid, or fires any tick. A test-spawned daemon that lost its isolated
  // HOME override must refuse to run against the operator's real state rather than
  // schedule against the real host. No-op in production (the marker is never set).
  assertTestDaemonHome();

  // Install the shared-daemon reload signal boundary BEFORE publishing our PID
  // in claimDaemonInstance(). Browser/routines clients use that PID to decide a
  // daemon exists and may request a service reload immediately. POSIX otherwise
  // applies its default SIGHUP action during the rest of startup and terminates
  // the whole process — exactly the client-caused eviction PHNX-3605 forbids.
  // Requests received before services are ready coalesce into one reload and are
  // applied through the normal guarded handler once startup completes.
  let reloadRequestedDuringStartup = false;
  let liveReloadHandler: (() => void) | null = null;
  const dispatchReloadSignal = () => {
    if (liveReloadHandler) liveReloadHandler();
    else reloadRequestedDuringStartup = true;
  };
  if (process.platform !== 'win32') process.on('SIGHUP', dispatchReloadSignal);

  // Single-instance guard (last-wins, SING-11): a direct `agents __daemon-run`
  // (manual, or a service-manager restart racing a live predecessor) EVICTS the
  // incumbent and becomes the survivor. claimDaemonInstance returns false only
  // when a concurrent `__daemon-run` currently holds the start lock — that peer
  // is mid-takeover and will be the singleton, so this instance stands down.
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

  // Converge the device-config/pins stores (legacy central block /
  // auto-launch.json / tracked-doc pins → per-device docs + pins file).
  // Idempotent, cheap no-op once folded. The daemon boots via
  // `agents __daemon-run`, which bypasses bootstrap's migration sentinel — so
  // the daemon runs this itself so its scheduler/watchdog gates read the
  // converged store.
  try {
    const { migrateDeviceConfigStores } = await import('../devices/config-migration.js');
    migrateDeviceConfigStores();
  } catch (err) {
    log('WARN', `device config migration failed: ${(err as Error).message}`);
  }

  // Version-skew one-shot (RUSH-2435): retrofit the current pane-died hook onto
  // any managed tmux session a pre-fix binary left with a stale one. The 5-min
  // `tmux-reconcile` routine that used to run this on a poll was deleted
  // (RUSH-2495) — startup + `ensureSessionHookRepaired` at attach time
  // (tmux/session.ts) now cover what that poll used to. Idempotent and
  // non-destructive: a session already at the current schema is a no-op.
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

  // The daemon holds NO Claude credential of its own. Routine runs authenticate
  // exactly like an interactive `agents run`: through the per-account
  // CLAUDE_CONFIG_DIR login on this device (its own auto-refreshing
  // .credentials.json). Claude Code's interactive access token is short-lived but
  // refreshes itself per-device; a routine whose account login has gone dead is
  // skipped up front by the auth-health preflight (runner.ts) with a re-login
  // hint, rather than papered over by an injected fallback token.

  // Register this daemon in the device instance registry, then reap any stray
  // duplicate that slipped past the start lock or was orphaned by a hard-crash —
  // before it can double-fire jobs. Registration comes first so a racing peer's
  // reaper can see this pid, and so this reaper never mistakes itself for a stray.
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

  // Socket services: secrets broker, monitor engine, account-state, and
  // browser IPC are all managed by the ServiceSupervisor (RUSH-3193 P2).
  // The supervisor is created here — before the scheduler — so the secrets
  // broker starts socket-first (#416) and `agents secrets` resolves within
  // ms of daemon start, exactly as before.
  const supervisor = new ServiceSupervisor();

  if (isEnabled('session-state')) {
    supervisor.register(new SessionStateService(() => supervisor.runNow('session-state')));
  } else log('INFO', 'Live session-state service disabled');

  if (isEnabled('secrets-broker')) supervisor.register(new SecretsBrokerService());
  else log('INFO', 'Secrets broker service disabled; daemon not hosting it');

  const monitorEngineSvc = new MonitorEngineService();
  if (isEnabled('monitors')) supervisor.register(monitorEngineSvc);
  else log('INFO', 'Monitor engine disabled');

  // Usage and auth refresh are two INDEPENDENT supervised services (PHNX-3608)
  // so a run of usage-refresh failures parks only usage and never starves the
  // slower auth refresh — each carries its own circuit breaker.
  if (isEnabled('account-state')) supervisor.register(new AccountUsageService());
  else log('INFO', 'Account-state service disabled');

  if (isEnabled('account-auth')) supervisor.register(new AccountAuthService());
  else log('INFO', 'Account-auth service disabled');

  // The routine scheduler handle. Declared HERE — before the CatchupService
  // registration — because `supervisor.startAll()` below fires each service's
  // first tick synchronously, so the `catchup` tick reads `scheduler` during
  // startAll, BEFORE this `let` would initialise if it lived at its old textual
  // position further down. That was a real TDZ `ReferenceError` on every boot
  // ("Cannot access 'scheduler' before initialization"), not a race (PHNX-3608).
  // `bootScheduler`/`stopScheduler` (hoisted below) assign this same binding.
  let scheduler: JobScheduler | null = null;

  // Catch-up recovery under the supervisor (PHNX-3608). The closures reference
  // `scheduler` (declared just above) and `catchupPass` (a hoisted function
  // declaration). The tick self-gates on the scheduler being booted, so it is a
  // cheap no-op — including on its immediate first tick during startAll, when
  // `scheduler` is still null — on a device whose scheduler.enabled gate is off.
  if (isEnabled('catchup')) {
    supervisor.register(new CatchupService({
      isSchedulerBooted: () => scheduler !== null,
      runPass: (signal) => catchupPass(signal),
    }));
  } else {
    log('INFO', 'Catch-up recovery service disabled');
  }

  // BrowserIPCService and BrowserTaskReapService share one long-lived
  // BrowserService. Browser IPC is registered even when disabled at boot so an
  // explicit later `agents browser start` can enable it live over SIGHUP — the
  // client owns a service transition, never a whole-daemon restart (PHNX-3605).
  const browserService = new BrowserService();
  supervisor.register(
    new BrowserIPCService(browserService),
    { enabled: isEnabled('browser-ipc') },
  );
  if (!isEnabled('browser-ipc')) log('INFO', 'Browser IPC service disabled');

  if (isEnabled('session-index')) supervisor.register(new SessionIndexService());
  else log('INFO', 'Session-index warm service disabled');

  // Watchdog, device-probe, self-heal, and keychain-reap are all periodic
  // services managed by the ServiceSupervisor (RUSH-3193 P3). Each is gated
  // the same way as the socket services above; state-dir-check is registered
  // separately, later, after `handleShutdown` exists (see below).
  if (isEnabled('watchdog')) supervisor.register(new WatchdogService());
  else log('INFO', 'Watchdog service disabled');

  if (isEnabled('device-probe')) supervisor.register(new DeviceProbeService());
  else log('INFO', 'Device-probe service disabled');

  if (isEnabled('self-heal')) supervisor.register(new SelfHealService());
  else log('INFO', 'Self-heal service disabled');

  if (isEnabled('self-update')) supervisor.register(new SelfUpdateService());
  else log('INFO', 'Self-update service disabled');

  if (isEnabled('keychain-reap')) supervisor.register(new KeychainReapService());
  else log('INFO', 'Keychain-reap service disabled');

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

  if (isEnabled('browser-task-reap')) {
    supervisor.register(new BrowserTaskReapService(browserService));
  } else {
    log('INFO', 'Browser-task reap service disabled');
  }

  await supervisor.startAll({ log });
  activeServiceSupervisor = supervisor;

  // scheduler.enabled=false in this machine's device doc means NO routines fire
  // here — the scheduler and its catchup recovery simply never start, while the
  // daemon keeps its other duties (secrets broker, browser IPC, session sync).
  // The refusal message is the same one the start surfaces
  // (`routines add` auto-start, manual `routines start`) raise. The gate is
  // re-evaluated on every SIGHUP reload (handleReload below) via
  // schedulerGateTransition, so flipping the key never needs a daemon restart.
  // Also honour the daemon-services toggle so `agents daemon services disable scheduler`
  // has a single, obvious effect.
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
    // RUSH-2030: branded desktop notification on start (agent/workflow routines;
    // suppressed for command housekeeping). Finish/output is fired from the
    // onFinish hook below — executeJobDetached finalizes the run in-process, so
    // the monitor tick never sees the live transition. Never let a notification
    // failure break the trigger.
    try { notifyRoutineStart(config); } catch { /* best-effort */ }
    try {
      const meta = await executeJobDetached(config, {
        onFinish: (final) => {
          emitRoutineEnd(final);
          try { notifyRoutineFinish(final); } catch { /* best-effort */ }
          // RUSH-2288: a failed/timed-out routine also reaches the OWNER's phone
          // (in-process owner channel stack), not just the local desktop. Green
          // runs are silent — the builder returns early. Async + swallowed so a
          // delivery hiccup never blocks the finish path.
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
      // RUSH-2030: the START ping already fired unconditionally above. A pre-spawn
      // failure produces no run record and thus no onFinish, so send a synthetic
      // "failed to start" finish here — otherwise the user is left with an orphaned
      // "Routine started" and never told it failed.
      try { notifyRoutineStartFailed(config, message); } catch { /* best-effort */ }
      // RUSH-2288: the pre-spawn failure (e.g. auth_failed) is exactly the one the
      // per-routine `agents notify` prompt can never send — its agent never ran —
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

  // Boot the scheduler. Called at daemon start when the gate allows, and again
  // from handleReload when the gate flips on. Catch-up recovery is a separate
  // supervised service (CatchupService, registered above) that self-gates on
  // `scheduler !== null`; here we just kick an immediate supervised pass so a
  // fresh boot catches up missed fires without waiting a full CATCHUP_TICK_MS.
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

  // Watchdog and device-probe are now managed by WatchdogService /
  // DeviceProbeService on the supervisor (RUSH-3193 P3), registered above
  // alongside the socket services. The supervisor fires an immediate first
  // tick on start, which replaces device-probe's old `void
  // runDeviceProbeTick()` kick-off (the 3-minute lag that used to leave the
  // menubar showing 20 phantom NEW DEVICES after a hermetic leak).

  // Monitor engine is now managed by MonitorEngineService on the supervisor
  // (RUSH-3193 P2). Access it via monitorEngineSvc.getEngine() in handleReload.

  // Backlog recovery: any enabled recurring job whose most-recent expected fire
  // is older than its most-recent recorded run was missed — the laptop slept,
  // the machine was off, or the daemon crashed through the fire. croner only
  // schedules forward from "now", so nothing replays it on its own.
  //
  // Every miss is RECORDED as a `missed` run and, unless the routine sets
  // `catchup: false`, RUN late. Runs on a timer as well as at startup: a startup
  // pass alone misses a fire lost while the daemon stayed up but its event loop
  // was wedged, or one lost across an OS suspend that the process survived.
  // A pass awaits executeJobDetached per job and an off-box (host/cloud)
  // dispatch can block for a while. Overlap is now guarded by the supervisor's
  // per-service inFlight guard (CatchupService) — a slow pass never overlaps the
  // next supervised tick — rather than a local `catchingUp` flag; and the
  // idempotency of the `missed` record still guards across passes and daemon
  // restarts. `signal` aborts at the CatchupService deadline, so a wedged pass is
  // abandoned + restarted instead of latching (PHNX-3608). Function declaration
  // (hoisted) so the CatchupService registration above can reference it.
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
      // Ordinary pass errors are logged, not re-thrown: a transient catchup
      // failure should not trip the circuit breaker. A HANG is still caught — the
      // CatchupService deadline aborts the tick and the supervisor parks +
      // restarts it regardless of this swallow (PHNX-3608).
      log('ERROR', `Catchup pass failed: ${(err as Error).message}`);
    }
  }

  // Browser orphan reap and IPC server start are now managed by BrowserIPCService
  // on the supervisor (RUSH-3193 P2). The orphan reap runs inside onStart().

  // Webhook receivers: signed webhook receiver(s) + their funnel (RUSH-2548).
  // Started after the broker (above) so it resolves each receiver's signing
  // secret headlessly — no AGENTS_SECRETS_PASSPHRASE, no nohup. Binds nothing
  // unless daemon/webhooks.yaml declares a receiver, so an unconfigured box no-ops.
  // Signed webhook ingress is owned by WebhookReceiverService, including
  // per-service failure isolation, measured health, and shutdown cleanup.

  // Resource self-heal is now managed by SelfHealService on the supervisor
  // (RUSH-3193 P3), registered above alongside the socket services. The
  // supervisor's immediate first tick on start replaces the old
  // SELF_HEAL_KICKOFF_MS (30s) delayed kickoff timer — see self-heal-service.ts.

  // Broker self-heal (RUSH-1817) is now encapsulated in SecretsBrokerService
  // (RUSH-3193 P2). The interval fires inside onStart() and is stopped in onStop().

  // RUSH-2232: keychain-reap is now managed by KeychainReapService on the
  // supervisor (RUSH-3193 P3), registered above alongside the socket services.

  // RUSH-2501: reap tmux sessions whose panes are all dead. Runs on the same
  // 5-min cadence as the keychain reaper. Daemon-only (single executor).
  // Dead managed panes and their orphan helpers are reaped by TmuxReapService.

  // RUSH-2622: close abandoned browser-task tabs on the same 5-min cadence,
  // reusing the daemon's long-lived BrowserService when browser IPC is enabled.
  // Abandoned browser tasks are reaped by BrowserTaskReapService, sharing the
  // same BrowserService instance as BrowserIPCService.

  // RUSH-2367 / RUSH-3193 P3: state-dir-check (self-terminate guard) is
  // registered on the supervisor further below, once `handleShutdown` exists
  // — see the registration site after its declaration for why.

  // RUSH-2418: startup is over — the scheduler, browser IPC, broker decision,
  // monitor engine and every background tick are up. Only NOW does this daemon
  // clear the auto-start failure streak `ensureDaemonStarted` reads. Clearing it
  // at claim time instead would reset the breaker for a process that dies while
  // initializing a subsystem, which is exactly the crash loop it exists to stop.
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
        // RUSH-3193 P4: a service the supervisor already owns takes the toggle
        // live via supervisor.start/stop — no restart needed. monitors is a
        // supervised service (PHNX-3608): its enable/disable takes effect through
        // that generic supervisor.start/stop path, so a disabled monitors service
        // actually stops dispatching (its supervised tick is torn down) instead of
        // being ticked with the last-loaded set. browser-ipc is deliberately
        // registered in a stopped state too (PHNX-3605), so a later browser client
        // can enable that service without restarting the shared daemon. Most other
        // services are only registered when enabled at boot; one disabled at boot
        // was never registered, so it falls through to the same "restart to apply"
        // advice as before.
        if (supervisor.isRegistered(id)) {
          // A periodic service may be inside a real tick when SIGHUP arrives.
          // Queue the desired transition behind that exact promise: deadlines
          // detect a wedge but cannot cancel arbitrary work, and polling here
          // would create another lifecycle timer outside the supervisor.
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
    // Re-evaluate the scheduler.enabled gate: flipping the key takes effect on
    // this reload, no daemon restart needed. A `routines add` on a re-enabled
    // box signals exactly this reload, which boots the scheduler — the
    // "Scheduler reloaded" it prints is then truthful, not a dead-end.
    // Also honour the daemon-services toggle.
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
    // Refresh monitor CONFIGS when the engine is live and monitors stays enabled
    // (the common `monitors add/edit` + SIGHUP case). The enable/disable
    // TRANSITION itself is handled by the generic supervisor.start/stop loop
    // above (PHNX-3608) — a disabled monitors service is supervisor.stop()'d
    // there, which tears down its supervised tick so nothing dispatches; an
    // off-transition leaves getEngine() null, so this reload is correctly skipped.
    const liveMonitorEngine = monitorEngineSvc.getEngine();
    if (liveMonitorEngine && reloadedEnabled('monitors')) {
      try {
        liveMonitorEngine.reload();
      } catch (err) {
        log('ERROR', `Monitor engine reload failed: ${(err as Error).message}`);
      }
    }
  };

  // Structurally single-shot (RUSH-2423). Shutdown is reachable from SIGTERM,
  // SIGINT, and StateDirCheckService's independent `onMissing` callback (which
  // calls this same handler), and two of those can arrive together — a
  // service manager that SIGTERMs a daemon whose state dir was just removed.
  // It was only INCIDENTALLY safe before (every step inside happens to be
  // idempotent); the guard makes single-shot a property of the function
  // rather than one that every step added later has to re-earn.
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

  // State-dir self-check (RUSH-2367 self-terminate guard) is registered on
  // the supervisor here — AFTER `handleShutdown` above — rather than
  // alongside watchdog/device-probe/self-heal/keychain-reap earlier. The
  // supervisor fires an immediate first tick on `register()`+`start()`; doing
  // that before `handleShutdown` exists would reference the const in its
  // temporal dead zone the moment a mismatch is ever detected. Registering it
  // here, once `handleShutdown` is a real function, removes that risk
  // entirely rather than relying on the marker always matching on tick one.
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

/**
 * Write a launchd plist or systemd unit with owner-only permissions atomically.
 *
 * `writeFileSync`'s `mode` is honored only when the file is *created*, so we
 * unlink any pre-existing manifest first. That guarantees every write is a
 * fresh 0600 create — closing the TOCTOU window on new files AND re-locking a
 * stale world-readable manifest left by an older install — since these files
 * embed long-lived credentials.
 */
export function writeOwnerOnlyServiceManifest(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.rmSync(filePath, { force: true });
  fs.writeFileSync(filePath, content, { encoding: 'utf-8', mode: 0o600 });
}

/**
 * Generate a macOS launchd plist for auto-starting the daemon.
 *
 * The plist never embeds a Claude OAuth token: the daemon holds no Claude
 * credential at all. Routine runs authenticate through the per-account
 * CLAUDE_CONFIG_DIR login on this device, exactly like an interactive
 * `agents run`, so no credential ever touches the service manifest.
 *
 * RUSH-2639: launchd does NOT inherit `launchctl load`'s caller's process
 * environment — a spawned daemon only ever sees the login session's default
 * env plus whatever this dict adds/overrides. Before this fix the dict carried
 * only PATH, so HOME resolved to the launchd session's own value regardless of
 * what HOME the process that generated (and loaded) the plist was running
 * under. In production that's a no-op (the login session's HOME already is the
 * real HOME), but under a hermetic test harness that redirects HOME to a
 * fork-private sandbox, a launchd-started daemon silently escaped the sandbox
 * and bootstrapped `~/.agents` (.cache/.history/.system/routines) in the
 * developer's/runner's REAL home. Baking HOME (and the AGENTS_REAL_HOME seam
 * every version-home consumer honors, see tests/setup.ts) into the plist at
 * generation time makes the launchd child inherit the SAME home the caller
 * resolved, exactly like the plain detached-spawn path already does via
 * `env: {...process.env}`.
 */
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

/**
 * Generate a Linux systemd user unit for auto-starting the daemon.
 *
 * The unit never embeds a Claude OAuth token: the daemon holds no Claude
 * credential at all. Routine runs authenticate through the per-account
 * CLAUDE_CONFIG_DIR login on this device, exactly like an interactive
 * `agents run`, so no credential ever touches the unit file.
 *
 * RUSH-2639: same seam as `generateLaunchdPlist` — a systemd --user unit is
 * started by the user's systemd instance, not the process that generated the
 * unit, so HOME is whatever that session provides unless this file pins it.
 * Baking HOME (and AGENTS_REAL_HOME) in at generation time keeps a
 * hermetic-test-started unit inside its sandbox instead of resolving against
 * the real account home.
 */
export function generateSystemdUnit(
  agentsBin: string = getAgentsBinPath(),
): string {
  const launch = getDaemonLaunch(agentsBin);
  const execStart = [launch.command, ...launch.args].map(systemdExecArg).join(' ');
  const { HOME: home, AGENTS_REAL_HOME: realHome } = serviceManifestHomeEnv();

  return `[Unit]
Description=Agents Daemon - Scheduled Job Runner
After=network.target
StartLimitIntervalSec=${DAEMON_START_LIMIT_INTERVAL_SECONDS}
StartLimitBurst=${DAEMON_START_LIMIT_BURST}

[Service]
Type=simple
ExecStart=${execStart}
Restart=always
RestartSec=${DAEMON_THROTTLE_SECONDS}
Environment=PATH=${daemonPathValue(agentsBin, ['/usr/local/bin', '/usr/bin', '/bin'])}
Environment=HOME=${home}
Environment=AGENTS_REAL_HOME=${realHome}

[Install]
WantedBy=default.target`;
}

// Binary-resolution helpers (getAgentsBinPath / isNodeScriptEntry / getCliLaunch)
// live in ./cli-entry.js — a leaf module the secrets broker also imports without
// forming a cycle. Re-exported so existing `from './daemon.js'` importers of
// getAgentsBinPath keep resolving.
export { getAgentsBinPath };

/**
 * Ask the service manager for the daemon's live PID. Used as a fallback when
 * the daemon hasn't yet written its pid file but launchd/systemd already report
 * it running — so a start never has to surface a null PID for a daemon that is
 * in fact up. Returns null when the service isn't running or the query fails.
 */
function readServiceManagerPid(platform: NodeJS.Platform = os.platform()): number | null {
  const reg = serviceManagerRegistrationAllowed();
  if (!reg.allowed) return null;
  try {
    if (platform === 'linux') {
      const out = execFileSync('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', daemonSystemdUnitName()],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const pid = parseInt(out, 10);
      return !isNaN(pid) && pid > 0 ? pid : null;
    }
    if (platform === 'darwin') {
      const out = execFileSync('launchctl', ['list', daemonServiceLabel()],
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

/** Start the daemon via launchd, systemd, or as a detached process. */
export function startDaemon(agentsBin?: string): { pid: number | null; method: string } {
  if (isDaemonRunning()) {
    const pid = readDaemonPid();
    return { pid, method: 'already-running' };
  }

  const releaseLock = acquireStartLock();
  if (!releaseLock) {
    // Another process is already starting the daemon
    const pid = waitForPid(3000);
    return { pid, method: 'already-starting' };
  }

  // Released by startDaemonLocked the moment the launch has been ISSUED, and
  // again here as the backstop for every path that returned before reaching
  // that point (a throw, or the platform default branch). Idempotent so the
  // double call is a no-op rather than unlinking a lock a later claimer owns.
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    releaseLock();
  };

  // RUSH-2418: count starts PESSIMISTICALLY, and let a daemon that reaches
  // steady state clear the streak itself (`recordSubsystemOk` at the end of
  // runDaemon's startup). Recording a failure only on an observable error would
  // miss the crash loop entirely: a daemon that spawns and then dies returns a
  // perfectly real `child.pid`, so the launcher has no error to see. Every path
  // out of startDaemonLocked is either pid-truthy or a throw, so an
  // outcome-shaped check here can only ever catch an unspawnable binary — not
  // the failure this breaker exists for. Marking the attempt up front and
  // clearing on proven health inverts that: the streak grows exactly when
  // starts stop producing a daemon that lives.
  //
  // The no-launch returns above (`already-running`, `already-starting`) return
  // before this point on purpose — they attempted nothing, so they count nothing.
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

/**
 * Is the auto-start circuit breaker open (RUSH-2418)? True once
 * {@link DAEMON_AUTOSTART_FAILURE_LIMIT} consecutive starts have failed to
 * produce a daemon that reported healthy. Pure read of the persisted health
 * record, and `agents daemon doctor` reports the same record — the message the
 * breaker prints has to lead somewhere that can explain it.
 */
export function isDaemonAutostartCircuitOpen(): boolean {
  const health = readSubsystemHealth(SUBSYSTEM_DAEMON_START);
  return (health?.consecutiveFailures ?? 0) >= DAEMON_AUTOSTART_FAILURE_LIMIT;
}

/**
 * Bring the always-on daemon up as a side effect of a background-adjacent
 * command (secrets unlock, browser start, ...), not only from `routines add`.
 *
 * Delegates to the single `startDaemon` entrypoint, so it honors the
 * single-instance start lock and is a no-op when a daemon is already running
 * (returns `already-running`). Best-effort: any failure is swallowed and null
 * returned, so ensuring the daemon can never break the foreground command that
 * happened to bring it up. See issue #415.
 */
export function ensureDaemonStarted(): { pid: number | null; method: string } | null {
  // RUSH-2354: honor daemon.enabled — a background-adjacent caller (secrets
  // unlock, browser start, ...) must not resurrect a daemon the owner
  // explicitly turned off. `agents daemon start` is the deliberate override
  // and calls startDaemon() directly instead of going through this helper.
  if (!isDaemonEnabled()) return null;
  // A live daemon is the answer whatever the failure history says — the breaker
  // gates LAUNCHING one, never reporting one that is already up. Checked first
  // so a stale failure streak can't make a healthy daemon read as absent to
  // callers that branch on this return (e.g. secrets/agent.ts).
  if (isDaemonRunning()) return startDaemon();
  // RUSH-3021: never LAUNCH a daemon from a redirected (sandbox/test) HOME.
  // #2860 gated service-manager registration on this signal but left the
  // detached spawn itself ungated, so a test-spawned CLI could fork a daemon
  // into the test's temp HOME; the child outlives the test and races its
  // recursive teardown rm (ENOTEMPTY). Placed after the already-running branch
  // — reporting a live daemon stays allowed, same as the circuit breaker.
  // AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME=1 is the test seam for suites
  // that exercise daemon startup deliberately; `agents daemon start` remains
  // the operator override.
  if (!serviceManagerRegistrationAllowed().allowed) return null;
  // RUSH-2418: the auto-start circuit breaker. A daemon that dies during
  // startup would otherwise be relaunched by EVERY foreground command that
  // wants one (secrets unlock, browser start, watchdog, ...) — an
  // application-level crash loop the OS supervisor's throttle cannot see,
  // because each attempt is a fresh service start rather than a respawn. After
  // DAEMON_AUTOSTART_FAILURE_LIMIT consecutive failures, refuse and say why.
  // Deliberately NOT applied in startDaemon(): `agents daemon start` is the
  // operator's override and must always be able to retry.
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

/**
 * Issue the launch, then wait for the child to record its pid.
 *
 * RUSH-2417: the wait phase MUST NOT hold the start lock. `acquireStartLock`
 * and `claimDaemonInstance` resolve the same `<daemonDir>/daemon.lock`, so a
 * parent that busy-waits on `waitForPid` while still holding it deterministically
 * defeats the child it just launched: the child's `claimDaemonInstance` hits
 * EEXIST, reads a holder pid that IS alive (this process), and exits with the
 * false "another daemon is mid-takeover" warning — every launchd/systemd start
 * on a fresh install. The lock's job is to keep two concurrent `startDaemon()`
 * calls from both launching, and that is done once `launchctl load` /
 * `systemctl start` / the detached spawn has been issued, so `releaseLock()` is
 * called there rather than in the caller's `finally`.
 *
 * Releasing early cannot produce two daemons: launchd (one plist label) and
 * systemd (one unit) are singletons that no-op a second start, and the detached
 * path is covered by `claimDaemonInstance`'s last-wins takeover (SING-11) —
 * a second claimer evicts the incumbent rather than running beside it.
 */
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
        // launchctl prints `Load failed:` and exits 0 when the label is in a
        // stuck state from a prior session — so a zero exit code isn't proof
        // of success. If no pid materializes within the window, give up on
        // launchd and fall through to a plain detached spawn.
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

/**
 * Resolve how to launch the daemon: `node <entry> __daemon-run`, matching the
 * exact form that works under a direct `__daemon-run`.
 *
 * We spawn the Node runtime (`process.execPath`) with the CLI entry as an
 * argument rather than executing the entry path directly. Executing the `.js`
 * path relies on its shebang on POSIX, and on Windows CreateProcess can't run a
 * `.js`/shim directly at all — it gets launched through a transient
 * console-owning wrapper (cmd.exe / the npm shim). When that wrapper exits it
 * closes its console, and the detached daemon sharing that console receives a
 * console-close event that trips its shutdown handler — the daemon comes up,
 * binds the browser IPC socket, then tears itself down ~36ms later (#556).
 * Going through `process.execPath` means a real PE/binary is spawned with
 * `detached: true` and no console, so nothing signals the daemon after launch.
 *
 * When the entry isn't a Node script (e.g. a native compiled launcher), run it
 * directly — it owns its own runtime resolution.
 */
export function getDaemonLaunch(agentsBin: string = getAgentsBinPath()): { command: string; args: string[] } {
  const { warnings } = validateDaemonBinary(agentsBin);
  for (const w of warnings) process.stderr.write(`[agents] ${w}\n`);
  return getCliLaunch(['__daemon-run'], agentsBin);
}

/**
 * The directory of the Node runtime that generated this service manifest, kept
 * first on the daemon's PATH. Both the shim's shebang and any child routine
 * process then resolve the exact Node that installed the service — never an
 * ancient system node or a pruned nvm version. Replaces the old hardcoded
 * `~/.nvm/versions/node/v24.0.0/bin`, which went stale the moment that patch
 * release was upgraded away and bricked the daemon fleet-wide.
 */
function daemonNodeBinDir(): string {
  return path.dirname(process.execPath);
}

/**
 * Login-shell user-bin dirs a service-manager-started daemon would otherwise
 * miss. systemd/launchd pin PATH and never source `~/.profile`, so they never
 * see `~/.rush/bin` (where `rush` lands) or `~/.local/bin` (XDG user-bin).
 * Monitor `notify` and dispatched `agents run` children inherit this PATH;
 * without these dirs the rush-backed owner channel fails with
 * `rush CLI not found on PATH` (PHNX-3075) while an interactive shell on the
 * same box succeeds. Uses the same HOME the manifest bakes (RUSH-2639).
 */
function daemonUserBinDirs(): string[] {
  const home = serviceManifestHomeEnv().HOME;
  return [path.join(home, '.rush', 'bin'), localBinDir(home)];
}

/**
 * The full PATH value the daemon service manifest pins, in order: the directory
 * of the `agents` shim itself FIRST, then the Node runtime dir, then login-shell
 * user-bin dirs (`~/.rush/bin`, `~/.local/bin`), then the platform's system dirs.
 *
 * The shim's own dir must lead so a scheduled `command` routine that shells out
 * to the bare name `agents` (`/bin/sh -c 'agents repo pull system'`) resolves the
 * SAME binary the daemon is running. When the Node runtime dir came first, a
 * stale `agents` install inside that dir (common with nvm or an npm global in the
 * same Node prefix) shadowed the current binary and routines failed with an
 * `unknown command` error against the wrong build.
 *
 * The Node runtime dir stays second so the shim's shebang (`#!/usr/bin/env node`)
 * still resolves the exact Node that installed the service — never an ancient
 * system node or a pruned nvm version. User-bin dirs sit after that pair so a
 * `~/.local/bin/agents` cannot shadow the daemon binary, but `rush` (and other
 * login-shell CLIs) still resolve. Deduped across the whole list, so a
 * Node/shim dir that already appears among the system dirs (e.g. a
 * `/usr/local/bin` install) never doubles.
 */
function daemonPathValue(agentsBin: string, systemDirs: readonly string[]): string {
  return [...new Set([
    path.dirname(agentsBin),
    daemonNodeBinDir(),
    ...daemonUserBinDirs(),
    ...systemDirs,
  ])].join(':');
}

/**
 * Build the argv to relaunch the `agents` CLI with the given subcommand args.
 *
 * Resolves the real on-disk binary via getAgentsBinPath(), then dispatches: a
 * `.js` entry runs under node (`node <entry> …`), a native/compiled binary runs
 * directly (`<bin> …`).
 *
 * Callers MUST route self-spawns through this rather than hand-rolling
 * `[process.execPath, process.argv[1], …]`: under the compiled standalone binary
 * (#315) `process.argv[1]` is the bun virtual entry `/$bunfs/root/agents`, so the
 * hand-rolled form becomes `agents /$bunfs/root/agents …` → the CLI receives the
 * bunfs path as a subcommand and dies with "unknown command '/$bunfs/root/agents'".
 * getAgentsBinPath() resolves that virtual entry to the physical process.execPath.
 */
export function getAgentsInvocation(
  subArgs: string[],
  agentsBin: string = getAgentsBinPath(),
): { command: string; args: string[] } {
  return getCliLaunch(subArgs, agentsBin);
}

/**
 * A daemon binary living under an ephemeral path — a git worktree, or a temp
 * directory (`/tmp`, `/var/folders`, `/dev/shm`) — is a latent wedge. The daemon
 * is long-lived but resolves its own job modules by dynamic `import()` rooted at
 * this entry (getAgentsBinPath → process.argv[1]). If that directory is later
 * removed (`git worktree remove`, a `/tmp` cleanup, a review/verify checkout
 * teardown) the running daemon keeps ENOENT-ing on every job it loads —
 * `anchorDaemonCwd` rescues the cwd, but nothing can re-root a deleted module
 * tree. Returns a human phrase naming the ephemeral kind, or null for a stable
 * install path (version home, a global npm prefix, a normal source checkout).
 */
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
  // fdStdio: the log-file fds make windowsHide inert (libuv skips
  // CREATE_NO_WINDOW when a stdio fd is inherited), so on Windows the daemon
  // must DETACH to own no console — otherwise it shares the launcher's console
  // and a console-close event tears it down when the launcher exits (#556).
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

  // `spawn` leaves `pid` undefined only when the process could not be created.
  // Returning null here (the old `child.pid || null`) let callers report
  // "PID: null" as if the daemon had started — a start with no PID is a failed
  // start, so fail loudly instead of manufacturing a phantom success.
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

/**
 * One piece of daemon state that a graceful `handleShutdown` removes and an
 * escalated kill leaves behind (RUSH-2421).
 */
export interface StopResidueArtifact {
  label: string;
  present: boolean;
  /** The file names a live owner, including a stopped target that survived. */
  ownedByLiveOther: boolean;
  reclaim: () => void;
  stillPresent: () => boolean;
}

/**
 * Read the pid a state file claims, or null when it is absent/unreadable/not
 * pid-shaped. The lifetime marker stores `<pid>:<epochMs>`; the heartbeat
 * stores JSON with a `pid`.
 */
function claimedPid(read: () => number | null): number | null {
  try { return read(); } catch { return null; }
}

/**
 * The lifetime marker, heartbeat, and instance-registry entry, described so
 * {@link stopDaemon} can assert them the same way it asserts the two sockets.
 *
 * Ownership, not mere presence, decides: a file naming a pid that is alive and
 * is not the daemon we just stopped belongs to a DIFFERENT daemon (a successor
 * that started during the stop, or a peer serving this state dir), and deleting
 * it would break that live daemon — the same reasoning the broker-socket branch
 * above uses for a standalone owner. Everything else is residue from a provably
 * dead owner and is reclaimed.
 */
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
      // The marker is named by pid, so it is unambiguously this daemon's — but
      // "this daemon" is only residue once it is actually DEAD. If the kill did
      // not land, deleting the marker erases the very record
      // `findSurvivingStateDirDaemons` enumerates, so the next `agents daemon
      // stop` would find an empty registry and a cleared pid file and report
      // `ok: true` with the daemon still running.
      //
      // "Dead" is decided by the caller's OWN survivor scan, not by `isAlive`:
      // a SIGKILLed child is a zombie until its parent reaps it, and `kill(pid,
      // 0)` succeeds on a zombie. Keyed off `isAlive` this kept the entry of a
      // daemon that was already gone, so the stop stopped being able to report
      // its own state truthfully. The survivor scan matches a live
      // `__daemon-run`, which a zombie is not.
      ownedByLiveOther: survivors.includes(stoppedPid),
      reclaim: () => unregisterDaemonInstance(stoppedPid),
      stillPresent: () => fs.existsSync(markerPath),
    });
  }

  return artifacts;
}

/**
 * Structured outcome of {@link stopDaemon} (SING-12, RUSH-2355). `stopDaemon`
 * asserts its postcondition instead of assuming it: `ok` is true only when every
 * resource the daemon held is provably released. `surviving` names anything that
 * did not release (a still-live daemon, or a stale socket that could not be
 * cleared) and is what drives a non-zero exit; `detachedChildren` are the
 * in-flight routine children that survive deliberately (SING-11a) and are
 * reported, never killed.
 */
export interface DaemonStopResult {
  ok: boolean;
  stoppedPid: number | null;
  escalated: boolean;
  released: string[];
  surviving: string[];
  detachedChildren: number[];
}

/**
 * Live `__daemon-run` processes still registered in THIS state dir's instance
 * registry, excluding `exclude`. State-dir-scoped by construction: the registry
 * lives inside this state dir, so a daemon serving a DIFFERENT state dir (a test
 * fixture with its own HOME, a separate install/home) registers elsewhere and is
 * invisible here — it is never a stop/takeover target. POSIX-only (the registry
 * and its `ps` liveness probe are); `[]` on Windows.
 *
 * Exported for `agents daemon status`/`doctor`/`services` (RUSH-2368): those
 * commands previously flagged every `__daemon-run` on the box (a raw `ps` scan)
 * as a "duplicate" of this daemon, which misreported test fixtures under their
 * own HOME — and therefore their own state dir and registry — as strays to
 * kill. This registry read is the same scope the reaper (`reapStrayDaemons`)
 * and the stop postcondition (`stopDaemon`) already use, so the display and the
 * reaper agree on what a duplicate is.
 */
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

/**
 * Stop the daemon and ASSERT its postcondition (SING-12, RUSH-2355), unloading it
 * from launchd/systemd if applicable.
 *
 * The SIGTERM → grace → killTree sequence is unchanged; what it adds is
 * verification. After the daemon is gone it checks that the secrets broker socket
 * and browser IPC binding actually released — a stale socket present on disk but
 * with no live owner is the orphan that keeps clients holding unlocked bundles
 * hanging (`daemon.ts` broker-hosting; the two-brokers-on-one-socket bug) — and
 * that no `__daemon-run` for THIS state dir survives. A killTree escalation exits
 * without running the daemon's graceful handleShutdown, so those sockets can be
 * left stale; this reclaims each (the owner is provably dead) and reports it. It
 * never reports success on an unverified stop.
 */
export function stopDaemon(): DaemonStopResult {
  const releaseLock = acquireStopLock();
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
  const browserSock = process.platform === 'win32' ? null : getBrowserIpcSocketPath();
  // Capture the socket's inode INDEPENDENTLY of whether a live pid resolved
  // (PHNX-3618). A daemon that died between the CLI liveness precheck and this
  // locked read leaves resolveLiveDaemonPid() returning null while its ungraceful
  // exit left the binding on disk — capturing only when `pid !== null` meant that
  // genuinely stale socket could never be reclaimed and was reported "ownership
  // could not be verified". The inode is the successor guard: a fresh daemon that
  // rebinds during the stop gets a new inode, so a later identity match still
  // proves this exact binding is the one we captured, never a successor's.
  const browserSockOwner = browserSock ? readPathIdentity(browserSock) : null;

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

        // Wait for it to actually go. This used to be a setTimeout escalation plus
        // an immediate removeDaemonPid(), which had two failure modes: in a
        // short-lived process (the npm postinstall) the timer never fired at all,
        // and clearing the pid file while the old daemon still ran made
        // isDaemonRunning() report false, so startDaemon() launched a SECOND
        // daemon. Its hosted broker then unlinked the live socket and rebound,
        // orphaning the first broker with every unlocked bundle still in its RAM
        // and unreachable — two brokers on one socket path, seen on a real machine
        // after an install into a second prefix.
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

  // Browser IPC binding: on POSIX the listening socket is a filesystem object.
  // A graceful handleShutdown unlinks it; if it survives, the daemon exited
  // ungracefully (killTree) and left a stale binding — the owner is provably
  // dead, so reclaim it and report.
  if (process.platform !== 'win32') {
    // A binding is provably stale — and reclaimable — when the inode on disk is
    // still the exact one captured under this lock AND no daemon (the signalled
    // target OR any successor for this state dir) survives to own it. Keying the
    // "a daemon still owns it" test on the whole survivor set rather than only the
    // captured target is what lets a daemon that died BEFORE this stop (pid ===
    // null, PHNX-3618) still have its stale socket reclaimed, while a live
    // successor — which either rebound the inode or shows up as a survivor — is
    // never touched (PHNX-3607's never-delete-a-successor invariant).
    const aDaemonSurvives = survivors.length > 0 || unverifiedSurvivors.length > 0;
    if (browserSock && fs.existsSync(browserSock)) {
      const ownsCapturedBinding = browserSockOwner !== null
        && pathIdentityMatches(browserSock, browserSockOwner);
      if (ownsCapturedBinding && !aDaemonSurvives) {
        try { fs.unlinkSync(browserSock); } catch { /* failed to reclaim the captured binding */ }
        if (pathIdentityMatches(browserSock, browserSockOwner)) surviving.push('browser IPC socket not released');
        else if (fs.existsSync(browserSock)) surviving.push('browser IPC socket ownership changed during stop');
        else released.push('browser IPC socket (reclaimed)');
      } else if (aDaemonSurvives) {
        surviving.push('browser IPC socket still owned by a surviving daemon');
      } else {
        // The path was absent when this transaction captured the target (a
        // successor bound it afterward) or a successor replaced the inode. Either
        // way this invocation does not own the current binding and must leave it.
        surviving.push('browser IPC socket ownership could not be verified');
      }
    } else {
      released.push('browser IPC socket');
    }

    // Secrets broker socket: released when it is gone, or still owned by a
    // DIFFERENT live broker (a standalone service the daemon never hosted). A
    // socket present with NO live owner is the orphan — reclaim it.
    const brokerSock = secretsBrokerSocketPath();
    if (!fs.existsSync(brokerSock)) {
      released.push('secrets broker socket');
    } else if (brokerPidAlive()) {
      released.push('secrets broker socket (standalone owner)');
    } else {
      try { fs.unlinkSync(brokerSock); } catch { /* raced with a fresh bind */ }
      if (fs.existsSync(brokerSock)) surviving.push('secrets broker socket not released');
      else released.push('secrets broker socket (reclaimed)');
    }
  }

  // ── The state files a killed daemon cannot clean up itself (RUSH-2421) ─────
  // handleShutdown removes the lifetime marker, the heartbeat and this pid's
  // instance-registry entry — but it only runs on the GRACEFUL path. Every
  // escalation above (killTree, and the whole win32 branch) skips it, so those
  // three outlive the daemon and the stop reported `ok: true` while its state
  // dir still described a daemon that no longer exists. Each is stale metadata
  // with real consequences: a leftover heartbeat is what `resolveLiveDaemonPid`
  // consults to re-adopt a "live" daemon, and a leftover registry entry is what
  // `reapStrayDaemons` enumerates. Same shape as the sockets above — reclaim
  // what a provably dead owner left, never touch what a live one owns.
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

/** Get current daemon status including running state, PID, and enabled job count. */
export function getDaemonStatus(): {
  state: 'running' | 'wedged' | 'stopped';
  running: boolean;
  pid: number | null;
  jobCount: number;
  logPath: string;
  binaryPath: string | null;
  heartbeat: DaemonHeartbeat | null;
} {
  const running = isDaemonRunning();
  const wedged = running && isDaemonWedged();
  const pid = readDaemonPid();

  let jobCount = 0;
  try {
    jobCount = listAllJobs().filter((j) => j.enabled).length;
  } catch { /* job listing failed */ }

  let binaryPath: string | null = null;
  try {
    binaryPath = getAgentsBinPath();
  } catch { /* resolution failed */ }

  return {
    state: wedged ? 'wedged' : running ? 'running' : 'stopped',
    running,
    pid,
    jobCount,
    logPath: getDaemonLogPath(),
    binaryPath,
    heartbeat: readHeartbeat(),
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
