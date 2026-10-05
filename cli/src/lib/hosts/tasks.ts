/** Local record of dispatched host tasks: each dispatch writes a `<id>.json` sidecar beside its
 * `.log` and the remote `.exit` under ~/.agents/.cache/hosts/, so `agents devices ps` / `agents
 * logs` work across invocations. Folding into the cloud SQLite store is a fast-follow. */

import * as fs from 'fs';
import * as path from 'path';
import { getCacheDir } from '../state.js';

export type HostTaskStatus = 'running' | 'completed' | 'failed' | 'unknown';

export interface HostTask {
  id: string;
  host: string;
  target: string;
  /** OpenSSH private-key path retained for follow/reconcile/stop calls. */
  identityFile?: string;
  remoteShell?: 'posix' | 'powershell';
  agent: string;
  prompt: string;
  pid?: number;
  /** The durable `agents run --name <slug>` handle, chosen at launch and agent-agnostic, so
   * `devices ps`, `agents logs <name>` and the dispatch tip can name the run even when no
   * session id is exposed up front. Absent when launched without `--name`. */
  name?: string;
  /** The remote run's session id, so resume-by-id can map a session to its host: the forced id
   * for Claude, else the id the remote coined (captured from the `--emit-session-id` sentinel,
   * session-marker.ts). Absent until captured, e.g. an unfollowed non-Claude run. */
  sessionId?: string;
  /** Remote paths (under the host's ~/.agents/.cache/hosts/). */
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

/** Local path we mirror a task's remote log into while following. */
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

/** The record patch for a run that finished with `code`: the single exit-code to status mapping,
 * so dispatch, reconcile and log-follow agree. A real exit code is never -1 (that means follow
 * window closed, run continues), so callers must not pass it. */
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

/** Find the host task that launched a session id so resume-by-id re-dispatches to the host it
 * lives on; newest wins (listTasks is createdAt-desc) if an id was reused. */
export function findTaskBySessionId(sessionId: string): HostTask | null {
  if (!sessionId) return null;
  for (const task of listTasks()) {
    if (task.sessionId === sessionId) return task;
  }
  return null;
}

/** Find the newest host task launched with `--name <name>` so `agents logs <name>`, `devices ps`
 * and handle resolution can address it; case-insensitive, newest wins on reuse. */
export function findTaskByName(name: string): HostTask | null {
  if (!name) return null;
  const wanted = name.toLowerCase();
  for (const task of listTasks()) {
    if (task.name && task.name.toLowerCase() === wanted) return task;
  }
  return null;
}

/** Resolve a host-task reference as `agents devices ps`, `agents logs` and `devices stop` do:
 * dispatch id, then `--name` handle, then remote agent/session id. Shared so other callers
 * (e.g. `agents message`) use the same lookup. */
export function resolveTaskRef(ref: string): HostTask | null {
  return loadTask(ref) ?? findTaskByName(ref) ?? findTaskBySessionId(ref);
}
