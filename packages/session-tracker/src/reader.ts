import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { STATE_DIR, parseState, stateFilePath } from './state-file.js';
import type { SessionState } from './types.js';

const execAsync = promisify(exec);

const PID_TREE_MAX_DEPTH = 5;
const PID_TREE_MAX_NODES = 100;

async function buildChildIndex(): Promise<Map<number, number[]>> {
  const index = new Map<number, number[]>();
  try {
    const { stdout } = await execAsync('ps -eo pid,ppid', { timeout: 2000 });
    for (const line of stdout.split('\n').slice(1)) {
      const [pidStr, ppidStr] = line.trim().split(/\s+/);
      const pid = Number(pidStr);
      const ppid = Number(ppidStr);
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
      const kids = index.get(ppid);
      if (kids) kids.push(pid);
      else index.set(ppid, [pid]);
    }
  } catch {
  }
  return index;
}

export async function descendantPids(rootPid: number): Promise<number[]> {
  const index = await buildChildIndex();
  const visited = new Set<number>([rootPid]);
  const out: number[] = [];
  const queue: { pid: number; depth: number }[] = [{ pid: rootPid, depth: 0 }];
  while (queue.length > 0 && visited.size < PID_TREE_MAX_NODES) {
    const { pid, depth } = queue.shift()!;
    if (depth >= PID_TREE_MAX_DEPTH) continue;
    for (const c of index.get(pid) ?? []) {
      if (visited.has(c)) continue;
      visited.add(c);
      out.push(c);
      queue.push({ pid: c, depth: depth + 1 });
      if (visited.size >= PID_TREE_MAX_NODES) break;
    }
  }
  return out;
}

export async function findStateByPid(pid: number): Promise<SessionState | null> {
  try {
    const raw = await fs.promises.readFile(stateFilePath(pid), 'utf8');
    return parseState(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

export async function findStateInTree(shellPid: number): Promise<SessionState | null> {
  const pids = [shellPid, ...(await descendantPids(shellPid))];
  let best: SessionState | null = null;
  for (const pid of pids) {
    const s = await findStateByPid(pid);
    if (s && (!best || s.ts > best.ts)) best = s;
  }
  return best;
}

async function scanAllStates(): Promise<SessionState[]> {
  let names: string[];
  try {
    names = await fs.promises.readdir(STATE_DIR);
  } catch {
    return [];
  }
  const out: SessionState[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await fs.promises.readFile(path.join(STATE_DIR, name), 'utf8');
      const s = parseState(raw);
      if (s) out.push(s);
    } catch {
    }
  }
  return out;
}

export async function findStateByTerminalId(terminalId: string): Promise<SessionState | null> {
  const all = await scanAllStates();
  let best: SessionState | null = null;
  for (const s of all) {
    if (s.terminal_id !== terminalId) continue;
    if (!best || s.ts > best.ts) best = s;
  }
  return best;
}

export async function findStateByLaunchId(launchId: string): Promise<SessionState | null> {
  const all = await scanAllStates();
  let best: SessionState | null = null;
  for (const s of all) {
    if (s.launch_id !== launchId) continue;
    if (!best || s.ts > best.ts) best = s;
  }
  return best;
}

export async function pruneStaleSessionState(): Promise<number> {
  let names: string[];
  try {
    names = await fs.promises.readdir(STATE_DIR);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const pid = Number(name.slice(0, -5));
    if (!Number.isFinite(pid) || pid <= 0) continue;
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
        try {
          await fs.promises.unlink(path.join(STATE_DIR, name));
          removed++;
        } catch {
        }
      }
    }
  }
  return removed;
}
