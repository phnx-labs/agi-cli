
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const WORKTREE_SEGMENT = '/.agents/worktrees/';

export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

// All project bucketing uses this worktree-aware fold; linked worktrees group under the primary repository.
export function projectKeyFromCwd(cwd?: string | null): string | undefined {
  if (!cwd) return undefined;
  const norm = cwd.replace(/\\/g, '/').replace(/\/+$/, '').trim();
  if (!norm) return undefined;
  const wtIdx = norm.indexOf(WORKTREE_SEGMENT);
  if (wtIdx > 0) {
    const repoPath = norm.slice(0, wtIdx);
    const base = repoPath.slice(repoPath.lastIndexOf('/') + 1);
    if (base) return base;
  }
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  return base || undefined;
}

// Never climb above HOME or treat HOME's dotfiles repository as the project root.
export function repoRootForCwd(dir: string, home: string = os.homedir()): string | undefined {
  const stop = path.resolve(home);
  let current = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current === stop ? undefined : current;
    if (current === stop) return undefined;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

// A worktree maps to the primary repository's .agents, which owns all its worktrees.
export function repoAgentsDirForCwd(cwd?: string | null, home?: string): string | undefined {
  if (!cwd) return undefined;
  const norm = cwd.replace(/\\/g, '/').replace(/\/+$/, '').trim();
  if (!norm) return undefined;
  const wtIdx = norm.indexOf(WORKTREE_SEGMENT);
  const repoRoot = wtIdx > 0 ? norm.slice(0, wtIdx) : repoRootForCwd(norm, home);
  return repoRoot ? path.join(repoRoot, '.agents') : undefined;
}

export function resolveProjectKey(cwd?: string | null, home?: string): string | undefined {
  if (!cwd) return undefined;
  const root = repoRootForCwd(cwd, home);
  return projectKeyFromCwd(root ?? cwd);
}
