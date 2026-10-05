import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import * as os from 'os';
import { sleepSync } from '../fs-atomic.js';

export function killTree(pid: number): void {

  if (!pid || pid <= 0) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    } catch {  }
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {  }
  }
}

export function backgroundSpawnOptions(
  opts: { cwd?: string; fdStdio?: boolean; platform?: NodeJS.Platform } = {},
): { cwd: string; detached: boolean; windowsHide: boolean } {
  const platform = opts.platform ?? process.platform;
  const cwd = opts.cwd ?? os.homedir();
  if (platform === 'win32') {

    return opts.fdStdio
      ? { cwd, detached: true, windowsHide: true }
      : { cwd, detached: false, windowsHide: true };
  }
  return { cwd, detached: true, windowsHide: false };
}

const EXIT_POLL_MS = 50;

export function hasExited(pid: number): boolean {
  if (!isAlive(pid)) return true;
  if (process.platform === 'win32') return false;
  try {
    const state = execFileSync('ps', ['-o', 'state=', '-p', String(pid)], { encoding: 'utf-8' }).trim();
    return state.startsWith('Z');
  } catch (err: any) {
    if (err?.code === 'ENOENT' && err?.syscall === 'spawnSync ps') return false;
    const out = String(err?.stdout ?? '').trim();
    const errOut = String(err?.stderr ?? '').trim();
    if (err?.status === 1 && out === '' && errOut === '') return true;
    return false;
  }
}

export function waitForExit(pid: number, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (hasExited(pid)) return true;
    if (Date.now() >= deadline) return false;
    sleepSync(EXIT_POLL_MS);
  }
}

export function isAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const startTimeByPid = new Map<number, string | null>();

export function captureProcessStartTime(pid: number, opts: { fresh?: boolean } = {}): string | null {

  if (!Number.isInteger(pid) || pid <= 0) return null;
  const cached = startTimeByPid.get(pid);
  if (!opts.fresh && cached !== undefined) return cached;
  const value = readProcessStartTime(pid);
  startTimeByPid.set(pid, value);
  return value;
}

function readProcessStartTime(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToFileTimeUtc()`,
        ],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5000 },
      );
      const trimmed = out.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const lastParen = stat.lastIndexOf(')');
      if (lastParen < 0) return null;
      const fields = stat.slice(lastParen + 2).split(' ');
      return fields[19] || null;
    }
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
