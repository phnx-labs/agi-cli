/** Branded desktop notifications for daemon events (RUSH-2030). On macOS it runs `"AGI Menu"
 * --notify` from the installed helper; without it, `osascript` so notices aren't lost; Linux
 * `notify-send`. Detached; every spawn needs an 'error' listener or ENOENT crashes the daemon. */

import { spawn, type ChildProcess } from 'child_process';
import * as os from 'os';
import { resolveInstalledMenubarExecutable } from './install-menubar.js';

/** Hard ceiling on a one-shot notifier's lifetime. It normally exits in under a second; a stalled
 * GUI helper could hang and pile up. Set above the Swift one-shot's own 0.6s flush + 3s watchdog,
 * so Node's kill is only the last resort. */
const NOTIFY_TIMEOUT_MS = 4000;

export interface DesktopNotification {
  title: string;
  body: string;
  subtitle?: string;
  /** Deep-link run when the notification is clicked, `<verb>:<arg>`: `open:/abs/path` opens a file,
   * `routines:list` opens the runs folder in Finder. macOS-only, best-effort. See
   * routine-notify.ts. */
  action?: string;
  /** Harness the notification is ABOUT (an `AgentId`); the companion renders it as the right-hand
   * avatar (AgentAvatar.swift). Omit when no single harness owns the event. macOS-only. */
  agent?: string;
  /** What the banner asks of the operator, so the companion picks its notification category and
   * buttons: `permission`, `question`, `plan_review`, `done`/`failure`. macOS-only. See {@link
   * choices}. */
  category?: 'permission' | 'question' | 'plan_review' | 'done' | 'failure';
  /** The attention key (`AttentionItem.key`) the companion passes to `agents feed answer <key>`
   * when a choice is picked; the stable handle for the reply rail, carried verbatim in argv. */
  key?: string;
  sessionId?: string;
  /** Ordered answerable choices (max 6). `id` is `[a-z0-9-]+` and is echoed to `agents feed answer
   * --choice <id>`; `label` is the button caption. Carried as one `--choice <id>=<label>` per
   * entry. */
  choices?: { id: string; label: string }[];
}

export function buildMenubarNotifyArgs(n: DesktopNotification): string[] {
  const args = ['--notify', '--title', n.title, '--body', n.body];
  if (n.subtitle) args.push('--subtitle', n.subtitle);
  if (n.action) args.push('--action', n.action);
  if (n.agent) args.push('--agent', n.agent);
  if (n.category) args.push('--category', n.category);
  if (n.key) args.push('--key', n.key);
  if (n.sessionId) args.push('--session', n.sessionId);
  for (const c of n.choices ?? []) args.push('--choice', `${c.id}=${c.label}`);
  return args;
}

export function buildOsascriptNotifyArgs(n: DesktopNotification): string[] {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  let script = `display notification "${esc(n.body)}" with title "${esc(n.title)}"`;
  if (n.subtitle) script += ` subtitle "${esc(n.subtitle)}"`;
  return ['-e', script];
}

/** Spawns one detached best-effort notifier with a bounded lifetime: unref'd so it never blocks the
 * daemon, but a watchdog SIGKILLs it after `timeoutMs` so a stalled one can't linger. The watchdog
 * is cleared on the child's own 'exit'. `timeoutMs` is injectable for tests; returns the child. */
export function spawnDetachedQuiet(
  command: string,
  args: string[],
  timeoutMs: number = NOTIFY_TIMEOUT_MS,
): ChildProcess {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  const watchdog = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
    }
  }, timeoutMs);
  watchdog.unref();
  // A missing binary (headless box, vanished helper) arrives as an async 'error' event and the
  // process never started, so cancel the watchdog. Without a listener Node re-throws ENOENT and
  // crashes the daemon.
  child.on('error', () => clearTimeout(watchdog));
  child.on('exit', () => clearTimeout(watchdog));
  child.unref();
  return child;
}

/** Fires a native desktop notification, branded via the "AGI Menu" companion on macOS. Best-effort:
 * any failure is swallowed so it never blocks or crashes the daemon. */
export function notifyDesktop(n: DesktopNotification): void {
  const platform = os.platform();
  try {
    if (platform === 'darwin') {
      const exec = resolveInstalledMenubarExecutable();
      if (exec) {
        spawnDetachedQuiet(exec, buildMenubarNotifyArgs(n));
        return;
      }
      spawnDetachedQuiet('osascript', buildOsascriptNotifyArgs(n));
      return;
    }
    if (platform === 'linux') {
      spawnDetachedQuiet('notify-send', [n.title, n.body]);
    }
  } catch {
  }
}
