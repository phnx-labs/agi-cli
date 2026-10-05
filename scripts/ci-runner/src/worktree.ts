import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { mirrorPath, worktreePath, type CiLayout } from './paths';
import type { ExecutorRequest } from './types';

function git(cwd: string, args: string[]): void {
  const proc = Bun.spawnSync({
    cmd: ['git', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) {
    throw new Error(Buffer.from(proc.stderr).toString('utf8') || `git ${args.join(' ')} failed`);
  }
}

/** Namespaced detached worktree from a per-repo mirror; two runs of the same repository never share
 * a checkout. */
export function ensureMirror(layout: CiLayout, sourceGitDir: string, owner: string, repo: string): string {
  const dest = mirrorPath(layout, owner, repo);
  mkdirSync(dirname(dest), { recursive: true });
  if (!existsSync(dest)) {
    git(process.cwd(), ['clone', '--mirror', sourceGitDir, dest]);
  } else {
    git(dest, ['remote', 'update', '--prune']);
  }
  return dest;
}

export function createRunWorktree(
  layout: CiLayout,
  req: ExecutorRequest,
  sourceGitDir: string,
): string {
  const dest = worktreePath(layout, req);
  if (existsSync(dest)) {
    throw new Error(`worktree already exists for check-run ${req.checkRunId} at ${dest}`);
  }
  const mirror = ensureMirror(layout, sourceGitDir, req.owner, req.repo);
  mkdirSync(dirname(dest), { recursive: true });
  git(mirror, ['worktree', 'add', '--detach', dest, req.candidateCommitSha]);
  return dest;
}

export function removeRunWorktree(layout: CiLayout, req: ExecutorRequest, sourceGitDir: string): void {
  const dest = worktreePath(layout, req);
  const mirror = mirrorPath(layout, req.owner, req.repo);
  if (existsSync(dest) && existsSync(mirror)) {
    git(mirror, ['worktree', 'remove', '--force', dest]);
  }
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  void sourceGitDir;
}
