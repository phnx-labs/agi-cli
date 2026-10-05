/** Atomic, serialized install of a macOS `.app` bundle to a stable user path, used by the menu-bar
 * helper on the hot path of ordinary invocations. The old `rm -rf` + `cp -R` let a concurrent
 * reader see a half-written bundle ("is damaged"). Now staged, renamed into place, and locked. */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

import { withFileLock, ensureLockTarget } from './fs-atomic.js';

// A helper `cp -R` under load can take a few seconds; the lock must outlast it so
// a peer never treats a live installer as crashed and interleaves a second swap.
// (fs-atomic's 5s default is tuned for sub-second read-modify-writes.)
const INSTALL_LOCK_STALE_MS = 60_000;
const INSTALL_LOCK_ACQUIRE_TIMEOUT_MS = 60_000;

/** Copy an `.app` bundle to `dest` atomically: stage in a sibling dir and swap with renames, so
 * `dest` is absent only for one rename and a failed copy leaves the existing bundle intact.
 * Serialize callers with withInstallLock. */
export function copyAppBundle(
  src: string,
  dest: string,
  io: { renameSync?: (from: string, to: string) => void } = {},
): void {
  const rename = io.renameSync ?? fs.renameSync;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const staging = `${dest}.installing.${process.pid}`;
  const backup = `${dest}.replaced.${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(backup, { recursive: true, force: true });
  // `cp -R` preserves the bundle's signature, symlinks, and resource forks;
  // `fs.cpSync({recursive:true})` has historically mishandled xattrs on `.app`
  // bundles, breaking codesign.
  const r = spawnSync('cp', ['-R', src, staging], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' });
  if (r.status !== 0) {
    fs.rmSync(staging, { recursive: true, force: true });
    const msg = (r.stderr || r.stdout || '').toString().trim();
    throw new Error(`Failed to copy ${src} -> ${staging}: ${msg || 'unknown error'}`);
  }
  // rename(2) cannot replace a non-empty directory, so move the current bundle
  // aside, then move staging into place. If the second rename fails, restore the
  // backup so `dest` is never left missing.
  try {
    if (fs.existsSync(dest)) rename(dest, backup);
    rename(staging, dest);
  } catch (err) {
    if (!fs.existsSync(dest) && fs.existsSync(backup)) {
      try {
        rename(backup, dest);
      } catch {
        /* best-effort restore */
      }
    }
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(`Failed to install ${src} -> ${dest}: ${(err as Error).message}`);
  }
  fs.rmSync(backup, { recursive: true, force: true });
}

/** Serialize installs across concurrent `agents` invocations so a burst copies once. Locks a
 * sentinel file beside the bundle (which may not exist on first install) via withFileLock. */
export function withInstallLock(dest: string, fn: (heartbeat: () => void) => void): void {
  const lockTarget = `${dest}.install-lock`;
  ensureLockTarget(lockTarget);
  // Pass proper-lockfile's `heartbeat` through: the install body is synchronous blocking
  // `spawnSync`s (`cp -R`, codesign, spctl), so the event loop never turns and its async mtime
  // refresh can't fire. Callers call heartbeat() between steps so the lock isn't broken as stale.
  withFileLock(lockTarget, (heartbeat) => fn(heartbeat), {
    staleMs: INSTALL_LOCK_STALE_MS,
    acquireTimeoutMs: INSTALL_LOCK_ACQUIRE_TIMEOUT_MS,
  });
}
