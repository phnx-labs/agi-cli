/** Leaked-daemon detection (W4, PHNX-3736). One daemon per device: the `__daemon-run` process is
 * the unit's main PID or the pid in `<daemonDir>/daemon.pid`; any other as this uid
 * is a LEAK, reported but not called a duplicate to kill (RUSH-2368). Other uids are never named. */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { productionDaemonServiceNames, readDaemonPid, readServiceManagerPid } from './daemon.js';
import { getDaemonDir } from '../state.js';

/** The daemon state dir for an arbitrary home, matching state.ts's DAEMON_DIR layout
 * (`<home>/.agents/.cache/helpers/daemon`), so a redirected-HOME caller can find the real
 * install's records. Not in state.ts (inflates the impact check); must move with its layout. */
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

/** Every live `__daemon-run` process on this box, whichever install or state dir. POSIX-only
 * (`ps`). `__daemon-run` must be the LAST token (a substring also matched prompts quoting it).
 * Not the duplicate scope (RUSH-2368): another HOME's daemon isn't one; callers add their scope. */
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

/** The HOME of a live process, or null. Linux reads `/proc/<pid>/environ`; macOS falls back to `ps
 * -E`. Best-effort: a null HOME must never become an accusation beyond "unknown". */
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

/** Every `__daemon-run` as THIS uid that no owner record names (neither the service manager's unit
 * main PID nor the recorded `daemon.pid`), with its HOME and start time. Empty means no leak,
 * including a stopped daemon. */
export function findLeakedDaemons(): LeakedDaemon[] {
  const owned = new Set<number>();
  const recorded = readDaemonPid();
  if (recorded) owned.add(recorded);
  const unitPid = readServiceManagerPid();
  if (unitPid) owned.add(unitPid);

  // A redirected-HOME caller must still recognize the real install's daemon as owned: its records
  // live under the account home (`os.userInfo().homedir` reads passwd, ignoring $HOME). Flagging
  // the healthy production daemon as a leak would be the RUSH-2368 harm by another route.
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
