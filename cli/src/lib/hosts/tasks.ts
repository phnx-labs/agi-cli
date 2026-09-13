/**
 * Local record of dispatched host tasks.
 *
 * Each dispatch writes a `<id>.json` sidecar next to its `<id>.log` (and the
 * remote's `<id>.exit`) under ~/.agents/.cache/hosts/, so `agents devices ps` / `agents logs`
 * can list runs and follow output across CLI invocations. (Folding these into
 * the cloud SQLite store so `agents cloud ps` sees them is a fast-follow — it
 * needs care around the cloud status-refresh path.)
 */

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
  /**
   * The durable `agents run --name <slug>` handle for this dispatch, if given.
   * Chosen at launch and agent-agnostic (unlike sessionId), so `agents devices
   * ps` / `agents logs <name>` and the dispatch tip can reference the run by a stable name
   * even for agents that never expose a session id up front. Absent when the
   * run was launched without `--name`.
   */
  name?: string;
  /**
   * The remote run's agent session id, so `agents sessions`/resume-by-id can map
   * a discovered session back to the host it lives on. Two sources: for Claude
   * (the only agent that accepts `--session-id`) it's the id we FORCED at
   * dispatch; for every other agent it's the id the remote COINED, captured from
   * the run's stdout sentinel (`--emit-session-id`, see session-marker.ts) once
   * the follow returns and stamped on the record via `captureRemoteSessionId`.
   * Absent only until that capture lands — e.g. an unfollowed (`--no-follow`)
   * non-Claude run whose id the reconcile path fills in later.
   */
  sessionId?: string;
  /** Remote paths (under the host's ~/.agents/.cache/hosts/). */
  remoteLog: string;
  remoteExit: string;
  /**
   * Staging root for this run's `--attach` files on the host, a sibling of
   * `remoteLog` (`<id>.attachments/`). Recorded so teardown removes the bytes
   * along with the log and exit marker instead of leaving them for the age
   * prune. Absent when the run carried no attachments (PHNX-3999).
   */
  remoteAttachDir?: string;
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

/**
 * The record patch for a run that has finished with `code`. The single authority
 * for the exit-code → status mapping, so the dispatch, reconcile, and log-follow
 * paths can never disagree. A genuine remote exit code is never -1 (that sentinel
 * means "follow window closed while the run continues"), so callers must resolve
 * -1 as still-running and never pass it here.
 */
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

/**
 * Find the host task that launched a given agent session id, so a resume-by-id
 * can re-dispatch to the host the session actually lives on. Newest task wins
 * (listTasks is createdAt-desc) — a session id should be unique, but a re-run
 * with the same forced id resolves to the most recent dispatch.
 */
export function findTaskBySessionId(sessionId: string): HostTask | null {
  if (!sessionId) return null;
  for (const task of listTasks()) {
    if (task.sessionId === sessionId) return task;
  }
  return null;
}

/**
 * Find the newest host task launched with `--name <name>`, so `agents logs
 * <name>` / `agents devices ps` and resolve-by-handle can address a run by its durable name.
 * Case-insensitive; newest wins (listTasks is createdAt-desc) when a name was
 * reused across dispatches.
 */
export function findTaskByName(name: string): HostTask | null {
  if (!name) return null;
  const wanted = name.toLowerCase();
  for (const task of listTasks()) {
    if (task.name && task.name.toLowerCase() === wanted) return task;
  }
  return null;
}

/**
 * Resolve a host-task reference the way `agents devices ps`, `agents logs`, and `agents devices stop` do: a raw
 * dispatch id first, then a `--name` handle, then the remote agent/session id.
 * Shared so any other caller resolving "does this ref name a detached --device
 * dispatch?" (e.g. `agents message`) uses the identical three-way lookup.
 */
export function resolveTaskRef(ref: string): HostTask | null {
  return loadTask(ref) ?? findTaskByName(ref) ?? findTaskBySessionId(ref);
}
