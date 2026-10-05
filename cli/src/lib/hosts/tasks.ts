
import * as fs from 'fs';
import * as path from 'path';
import { getCacheDir } from '../state.js';

export type HostTaskStatus = 'running' | 'completed' | 'failed' | 'unknown';

export interface HostTask {
  id: string;
  host: string;
  target: string;
  identityFile?: string;
  remoteShell?: 'posix' | 'powershell';
  agent: string;
  prompt: string;
  pid?: number;
  name?: string;
  sessionId?: string;
  remoteLog: string;
  remoteExit: string;
  status: HostTaskStatus;
  exitCode?: number;
  createdAt: string;
  finishedAt?: string;
}

export function hostsCacheDir(): string {
  return path.join(getCacheDir(), 'hosts');
}

function taskFile(id: string): string {
  return path.join(hostsCacheDir(), `${id}.json`);
}

export function localLogPath(id: string): string {
  return path.join(hostsCacheDir(), `${id}.log`);
}

export function saveTask(task: HostTask): void {
  fs.mkdirSync(hostsCacheDir(), { recursive: true });
  fs.writeFileSync(taskFile(task.id), JSON.stringify(task, null, 2));
}

export function loadTask(id: string): HostTask | null {
  try {
    return JSON.parse(fs.readFileSync(taskFile(id), 'utf-8')) as HostTask;
  } catch {
    return null;
  }
}

export function updateTask(id: string, patch: Partial<HostTask>): HostTask | null {
  const task = loadTask(id);
  if (!task) return null;
  const next = { ...task, ...patch };
  saveTask(next);
  return next;
}

export function terminalPatch(code: number): Partial<HostTask> {

  return {
    status: code === 0 ? 'completed' : 'failed',
    exitCode: code,
    finishedAt: new Date().toISOString(),
  };
}

export function listTasks(): HostTask[] {
  let files: string[];
  try {
    files = fs.readdirSync(hostsCacheDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const tasks: HostTask[] = [];
  for (const f of files) {
    const task = loadTask(f.replace(/\.json$/, ''));
    if (task) tasks.push(task);
  }
  return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function findTaskBySessionId(sessionId: string): HostTask | null {
  if (!sessionId) return null;
  for (const task of listTasks()) {
    if (task.sessionId === sessionId) return task;
  }
  return null;
}

export function findTaskByName(name: string): HostTask | null {
  if (!name) return null;
  const wanted = name.toLowerCase();
  for (const task of listTasks()) {
    if (task.name && task.name.toLowerCase() === wanted) return task;
  }
  return null;
}

export function resolveTaskRef(ref: string): HostTask | null {
  return loadTask(ref) ?? findTaskByName(ref) ?? findTaskBySessionId(ref);
}
