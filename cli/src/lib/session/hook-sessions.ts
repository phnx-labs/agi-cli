import fs from 'fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { atomicWriteFileSync } from '../fs-atomic.js';
import { hostProcessView } from './process-view.js';
import path from 'path';
import { getTerminalsDir, getRuntimeStateDir } from '../state.js';
import { listPidSessionEntries, pidSessionEntryMatchesLiveProcess, readLivePidSessionEntry, readPidSessionEntry, type PidSessionEntry } from './pid-registry.js';

export interface HookSessionRecord {
  session_id: string;
  agent?: string;
  cwd?: string;
  pid: number;
  launch_id?: string;
  terminal_id?: string;
  ts?: number;
  completed?: boolean;
}

export interface HookSessionIndex {
  byLaunchId: Map<string, HookSessionRecord>;
  byTerminalId: Map<string, HookSessionRecord>;
  byPid: Map<number, HookSessionRecord>;
}

function hookSessionsDir(): string {
  return path.join(getTerminalsDir(), 'sessions');
}

function stateSessionRecordPath(pid: number): string {
  return path.join(getRuntimeStateDir(), 'sessions', `${pid}.json`);
}

export function readStateSessionRecord(
  pid: number,
  startedAtMs?: number,
): HookSessionRecord | undefined {

  if (!pid || pid < 1) return undefined;
  let rec: HookSessionRecord | undefined;
  try {
    rec = parseRecord(fs.readFileSync(stateSessionRecordPath(pid), 'utf8'));
  } catch {
    return undefined;
  }
  if (!rec) return undefined;
  if (startedAtMs !== undefined && typeof rec.ts === 'number') {
    const SKEW_MS = 5_000;
    if (rec.ts * 1000 < startedAtMs - SKEW_MS) return undefined;
  }
  return rec;
}

function parseRecord(raw: string): HookSessionRecord | undefined {
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === 'object' && typeof o.session_id === 'string' && o.session_id) {
      return o as HookSessionRecord;
    }
  } catch {
  }
  return undefined;
}

function keepNewest(map: Map<string | number, HookSessionRecord>, key: string | number, rec: HookSessionRecord): void {
  const prev = map.get(key);
  if (!prev || (rec.ts ?? 0) > (prev.ts ?? 0)) map.set(key, rec);
}

let clockTicks: number | undefined;

function liveUnregisteredHookRecords(): HookSessionRecord[] {
  const scope = hostProcessView();
  if (process.platform !== 'linux' || !scope?.pidNamespace) return [];
  try {
    clockTicks ??= Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 1000 }));
    if (!Number.isFinite(clockTicks) || clockTicks <= 0) return [];
    const bootSeconds = Number(fs.readFileSync('/proc/stat', 'utf8').match(/^btime (\d+)$/m)?.[1]);
    if (!Number.isFinite(bootSeconds)) return [];
    const result: HookSessionRecord[] = [];
    const identity = (pid: number) => {
      if (fs.readlinkSync(`/proc/${pid}/ns/pid`) !== scope.pidNamespace) return undefined;
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return fields[0] !== 'Z' && /^\d+$/.test(fields[19]) ? fields[19] : undefined;
    };
    const prefix = Buffer.from('AGENT_LAUNCH_ID=');
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      try {
        if (!fs.existsSync(stateSessionRecordPath(pid))) continue;
        const before = identity(pid);
        if (!before) continue;
        const rec = readStateSessionRecord(pid);
        const startedSeconds = bootSeconds + Number(before) / clockTicks;
        if (!rec || rec.pid !== pid || typeof rec.ts !== 'number'
          || rec.ts < Math.floor(startedSeconds) || rec.ts > Date.now() / 1000) continue;
        const environment = fs.readFileSync(`/proc/${pid}/environ`);
        let launchId: string | undefined;
        for (let start = 0; start < environment.length;) {
          const end = environment.indexOf(0, start);
          const limit = end < 0 ? environment.length : end;
          if (environment.subarray(start, start + prefix.length).equals(prefix)) {
            launchId = environment.subarray(start + prefix.length, limit).toString('utf8').trim();
            break;
          }
          start = limit + 1;
        }
        if (!launchId || launchId.length > 512 || /[\x00-\x20]/.test(launchId)
          || (rec.launch_id && rec.launch_id !== launchId) || identity(pid) !== before) continue;
        result.push({ ...rec, launch_id: launchId });
      } catch {  }
    }
    return result;
  } catch { return []; }
}

export function captureLaunchBinding(pid: number | undefined, launchId: string): PidSessionEntry | undefined {
  if (!pid) return undefined;
  const entry = readLivePidSessionEntry(pid);
  return entry?.launchId === launchId ? structuredClone(entry) : undefined;
}

export function recordCompletedLaunch(binding: PidSessionEntry | undefined): void {
  if (!binding?.launchId || !hostProcessView()) return;
  const entry = readPidSessionEntry(binding.pid);
  if (!entry?.sessionId || entry.pid !== binding.pid || entry.launchId !== binding.launchId
    || entry.startedAtMs !== binding.startedAtMs || entry.agent !== binding.agent) return;
  const rec: HookSessionRecord = { session_id: entry.sessionId, pid: entry.pid, agent: entry.agent,
    launch_id: binding.launchId, terminal_id: binding.terminalId, ts: Date.now() / 1000, completed: true };
  try {
    fs.mkdirSync(hookSessionsDir(), { recursive: true });
    const name = createHash('sha256').update(binding.launchId).digest('hex');
    atomicWriteFileSync(path.join(hookSessionsDir(), `launch-${name}.json`), JSON.stringify(rec), 'utf8');
  } catch {  }
}

export function loadHookSessionIndex(): HookSessionIndex {

  const byLaunchId = new Map<string, HookSessionRecord>();
  const byTerminalId = new Map<string, HookSessionRecord>();
  const byPid = new Map<number, HookSessionRecord>();
  let files: string[];
  try {
    files = fs.readdirSync(hookSessionsDir()).filter(f => f.endsWith('.json'));
  } catch {
    files = [];
  }
  for (const f of files) {
    let rec: HookSessionRecord | undefined;
    try {
      rec = parseRecord(fs.readFileSync(path.join(hookSessionsDir(), f), 'utf8'));
    } catch {
    }
    if (!rec) continue;
    if (!rec.completed && typeof rec.pid === 'number') keepNewest(byPid as Map<string | number, HookSessionRecord>, rec.pid, rec);
    if (rec.launch_id) keepNewest(byLaunchId as Map<string | number, HookSessionRecord>, rec.launch_id, rec);
    if (!rec.completed && rec.terminal_id) keepNewest(byTerminalId as Map<string | number, HookSessionRecord>, rec.terminal_id, rec);
  }
  for (const entry of listPidSessionEntries()) {
    if (!entry.launchId || pidSessionEntryMatchesLiveProcess(entry) !== true) continue;
    const rec: HookSessionRecord | undefined = entry.sessionId
      ? { session_id: entry.sessionId, pid: entry.pid, ts: entry.startedAtMs / 1000, agent: entry.agent }
      : readStateSessionRecord(entry.pid, entry.startedAtMs);
    if (!rec || !kindMatches(rec.agent, entry.agent)) continue;
    if (rec.launch_id && rec.launch_id !== entry.launchId) continue;
    const joined = { ...rec, agent: rec.agent ?? entry.agent, launch_id: entry.launchId, terminal_id: entry.terminalId };
    if (!byLaunchId.has(entry.launchId)) byLaunchId.set(entry.launchId, joined);
    if (!byPid.has(entry.pid)) byPid.set(entry.pid, joined);
    if (entry.terminalId && !byTerminalId.has(entry.terminalId)) byTerminalId.set(entry.terminalId, joined);
  }
  const recovered = new Map<string, HookSessionRecord | null>();
  for (const rec of liveUnregisteredHookRecords()) {
    if (!byPid.has(rec.pid)) byPid.set(rec.pid, rec);
    const previous = recovered.get(rec.launch_id!);
    recovered.set(rec.launch_id!, previous === null || (previous && previous.session_id !== rec.session_id) ? null : rec);
  }
  for (const [launchId, rec] of recovered) {
    if (rec && !byLaunchId.has(launchId)) byLaunchId.set(launchId, rec);
  }
  return { byLaunchId, byTerminalId, byPid };
}

function kindMatches(recordAgent: string | undefined, kind: string): boolean {
  if (!recordAgent || recordAgent === 'unknown') return true;
  const norm = (k: string) => (k === 'cursor-agent' ? 'cursor' : k);
  return norm(recordAgent) === norm(kind);
}

interface ResolveOpts {
  pid: number;
  kind: string;
  launchId?: string;
  terminalId?: string;
  childPids?: number[];
}

export function resolveHookSessionRecord(index: HookSessionIndex, opts: ResolveOpts): HookSessionRecord | undefined {

  const { pid, kind, launchId, terminalId, childPids } = opts;
  const take = (rec: HookSessionRecord | undefined): HookSessionRecord | undefined =>
    rec?.session_id && kindMatches(rec.agent, kind)
      && (!launchId || !rec.launch_id || rec.launch_id === launchId) ? rec : undefined;

  if (launchId) {
    const hit = take(index.byLaunchId.get(launchId));
    if (hit) return hit;
  }
  if (terminalId && !launchId) {
    const hit = take(index.byTerminalId.get(terminalId));
    if (hit) return hit;
  }
  const direct = take(index.byPid.get(pid));
  if (direct) return direct;
  for (const c of childPids ?? []) {
    const hit = take(index.byPid.get(c));
    if (hit) return hit;
  }
  return undefined;
}

export function resolveHookSessionId(index: HookSessionIndex, opts: ResolveOpts): string | undefined {
  return resolveHookSessionRecord(index, opts)?.session_id;
}
