/**
 * Automatic transport for the non-secret fleet state stored in the user repo.
 *
 * Usage/auth services publish only their own conflict-free
 * `devices/<device>/daemon-state.json` file. This module commits that one path,
 * rebases the user repo, and pushes it so peer daemons can read the snapshot
 * after their own fetch/rebase. Git runs asynchronously under one cross-process
 * lock; every invocation has a wall-clock deadline and a timed-out process tree
 * is terminated, including git's ssh child and its remote channel.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';

import { fleetSharedStatePath } from './fleet-shared-state.js';
import { ensureLockTarget } from './fs-atomic.js';
import { logAndContinueOnLockCompromised } from './lock-compromise.js';
import { machineId } from './session/sync/config.js';
import { getDaemonDir, getUserAgentsDir } from './state.js';

export const FLEET_SHARED_REPO_SYNC_DEADLINE_MS = 45_000;
export const FLEET_SHARED_REPO_KILL_GRACE_MS = 250;
export const FLEET_SHARED_REPO_OUTPUT_MAX_BYTES = 1024 * 1024;
const FLEET_SHARED_REPO_PUSH_ATTEMPTS = 3;
const FLEET_SHARED_REPO_REBASE_CLEANUP_RESERVE_MS = 5_000;

/**
 * The exchange records its last SUCCESSFUL completion beside its lock so a
 * sibling service (auth-sync) can gate work on the freshness of the peer state
 * this exchange delivers into the local checkout (PHNX-4051). auth-sync's
 * credential pushes read the peer verdicts the LAST usage-sync exchange wrote; if
 * that exchange has not landed within a tick interval, those verdicts are stale
 * and pushing off them would act on a peer that may already hold the key.
 */
function exchangeMarkerPath(lockPath: string): string {
  return `${lockPath}.last-success`;
}

function writeExchangeMarker(lockPath: string, nowMs: number = Date.now()): void {
  try {
    const p = exchangeMarkerPath(lockPath);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ at: nowMs }), 'utf-8');
  } catch {
    // Best-effort telemetry — never fail the exchange over its own marker.
  }
}

/**
 * When the shared-state exchange last completed successfully, in epoch ms, or
 * `null` if it never has on this box (no marker yet) or the marker is unreadable.
 * Reads the default daemon-dir marker the periodic exchange writes.
 */
export function readLastSuccessfulExchangeMs(): number | null {
  try {
    const lockPath = path.join(getDaemonDir(), 'fleet-shared-repo-sync');
    const raw = fs.readFileSync(exchangeMarkerPath(lockPath), 'utf-8');
    const at = (JSON.parse(raw) as { at?: unknown }).at;
    return typeof at === 'number' && Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

export interface BoundedProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface FleetSharedRepoSyncOptions {
  userAgentsDir?: string;
  device?: string;
  timeoutMs?: number;
  /** Test-only redirection for the untracked cross-process lock target. */
  lockPath?: string;
}

export interface FleetSharedRepoSyncResult {
  success: boolean;
  committed: boolean;
  pushed: boolean;
  commit: string | null;
  timedOut: boolean;
  skipped: string | null;
  error: string | null;
  /**
   * Untracked working-tree files that collided with origin and were dropped
   * (byte-identical to origin) before rebasing. See clearCollidingUntracked.
   */
  untrackedCleared?: number;
  /**
   * Untracked working-tree files that collided with origin, differed from it,
   * and were moved to untrackedBackupDir before rebasing.
   */
  untrackedBackedUp?: string[];
  /** Directory the differing untracked collisions were moved to, if any. */
  untrackedBackupDir?: string;
}

function signalProcessTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    // Windows has no process-group signal. taskkill is asynchronous here so a
    // timeout path cannot replace one event-loop stall with another.
    const killer = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.unref();
    return;
  }
  try {
    // The child is spawned detached on POSIX, so -pid reaches git plus ssh.
    process.kill(-pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

/** Run one real process asynchronously with a hard wall-clock/process-tree bound. */
export function runBoundedProcess(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<BoundedProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let overflow = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ code, stdout, stderr, timedOut });
    };
    const hardKill = (): void => {
      signalProcessTree(child, 'SIGKILL');
      if (process.platform === 'win32' && !killTimer) {
        // taskkill owns the descendant cleanup; this fallback only guarantees
        // the direct child's Promise settles if taskkill itself cannot run.
        killTimer = setTimeout(() => {
          if (!settled) {
            try { child.kill('SIGKILL'); } catch { /* already gone */ }
          }
        }, FLEET_SHARED_REPO_KILL_GRACE_MS);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') {
        hardKill();
        return;
      }
      signalProcessTree(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        if (!settled) hardKill();
      }, FLEET_SHARED_REPO_KILL_GRACE_MS);
    }, Math.max(1, options.timeoutMs));

    const append = (stream: 'stdout' | 'stderr', chunk: Buffer | string): void => {
      if (overflow) return;
      const value = String(chunk);
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + Buffer.byteLength(value) > FLEET_SHARED_REPO_OUTPUT_MAX_BYTES) {
        overflow = true;
        stderr += '\ngit output exceeded 1 MiB';
        hardKill();
        return;
      }
      if (stream === 'stdout') stdout += value;
      else stderr += value;
    };
    child.stdout?.on('data', (chunk) => append('stdout', chunk));
    child.stderr?.on('data', (chunk) => append('stderr', chunk));
    child.on('error', (err) => {
      stderr += err.message;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

function failure(command: string, result: BoundedProcessResult): FleetSharedRepoSyncResult {
  const detail = result.timedOut
    ? `${command} timed out`
    : result.stderr.trim() || result.stdout.trim() || `${command} exited ${result.code ?? 'without a status'}`;
  return {
    success: false,
    committed: false,
    pushed: false,
    commit: null,
    timedOut: result.timedOut,
    skipped: null,
    error: detail,
  };
}

function isPushRace(result: BoundedProcessResult): boolean {
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return text.includes('non-fast-forward') || text.includes('fetch first') || text.includes('[rejected]');
}

function createdAutostashObject(result: BoundedProcessResult): string | null {
  return `${result.stdout}\n${result.stderr}`.match(/created autostash:\s*([0-9a-f]+)/i)?.[1] ?? null;
}

function retainedAutostash(
  stashList: BoundedProcessResult,
  objectId: string | null,
): { label: string; ref: string | null } {
  if (stashList.code === 0) {
    const entries = stashList.stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [ref = '', hash = '', ...subject] = line.split('\t');
      return { ref, hash, subject: subject.join('\t') };
    });
    const matched = objectId
      ? entries.find((entry) => entry.hash.startsWith(objectId) || objectId.startsWith(entry.hash))
      : entries.find((entry) => /autostash/i.test(entry.subject));
    if (matched?.ref) return { label: `${matched.ref} (${matched.hash.slice(0, 8)})`, ref: matched.ref };
  }
  return {
    label: objectId ? `autostash object ${objectId}` : 'the retained autostash',
    ref: null,
  };
}

/**
 * `git rebase` checks out its base (origin/<branch>) and aborts when an
 * untracked working-tree file would be overwritten by a file that origin
 * tracks. `--autostash` only sets aside *tracked* changes, so these untracked
 * collisions wedge the rebase on every sync and the device silently falls
 * hundreds of commits behind — the fleet-wide drift root cause (PHNX-3923).
 *
 * In this shared-state repo an untracked file that also exists on origin is a
 * stale local snapshot: the canonical copy is on origin and every device
 * republishes its own state (this device's own owned file is already committed
 * before we get here, so it is tracked and never appears below). Drop the ones
 * byte-identical to origin (lossless) and move any that differ into a backup
 * dir beside the repo root — outside the repo's tracked tree, so the move
 * cannot create a fresh collision — so nothing is silently destroyed. Then let
 * the rebase check out origin's version. A file we cannot clear is left in
 * place; the rebase may still abort, no worse than today and never losing data.
 *
 * The scan is scoped to the TRACKED ROOTS origin carries — the top-level entries
 * of `git ls-tree --name-only origin/<branch>` — NOT the whole working tree
 * (PHNX-4051). Only a file origin tracks can be overwritten by the rebase
 * checkout, so a tracked root is the tightest superset of the collidable paths:
 * every path origin tracks stays in scope (a stale untracked `projects/rush.yaml`
 * under a tracked `projects/` root is still cleared), while an untracked-ONLY tree
 * origin never tracks — artifacts-cli's revision store
 * (`~/.agents/artifact-history/`, ~11k files / >1 MiB of paths) is the live case —
 * is never a tracked root, so it never enters the `git ls-files --others` listing.
 * An unbounded listing there blows past {@link FLEET_SHARED_REPO_OUTPUT_MAX_BYTES}
 * and kills the exchange on every tick; scoping to the tracked roots keeps the
 * PHNX-3923 coverage whole while an unrelated untracked tree cannot push the
 * listing over the cap. `ls-tree`'s own output is bounded — it lists only the root
 * entries, never the recursive tree.
 */
async function clearCollidingUntracked(
  git: (args: string[], reserveMs?: number) => Promise<BoundedProcessResult>,
  root: string,
  branch: string,
): Promise<{ cleared: number; backedUp: string[]; backupDir: string | null } | { error: BoundedProcessResult }> {
  const tree = await git(['ls-tree', '--name-only', '-z', `origin/${branch}`]);
  if (tree.code !== 0) return { error: tree };
  const trackedRoots = tree.stdout.split('\0').filter(Boolean);
  if (trackedRoots.length === 0) return { cleared: 0, backedUp: [], backupDir: null };
  const others = await git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...trackedRoots]);
  if (others.code !== 0) return { error: others };
  const relPaths = others.stdout.split('\0').filter(Boolean);
  let cleared = 0;
  const backedUp: string[] = [];
  let backupDir: string | null = null;
  for (const rel of relPaths) {
    // rev-parse doubles as the "does origin track this path" test (non-zero =
    // absent) — only paths origin tracks are overwritten by the rebase checkout.
    const originHash = await git(['rev-parse', `origin/${branch}:${rel}`]);
    if (originHash.code !== 0 || !originHash.stdout.trim()) continue;
    const abs = path.join(root, rel);
    // Byte-exact identity via git blob SHAs. Comparing UTF-8-decoded strings
    // would collapse distinct invalid bytes to U+FFFD and could delete
    // non-identical content. `--no-filters` hashes the raw on-disk bytes (no
    // clean/autocrlf normalization), so `identical` is true only when the local
    // bytes exactly equal origin's stored blob — never a filter-normalized
    // near-match. A hash-object failure (unreadable / vanished under a
    // concurrent writer) means "leave it in place".
    const localHash = await git(['hash-object', '--no-filters', '--', abs]);
    if (localHash.code !== 0 || !localHash.stdout.trim()) continue;
    const identical = originHash.stdout.trim() === localHash.stdout.trim();
    try {
      if (identical) {
        fs.rmSync(abs, { force: true });
        cleared++;
      } else {
        if (!backupDir) {
          // A sibling of the repo root: outside the tracked tree (so the move
          // cannot create a fresh collision) yet colocated for easy recovery.
          backupDir = path.join(`${root}-fleet-sync-backups`, String(Date.now()));
        }
        const dest = path.join(backupDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(abs, dest);
        backedUp.push(rel);
      }
    } catch {
      // Could not clear this collision; leave it in place.
    }
  }
  return { cleared, backedUp, backupDir };
}

async function performFleetSharedRepoSync(
  root: string,
  device: string,
  timeoutMs: number,
): Promise<FleetSharedRepoSyncResult> {
  if (!fs.existsSync(path.join(root, '.git'))) {
    return {
      success: false,
      committed: false,
      pushed: false,
      commit: null,
      timedOut: false,
      skipped: `user store is not git-backed: ${root}`,
      error: null,
    };
  }
  const deadline = Date.now() + timeoutMs;
  const git = async (args: string[], reserveMs = 0): Promise<BoundedProcessResult> => {
    const remaining = deadline - Date.now() - reserveMs;
    if (remaining <= 0) return { code: null, stdout: '', stderr: '', timedOut: true };
    return runBoundedProcess('git', args, {
      cwd: root,
      timeoutMs: remaining,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  };

  const branchResult = await git(['branch', '--show-current']);
  if (branchResult.code !== 0) return failure('git branch --show-current', branchResult);
  const branch = branchResult.stdout.trim();
  if (!branch) {
    return {
      success: false,
      committed: false,
      pushed: false,
      commit: null,
      timedOut: false,
      skipped: null,
      error: 'user store is on a detached HEAD',
    };
  }

  const ownedFile = fleetSharedStatePath(device, root);
  const relativeOwnedFile = path.relative(root, ownedFile).split(path.sep).join('/');
  // The central `agents.yaml` is fleet-shared state too — native account rows
  // land there (lib/state.ts writeMetaUnlocked) as a plain file write with no
  // commit. Publishing only the per-device file and then `rebase --autostash`-ing
  // over a dirty central file silently destroyed those names: every box lost its
  // account names on its next daemon publish (PHNX-3887). Commit it alongside the
  // device doc so the rebase carries the rows instead of stashing them.
  const centralFile = path.join(root, 'agents.yaml');
  const publishPaths = [relativeOwnedFile];
  if (fs.existsSync(centralFile)) publishPaths.push('agents.yaml');
  const existingPaths = publishPaths.filter(rel => fs.existsSync(path.join(root, rel)));
  let committed = false;
  if (existingPaths.length > 0) {
    const status = await git(['status', '--porcelain=v1', '--', ...existingPaths]);
    if (status.code !== 0) return failure('git status', status);
    if (status.stdout.trim()) {
      const add = await git(['add', '--', ...existingPaths]);
      if (add.code !== 0) return failure('git add', add);
      const commit = await git([
        '-c', 'commit.gpgsign=false',
        'commit', '--no-verify', '-m', `chore(devices): publish ${device} daemon state`,
        '--', ...existingPaths,
      ]);
      if (commit.code !== 0) return failure('git commit', commit);
      committed = true;
    }
  }

  let untrackedCleared = 0;
  const untrackedBackedUp: string[] = [];
  let untrackedBackupDir: string | undefined;
  for (let attempt = 1; attempt <= FLEET_SHARED_REPO_PUSH_ATTEMPTS; attempt++) {
    const fetch = await git(['fetch', 'origin']);
    if (fetch.code !== 0) return { ...failure('git fetch', fetch), committed };

    // Untracked files that origin tracks would abort the rebase's checkout
    // (autostash only covers tracked changes). Clear them first — this is the
    // fleet-drift root cause (PHNX-3923).
    const reconcile = await clearCollidingUntracked(git, root, branch);
    if ('error' in reconcile) {
      return { ...failure('git ls-files --others', reconcile.error), committed };
    }
    untrackedCleared += reconcile.cleared;
    untrackedBackedUp.push(...reconcile.backedUp);
    if (reconcile.backupDir) untrackedBackupDir = reconcile.backupDir;

    // Keep enough of the same wall-clock bound available to remove a botched
    // autostash pop from the operator's live checkout before returning.
    const rebase = await git(
      ['rebase', '--autostash', `origin/${branch}`],
      FLEET_SHARED_REPO_REBASE_CLEANUP_RESERVE_MS,
    );
    if (rebase.code !== 0) {
      // Rebase can leave control files behind even when the child was killed.
      // Abort is bounded by the same overall deadline and never hides the cause.
      await git(['rebase', '--abort']);
      return { ...failure('git rebase', rebase), committed };
    }

    // `git rebase --autostash` exits zero when the rebase succeeds but applying
    // the autostash conflicts. Never push or leave those conflict markers in
    // the operator's real ~/.agents checkout. Git retains the original changes
    // in the stash on this path, so reset only the failed pop to rebased HEAD.
    const unmerged = await git(['ls-files', '--unmerged']);
    if (unmerged.code !== 0) return { ...failure('git ls-files --unmerged', unmerged), committed };
    if (unmerged.stdout.trim()) {
      const autostashObject = createdAutostashObject(rebase);
      const reset = await git(['reset', '--hard', 'HEAD']);
      const cleaned = await git(['ls-files', '--unmerged']);
      const stashList = await git(['stash', 'list', '--format=%gd%x09%H%x09%gs']);
      const stash = retainedAutostash(stashList, autostashObject);
      if (reset.code !== 0 || cleaned.code !== 0 || cleaned.stdout.trim()) {
        const cleanup = reset.code !== 0
          ? failure('git reset --hard HEAD', reset).error
          : cleaned.code !== 0
            ? failure('git ls-files --unmerged', cleaned).error
            : 'unmerged index entries remain after git reset --hard HEAD';
        return {
          success: false,
          committed,
          pushed: false,
          commit: null,
          timedOut: reset.timedOut || cleaned.timedOut,
          skipped: null,
          error: `autostash pop conflicted; push refused, but cleanup failed: ${cleanup}. Original tracked changes remain safe in ${stash.label}`,
        };
      }
      return {
        success: false,
        committed,
        pushed: false,
        commit: null,
        timedOut: false,
        skipped: null,
        error: `autostash pop conflicted; push refused and the worktree was reset to rebased HEAD without conflict markers. Original tracked changes remain safe in ${stash.label}; inspect with ${stash.ref ? `git stash show -p ${stash.ref}` : 'git stash list'}`,
      };
    }

    const push = await git(['push', '--', 'origin', branch]);
    if (push.code === 0) {
      const head = await git(['rev-parse', '--short=8', 'HEAD']);
      return {
        success: true,
        committed,
        pushed: committed || push.stdout.trim().length > 0 || push.stderr.includes('->'),
        commit: head.code === 0 ? head.stdout.trim() : null,
        timedOut: false,
        skipped: null,
        error: null,
        untrackedCleared,
        untrackedBackedUp,
        untrackedBackupDir,
      };
    }
    if (attempt === FLEET_SHARED_REPO_PUSH_ATTEMPTS || !isPushRace(push)) {
      return { ...failure('git push', push), committed };
    }
  }

  throw new Error('unreachable fleet shared repo push loop');
}

/**
 * Commit/pull/push this device's shared state under one cross-process lock.
 * Callers publish their local fields first and consume peer fields only after
 * this resolves successfully.
 */
export async function syncFleetSharedStateRepo(
  options: FleetSharedRepoSyncOptions = {},
): Promise<FleetSharedRepoSyncResult> {
  const root = options.userAgentsDir ?? getUserAgentsDir();
  const device = options.device ?? machineId();
  const timeoutMs = options.timeoutMs ?? FLEET_SHARED_REPO_SYNC_DEADLINE_MS;
  const lockPath = options.lockPath ?? path.join(getDaemonDir(), 'fleet-shared-repo-sync');
  ensureLockTarget(lockPath, '');
  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(lockPath, {
      stale: Math.max(10_000, timeoutMs + 5_000),
      retries: { retries: 20, factor: 1, minTimeout: 100, maxTimeout: 100 },
      onCompromised: logAndContinueOnLockCompromised('fleet shared repo sync'),
    });
    const result = await performFleetSharedRepoSync(root, device, timeoutMs);
    // Record freshness only on a real success, beside the lock so a test-redirected
    // lockPath keeps its marker isolated too (PHNX-4051).
    if (result.success) writeExchangeMarker(lockPath);
    return result;
  } catch (err) {
    return {
      success: false,
      committed: false,
      pushed: false,
      commit: null,
      timedOut: false,
      skipped: null,
      error: (err as Error).message,
    };
  } finally {
    if (release) {
      try { await release(); } catch { /* compromised/already released */ }
    }
  }
}
