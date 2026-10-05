import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { safeJoin } from '../paths.js';
import { getMainRepoRoot } from '../git.js';

const execFileAsync = promisify(execFile);

const WORKTREE_NAME_RE = /^[A-Za-z0-9_-]+$/;

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

export async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: worktreePath });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export async function localDefaultBranch(gitRoot: string): Promise<string> {
  try {
    await execFileAsync('git', ['remote', 'set-head', 'origin', '--auto'], { cwd: gitRoot });
  } catch {
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
  }
  return 'main';
}

export async function commitsBehindDefault(
  repoDir: string,
): Promise<{ behind: number; base: string } | null> {
  const gitRoot = await getGitRoot(repoDir).catch(() => null);
  if (!gitRoot) return null;
  try {
    await execFileAsync('git', ['fetch', 'origin'], { cwd: gitRoot });
  } catch {
    return null;
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
    return null;
  }
}

export async function createWorktree(repoDir: string, worktreeName: string): Promise<string> {
  // Place under the main checkout and fetch before branching from origin/default.
  if (!WORKTREE_NAME_RE.test(worktreeName)) {
    throw new Error(`Invalid worktree name: ${worktreeName}`);
  }
  const gitRoot = await getMainRepoRoot(repoDir);
  const worktreePath = safeJoin(path.join(gitRoot, '.agents', 'worktrees'), worktreeName);
  const branchName = `agents/${worktreeName}`;
  const base = await localDefaultBranch(gitRoot);

  await fs.mkdir(path.dirname(worktreePath), { recursive: true });

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
    }
  }
}

export function getWorktreePath(gitRoot: string, worktreeName: string): string {
  if (!WORKTREE_NAME_RE.test(worktreeName)) {
    throw new Error(`Invalid worktree name: ${worktreeName}`);
  }
  return safeJoin(path.join(gitRoot, '.agents', 'worktrees'), worktreeName);
}

export function getWorktreeBranch(worktreeName: string): string {
  return `agents/${worktreeName}`;
}

export async function worktreeCheckoutExists(repoDir: string, worktreeName: string): Promise<boolean> {
  // Checkout presence and dangling branch presence are distinct ownership signals.
  if (!WORKTREE_NAME_RE.test(worktreeName)) {
    throw new Error(`Invalid worktree name: ${worktreeName}`);
  }
  const gitRoot = await getMainRepoRoot(repoDir);
  const dir = safeJoin(path.join(gitRoot, '.agents', 'worktrees'), worktreeName);
  return fs.stat(dir).then(() => true).catch(() => false);
}

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
    return false;
  }
}
