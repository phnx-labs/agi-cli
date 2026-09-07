/**
 * `agents daemon` — runtime, hosted services, and failure visibility for the
 * always-on daemon (RUSH-2354).
 *
 * The daemon holds the routines scheduler, the browser IPC server, and the
 * watchdog pass — but until this command group existed it had no user-facing
 * surface: no way to see it, restart it, or turn it off. The secrets broker
 * moved out of this daemon entirely with the standalone `secrets` engine
 * (PHNX-3989 OWN-1); `agents daemon status` only probes its reachability.
 * `daemon.ts` (the runtime) has always implemented every mechanism this file
 * wires up; nothing here is new machinery, only the missing CLI surface.
 *
 * There is deliberately no `agents daemon jobs` — scheduled work is
 * `agents routines`, always (see RUSH-2353, which migrates the daemon's
 * hardcoded timers onto routines). `status`/`services` point at
 * `agents routines stats` for per-routine failure detail instead of
 * duplicating it.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { setHelpSections } from '../lib/help.js';
import {
  getDaemonStatus,
  isDaemonRunning,
  isDaemonWedged,
  readDaemonLog,
  startDaemon,
  stopDaemon,
  signalDaemonReload,
  findSurvivingStateDirDaemons,
  getDaemonLogPath,
  isDaemonAutostartCircuitOpen,
} from '../lib/daemon/daemon.js';
import { getConfigValue, setConfigValue, isDaemonEnabled } from '../lib/device-config.js';
import {
  readSubsystemHealth,
  readAllSubsystemHealth,
  SUBSYSTEM_BROWSER_IPC,
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
} from '../lib/daemon-services.js';
import { listJobs, getLatestRun } from '../lib/scheduling/routines.js';
import { JobScheduler } from '../lib/scheduler.js';
import { followFile } from '../lib/log-follow.js';
import { parseDuration } from '../lib/hooks/cache.js';
import { registerFunnelCommand } from './funnel.js';
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

// ─── Process scanning — which install owns the pid, and every duplicate ──────

interface DaemonProcess {
  pid: number;
  /** The entry file/binary the process was launched from, best-effort. */
  entry: string | null;
  /** Resolved package version for `entry`, or null if it couldn't be found. */
  version: string | null;
  /**
   * Whether `entry` is provably ABSENT (`ENOENT`). Null when we cannot tell —
   * a permission error on a parent directory, or any other stat failure. See
   * {@link entryIsGone}: "we cannot see it" must never be reported as "deleted".
   */
  entryMissing: boolean | null;
  /** Owning uid from `ps`, or null when unavailable. */
  uid: number | null;
}

/**
 * Provably absent, or null when unknowable.
 *
 * `fs.existsSync` cannot express the difference: it returns false for ANY failed
 * stat, so `EACCES` on a parent directory is indistinguishable from deletion.
 * The feeding scan is box-wide `ps` with no uid filter, so that gap is reachable
 * on any shared box — `/root` is mode 700, and a stat of a root-owned daemon's
 * entry from an ordinary uid returns false while the file is perfectly present.
 * Reporting that would tell the user to `kill` a healthy daemon they do not own,
 * with a command that would `EPERM` anyway.
 *
 * `statSync(p, { throwIfNoEntry: false })` returns `undefined` only for `ENOENT`
 * and throws for everything else, which is exactly the distinction needed.
 */
function entryAbsent(p: string): boolean | null {
  try {
    return fs.statSync(p, { throwIfNoEntry: false }) === undefined;
  } catch {
    return null;
  }
}

/**
 * A daemon whose launch entry is provably gone from disk (RUSH-2493).
 *
 * This predicate answers only "is this one's code gone?". WHO may be told about
 * it, and whether that report is actionable, is {@link staleDaemons}'s job — a
 * separation reached the hard way: an early revision reported every box-wide
 * `ps` match as actionable (re-opening RUSH-2368), and the correction then
 * over-swung to registry-only, which silently excluded the very incident below.
 *
 * Observed 2026-08-10 on yosemite-s0: a daemon ran for 4h14m from
 * `.agents/worktrees/rush-2431-binary-shadow/apps/cli/dist/index.js` after that
 * worktree was deleted. `systemctl --user is-active` said `active`,
 * `agents daemon status` reported healthy, and nothing anywhere named it —
 * while it held a second routine scheduler, the double-fire class the
 * one-scheduler-one-executor rule exists to prevent. A restart would also have
 * failed, since the manifest pointed at the same missing path.
 *
 * ABSOLUTE PATHS ONLY. `entryFromTokens` returns the second-to-last argv token,
 * which is the entry for a real daemon (`getDaemonLaunch` always spawns an
 * absolute one) but is arbitrary text for anything else — `node -e '<code>'
 * __daemon-run` yields the code blob, which of course does not exist on disk.
 * Requiring absoluteness keeps a non-path token from being reported as deleted
 * code, the same false-positive class RUSH-2368 had to correct for duplicates.
 *
 * That guard also covers an entry path containing SPACES, which `ps` renders
 * unquoted and the tokenizer therefore splits: `/tmp/ghost space/sub/index.js`
 * yields `space/sub/index.js`, not absolute, so a healthy daemon on such a path
 * is never accused (verified live). The cost is a false NEGATIVE — a genuinely
 * deleted entry containing a space is not reported either. That is the safe
 * direction to fail: missing one detection is a silence we already lived with,
 * whereas telling someone to `kill` a healthy shared daemon is a new harm.
 */
function entryIsGone(p: DaemonProcess): boolean {
  return p.entry !== null && path.isAbsolute(p.entry) && p.entryMissing === true;
}

/**
 * Stale daemons split into two tiers, because DETECTION and ACCUSATION are
 * different acts with different blast radii.
 *
 * RUSH-2368's harm was the accusation, not the sighting: a leaked fixture "was
 * reported as a stray to `kill`". So the narrow registry scope is what gates
 * anything actionable — a `doctor` problem, a non-zero exit, a `kill` — while a
 * same-uid sighting is merely shown.
 *
 * That split is not academic. The incident this feature exists to catch was
 * neither the tracked pid nor in the registry: it ran under an ephemeral `/tmp`
 * cwd from a deleted worktree, and `lib/daemon/daemon.ts` documents that such a process
 * "registers under its own state dir and is invisible here" BY DESIGN. Gating
 * the display on the registry too would have made this command silent on the
 * exact 4h14m ghost that motivated it.
 *
 *   `actionable` — this device's daemon, or this install's registry. Drives
 *                  `doctor` problems and the `kill`/`restart` remediation.
 *   `visible`    — additionally any daemon running as THIS uid. Shown in
 *                  `status`, never exits non-zero, never told to kill.
 *
 * A different uid is never named at all: we cannot reliably stat its entry
 * ({@link entryAbsent}), and we could not signal it if we tried.
 */
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

/**
 * Resolve the working directory a live process was started from, or null if
 * unavailable. Linux only (`/proc/<pid>/cwd`) — there is no equivalent
 * zero-dependency primitive on macOS/BSD.
 */
function processCwd(pid: number): string | null {
  try { return fs.realpathSync(`/proc/${pid}/cwd`); } catch { return null; }
}

/**
 * Walk up from `entryPath` looking for the nearest `package.json` and read its
 * version. A relative `entryPath` (the common shape for a dev `node --import
 * tsx <entry> __daemon-run` invocation) is meaningless resolved against the
 * CALLING process's cwd — it must be anchored to the OWNING process's own cwd
 * instead, via `processCwd(pid)`. Getting this wrong silently reports another
 * process's version as this one's (observed live: a relative `src/index.ts`
 * resolved against the caller's cwd instead of the stray daemon's actual
 * ephemeral `/tmp` cwd, reporting a version that process was not running).
 * Absolute entries (every production launch — `getAgentsBinPath()` always
 * returns one) need no anchoring and resolve the same either way.
 */
function resolveVersionNear(entryPath: string, pid: number): string | null {
  let resolved = entryPath;
  if (!path.isAbsolute(resolved)) {
    const cwd = processCwd(pid);
    if (!cwd) return null; // cannot anchor a relative entry — do not guess
    resolved = path.join(cwd, resolved);
  }
  try { resolved = fs.realpathSync(resolved); } catch { /* shim/symlink may be broken or entry may not exist locally */ }
  let dir = path.dirname(resolved);
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
      if (typeof pkg.version === 'string') return pkg.version;
    } catch { /* keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Extract the launch entry from a tokenized `ps` args line ending in
 * `__daemon-run`: the token immediately before it is always the entry —
 * `<node> [node flags...] <entry> __daemon-run` (a dev `node --import tsx
 * <entry> __daemon-run` or the production `node <entry> __daemon-run`) or a
 * compiled standalone binary (`<binary> __daemon-run`, 2 tokens). Reading the
 * second-to-last token is robust to however many node flags precede the entry,
 * unlike guessing a fixed position from the front.
 */
function entryFromTokens(tokens: string[]): string | null {
  return tokens.length >= 2 ? tokens[tokens.length - 2] : null;
}

/**
 * Every live `__daemon-run` process on this box, regardless of which install
 * launched it or which state dir it serves. POSIX-only (uses `ps`); a no-op on
 * Windows.
 *
 * `getDaemonLaunch` always spawns `<node> <entry> __daemon-run` with nothing
 * after it — the ONLY argv `__daemon-run` ever appears in for a real daemon.
 * A substring/regex test anywhere in the full command line is not enough: an
 * `agents run claude "<prompt>"` invocation whose prompt happens to quote the
 * literal text `__daemon-run` (this ticket's own brief does) matches that test
 * too, and was observed producing false "duplicate daemon" rows. Requiring it
 * to be the LAST whitespace-delimited token is the actual invariant.
 *
 * This raw box-wide scan is deliberately NOT the duplicate-detection scope
 * (RUSH-2368): a `__daemon-run` under a different HOME serves a different
 * `getDaemonDir()` and is not a duplicate of THIS device's daemon, however
 * `ps` sees it — a leaked vitest fixture under its own `/tmp` HOME matched
 * this scan and was reported as a stray to `kill`. It is used only to attach
 * display metadata (entry/version) to pids the registry-scoped
 * `findSurvivingStateDirDaemons` has already confirmed as real duplicates.
 */
function scanDaemonProcesses(): DaemonProcess[] {
  if (process.platform === 'win32') return [];
  let out: string;
  try {
    out = execFileSync('ps', ['-eo', 'pid=,uid=,args='], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return [];
  }
  const found: DaemonProcess[] = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const args = m[3].trim();
    const tokens = args.split(/\s+/);
    if (tokens.length === 0 || tokens[tokens.length - 1] !== '__daemon-run') continue;
    const pid = parseInt(m[1], 10);
    if (isNaN(pid)) continue;
    const uidParsed = parseInt(m[2], 10);
    const uid = isNaN(uidParsed) ? null : uidParsed;
    const entry = entryFromTokens(tokens);
    const version = entry ? resolveVersionNear(entry, pid) : null;
    // Asks whether the code is on disk for the NEXT launch -- what a restart and
    // every other reader will see -- not what this pid currently has mapped.
    const entryMissing = entry ? entryAbsent(entry) : false;
    found.push({ pid, entry, version, entryMissing, uid });
  }
  return found;
}

/**
 * Duplicates of THIS device's daemon, scoped to the same instance registry the
 * reaper and the stop postcondition use (RUSH-2368) — never a raw `ps` match.
 * `processes` (from `scanDaemonProcesses`) supplies display metadata
 * (entry/version); `findSurvivingStateDirDaemons` supplies the actual scope, so
 * a `__daemon-run` under a different HOME (a different `getDaemonDir()`) —
 * whether a leaked test fixture or a genuinely separate install — never shows
 * up here even though it is visible to the box-wide `ps` scan.
 */
function registryScopedDuplicates(processes: DaemonProcess[], ownerPid: number | null): DaemonProcess[] {
  const exclude = new Set<number>();
  if (ownerPid) exclude.add(ownerPid);
  const registered = new Set(findSurvivingStateDirDaemons(exclude));
  return processes.filter((p) => registered.has(p.pid));
}

/** Parse a `ps -o etime=` value (`[[dd-]hh:]mm:ss`) into elapsed seconds. */
export function parseEtimeToSeconds(raw: string): number | null {
  const m = raw.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const days = m[1] ? parseInt(m[1], 10) : 0;
  const hours = m[2] ? parseInt(m[2], 10) : 0;
  const mins = parseInt(m[3], 10);
  const secs = parseInt(m[4], 10);
  if ([days, hours, mins, secs].some(isNaN)) return null;
  return ((days * 24 + hours) * 60 + mins) * 60 + secs;
}

/** Elapsed wall-clock seconds since `pid` started, or null if unavailable (best-effort, POSIX only). */
export function uptimeSeconds(pid: number): number | null {
  if (process.platform === 'win32') return null;
  try {
    // `-o etimes=` is a GNU/procps keyword macOS/BSD `ps` rejects with a
    // non-zero exit (`ps: etimes: keyword not found`), so `agents daemon status`
    // errored out entirely on macOS. `etime` (`[[dd-]hh:]mm:ss`) is the portable
    // POSIX field; `parseEtimeToSeconds` above parses it.
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

// ─── Health probes for the two hosted services ───────────────────────────────

interface SecretsBrokerHealth {
  reachable: boolean;
  /**
   * Always `null` — the broker's socket now lives entirely inside the
   * standalone `secrets` engine's own process (PHNX-3989 OWN-1); the daemon
   * neither hosts it nor knows its transport details. Kept in the shape for
   * `--json` compatibility.
   */
  socketPath: string | null;
  heldBundles: number | null;
  /**
   * Always `null` — no daemon service writes a health record for the broker
   * anymore (the daemon does not host or supervise it). Kept in the shape for
   * `--json` compatibility.
   */
  record: SubsystemHealth | null;
}

/** Reachability probe only — the daemon does not host, supervise, or take over the broker (OWN-1). */
async function probeSecretsBroker(): Promise<SecretsBrokerHealth> {
  try {
    const { agentPing, agentStatus } = await import('../lib/secrets-client.js');
    const ping = await agentPing();
    if (!ping.reachable) return { reachable: false, socketPath: null, heldBundles: null, record: null };
    const entries = await agentStatus();
    return { reachable: true, socketPath: null, heldBundles: entries.length, record: null };
  } catch {
    return { reachable: false, socketPath: null, heldBundles: null, record: null };
  }
}

interface BrowserIpcHealth {
  bound: boolean;
  socketPath: string;
  sessionCount: number;
  record: SubsystemHealth | null;
}

async function probeBrowserIPC(): Promise<BrowserIpcHealth> {
  const record = readSubsystemHealth(SUBSYSTEM_BROWSER_IPC);
  const { isBrowserServiceReachable, getSocketPath } = await import('../lib/browser/ipc.js');
  const { listAllProfileSnapshots } = await import('../lib/browser/runtime-state.js');
  const bound = await isBrowserServiceReachable();
  const sessionCount = listAllProfileSnapshots().filter((s) => s.pidAlive && s.daemonAlive).length;
  return { bound, socketPath: getSocketPath(), sessionCount, record };
}

// ─── Scheduler summary (routine count / next fire / failing count) ──────────

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
  } catch { /* best-effort */ }
  const failingCount = enabled.filter((j) => {
    const last = getLatestRun(j.name);
    return last?.status === 'failed' || last?.status === 'timeout';
  }).length;
  return { routineCount: jobs.length, enabledCount: enabled.length, nextFire, failingCount };
}

// ─── Rendering ────────────────────────────────────────────────────────────

/**
 * Render one service's health line. `live` is the verdict — a probe run RIGHT
 * NOW against the actual socket/binding — and is the only thing allowed to say
 * `healthy` (RUSH-2368). `record` is the daemon's persisted last-ok/last-error
 * history: supporting context, never the verdict. Before this fix the verdict
 * came from `record.consecutiveFailures`, which the daemon only updates at its
 * own startup (`recordSubsystemOk`/`recordSubsystemError` in daemon.ts) — a
 * broker that went unreachable hours into a still-running daemon rendered
 * `healthy (unreachable)` on one line, a contradiction that is exactly the
 * silent-success pattern this command exists to remove.
 */
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

async function runStatus(opts: { json?: boolean }): Promise<void> {
  const status = getDaemonStatus();
  const enabled = isDaemonEnabled();
  const state: 'running' | 'wedged' | 'stopped' | 'disabled' =
    !status.running && !enabled ? 'disabled' : status.state;
  const pid = status.pid;
  const uptime = pid ? uptimeSeconds(pid) : null;
  const heartbeatAgeMs = status.heartbeat ? Date.now() - Date.parse(status.heartbeat.lastTick) : null;

  const processes = scanDaemonProcesses();
  const owner = pid ? processes.find((p) => p.pid === pid) : undefined;
  const duplicates = registryScopedDuplicates(processes, pid ?? null);
  // Every daemon whose code is gone from disk, including this device's own if
  // it is one. Not filtered by the duplicate scope — see entryIsGone.
  // Deliberately its own read, NOT shared with registryScopedDuplicates above.
  // That one passes `exclude` INTO findSurvivingStateDirDaemons to drop the
  // owner, so handing it a shared empty-exclude snapshot would put ownerPid back
  // in the set and report this device's daemon as its own duplicate. The saving
  // would be one `ps` spawn per registered pid, at the 1-3 that actually run.
  const registeredPids = new Set(findSurvivingStateDirDaemons(new Set()));
  const staleTiers = staleDaemons(processes, pid ?? null, registeredPids);
  const stale = staleTiers.visible;
  const ownerEntryGone = owner ? entryIsGone(owner) : false;

  const [secrets, browserIpc] = await Promise.all([probeSecretsBroker(), probeBrowserIPC()]);
  const scheduler = schedulerSummary();

  if (opts.json) {
    console.log(JSON.stringify({
      state,
      pid,
      uptimeSeconds: uptime,
      heartbeatAgeMs,
      logPath: status.logPath,
      binaryPath: owner?.entry ?? status.binaryPath,
      binaryVersion: owner?.version ?? null,
      binaryMissing: ownerEntryGone,
      duplicates: duplicates.map((d) => ({ pid: d.pid, entry: d.entry, version: d.version })),
      // `actionable` is part of the contract, not decoration: a routine or
      // monitor reading this must be able to tell a ghost it may act on from one
      // that is merely visible. Without it the machine surface re-opens exactly
      // what the two-tier split closed for the text surface.
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
        browserIpc: {
          bound: browserIpc.bound,
          socketPath: browserIpc.socketPath,
          sessionCount: browserIpc.sessionCount,
          health: browserIpc.record,
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
    : state === 'wedged' ? chalk.red('wedged')
    : state === 'disabled' ? chalk.yellow('disabled')
    : chalk.gray('stopped');

  console.log(chalk.bold('Identity\n'));
  console.log(`  State:      ${stateLabel}`);
  if (pid) console.log(`  PID:        ${pid}`);
  if (uptime !== null) console.log(`  Uptime:     ${humanDuration(uptime)}`);
  if (heartbeatAgeMs !== null) console.log(`  Heartbeat:  ${Math.round(heartbeatAgeMs / 1000)}s ago`);
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
    // Only offer a remedy when a row here is one we may act on. Printing
    // `kill <pid>` under a section whose only rows are visibility-tier is
    // RUSH-2368's harm re-entering through the render layer after the data
    // layer stopped producing it.
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
  console.log(healthLine(`secrets broker  ${secrets.reachable ? `(${secrets.socketPath}, ${secrets.heldBundles} bundle(s) held)` : '(unreachable)'}`, secrets.reachable, secrets.record));
  console.log(healthLine(`browser IPC     ${browserIpc.bound ? `(${browserIpc.socketPath}, ${browserIpc.sessionCount} session(s))` : '(unbound)'}`, browserIpc.bound, browserIpc.record));

  const schedulerEnabled = getConfigValue('scheduler.enabled').value !== false;
  console.log(`  ${schedulerEnabled ? chalk.green('enabled') : chalk.yellow('disabled')}  scheduler — ${scheduler.enabledCount}/${scheduler.routineCount} routine(s) enabled` +
    (scheduler.nextFire ? `, next ${scheduler.nextFire.toLocaleString()}` : ''));
  if (scheduler.failingCount > 0) {
    console.log(chalk.red(`  ${scheduler.failingCount} routine(s) failing their last run — see: agents routines stats`));
  }

  if (state === 'wedged') {
    console.log(chalk.red('\nThe daemon is wedged (heartbeat stale). Restart: agents daemon restart'));
  }
}

// ─── Full service roster (RUSH-3193 P4) ──────────────────────────────────────

/** One row of the roster every registered daemon service — supervisor-managed or legacy — renders in `agents daemon services`. */
export interface DaemonServiceRow {
  id: DaemonServiceId;
  title: string;
  description: string;
  enabled: boolean;
  /**
   * `ServiceSupervisor`'s real lifecycle state when `supervised` is true
   * (`idle`/`running`/`parked`/`stopped`, written cross-process via
   * `recordSubsystemState`). A legacy `setInterval`-driven service has no such
   * record, so its state is inferred from `enabled` + whether the daemon
   * process is up — labelled distinctly so a reader can't mistake it for a
   * measured value.
   */
  state: string;
  supervised: boolean;
  lastRunMs: number | null;
  lastError: string | null;
  consecutiveFailures: number;
}

/**
 * Combine the persisted enable/disable toggles with whatever health the
 * `ServiceSupervisor` (or a legacy subsystem) has reported. Pure — reads two
 * on-disk files, makes no probes — so it's cheap to call from both the
 * non-interactive renderer and the interactive picker's refresh tick.
 */
function buildServiceRows(daemonRunning: boolean): DaemonServiceRow[] {
  const states = listDaemonServiceStates();
  const healthById = new Map(readAllSubsystemHealth().map((h) => [h.subsystem, h]));
  return states.map((s) => {
    const h = healthById.get(s.id);
    const supervised = h?.state !== undefined;
    // A persisted supervisor state (health.json) is only trustworthy while the
    // daemon is actually up. If it is not running (crash / kill -9 / never
    // started), every service is stopped no matter what the last-written record
    // says — trusting a stale 'running'/'parked'/'idle' here would print a
    // report that contradicts the live-probed socket rows below (RUSH-2368).
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
  if (state === 'parked') return chalk.red('parked');
  if (state === 'stopped') return chalk.gray('stopped');
  if (state === 'idle') return chalk.gray('idle');
  return chalk.yellow(state); // 'running (unsupervised)' or any future label
}

async function runServices(opts: { json?: boolean }): Promise<void> {
  const [secrets, browserIpc] = await Promise.all([probeSecretsBroker(), probeBrowserIPC()]);
  const rows = buildServiceRows(isDaemonRunning());
  if (opts.json) {
    console.log(JSON.stringify({
      // Existing fields — unchanged shape, agents/CI consume these directly.
      secretsBroker: { reachable: secrets.reachable, socketPath: secrets.socketPath, heldBundles: secrets.heldBundles, health: secrets.record },
      browserIpc: { bound: browserIpc.bound, socketPath: browserIpc.socketPath, sessionCount: browserIpc.sessionCount, health: browserIpc.record },
      // Additive: every registered service, supervised or legacy.
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
  console.log(healthLine(`secrets broker  ${secrets.reachable ? `(${secrets.socketPath}, ${secrets.heldBundles} bundle(s) held)` : '(unreachable)'}`, secrets.reachable, secrets.record));
  console.log(healthLine(`browser IPC     ${browserIpc.bound ? `(${browserIpc.socketPath}, ${browserIpc.sessionCount} session(s))` : '(unbound)'}`, browserIpc.bound, browserIpc.record));
  console.log(chalk.gray('\nScheduled routines run through `agents routines` — see: agents routines stats'));
  console.log(chalk.gray('agents daemon services enable|disable|restart <id> apply live for supervised services.'));
}

// ─── Logs ────────────────────────────────────────────────────────────────

interface DaemonLogEntry {
  ts: string;
  level: string;
  message: string;
}

function parseLogLines(raw: string): DaemonLogEntry[] {
  const out: DaemonLogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry.ts === 'string' && typeof entry.level === 'string') out.push(entry);
    } catch { /* skip malformed line */ }
  }
  return out;
}

const LEVEL_RANK: Record<string, number> = { INFO: 0, WARN: 1, ERROR: 2 };

function passesFilters(entry: DaemonLogEntry, minLevel: string | undefined, sinceMs: number | undefined): boolean {
  if (minLevel) {
    const min = LEVEL_RANK[minLevel.toUpperCase()] ?? 0;
    const level = LEVEL_RANK[entry.level.toUpperCase()] ?? 0;
    if (level < min) return false;
  }
  if (sinceMs !== undefined && Date.parse(entry.ts) < sinceMs) return false;
  return true;
}

function printLogEntry(entry: DaemonLogEntry): void {
  const color = entry.level === 'ERROR' ? chalk.red : entry.level === 'WARN' ? chalk.yellow : chalk.gray;
  console.log(`${chalk.gray(entry.ts)} ${color(entry.level.padEnd(5))} ${entry.message}`);
}

async function runLogs(opts: { lines?: string; follow?: boolean; level?: string; since?: string; json?: boolean }): Promise<void> {
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

// ─── Doctor ──────────────────────────────────────────────────────────────

async function runDoctor(opts: { json?: boolean }): Promise<void> {
  const status = getDaemonStatus();
  const enabled = isDaemonEnabled();
  const problems: string[] = [];

  if (!status.running && enabled) problems.push('Daemon is not running. Start it: agents daemon start');
  if (status.running && isDaemonWedged()) problems.push('Daemon is wedged (heartbeat stale). Restart: agents daemon restart');

  // RUSH-2418: an open auto-start circuit breaker is the FIRST thing to report
  // for a stopped daemon — otherwise the only advice is "agents daemon start",
  // which is the exact action the breaker just refused, with no hint that a
  // breaker exists or what the underlying failure was. This is where the
  // breaker's own message sends the operator, so it has to answer them.
  const startHealth = readSubsystemHealth(SUBSYSTEM_DAEMON_START);
  if (isDaemonAutostartCircuitOpen()) {
    problems.push(
      `Daemon auto-start is disabled after ${startHealth?.consecutiveFailures ?? 0} consecutive starts that never reported healthy: ` +
      `${startHealth?.lastError ?? 'no reason recorded'}. Fix the cause, then retry with: agents daemon start`,
    );
  } else if (!status.running && startHealth && startHealth.consecutiveFailures > 0) {
    // Only while the daemon is DOWN. A start is marked as failed the moment it
    // is issued and cleared once the daemon finishes booting, so a running
    // daemon with a non-zero streak is just the boot window (or a daemon
    // launched outside startDaemon) — reporting it there is a false alarm that
    // clears itself a second later.
    problems.push(`Daemon start has ${startHealth.consecutiveFailures} consecutive failure(s): ${startHealth.lastError}`);
  }

  const healthProcesses = scanDaemonProcesses();
  const duplicates = registryScopedDuplicates(healthProcesses, status.pid);
  if (duplicates.length > 0) {
    problems.push(`${duplicates.length} duplicate daemon process(es) running: ${duplicates.map((d) => d.pid).join(', ')}. Stop the stray(s).`);
  }

  // A daemon whose entry is gone from disk is a problem even when it answers
  // every probe: it cannot restart, and it is running whatever was loaded
  // before the file was deleted (RUSH-2493).
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

  const browserIpc = await probeBrowserIPC();
  if (!browserIpc.bound) problems.push('Browser IPC is unbound.');
  if (browserIpc.record && browserIpc.record.consecutiveFailures > 0) {
    problems.push(`Browser IPC has ${browserIpc.record.consecutiveFailures} consecutive failure(s): ${browserIpc.record.lastError}`);
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

// ─── Hosted webhook receivers ────────────────────────────────────────────

/** Parse a positive-integer option, failing loud rather than silently defaulting. */
function requirePositiveInt(raw: string, label: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(chalk.red(`${label} must be a positive integer (got '${raw}').`));
    process.exit(1);
  }
  return parsed;
}

/**
 * `agents daemon webhooks` — which signed receivers THIS box hosts (RUSH-2548).
 *
 * The entries land in `daemon/webhooks.yaml`, which the daemon's
 * `webhook-receiver` service reads at start; nothing binds until the daemon
 * picks the change up, so every mutation says how to apply it.
 */
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
      through the secrets broker, so a hosted receiver needs no
      AGENTS_SECRETS_PASSPHRASE and no nohup. A LOCKED bundle fails that receiver
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
        // Leaving the Funnel up would keep a public HTTPS route pointed at a port
        // nothing serves, so say what to run — this box may not be the tailnet
        // node, and `funnel down` names the host explicitly.
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

// ─── Command registration ────────────────────────────────────────────────

export function registerDaemonCommand(program: Command): void {
  const cmd = program
    .command('daemon')
    .description('The always-on daemon: browser IPC, watchdog, and the routines scheduler. Bare `agents daemon` shows status.')
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
      # for supervisor-managed services (browser-ipc, account-state,
      # session-index, monitors' off-transition, watchdog, device-probe,
      # self-heal, state-dir-check)
      agents daemon services disable browser-ipc
      agents daemon services enable browser-ipc
      agents daemon services restart browser-ipc

      # Host a signed webhook receiver here, supervised and restarted on crash
      agents daemon webhooks add --secrets-bundle linear-webhook
      agents daemon webhooks list

      # Manage public ingress for daemon-world webhook receivers
      agents daemon funnel status yosemite-s0
      agents daemon funnel up yosemite-s0 --local-port 8787 --port 443

      # Tail the daemon's own log, warnings and up, from the last hour
      agents daemon logs -f --level warn --since 1h

      # One-shot health check for scripts (non-zero exit on problems)
      agents daemon doctor
    `,
    notes: `
      There is no 'agents daemon jobs' — scheduled work is 'agents routines',
      always. Use 'agents routines stats' for per-routine failure detail.

      'disable' is a persisted kill switch: it stops routines/add,
      routines/start, routines/catchup, monitors/add, and webhook triggers from auto-starting
      the daemon (daemon.enabled: false in ~/.agents/devices/<host>/agents.yaml).
      'agents daemon start' still starts it explicitly, same as
      'systemctl start' on a disabled unit.

      'agents daemon services enable|disable|restart <id>' applies live (no
      daemon restart) for supervisor-managed services that were registered at
      boot. browser-ipc is also registered while disabled, specifically so a
      browser client can enable it live. The inline scheduler re-evaluates its
      toggle on every reload as well. A boot-disabled service other than
      browser-ipc, the monitor on-transition, and webhook-receiver still need an
      operator 'agents daemon restart'. 'agents daemon services' names which
      case you're in per row.
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
      const result = startDaemon();
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
      // SING-12 / RUSH-2355: stop asserts its postcondition and returns what
      // released vs survived — surface it and exit non-zero on an unclean stop.
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
      const result = startDaemon();
      if (result.pid) console.log(chalk.green(`Daemon started (PID: ${result.pid}, ${result.method})`));
      else console.log(chalk.yellow('Daemon start dispatched but no PID surfaced. Check: agents daemon status'));
    });

  cmd.command('enable')
    .description('Clear the daemon.enabled kill switch. Does not start the daemon by itself.')
    .action(() => {
      setConfigValue('daemon.enabled', true);
      console.log(chalk.green('daemon.enabled: true') + chalk.gray(' — auto-start surfaces (routines add/start/catchup, monitors add, webhooks) may bring the daemon up again'));
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
      # service (browser-ipc, account-state, session-index)
      agents daemon services disable browser-ipc
      agents daemon services enable browser-ipc
      agents daemon services restart browser-ipc
    `,
    notes: `
      A service disabled at daemon boot is normally not registered on the
      supervisor, so enabling it needs an operator restart. browser-ipc is the
      exception: it is registered stopped and can be enabled live. The inline
      scheduler also applies enable/disable on reload; webhook-receiver and the
      monitor on-transition still require 'agents daemon restart'. Each row in
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

  /**
   * Apply an enable/disable toggle live (RUSH-3193 P4): persist it, then signal
   * the running daemon to reload — its handler diffs the toggle and drives
   * `supervisor.start/stop(id)` for a supervised service, so no restart is
   * needed for supervisor-managed services registered at boot. browser-ipc is
   * registered even when disabled so it can be enabled live; the inline
   * scheduler also re-evaluates its toggle on reload. webhook-receiver,
   * monitors' on-transition, and other boot-disabled services still need a
   * deliberate operator restart — the daemon's own reload log says so.
   */
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

  cmd.command('logs')
    .description('Read the daemon\'s own log (lifecycle + subsystem errors — not routine run output).')
    .option('-n, --lines <number>', 'Show this many recent lines', '50')
    .option('-f, --follow', 'Stream new lines as they are written (like tail -f)')
    .option('--level <level>', 'Minimum level to show: info | warn | error')
    .option('--since <dur>', 'Only lines newer than this (e.g. 1h, 30m)')
    .option('--json', 'Emit each line as JSON')
    .action(async (opts, command) => {
      const merged = command.optsWithGlobals();
      await runLogs({ lines: opts.lines, follow: opts.follow, level: opts.level, since: opts.since, json: merged.json === true || opts.json === true });
    });

  cmd.command('doctor')
    .description('One-shot health check: identity, duplicates, hosted services, scheduler. Non-zero exit on problems.')
    .option('--json', 'Emit as JSON')
    .action(async (opts, command) => {
      await runDoctor({ json: command.optsWithGlobals().json === true });
    });
}
