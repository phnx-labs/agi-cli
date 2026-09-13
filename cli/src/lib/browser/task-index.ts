/**
 * Local task → device index.
 *
 * `tasks.json` is per-profile and lives in that profile's cache dir on the
 * machine running the browser daemon, so a later verb issued from a different
 * box cannot see where task `post` lives. The machine that STARTS a task
 * records the binding here — a small JSON file in THIS box's browser cache.
 * No fleet state, no sync: the agent that opens a task is the agent that
 * drives it.
 *
 * Kind is not stored. A missing name fails loud and lists the open tasks;
 * it never guesses, never opens a new browser, never falls back to a default
 * profile.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getBrowserRuntimeDir } from '../state.js';
import { machineId } from '../machine-id.js';

interface TaskBinding {
  device: string;
  profile?: string;
  url?: string;
  sessionId?: string;
  launchId?: string;
  createdAt: number;
}

type TaskIndex = Record<string, TaskBinding>;

export const REJECT_DEVICE_MESSAGE =
  '--device is only valid on `agents browser start`.\n' +
  'The task is bound to a device at start; later verbs resolve it from --task.\n' +
  'Next: agents browser start --task <name> --device <device>';

type TaskRoute =
  | { kind: 'proceed'; task?: string; device: string }
  | { kind: 'unknown'; task: string; message: string }
  | { kind: 'ambiguous'; message: string }
  | { kind: 'reject-device'; message: string };

/**
 * Verbs that CLOSE a browsing context. A cold (no bound task) close verb must
 * never follow the fleet hub: with no task it would target a browsing context
 * this session never opened, and on the hub could stop an unrelated task. They
 * stay local unless an explicit `--task` or a local binding routes them. The
 * driving/read verbs (navigate, screenshot, click, …) are safe to forward cold
 * because the hub creates the caller's OWN task, keyed to the identity the
 * dispatch now forwards.
 */
const TERMINAL_BROWSER_VERBS = new Set(['done', 'stop']);
export function isTerminalBrowserVerb(verb: string): boolean {
  return TERMINAL_BROWSER_VERBS.has(verb);
}

function taskIndexPath(): string {
  return path.join(getBrowserRuntimeDir(), 'task-index.json');
}

export function readTaskIndex(): TaskIndex {
  const file = taskIndexPath();
  if (!fs.existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(
      `Cannot read browser task index at ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Cannot read browser task index at ${file}: document root must be a map.`);
  }
  return parsed as TaskIndex;
}

function writeTaskIndex(index: TaskIndex): void {
  const file = taskIndexPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function getTaskBinding(name: string): TaskBinding | undefined {
  return readTaskIndex()[name];
}

export function listTaskBindings(): Array<{ name: string } & TaskBinding> {
  return Object.entries(readTaskIndex())
    .map(([name, binding]) => ({ name, ...binding }))
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function bindTask(name: string, binding: TaskBinding): void {
  if (!name) {
    throw new Error('Cannot bind a browser task with an empty name.');
  }
  if (!binding.device) {
    throw new Error(`Cannot bind browser task "${name}" without a device.`);
  }
  const index = readTaskIndex();
  index[name] = { ...binding };
  writeTaskIndex(index);
}

export function updateTaskBinding(name: string, patch: Partial<TaskBinding>): void {
  const index = readTaskIndex();
  const existing = index[name];
  if (!existing) return;
  index[name] = { ...existing, ...patch };
  writeTaskIndex(index);
}

export function unbindTask(name: string): void {
  const index = readTaskIndex();
  if (!(name in index)) return;
  delete index[name];
  writeTaskIndex(index);
}

/** Drop every binding recorded under this profile (after `stop --profile` / gc). */
export function unbindTasksForProfile(profile: string): void {
  const index = readTaskIndex();
  let changed = false;
  for (const [name, binding] of Object.entries(index)) {
    if (binding.profile === profile) {
      delete index[name];
      changed = true;
    }
  }
  if (changed) writeTaskIndex(index);
}

export function tasksForCaller(sessionId?: string, launchId?: string): Array<{ name: string } & TaskBinding> {
  return listTaskBindings().filter((entry) => {
    if (sessionId && entry.sessionId === sessionId) return true;
    if (launchId && entry.launchId === launchId) return true;
    return false;
  });
}

function formatAge(createdAt: number, now = Date.now()): string {
  const ageMs = Math.max(0, now - createdAt);
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s`;
  return `${Math.round(ageMs / 60_000)}m`;
}

export function formatOpenTaskList(
  entries: Array<{ name: string } & TaskBinding>,
  now = Date.now(),
): string {
  if (entries.length === 0) return '  (no open tasks)';
  return entries
    .map((entry) => {
      const url = entry.url && entry.url.length > 0 ? entry.url : '-';
      return `  ${entry.name}  url=${url}  device=${entry.device}  age=${formatAge(entry.createdAt, now)}`;
    })
    .join('\n');
}

export function unknownTaskMessage(name: string, entries = listTaskBindings()): string {
  return [
    `Unknown browser task "${name}".`,
    'Open tasks:',
    formatOpenTaskList(entries),
    'Next: agents browser start --task <name> [--device <device>]',
  ].join('\n');
}

export function ambiguousTasksMessage(entries: Array<{ name: string } & TaskBinding>): string {
  return [
    'Multiple browser tasks for this session — pass --task <name>:',
    formatOpenTaskList(entries),
    'Next: agents browser status',
  ].join('\n');
}

/**
 * Decide where a page verb should run.
 *
 * `--device` on a later verb is always rejected (bind it at start).
 * A named task that is not in the local index fails loud with the open-task
 * list. Two or more tasks for this caller, with no `--task`, fail the same way.
 * Zero matches with no `--task` follows the fleet browser hub when the caller
 * passed one (`opts.hub` — the box drives `browser.device` by default), so a
 * cold page verb reaches the logged-in hub browser exactly as a bare
 * `agents browser start` already does; with no hub it proceeds locally and the
 * daemon resolves from caller identity for the first implicit create. The caller
 * (the CLI's task-routing hook) supplies `opts.hub` from `defaultBrowserHub()`,
 * which is already undefined on the hub itself and on a fleet-remote re-exec, so
 * this can never forward to self or loop.
 */
export function resolveTaskRoute(opts: {
  task?: string;
  device?: string;
  sessionId?: string;
  launchId?: string;
  self?: string;
  hub?: string;
}): TaskRoute {
  if (opts.device) {
    return { kind: 'reject-device', message: REJECT_DEVICE_MESSAGE };
  }

  const self = opts.self ?? machineId();

  if (opts.task) {
    const binding = getTaskBinding(opts.task);
    if (!binding) {
      return { kind: 'unknown', task: opts.task, message: unknownTaskMessage(opts.task) };
    }
    return { kind: 'proceed', task: opts.task, device: binding.device };
  }

  const matches = tasksForCaller(opts.sessionId, opts.launchId);
  if (matches.length > 1) {
    return { kind: 'ambiguous', message: ambiguousTasksMessage(matches) };
  }
  if (matches.length === 1) {
    const only = matches[0]!;
    return { kind: 'proceed', task: only.name, device: only.device };
  }
  return { kind: 'proceed', device: opts.hub ?? self };
}

/**
 * The daemon sandboxes screenshot writes to the browser runtime dir, so `-o`
 * outside that dir is ignored there. The CLI process honors `-o` by copying
 * the captured file to the requested path. Same path → no copy.
 */
export function honorScreenshotOutput(requested: string | undefined, daemonPath: string): string {
  if (!requested) return daemonPath;
  const dest = path.resolve(requested);
  if (path.resolve(daemonPath) === dest) return dest;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(daemonPath, dest);
  return dest;
}
