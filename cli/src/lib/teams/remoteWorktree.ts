import { sshExec, shellQuote, assertValidSshTarget } from '../ssh-exec.js';
import { assertSafeGitTransport } from '../git.js';

interface RemoteSshOptions { extraSshArgs?: string[] }

const WORKTREE_NAME_RE = /^[A-Za-z0-9_-]+$/;

function assertName(worktreeName: string): void {
  if (!WORKTREE_NAME_RE.test(worktreeName)) {
    throw new Error(`Invalid worktree name: ${worktreeName}`);
  }
}

export function remotePathExpr(p: string): string {

  if (p === '~') return '"$HOME"';
  if (p.startsWith('~/')) return '"$HOME"/' + shellQuote(p.slice(2));
  return shellQuote(p);
}

function resolveRemoteRepoRoot(target: string, repoPath: string, opts: RemoteSshOptions = {}): string | null {
  assertValidSshTarget(target);
  const cmd = `git -C ${remotePathExpr(repoPath)} rev-parse --show-toplevel 2>/dev/null`;
  const res = sshExec(target, cmd, { timeoutMs: 15000, multiplex: true, extraSshArgs: opts.extraSshArgs });
  const root = res.stdout.trim();
  return res.code === 0 && root ? root : null;
}

function remoteGit(target: string, repoPath: string, args: string[], timeoutMs = 60000, opts: RemoteSshOptions = {}): string {
  const cmd = ['git', '-C', repoPath, ...args].map(shellQuote).join(' ');
  const res = sshExec(target, cmd, { timeoutMs, multiplex: true, extraSshArgs: opts.extraSshArgs });
  if (res.code !== 0) {
    throw new Error(`remote git failed on ${target} (${args[0]}): ${(res.stderr || res.stdout).trim() || 'ssh error'}`);
  }
  return res.stdout.trim();
}

function isRemoteGitRepo(target: string, repoPath: string, opts: RemoteSshOptions = {}): boolean {
  assertValidSshTarget(target);
  const cmd = `git -C ${remotePathExpr(repoPath)} rev-parse --git-dir 2>/dev/null`;
  const res = sshExec(target, cmd, { timeoutMs: 15000, multiplex: true, extraSshArgs: opts.extraSshArgs });
  return res.code === 0;
}

function remoteDefaultBranch(target: string, repoPath: string, opts: RemoteSshOptions = {}): string {
  assertValidSshTarget(target);
  try {
    sshExec(
      target,
      ['git', '-C', repoPath, 'remote', 'set-head', 'origin', '--auto'].map(shellQuote).join(' '),
      { timeoutMs: 20000, multiplex: true, extraSshArgs: opts.extraSshArgs },
    );
    const ref = remoteGit(target, repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], 60000, opts);
    return ref.replace(/^origin\//, '') || 'main';
  } catch {
    return 'main';
  }
}

export function createRemoteWorktree(target: string, repoPath: string, worktreeName: string, opts: RemoteSshOptions = {}): string {
  assertValidSshTarget(target);
  assertName(worktreeName);
  const gitRoot = remoteGit(target, repoPath, ['rev-parse', '--show-toplevel'], 60000, opts);
  const base = remoteDefaultBranch(target, gitRoot, opts);
  const worktreePath = `${gitRoot}/.agents/worktrees/${worktreeName}`;
  const branchName = `agents/${worktreeName}`;

  remoteGit(target, gitRoot, ['fetch', 'origin'], 120000, opts);
  remoteGit(
    target,
    gitRoot,
    ['worktree', 'add', '-b', branchName, worktreePath, `origin/${base}`],
    120000, opts,
  );
  return worktreePath;
}

export function remoteCommitsBehindDefault(
  target: string,
  repoPath: string,
  opts: RemoteSshOptions = {},
): { behind: number; base: string } | null {
  assertValidSshTarget(target);
  try {
    const base = remoteDefaultBranch(target, repoPath, opts);
    const raw = remoteGit(target, repoPath, ['rev-list', '--count', `HEAD..origin/${base}`], 30000, opts);
    const behind = parseInt(raw, 10);
    if (!Number.isFinite(behind)) return null;
    return { behind, base };
  } catch {
    return null;
  }
}

const SLUG_RE = /[^A-Za-z0-9_-]/g;

function repoSlug(name: string): string {
  const s = name.replace(SLUG_RE, '-');
  if (!s) throw new Error(`Cannot derive a repo slug from team name: ${name}`);
  return s;
}

export function ensureRemoteRepo(target: string, repo: string, slug: string, opts: RemoteSshOptions = {}): string {
  assertValidSshTarget(target);
  const safeSlug = repoSlug(slug);
  const canonical = `~/.agents/repos/${safeSlug}`;

  if (isRemoteGitRepo(target, canonical, opts)) {
    sshExec(
      target,
      `git -C ${remotePathExpr(canonical)} fetch origin`,
      { timeoutMs: 120000, multiplex: true, extraSshArgs: opts.extraSshArgs },
    );
    const root = resolveRemoteRepoRoot(target, canonical, opts);
    if (!root) throw new Error(`Repo at ${canonical} on ${target} vanished mid-provision.`);
    return root;
  }

  if (repo && !looksLikeUrl(repo)) {
    const existing = resolveRemoteRepoRoot(target, repo, opts);
    if (existing) {
      sshExec(
        target,
        `git -C ${remotePathExpr(existing)} fetch origin`,
        { timeoutMs: 120000, multiplex: true, extraSshArgs: opts.extraSshArgs },
      );
      return existing;
    }
  }

  if (!repo) {
    throw new Error(
      `No repo configured for team on ${target}: set \`teams create --repo <url|path>\` ` +
        `or run this teammate from a git checkout so origin can be inferred.`,
    );
  }
  assertSafeGitTransport(repo);
  const clone = sshExec(
    target,
    `mkdir -p ${remotePathExpr('~/.agents/repos')} && ` +
      `git clone -- ${shellQuote(repo)} ${remotePathExpr(canonical)}`,
    { timeoutMs: 600000, multiplex: true, extraSshArgs: opts.extraSshArgs },
  );
  if (clone.code !== 0) {
    throw new Error(
      `git clone ${repo} into ${canonical} on ${target} failed: ` +
        `${(clone.stderr || clone.stdout).trim() || 'ssh error'}`,
    );
  }
  const root = resolveRemoteRepoRoot(target, canonical, opts);
  if (!root) throw new Error(`Cloned ${repo} into ${canonical} on ${target} but it isn't a git repo.`);
  return root;
}

function looksLikeUrl(repo: string): boolean {
  return (
    /^(https?|git|ssh):\/\//.test(repo) ||
    /^[^/\s]+@[^/\s]+:/.test(repo) ||
    repo.startsWith('git@')
  );
}

export function remoteWorktreeDirty(target: string, worktreePath: string, opts: RemoteSshOptions = {}): boolean {
  assertValidSshTarget(target);
  const cmd = ['git', '-C', worktreePath, 'status', '--porcelain'].map(shellQuote).join(' ');
  const res = sshExec(target, cmd, { timeoutMs: 20000, multiplex: true, extraSshArgs: opts.extraSshArgs });
  if (res.code !== 0) return false;
  return res.stdout.trim().length > 0;
}

export function removeRemoteWorktree(
  target: string,
  repoPath: string,
  worktreeName: string,
  deleteBranch = true,
  opts: RemoteSshOptions = {},
): void {
  assertValidSshTarget(target);
  assertName(worktreeName);
  const gitRoot = remoteGit(target, repoPath, ['rev-parse', '--show-toplevel'], 60000, opts);
  const worktreePath = `${gitRoot}/.agents/worktrees/${worktreeName}`;
  const branchName = `agents/${worktreeName}`;

  const rm = sshExec(
    target,
    ['git', '-C', gitRoot, 'worktree', 'remove', '--force', worktreePath].map(shellQuote).join(' '),
    { timeoutMs: 60000, multiplex: true, extraSshArgs: opts.extraSshArgs },
  );
  if (rm.code !== 0 && /is not a working tree/.test(rm.stderr + rm.stdout)) {
    sshExec(target, ['git', '-C', gitRoot, 'worktree', 'prune'].map(shellQuote).join(' '), {
      timeoutMs: 30000,
      multiplex: true,
      extraSshArgs: opts.extraSshArgs,
    });
  }
  if (deleteBranch) {
    sshExec(target, ['git', '-C', gitRoot, 'branch', '-D', branchName].map(shellQuote).join(' '), {
      timeoutMs: 20000,
      multiplex: true,
      extraSshArgs: opts.extraSshArgs,
    });
  }
}
