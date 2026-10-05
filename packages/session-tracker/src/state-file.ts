import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionState } from './types.js';

export const STATE_DIR = path.join(os.homedir(), '.agents', '.cache', 'terminals', 'sessions');

export function stateFilePath(pid: number, stateDir: string = STATE_DIR): string {
  return path.join(stateDir, `${pid}.json`);
}

const KEY_ORDER: (keyof SessionState)[] = [
  'session_id',
  'agent',
  'cwd',
  'pid',
  'terminal_id',
  'launch_id',
  'ts',
  'method',
];

export function serializeState(s: SessionState): string {
  const ordered: Record<string, unknown> = {};
  for (const k of KEY_ORDER) {
    const v = s[k];
    if (v !== undefined) ordered[k] = v;
  }
  return JSON.stringify(ordered);
}

export function parseState(raw: string): SessionState | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (
    typeof o.session_id !== 'string' ||
    typeof o.cwd !== 'string' ||
    typeof o.pid !== 'number' ||
    typeof o.ts !== 'number'
  ) {
    return null;
  }
  if (typeof o.agent !== 'string') o.agent = 'unknown';
  if (typeof o.method !== 'string') o.method = 'hook-stdin';
  return o as unknown as SessionState;
}

export async function writeStateAtomic(
  state: SessionState,
  stateDir: string = STATE_DIR,
): Promise<void> {
  await fs.promises.mkdir(stateDir, { recursive: true });
  const finalPath = stateFilePath(state.pid, stateDir);
  const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.promises.writeFile(tmpPath, serializeState(state), 'utf8');
    await fs.promises.rename(tmpPath, finalPath);
  } catch (err) {
    try { await fs.promises.unlink(tmpPath); } catch {  }
    throw err;
  }
}

const PID_JSON_RE = /^(\d+)\.json$/;
const PID_TEMP_RE = /^\.(\d+)\.[^.]+$/;

export async function cleanupOrphanedStateFiles(stateDir: string = STATE_DIR): Promise<number> {
  let names: string[];
  try {
    names = await fs.promises.readdir(stateDir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const full = path.join(stateDir, name);
    let stat: fs.Stats | undefined;
    try {
      stat = await fs.promises.stat(full);
    } catch {
      continue;
    }
    if (stat.size === 0 && name.endsWith('.json')) {
      try {
        await fs.promises.unlink(full);
        removed++;
      } catch {  }
      continue;
    }
    const pidMatch = PID_JSON_RE.exec(name) ?? PID_TEMP_RE.exec(name);
    if (!pidMatch) continue;
    const pid = Number(pidMatch[1]);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
        try {
          await fs.promises.unlink(full);
          removed++;
        } catch {  }
      }
    }
  }
  return removed;
}
