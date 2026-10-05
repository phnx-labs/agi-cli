import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { productionDaemonServiceNames, readDaemonPid, readServiceManagerPid } from './daemon.js';
import { getDaemonDir } from '../state.js';

export function getDaemonDirForHome(home: string): string {
  return path.join(home, '.agents', '.cache', 'helpers', 'daemon');
}

export interface DaemonRunProcess {
  pid: number;
  uid: number | null;
  tokens: string[];
}

// A real daemon has __daemon-run as the final argv token; prompt text containing it is not identity.
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

export interface LeakedDaemon {
  pid: number;
  home: string | null;
  startedAt: string | null;
  entry: string | null;
}

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

function processStartTime(pid: number): string | null {
  if (process.platform === 'win32') return null;
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out || null;
  } catch {
    return null;
  }
}

// Different-HOME processes are not duplicates; report only this uid's pid absent from manager and real-HOME owner records.
export function findLeakedDaemons(): LeakedDaemon[] {
  const owned = new Set<number>();
  const recorded = readDaemonPid();
  if (recorded) owned.add(recorded);
  const unitPid = readServiceManagerPid();
  if (unitPid) owned.add(unitPid);

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
