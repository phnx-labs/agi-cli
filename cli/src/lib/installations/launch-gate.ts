/** The launch side of the launch/update mutual exclusion (PHNX-3940): every launch briefly takes
 * the installation lock `updateInstallation` holds (blocking during an update, never fail-open),
 * records a launch lease for its pid, then releases before exec. Shim callers fail closed. */

import { withFileLockAsync } from '../fs-atomic.js';
import * as fs from 'node:fs';
import { ensureInstallationLocked, installationDir } from './store.js';
import { recordLaunchLease } from './shims.js';
import type { AgentId } from '../types.js';
import { AGENTS } from '../agents.js';
import { VERSION_RE } from '../agent-spec/primitives.js';
import { installationLockTarget, INSTALLATION_LOCK_OPTIONS } from './installation-lock.js';

/** Matches `update.ts`'s `UPDATE_LOCK_STALE_MS`: it is the same lock, and a mismatched stale
 * threshold would let one side break a lock the other still holds mid-transaction. */
/** How long a launch waits for an in-flight update of the same installation: bounded by an
 * update's real worst case (a 120s npm install plus two launch probes), not a hot-path budget;
 * it must not be a short fail-open timeout (see the module docblock). */
const LAUNCH_GATE_ACQUIRE_TIMEOUT_MS = 3 * 60_000;

/** Acquire the per-installation update lock, run `fn` while holding it, then release. Wrap the
 * spawn itself so an update cannot be mid-commit while the new process starts. `fn` must be
 * fast (a spawn plus a lease write), since every launch of this installation holds the lock. */
export async function withLaunchGate<T>(agent: AgentId, label: string, fn: () => T): Promise<T> {
  if (!Object.hasOwn(AGENTS, agent) || !VERSION_RE.test(label)) throw new Error('Invalid managed installation.');
  if (!fs.existsSync(installationDir(agent, label))) throw new Error(`No installation directory for ${agent}@${label}.`);
  // Guarantee `installation.json` exists and is valid before locking, migrating a legacy pre-frozen
  // dir (as launch-gate.ts does). Seeding an empty file as a bare lock target made
  // `readInstallation` see "corrupted" and wedged legacy installs on first launch.
  const recordPath = installationLockTarget(agent, label);
  return withFileLockAsync(recordPath, () => {
    ensureInstallationLocked(agent, label);
    return fn();
  }, {
    ...INSTALLATION_LOCK_OPTIONS,
    acquireTimeoutMs: LAUNCH_GATE_ACQUIRE_TIMEOUT_MS,
  });
}

/** Acquire the per-installation update lock, register a launch lease for `pid`, then release.
 * For a caller that already has its pid (the native shim's exec-replaced `$$`); a Node caller
 * that spawns a child should use withLaunchGate around the spawn. */
async function acquireLaunchGate(agent: AgentId, label: string, pid: number): Promise<() => void> {
  return withLaunchGate(agent, label, () => recordLaunchLease(agent, label, pid));
}

/** Keep a live launcher's lease until its operation ends, without holding the lock. */
export async function withInstallationLease<T>(agent: AgentId, label: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireLaunchGate(agent, label, process.pid);
  try { return await fn(); } finally { release(); }
}

/** Entry point for the hidden `agents __launch-lease <agent> <label> <pid>` verb the native
 * shims call before `exec`. Non-zero makes the shim `exit 1`: this one exists to prevent a
 * launch racing an update, so failure (e.g. lock held past the timeout) must refuse the launch. */
export async function runLaunchLeaseCli(argv: string[]): Promise<number> {
  const [agentRaw, label, pidRaw] = argv;
  const pid = Number(pidRaw);
  if (!agentRaw || !label || !Number.isInteger(pid) || pid <= 0) {
    process.stderr.write('usage: agents __launch-lease <agent> <label> <pid>\n');
    return 2;
  }
  try {
    await acquireLaunchGate(agentRaw as AgentId, label, pid);
    return 0;
  } catch (err) {
    process.stderr.write(`agents __launch-lease: ${(err as Error).message}\n`);
    return 1;
  }
}
