/** The one worktree-aware cwd -> project fold, shared by sessions, feed and others so keys agree. A
 * worktree cwd folds to the repo directory name; other paths use their basename. projectKeyFromCwd
 * is pure; resolveProjectKey walks the filesystem. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const WORKTREE_SEGMENT = '/.agents/worktrees/';

/** Convert an absolute cwd to Claude Code's project-folder name under `~/.claude/projects/` (slashes
 * and dots become dashes), so session discovery and native-memory sync agree on one directory. */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

/** Resolve a stable project key from a cwd, or `undefined` when the path carries nothing usable
 * (empty, `/`, whitespace). */
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

/** Git working-tree root containing `dir`, by walking up for `.git` (a file in linked worktrees).
 * Filesystem-only, no `git` process. Undefined outside a repo, for nonexistent paths, or when the
 * only repo is $HOME (a dotfiles repo would swallow everything). */
export function repoRootForCwd(dir: string, home: string = os.homedir()): string | undefined {
  const stop = path.resolve(home);
  let current = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current === stop ? undefined : current;
    // Never climb past $HOME: an ancestor of home (/tmp, /) is not part of any project, and a stray
    // /tmp/.git would swallow every loose directory under home. Mirrors the shim's own home
    // boundary (codex adapter's shimExecTail, lib/harness/adapters/codex.ts).
    if (current === stop) return undefined;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Main-repo `.agents` dir for a cwd (the PRIMARY repo's for a worktree cwd), or undefined outside
 * a repo. Used for Codex `edit` mode: its sandbox hardcodes `.agents/` read-only, and naming it an
 * explicit writable root overrides that. Filesystem-only. */
export function repoAgentsDirForCwd(cwd?: string | null, home?: string): string | undefined {
  if (!cwd) return undefined;
  const norm = cwd.replace(/\\/g, '/').replace(/\/+$/, '').trim();
  if (!norm) return undefined;
  const wtIdx = norm.indexOf(WORKTREE_SEGMENT);
  const repoRoot = wtIdx > 0 ? norm.slice(0, wtIdx) : repoRootForCwd(norm, home);
  return repoRoot ? path.join(repoRoot, '.agents') : undefined;
}

/** Project key for a cwd on THIS machine: its repository when there is one (so `<repo>/apps/cli`
 * groups under `<repo>`), else the directory. Each machine resolves its own paths;
 * projectKeyFromCwd is the pure fold. */
export function resolveProjectKey(cwd?: string | null, home?: string): string | undefined {
  if (!cwd) return undefined;
  const root = repoRootForCwd(cwd, home);
  return projectKeyFromCwd(root ?? cwd);
}
