import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { hostProcessView, writerProcessView } from './process-view.js';
import { getTerminalsDir } from '../state.js';
import { atomicWriteFileSync, withFileLock } from '../fs-atomic.js';
import type { LaunchOrigin } from '../launch-identity.js';

export interface PidSessionEntry {
  pid: number;
  agent: string;
  harness?: string;
  sessionId?: string;
  cwd?: string;
  actor?: string;
  initiatedBy?: 'human' | 'agent';
  launchId?: string;
  terminalId?: string;
  originTerminal?: LaunchOrigin;
  tmuxPane?: string;
  startedAtMs: number;
  processIdentity?: { bootId?: string; pidNamespace?: string; initStartTicks?: string; startTicks?: string; startTime?: string };
}

function linuxStartTicks(pid: number): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const value = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    return value && /^\d+$/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function pidExists(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return undefined;
  }
}

function darwinStartTime(pid: number): string | undefined {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch { return undefined; }
}

function processStartTimeMs(value: string | undefined): number {
  return typeof value === 'string' ? Date.parse(value.trim().replace(/\s+/g, ' ')) : NaN;
}

export function processStartTimesMatch(recorded: string | undefined, observed: string | undefined): boolean | undefined {
  const recordedMs = processStartTimeMs(recorded);
  const observedMs = processStartTimeMs(observed);
  return Number.isFinite(recordedMs) && Number.isFinite(observedMs) ? recordedMs === observedMs : undefined;
}

export function pidSessionEntryMatchesLiveProcess(entry: PidSessionEntry, startTime?: string): boolean | undefined {

  if (!Number.isInteger(entry.pid) || entry.pid < 1) return undefined;
  if (process.platform === 'darwin') {
    const exists = pidExists(entry.pid);
    if (exists !== true) return exists;
    const start = startTime ?? darwinStartTime(entry.pid);
    return processStartTimesMatch(entry.processIdentity?.startTime, start);
  }
  if (process.platform !== 'linux') return undefined;
  const scope = hostProcessView();
  if (!scope || entry.processIdentity?.bootId !== scope.bootId
    || entry.processIdentity?.pidNamespace !== scope.pidNamespace
    || entry.processIdentity?.initStartTicks !== scope.initStartTicks) return undefined;
  const exists = pidExists(entry.pid);
  if (exists !== true) return exists;
  const start = linuxStartTicks(entry.pid);
  const recordedStart = entry.processIdentity?.startTicks;
  if (!start || typeof recordedStart !== 'string' || !/^\d+$/.test(recordedStart)) return undefined;
  return start === recordedStart;
}

const SESSION_ID_VALUE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isSessionIdShape(value: string): boolean {
  return SESSION_ID_VALUE_RE.test(value);
}
export function extractSessionIdArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--session-id') {
      const v = args[i + 1];
      if (v && SESSION_ID_VALUE_RE.test(v)) return v;
    } else if (a.startsWith('--session-id=')) {
      const v = a.slice('--session-id='.length);
      if (SESSION_ID_VALUE_RE.test(v)) return v;
    }
  }
  return undefined;
}

export function readProcessArgv(pid: number): string[] | undefined {
  if (!pid || pid < 1) return undefined;
  if (process.platform === 'linux') {
    try {
      const buf = fs.readFileSync(`/proc/${pid}/cmdline`);
      const parts = buf.toString('utf8').split('\0').filter(Boolean);
      return parts.length > 0 ? parts : undefined;
    } catch {
      return undefined;
    }
  }
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'args='], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (!out) return undefined;
      return out.split(/\s+/);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function sessionIdFromLivePid(pid: number): string | undefined {
  const argv = readProcessArgv(pid);
  if (!argv) return undefined;
  return extractSessionIdArg(argv);
}

function pidRegistryDir(): string {
  return path.join(getTerminalsDir(), 'by-pid');
}

function entryPath(pid: number): string {
  return path.join(pidRegistryDir(), `${pid}.json`);
}

function ownershipPath(pid: number): string {
  return path.join(getTerminalsDir(), 'by-pid-ownership', `${pid}.json`);
}

function persistOwnership(entry: PidSessionEntry): void {
  fs.mkdirSync(path.dirname(ownershipPath(entry.pid)), { recursive: true });
  atomicWriteFileSync(ownershipPath(entry.pid), JSON.stringify(entry), 'utf8');
}

function restoreOwnership(entry: PidSessionEntry): PidSessionEntry {
  if (entry.processIdentity && (entry.originTerminal || !entry.launchId)) return entry;
  try {
    const owner = JSON.parse(fs.readFileSync(ownershipPath(entry.pid), 'utf8')) as PidSessionEntry;
    if (owner.pid === entry.pid && owner.launchId === entry.launchId && owner.startedAtMs === entry.startedAtMs) {
      return {
        ...entry,
        processIdentity: entry.processIdentity ?? owner.processIdentity,
        ...(entry.originTerminal ?? owner.originTerminal ? { originTerminal: entry.originTerminal ?? owner.originTerminal } : {}),
      };
    }
  } catch {  }
  return entry;
}

export function writePidSessionEntry(entry: PidSessionEntry): void {

  if (!Number.isInteger(entry.pid) || entry.pid < 1) return;
  try {
    const scope = process.platform === 'linux' ? writerProcessView() : undefined;
    if (process.platform === 'linux' && !scope) return;
    fs.mkdirSync(pidRegistryDir(), { recursive: true });
    const processIdentity = scope?.bootId && scope.pidNamespace ? { bootId: scope.bootId, pidNamespace: scope.pidNamespace, initStartTicks: scope.initStartTicks, startTicks: linuxStartTicks(entry.pid) }
      : process.platform === 'darwin' ? { startTime: darwinStartTime(entry.pid) } : undefined;
    const file = entryPath(entry.pid);
    withFileLock(file, () => {
      const owned = { ...entry, processIdentity };
      persistOwnership(owned);
      atomicWriteFileSync(file, JSON.stringify(owned), 'utf8');
    }, { realpath: false, acquireTimeoutMs: 0 });
  } catch {
  }
}

export function readPidSessionEntry(pid: number): PidSessionEntry | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(entryPath(pid), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.pid === pid) {
      return restoreOwnership(parsed as PidSessionEntry);
    }
  } catch {
  }
  return undefined;
}

export function readLivePidSessionEntry(pid: number, startTime?: string): PidSessionEntry | undefined {

  const entry = readPidSessionEntry(pid);
  if (!entry || !hostProcessView()) return undefined;
  if (process.platform === 'win32') return pidExists(pid) === true ? entry : undefined;
  if (!entry.processIdentity && pidExists(pid) === true) {
    const start = startTime ?? darwinStartTime(pid);
    const startMs = processStartTimeMs(start);
    if (Number.isFinite(startMs) && entry.startedAtMs >= startMs - 1000 && entry.startedAtMs <= Date.now()) {
      const scope = hostProcessView()!;
      entry.processIdentity = process.platform === 'linux'
        ? { ...scope, startTicks: linuxStartTicks(pid) }
        : { startTime: start };
      try { persistOwnership(entry); } catch {  }
    }
  }
  return pidSessionEntryMatchesLiveProcess(entry, startTime) === true ? entry : undefined;
}

export function listPidSessionEntries(): PidSessionEntry[] {
  let files: string[];
  try {
    files = fs.readdirSync(pidRegistryDir()).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: PidSessionEntry[] = [];
  for (const f of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(pidRegistryDir(), f), 'utf8'));
      if (parsed && typeof parsed === 'object' && typeof parsed.pid === 'number') {
        out.push(restoreOwnership(parsed as PidSessionEntry));
      }
    } catch {
    }
  }
  return out;
}

export function prunePidSessionRegistry(isAlive?: (pid: number, startedAtMs?: number) => boolean | undefined): void {
  let files: string[];
  try {
    files = fs.readdirSync(pidRegistryDir()).filter(f => f.endsWith('.json'));
  } catch {
    return;
  }
  const scope = process.platform === 'linux' ? hostProcessView() : undefined;
  for (const f of files) {
    const pid = Number(f.slice(0, -'.json'.length));
    if (!Number.isInteger(pid) || pid < 1) continue;
    let raw: string;
    let entry: PidSessionEntry;
    try {
      raw = fs.readFileSync(path.join(pidRegistryDir(), f), 'utf8');
      entry = restoreOwnership(JSON.parse(raw));
      if (entry?.pid !== pid) continue;
    } catch {
      continue;
    }
    if (process.platform === 'linux' && (!scope
      || entry.processIdentity?.bootId !== scope.bootId
      || entry.processIdentity?.pidNamespace !== scope.pidNamespace
      || entry.processIdentity?.initStartTicks !== scope.initStartTicks)) continue;
    const exists = pidExists(pid);
    if (exists === undefined) continue;
    if (exists) {
      if (process.platform === 'linux') {
        const start = linuxStartTicks(pid);
        const recordedStart = entry.processIdentity?.startTicks;
        if (!start || typeof recordedStart !== 'string' || !/^\d+$/.test(recordedStart) || start === recordedStart) continue;
      } else if (!isAlive || isAlive(pid, entry.startedAtMs) !== false) continue;
    }
    try {
      const file = path.join(pidRegistryDir(), f);
      withFileLock(file, () => {
        if (fs.readFileSync(file, 'utf8') === raw) fs.unlinkSync(file);
      }, { realpath: false, acquireTimeoutMs: 0 });
    } catch {
    }
  }
}
