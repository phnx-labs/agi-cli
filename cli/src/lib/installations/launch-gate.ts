/**
 * The launch side of the launch/update mutual exclusion (PHNX-3940).
 *
 * `updateInstallation` (`update.ts`) holds an exclusive lock on
 * `installationLockTarget(agent, label)` for its ENTIRE stage->verify->
 * commit->record transaction. This module makes every launch of that same
 * installation take the SAME lock, briefly, before the real binary starts
 * running:
 *
 *   1. Acquire the lock. If an automatic update of this exact installation is
 *      currently in flight, this BLOCKS here until it finishes (commits or
 *      rolls back) — the launch cannot proceed past this point while a swap
 *      could be underway. This is deliberately not a short, fail-open wait: a
 *      short timeout that gave up and launched anyway would reintroduce
 *      exactly the race this exists to close, on the one case where waiting
 *      actually matters (genuine contention).
 *   2. While still holding the lock, record a launch lease for the caller's
 *      pid (`shims.ts`'s `recordLaunchLease`) — so if an update instead starts
 *      AFTER this launch already has the lock, it will see the lease as soon
 *      as it acquires the lock itself and defer (`active-check.ts`).
 *   3. Release the lock. The actual exec/spawn happens immediately after,
 *      outside the lock — for an exec-replacing native shim (see
 *      `shims.ts`'s `generateShimScript`/`generateVersionedAliasScript`) that
 *      gap is a single shell statement; for a Node-spawned launch it is the
 *      `spawn()` call itself, whose pid is already the one just leased.
 *
 * Called from three places, so no launch surface is exempt: the native POSIX
 * shim and versioned-alias scripts invoke the hidden `agents __launch-lease`
 * verb (see `index.ts`) right before their final `exec` and FAIL CLOSED (a
 * non-zero exit refuses the launch) rather than falling through on error —
 * silently proceeding would mean "the lock was unavailable" and "no update is
 * running" become indistinguishable to the one check that exists to tell them
 * apart; `execShimPassthrough` and the main `agents run` spawn path
 * (`exec.ts`) call {@link withLaunchGate} directly, in-process, wrapping the
 * `spawn()` call itself.
 */

import { withFileLockAsync } from '../fs-atomic.js';
import * as fs from 'node:fs';
import { ensureInstallationLocked, installationDir } from './store.js';
import { recordLaunchLease } from './shims.js';
import type { AgentId } from '../types.js';
import { AGENTS } from '../agents.js';
import { VERSION_RE } from '../agent-spec/primitives.js';
import { installationLockTarget, INSTALLATION_LOCK_OPTIONS } from './installation-lock.js';

/**
 * Matches `update.ts`'s `UPDATE_LOCK_STALE_MS` — the same lock, so a stale
 * threshold that doesn't match would let one side break a lock the other
 * legitimately still holds mid-transaction.
 */
/**
 * How long a launch will wait for an in-flight update of the SAME
 * installation to finish. Bounded by the real worst case an update should
 * ever take (a 120s npm install plus two launch probes), not a hot-path
 * budget — see the module docblock for why this must not be a short,
 * fail-open timeout.
 */
const LAUNCH_GATE_ACQUIRE_TIMEOUT_MS = 3 * 60_000;

/**
 * Acquire the per-installation update lock, run `fn` while holding it, then
 * release. Use this to wrap the SPAWN itself (not just the lease write) so an
 * in-flight update cannot be mid-commit while the new process is starting —
 * see the module docblock. `fn` should be fast (a spawn call plus a lease
 * write): this lock is held by every launch of this installation, so slow
 * work here serializes launches against each other unnecessarily.
 */
export async function withLaunchGate<T>(agent: AgentId, label: string, fn: () => T): Promise<T> {
  if (!Object.hasOwn(AGENTS, agent) || !VERSION_RE.test(label)) throw new Error('Invalid managed installation.');
  if (!fs.existsSync(installationDir(agent, label))) throw new Error(`No installation directory for ${agent}@${label}.`);
  // Guarantees `installation.json` exists and is VALID before locking on it —
  // migrating a legacy pre-frozen version dir when needed, exactly like every
  // other reader (`listInstallations`). Seeding an EMPTY file as a bare lock
  // target (the earlier version of this code) would make a subsequent
  // `readInstallation` see "corrupted, not valid JSON" instead of running that
  // migration, permanently wedging a legacy installation the first time
  // anything launched it.
  const recordPath = installationLockTarget(agent, label);
  return withFileLockAsync(recordPath, () => {
    ensureInstallationLocked(agent, label);
    return fn();
  }, {
    ...INSTALLATION_LOCK_OPTIONS,
    acquireTimeoutMs: LAUNCH_GATE_ACQUIRE_TIMEOUT_MS,
  });
}

/**
 * Acquire the per-installation update lock, register a launch lease for
 * `pid`, then release. For a caller that already has its own pid before the
 * risky operation (the native shim's `$$`, exec-replaced so the pid is
 * final) — a Node caller that spawns a child should use {@link withLaunchGate}
 * around the spawn itself instead, since here the process already exists by
 * the time the lock is acquired.
 */
async function acquireLaunchGate(agent: AgentId, label: string, pid: number): Promise<() => void> {
  return withLaunchGate(agent, label, () => recordLaunchLease(agent, label, pid));
}

/** Keep a live launcher's lease until its operation ends, without holding the lock. */
export async function withInstallationLease<T>(agent: AgentId, label: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireLaunchGate(agent, label, process.pid);
  try { return await fn(); } finally { release(); }
}

/**
 * Entry point for the hidden `agents __launch-lease <agent> <label> <pid>`
 * verb the generated native shims call right before their final `exec`. A
 * non-zero return makes the calling shim `exit 1` instead of proceeding to
 * exec (see `shims.ts`) — the shim's other pre-launch step (`agents sync
 * --launch`) is best-effort and swallows failure, but this one exists
 * specifically to prevent a launch from racing an in-progress update, so a
 * failure here (most commonly: the lock is genuinely held past
 * `LAUNCH_GATE_ACQUIRE_TIMEOUT_MS`) must refuse the launch, not silently
 * allow it. The printed message is what the operator sees.
 */
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
