
import { spawn, type ChildProcess } from 'child_process';
import * as os from 'os';
import { resolveInstalledMenubarExecutable } from './install-menubar.js';

const NOTIFY_TIMEOUT_MS = 4000;

export interface DesktopNotification {
  title: string;
  body: string;
  subtitle?: string;
  action?: string;
  agent?: string;
  category?: 'permission' | 'question' | 'plan_review' | 'done' | 'failure';
  key?: string;
  sessionId?: string;
  choices?: { id: string; label: string }[];
  /** urgent/high post as time-sensitive, normal/low as active. See docs/menubar.md §Attention banners for the helper floor. */
  level?: 'urgent' | 'high' | 'normal' | 'low';
  sound?: boolean;
  /** n >= 1 marks the nth reminder of the same ask. */
  reminder?: number;
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
  if (n.level) args.push('--level', n.level);
  if (n.sound) args.push('--sound');
  if (n.reminder !== undefined && n.reminder >= 1) args.push('--reminder', String(n.reminder));
  return args;
}

/**
 * Rides on `--notify` on purpose: an AGI Menu that predates withdraw requires
 * --title/--body and exits 2, instead of launching a second menu-bar instance.
 */
export function buildMenubarWithdrawArgs(keys: readonly string[]): string[] {
  const args = ['--notify'];
  for (const key of keys) args.push('--withdraw', key);
  return args;
}

export function buildOsascriptNotifyArgs(n: DesktopNotification): string[] {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  let script = `display notification "${esc(n.body)}" with title "${esc(n.title)}"`;
  if (n.subtitle) script += ` subtitle "${esc(n.subtitle)}"`;
  return ['-e', script];
}

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
  child.on('error', () => clearTimeout(watchdog));
  child.on('exit', () => clearTimeout(watchdog));
  child.unref();
  return child;
}

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

/** Removes delivered AGI Menu banners by key. osascript and notify-send banners cannot be recalled, so it is a no-op there. */
export function withdrawDesktop(keys: readonly string[]): void {
  if (keys.length === 0 || os.platform() !== 'darwin') return;
  try {
    const exec = resolveInstalledMenubarExecutable();
    if (exec) spawnDetachedQuiet(exec, buildMenubarWithdrawArgs(keys));
  } catch {
  }
}
