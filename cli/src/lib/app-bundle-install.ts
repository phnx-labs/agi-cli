import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

import { withFileLock, ensureLockTarget } from './fs-atomic.js';

const INSTALL_LOCK_STALE_MS = 60_000;
const INSTALL_LOCK_ACQUIRE_TIMEOUT_MS = 60_000;

export function copyAppBundle(
  src: string,
  dest: string,
  io: { renameSync?: (from: string, to: string) => void } = {},
): void {
  // Stage beside the destination, preserve signature/xattrs with cp -R, then
  // rename with rollback so readers never observe a partial signed bundle.
  const rename = io.renameSync ?? fs.renameSync;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const staging = `${dest}.installing.${process.pid}`;
  const backup = `${dest}.replaced.${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(backup, { recursive: true, force: true });
  const r = spawnSync('cp', ['-R', src, staging], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' });
  if (r.status !== 0) {
    fs.rmSync(staging, { recursive: true, force: true });
    const msg = (r.stderr || r.stdout || '').toString().trim();
    throw new Error(`Failed to copy ${src} -> ${staging}: ${msg || 'unknown error'}`);
  }
  try {
    if (fs.existsSync(dest)) rename(dest, backup);
    rename(staging, dest);
  } catch (err) {
    if (!fs.existsSync(dest) && fs.existsSync(backup)) {
      try {
        rename(backup, dest);
      } catch {
      }
    }
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(`Failed to install ${src} -> ${dest}: ${(err as Error).message}`);
  }
  fs.rmSync(backup, { recursive: true, force: true });
}

export function withInstallLock(dest: string, fn: (heartbeat: () => void) => void): void {
  // Callers must invoke the heartbeat between long synchronous copy/codesign stages.
  const lockTarget = `${dest}.install-lock`;
  ensureLockTarget(lockTarget);
  withFileLock(lockTarget, (heartbeat) => fn(heartbeat), {
    staleMs: INSTALL_LOCK_STALE_MS,
    acquireTimeoutMs: INSTALL_LOCK_ACQUIRE_TIMEOUT_MS,
  });
}
