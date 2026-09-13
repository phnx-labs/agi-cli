/**
 * Git worktree utilities for isolated agent execution.
 *
 * Creates/removes temporary worktrees so each teammate can work on
 * its own branch without interfering with others or the main checkout.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { safeJoin } from '../paths.js';
import { getMainRepoRoot } from '../git.js';

const execFileAsync = promisify(execFile);

const WORKTREE_NAME_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Check if `dir` is inside a git repository (**async, worktree-correct**).
 *
 * Shells out to `git rev-parse --git-dir`, so it returns true from any
 * subdirectory and for linked worktrees. Distinct from the synchronous,
 * root-only `isGitRepo` in `lib/git.ts` (a `.git`-existence check): different
 * semantics, so the two are intentionally **not** merged.
 */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

export async function getGitRoot(dir: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: dir });
  return stdout.trim();
}

/**
 * Check if a worktree directory has uncommitted changes.
 */
export async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: worktreePath });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Resolve the repo's default branch name (origin/HEAD → `main`/`master`/…).
 * Refreshes origin/HEAD first so a repo cloned before the default was set resolves.
 * Falls back to `main` when origin/HEAD isn't set.
 */
export async function localDefaultBranch(gitRoot: string): Promise<string> {
  try {
    await execFileAsync('git', ['remote', 'set-head', 'origin', '--auto'], { cwd: gitRoot });
  } catch {
    // Offline / no origin — fall through to symbolic-ref or main.
  }
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      { cwd: gitRoot },
    );
    const base = stdout.trim().replace(/^origin\//, '');
    if (base) return base;
  } catch {
    // no origin/HEAD
  }
  return 'main';
}

/**
 * How many commits the checkout at `repoDir` is behind freshly-fetched
 * `origin/<default>` — the staleness the `teams add` guard checks before pointing
 * a team at a repo.
 *
 * Fetches `origin` FIRST, on purpose: the exact failure this guards (a team
 * pointed at a repo "without fetching first" — a 71-commit-stale s1 checkout in
 * the real incident) leaves the remote-tracking ref itself stale, so a naive
 * `HEAD..origin/<default>` reads 0 and hides the drift. After the fetch the count
 * is against the true remote.
 *
 * Measures the passed checkout's OWN root ({@link getGitRoot} / `--show-toplevel`,
 * worktree-correct) — NOT {@link getMainRepoRoot}: for a `--use-worktree` shared
 * worktree (or a caller standing inside a linked worktree), the teammate runs in
 * THAT worktree, whose HEAD differs from the main checkout's, so folding to the
 * main root would report the wrong tree's staleness. `origin/<default>` resolves
 * from the shared object store regardless of which worktree we stand in. Returns
 * null when `repoDir` isn't a git repo, origin is unreachable, or git errors — the
 * caller treats null as "can't tell, don't block".
 */
export async function commitsBehindDefault(
  repoDir: string,
): Promise<{ behind: number; base: string } | null> {
  const gitRoot = await getGitRoot(repoDir).catch(() => null);
  if (!gitRoot) return null;
  try {
    await execFileAsync('git', ['fetch', 'origin'], { cwd: gitRoot });
  } catch {
    return null; // offline / no origin — can't assess staleness, don't block a team.
  }
  const base = await localDefaultBranch(gitRoot);
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-list', '--count', `HEAD..origin/${base}`],
      { cwd: gitRoot },
    );
    const behind = parseInt(stdout.trim(), 10);
    if (!Number.isFinite(behind)) return null;
    return { behind, base };
  } catch {
    return null; // no origin/<default> tracking ref, detached probe, etc.
  }
}

/**
 * Create a new git worktree for a teammate, branched off the freshly-fetched
 * default branch. Fetches `origin` first and bases the branch on
 * `origin/<default>` so a stale local checkout cannot fork teammates off old
 * code. Matches `createRemoteWorktree` — local and remote isolation share one
 * base policy.
 *
 * Resolves the placement root with {@link getMainRepoRoot}, NOT the local
 * `getGitRoot`/`--show-toplevel`, on purpose: when `repoDir` (the caller's
 * ambient cwd) is itself inside another teammate's linked worktree,
 * `--show-toplevel` returns THAT worktree's own root, so the new worktree
 * lands nested inside it (observed: `.../worktrees/A/.agents/worktrees/B`,
 * destroyed along with A's cleanup). `getMainRepoRoot` follows
 * `--git-common-dir`, which always points at the primary checkout's `.git`
 * regardless of which worktree the caller is standing in.
 *
 * @param repoDir - Directory inside the git repository (main checkout or any linked worktree)
 * @param worktreeName - Name for the worktree (used in path and branch)
 * @returns The absolute path to the created worktree
 */
export async function createWorktree(repoDir: string, worktreeName: string): Promise<string> {
  if (!WORKTREE_NAME_RE.test(worktreeName)) {
    throw new Error(`Invalid worktree name: ${worktreeName}`);
  }
  const gitRoot = await getMainRepoRoot(repoDir);
  const worktreePath = safeJoin(path.join(gitRoot, '.agents', 'worktrees'), worktreeName);
  const branchName = `agents/${worktreeName}`;
  const base = await localDefaultBranch(gitRoot);

  await fs.mkdir(path.dirname(worktreePath), { recursive: true });

  // Fetch first so origin/<default> is current. Fail loud on network errors —
  // silent fallback to HEAD is how swarms write on a days-stale base and only
  // discover it at merge time.
  try {
    await execFileAsync('git', ['fetch', 'origin'], { cwd: gitRoot });
  } catch (err: any) {
    const detail = (err?.stderr || err?.message || String(err)).toString().trim();
    throw new Error(
      `createWorktree: git fetch origin failed in ${gitRoot}` +
        (detail ? `: ${detail}` : '') +
        `. Cannot base a teammate worktree on a stale remote-tracking ref.`,
    );
  }

  await execFileAsync(
    'git',
    ['worktree', 'add', '-b', branchName, worktreePath, `origin/${base}`],
    { cwd: gitRoot },
  );

  return worktreePath;
}

/**
 * Remove a git worktree and optionally its branch.
 *
 * Resolves via {@link getMainRepoRoot}, same as {@link createWorktree} — a
 * caller standing inside a DIFFERENT linked worktree (e.g. a `teams stop`
 * run from within another teammate's checkout) must still target the main
 * repo's `.agents/worktrees/<name>`, not `--show-toplevel`'s local answer.
 *
 * @param repoDir - Directory inside the git repository (main checkout or any linked worktree)
 * @param worktreeName - Name of the worktree to remove
 * @param deleteBranch - Whether to delete the associated branch
 */
export async function removeWorktree(
  repoDir: string,
  worktreeName: string,
  deleteBranch = true
): Promise<void> {
  if (!WORKTREE_NAME_RE.test(worktreeName)) {
    throw new Error(`Invalid worktree name: ${worktreeName}`);
  }
  const gitRoot = await getMainRepoRoot(repoDir);
  const worktreePath = safeJoin(path.join(gitRoot, '.agents', 'worktrees'), worktreeName);
  const branchName = `agents/${worktreeName}`;

  try {
    await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: gitRoot });
  } catch (err: any) {
    if (err.message?.includes('is not a working tree')) {
      await execFileAsync('git', ['worktree', 'prune'], { cwd: gitRoot });
    } else {
      throw err;
    }
  }

  if (deleteBranch) {
    try {
      await execFileAsync('git', ['branch', '-D', branchName], { cwd: gitRoot });
    } catch {
      // Branch might not exist; ignore
    }
  }
}

/**
 * Get the worktree path for a given name.
 */
export function getWorktreePath(gitRoot: string, worktreeName: string): string {
  if (!WORKTREE_NAME_RE.test(worktreeName)) {
    throw new Error(`Invalid worktree name: ${worktreeName}`);
  }
  return safeJoin(path.join(gitRoot, '.agents', 'worktrees'), worktreeName);
}

/**
 * Get the branch name for a worktree.
 */
export function getWorktreeBranch(worktreeName: string): string {
  return `agents/${worktreeName}`;
}

/**
 * Does the CHECKOUT DIRECTORY for this worktree name exist?
 *
 * Narrower than {@link worktreeExists}, and the difference is load-bearing:
 * `teams add` only ever cleans up after a failed create when there is NO
 * checkout — i.e. when all that can be left is a dangling `agents/<name>`
 * branch ref. That keeps the cleanup incapable of deleting anybody's files,
 * including a concurrent add's freshly-created worktree, whatever the
 * pre-flight probe saw a `git fetch` ago. (RUSH-2356)
 */
export async function worktreeCheckoutExists(repoDir: string, worktreeName: string): Promise<boolean> {
  if (!WORKTREE_NAME_RE.test(worktreeName)) {
    throw new Error(`Invalid worktree name: ${worktreeName}`);
  }
  const gitRoot = await getMainRepoRoot(repoDir);
  const dir = safeJoin(path.join(gitRoot, '.agents', 'worktrees'), worktreeName);
  return fs.stat(dir).then(() => true).catch(() => false);
}

/**
 * Does anything already exist under this worktree name — the checkout directory
 * or its `agents/<name>` branch?
 *
 * Answered from git and the filesystem, never from teammate records: it is asked
 * by `teams add` immediately BEFORE {@link createWorktree}, so that if the create
 * fails the command can tell "the branch ref I half-created" (safe to remove)
 * from "something that was already here" (never remove — `teams stop` deliberately
 * KEEPS a worktree holding uncommitted changes, and its teammate record is
 * terminal by then, so no record-based check can protect it). (RUSH-2356)
 */
export async function worktreeExists(repoDir: string, worktreeName: string): Promise<boolean> {
  if (await worktreeCheckoutExists(repoDir, worktreeName)) return true;
  const gitRoot = await getMainRepoRoot(repoDir);
  try {
    await execFileAsync(
      'git',
      ['rev-parse', '--verify', '--quiet', `refs/heads/${getWorktreeBranch(worktreeName)}`],
      { cwd: gitRoot },
    );
    return true;
  } catch {
    return false; // `--verify` exits non-zero when the ref doesn't exist
  }
}
