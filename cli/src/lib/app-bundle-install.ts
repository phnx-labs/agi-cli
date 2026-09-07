/**
 * Atomic, serialized install of a macOS `.app` bundle to a stable user path.
 *
 * Used by the menu-bar helper (`lib/menubar/install-menubar.ts`), which is
 * (re)installed on the hot path of ordinary `agents` invocations. (A second
 * helper this module used to also serve, the secrets keychain broker, moved
 * out of this repo entirely with the standalone `secrets` engine —
 * PHNX-3989 — and installs itself now.) It previously did a non-atomic
 * `rm -rf dest` + `cp -R src dest` straight onto the live bundle. That copy takes
 * long enough that a concurrent reader (Gatekeeper, or an exec of the bundle) sees
 * a half-written `.app` — a truncated Mach-O / mismatched `_CodeSignature` hash —
 * which macOS reports as **"is damaged and can't be opened."** On a busy box dozens
 * of concurrent invocations raced the same path, so the dialog fired intermittently.
 *
 * {@link copyAppBundle} stages the copy in a sibling directory and swaps it into
 * place with renames, so a reader sees either the old or the new complete bundle,
 * never a half-written one — the only moment `dest` is briefly absent is the
 * sub-millisecond gap between the two renames (vs the seconds-long `cp`), and a
 * failed copy never touches the live bundle. {@link withInstallLock} serializes concurrent
 * installers (via the shared `withFileLock`) so a burst of invocations installs
 * once instead of stampeding.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

import { withFileLock, ensureLockTarget } from './fs-atomic.js';

// A helper `cp -R` under load can take a few seconds; the lock must outlast it so
// a peer never treats a live installer as crashed and interleaves a second swap.
// (fs-atomic's 5s default is tuned for sub-second read-modify-writes.)
const INSTALL_LOCK_STALE_MS = 60_000;
const INSTALL_LOCK_ACQUIRE_TIMEOUT_MS = 60_000;

/**
 * Copy an `.app` bundle to `dest` atomically. Stages into a sibling dir, then
 * swaps with renames — the window where `dest` is absent shrinks from the
 * seconds-long `cp` to a single microsecond rename, and a failed copy leaves the
 * existing bundle untouched. Serialize concurrent callers with {@link withInstallLock}
 * so the two-step swap never races another swap.
 */
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

/**
 * Serialize installs across the many concurrent `agents` invocations that pass
 * through the helper-install path, so a burst copies once instead of stampeding
 * the atomic swap. Locks a sentinel file beside the bundle (the bundle itself may
 * not exist yet on first install) via the shared {@link withFileLock}.
 */
export function withInstallLock(dest: string, fn: (heartbeat: () => void) => void): void {
  const lockTarget = `${dest}.install-lock`;
  ensureLockTarget(lockTarget);
  // Pass proper-lockfile's `heartbeat` straight through: the install body is a
  // fully SYNCHRONOUS chain of blocking `spawnSync`s (`cp -R`, then codesign /
  // spctl), so the event loop never turns and proper-lockfile's own async mtime
  // refresh can't fire. Callers invoke heartbeat() between those steps to keep a
  // long hold from ageing past staleMs and being broken by a contending peer.
  withFileLock(lockTarget, (heartbeat) => fn(heartbeat), {
    staleMs: INSTALL_LOCK_STALE_MS,
    acquireTimeoutMs: INSTALL_LOCK_ACQUIRE_TIMEOUT_MS,
  });
}
