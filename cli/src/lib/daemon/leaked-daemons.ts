/**
 * Leaked-daemon detection (W4, PHNX-3736).
 *
 * One daemon per device is the contract: the always-on process behind
 * `agents __daemon-run` is either the service manager's unit main PID or the
 * pid recorded in `<daemonDir>/daemon.pid`. Anything else running
 * `__daemon-run` as this uid is a LEAK — a daemon nothing owns.
 *
 * The motivating incident ran 4+ days on yosemite-s1: a headless e2e session
 * launched a daemon under `HOME=/tmp/pin-e2e-<pid>` and never stopped it. The
 * pid-file takeover in `daemon.ts` could not see it because it keeps its own
 * pid file under the temp home, and `agents daemon status`'s duplicate scope
 * (`findSurvivingStateDirDaemons`, RUSH-2368) deliberately covers only this
 * install's state dir — so the leak was invisible to every existing surface.
 *
 * Why flagging a different-HOME daemon here is not the RUSH-2368 harm: that
 * incident taught that a `__daemon-run` under another HOME is not a DUPLICATE
 * of this device's daemon and must never be told to `kill` from the duplicate
 * path. This module does not accuse it of being a duplicate — it reports that
 * NO owner record (unit main PID, recorded daemon.pid) names the pid at all,
 * and shows the process's own HOME and start time so the operator can judge
 * before acting. A different uid is never named: we cannot inspect its
 * environment or signal it.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { productionDaemonServiceNames, readDaemonPid, readServiceManagerPid } from './daemon.js';
import { getDaemonDir } from '../state.js';

/**
 * The daemon state dir for an ARBITRARY home — the same layout state.ts's
 * DAEMON_DIR chain produces (`<home>/.agents/.cache/helpers/daemon`). A caller
 * under a redirected HOME (a test/e2e harness) uses this to find the REAL
 * install's daemon records. Kept here rather than exported from state.ts: any
 * edit to state.ts selects its entire static-import closure into the required
 * impact gate (186 files, 295s against the 240s budget, measured on this
 * change's first CI run), so the helper cannot live there without a
 * budget-policy change. If state.ts's layout ever moves, this must move with
 * it — the two are the same address.
 */
export function getDaemonDirForHome(home: string): string {
  return path.join(home, '.agents', '.cache', 'helpers', 'daemon');
}

/** One live `__daemon-run` process from the box-wide `ps` scan. */
export interface DaemonRunProcess {
  pid: number;
  /** Owning uid from `ps`, or null when unavailable. */
  uid: number | null;
  /** Whitespace-tokenized argv (`ps` renders it unquoted). */
  tokens: string[];
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
 * this scan and was reported as a stray to `kill`. Callers attach their own
 * scope: `agents daemon status` gates on the instance registry,
 * {@link findLeakedDaemons} on the owner records above.
 */
export function listDaemonRunProcesses(): DaemonRunProcess[] {
  if (process.platform === 'win32') return [];
  let out: string;
  try {
    out = execFileSync('ps', ['-eo', 'pid=,uid=,args='], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return [];
  }
  const found: DaemonRunProcess[] = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const tokens = m[3].trim().split(/\s+/);
    if (tokens.length === 0 || tokens[tokens.length - 1] !== '__daemon-run') continue;
    const pid = parseInt(m[1], 10);
    if (isNaN(pid)) continue;
    const uidParsed = parseInt(m[2], 10);
    found.push({ pid, uid: isNaN(uidParsed) ? null : uidParsed, tokens });
  }
  return found;
}

/** A `__daemon-run` process no owner record names. */
export interface LeakedDaemon {
  pid: number;
  /** The HOME the process runs under, or null when it cannot be read. */
  home: string | null;
  /** The process's start time as `ps lstart` renders it, or null when unavailable. */
  startedAt: string | null;
  /** The launch entry (the argv token before `__daemon-run`), best-effort. */
  entry: string | null;
}

/**
 * The HOME of a live process, or null when unreadable. Linux reads
 * `/proc/<pid>/environ`; macOS has no equivalent zero-dependency primitive, so
 * it falls back to `ps -E`, which appends the environment to the command
 * column. Both are best-effort: a null HOME must never turn into an accusation
 * beyond "unknown".
 */
function processHome(pid: number): string | null {
  if (process.platform === 'linux') {
    try {
      const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf-8');
      for (const entry of env.split('\0')) {
        if (entry.startsWith('HOME=')) return entry.slice('HOME='.length) || null;
      }
      return null;
    } catch {
      return null;
    }
  }
  try {
    const out = execFileSync('ps', ['-E', '-o', 'command=', '-p', String(pid)], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/(?:^|\s)HOME=(\S+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** The start time of a live process as `ps lstart` renders it, or null (best-effort, POSIX only). */
function processStartTime(pid: number): string | null {
  if (process.platform === 'win32') return null;
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Every `__daemon-run` process running as THIS uid that no owner record names:
 * neither the service manager's unit main PID nor the recorded
 * `<daemonDir>/daemon.pid`. Each result carries the process's HOME and start
 * time so the report can show them. An empty list means no leak — including
 * the common stopped-daemon case, where there is simply nothing running.
 */
export function findLeakedDaemons(): LeakedDaemon[] {
  const owned = new Set<number>();
  const recorded = readDaemonPid();
  if (recorded) owned.add(recorded);
  const unitPid = readServiceManagerPid();
  if (unitPid) owned.add(unitPid);

  // A caller under a redirected HOME (a test/e2e harness) must still recognize
  // the REAL install's daemon as owned: its records live under the account
  // home (`os.userInfo().homedir` reads the passwd record, ignoring $HOME),
  // not under this process's HOME. Flagging the box's healthy production
  // daemon as a leak would be the RUSH-2368 harm through a new door.
  const realDaemonDir = getDaemonDirForHome(os.userInfo().homedir);
  if (realDaemonDir !== getDaemonDir()) {
    const realRecorded = readDaemonPid(realDaemonDir);
    if (realRecorded) owned.add(realRecorded);
    const realUnitPid = readServiceManagerPid(os.platform(), productionDaemonServiceNames());
    if (realUnitPid) owned.add(realUnitPid);
  }

  const myUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const leaked: LeakedDaemon[] = [];
  for (const p of listDaemonRunProcesses()) {
    if (owned.has(p.pid)) continue;
    // Another uid's daemon is never named: we cannot read its environment
    // reliably and could not signal it if we tried.
    if (myUid !== null && p.uid !== null && p.uid !== myUid) continue;
    leaked.push({
      pid: p.pid,
      home: processHome(p.pid),
      startedAt: processStartTime(p.pid),
      entry: p.tokens.length >= 2 ? p.tokens[p.tokens.length - 2] : null,
    });
  }
  return leaked;
}
