/**
 * Remote git-worktree utilities for distributed teams — the SSH analog of
 * `teams/worktree.ts`. Each function runs the SAME git argv the local helper
 * runs, but over SSH on the host that owns the teammate's checkout, so a
 * distributed teammate gets its own branch/worktree without a shared local tree.
 *
 * The repo is provisioned on the host by `ensureRemoteRepo` (reuse an existing
 * checkout or clone the team's `--repo`); we fetch origin and branch the worktree
 * off `origin/<default>` so remote teammates build on the freshly-fetched default
 * branch, mirroring the local git-workflow.
 */
import { sshExec, shellQuote, assertValidSshTarget } from '../ssh-exec.js';
import { assertSafeGitTransport } from '../git.js';

interface RemoteSshOptions { extraSshArgs?: string[] }

// Same allowlist as the local helper — worktree names land in a branch name and
// a path, so keep them injection-safe (no shell metacharacters).
const WORKTREE_NAME_RE = /^[A-Za-z0-9_-]+$/;

function assertName(worktreeName: string): void {
  if (!WORKTREE_NAME_RE.test(worktreeName)) {
    throw new Error(`Invalid worktree name: ${worktreeName}`);
  }
}

/**
 * Render a path for safe interpolation into a REMOTE shell, expanding a leading
 * `~`/`~/` to `"$HOME"` so it resolves on the host. A plain `shellQuote('~/x')`
 * single-quotes the tilde and the remote shell leaves it literal (the same
 * reason dispatch.ts uses `$HOME`, not `~`). Everything after the tilde is still
 * single-quoted, so odd path characters stay safe.
 */
export function remotePathExpr(p: string): string {
  if (p === '~') return '"$HOME"';
  if (p.startsWith('~/')) return '"$HOME"/' + shellQuote(p.slice(2));
  return shellQuote(p);
}

/**
 * Resolve the ABSOLUTE git top-level for a (possibly `~`-relative) repo path on
 * the host, or null when it isn't a git repo / the host is unreachable. Used by
 * `ensureRemoteRepo` to both VALIDATE and CANONICALIZE a repo location, so every
 * downstream remote command (launch `cd`, worktree create, polling) works from an
 * absolute path with no tilde-expansion hazard.
 */
function resolveRemoteRepoRoot(target: string, repoPath: string, opts: RemoteSshOptions = {}): string | null {
  assertValidSshTarget(target);
  const cmd = `git -C ${remotePathExpr(repoPath)} rev-parse --show-toplevel 2>/dev/null`;
  const res = sshExec(target, cmd, { timeoutMs: 15000, multiplex: true, extraSshArgs: opts.extraSshArgs });
  const root = res.stdout.trim();
  return res.code === 0 && root ? root : null;
}

/** Run one git command in `repoPath` on the host; throw with stderr on failure. */
function remoteGit(target: string, repoPath: string, args: string[], timeoutMs = 60000, opts: RemoteSshOptions = {}): string {
  const cmd = ['git', '-C', repoPath, ...args].map(shellQuote).join(' ');
  const res = sshExec(target, cmd, { timeoutMs, multiplex: true, extraSshArgs: opts.extraSshArgs });
  if (res.code !== 0) {
    throw new Error(`remote git failed on ${target} (${args[0]}): ${(res.stderr || res.stdout).trim() || 'ssh error'}`);
  }
  return res.stdout.trim();
}

/** True when `repoPath` is a git working tree on the host. */
function isRemoteGitRepo(target: string, repoPath: string, opts: RemoteSshOptions = {}): boolean {
  assertValidSshTarget(target);
  // remotePathExpr so a `~`/`$HOME`-relative path (the canonical repos dir) expands
  // on the host — plain shellQuote would single-quote the tilde into a literal,
  // making an existing checkout look absent and forcing a doomed re-clone.
  const cmd = `git -C ${remotePathExpr(repoPath)} rev-parse --git-dir 2>/dev/null`;
  const res = sshExec(target, cmd, { timeoutMs: 15000, multiplex: true, extraSshArgs: opts.extraSshArgs });
  return res.code === 0;
}

/**
 * Resolve the host repo's default branch name (origin/HEAD → `main`/`master`/…).
 * Falls back to `main` when origin/HEAD isn't set, matching the local recipe's
 * `remote set-head` step.
 */
function remoteDefaultBranch(target: string, repoPath: string, opts: RemoteSshOptions = {}): string {
  assertValidSshTarget(target);
  try {
    // Refresh origin/HEAD first so a repo cloned before the default was set resolves.
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

/**
 * Create a worktree on the host for a teammate, branched off the freshly-fetched
 * default branch. Returns the absolute worktree path on the host.
 *
 * Same base policy as local `createWorktree`: fetch origin, then
 * `worktree add -b … origin/<default>` so a stale checkout can't fork the
 * teammate off old code.
 */
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

/**
 * How many commits the host checkout at `repoPath` is behind `origin/<default>` —
 * the remote analog of the local {@link commitsBehindDefault} staleness probe, and
 * the exact case from the incident this guard exists for (a distributed team
 * pointed at a 71-commit-stale checkout on another box).
 *
 * `ensureRemoteRepo` already fetched `origin` when it provisioned/reused the
 * checkout right before this runs, so the remote-tracking ref is usually fresh and
 * this reads it WITHOUT a second fetch: resolve the default branch, then
 * `rev-list --count HEAD..origin/<default>`. (That reuse fetch is best-effort —
 * an offline host leaves the ref stale, so this under-reports rather than blocks;
 * `createRemoteWorktree` re-fetches at launch so the teammate's base is still
 * fresh regardless.) Returns null on any git/ssh error (unreachable host, non-repo
 * path) — the caller treats null as "can't tell, don't block".
 */
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

// Team-name → repos-dir slug: same allowlist a worktree name uses, so it lands
// safely in a path (`~/.agents/repos/<slug>`) with no shell metacharacters.
const SLUG_RE = /[^A-Za-z0-9_-]/g;

/** Sanitize a team name into a repos-directory slug (`[A-Za-z0-9_-]` only). */
function repoSlug(name: string): string {
  const s = name.replace(SLUG_RE, '-');
  if (!s) throw new Error(`Cannot derive a repo slug from team name: ${name}`);
  return s;
}

/**
 * Ensure the team's repo is present on the host and return its absolute git
 * root. The canonical location is `~/.agents/repos/<slug>` (slug = sanitized
 * team name). Resolution, in order:
 *
 *   1. `~/.agents/repos/<slug>` already a git repo  → `git fetch origin`, use it.
 *   2. `repo` is a path that exists on the host as a git repo → use it in place.
 *   3. `repo` is a URL (or a non-existent path)      → `git clone` into the
 *      canonical location, then use it.
 *
 * `$HOME`-prefixed paths interpolate UNQUOTED (remotePathExpr) so the host shell
 * expands `$HOME` — single-quoting the tilde would defeat expansion, the same
 * hazard dispatch.ts avoids.
 */
export function ensureRemoteRepo(target: string, repo: string, slug: string, opts: RemoteSshOptions = {}): string {
  assertValidSshTarget(target);
  const safeSlug = repoSlug(slug);
  const canonical = `~/.agents/repos/${safeSlug}`;

  // 1. Canonical checkout already exists → fetch and reuse.
  if (isRemoteGitRepo(target, canonical, opts)) {
    // Best-effort refresh; a fetch failure (offline origin) shouldn't block reuse.
    sshExec(
      target,
      `git -C ${remotePathExpr(canonical)} fetch origin`,
      { timeoutMs: 120000, multiplex: true, extraSshArgs: opts.extraSshArgs },
    );
    const root = resolveRemoteRepoRoot(target, canonical, opts);
    if (!root) throw new Error(`Repo at ${canonical} on ${target} vanished mid-provision.`);
    return root;
  }

  // 2. `repo` is a path that already exists on the host as a git repo → use it.
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

  // 3. Clone the URL (or a path-that-wasn't-there) into the canonical location.
  if (!repo) {
    throw new Error(
      `No repo configured for team on ${target}: set \`teams create --repo <url|path>\` ` +
        `or run this teammate from a git checkout so origin can be inferred.`,
    );
  }
  // A `--repo` is a git-transport source that clones ON THE REMOTE HOST — guard it
  // like the local clone path (plugins.ts) does: reject remote-helper transports
  // (`ext::sh -c …` runs arbitrary commands at clone time) and a leading `-`, then
  // pass `--` so a leftover `-` can't be parsed as a git option. shellQuote only
  // blocks *shell* injection and is orthogonal to *git-transport* injection.
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

/** Heuristic: does `repo` look like a git URL (vs a filesystem path)? */
function looksLikeUrl(repo: string): boolean {
  return (
    /^(https?|git|ssh):\/\//.test(repo) ||
    /^[^/\s]+@[^/\s]+:/.test(repo) || // scp-style: git@github.com:owner/repo.git
    repo.startsWith('git@')
  );
}

/** True when the host worktree has uncommitted changes (staged or unstaged). */
export function remoteWorktreeDirty(target: string, worktreePath: string, opts: RemoteSshOptions = {}): boolean {
  assertValidSshTarget(target);
  const cmd = ['git', '-C', worktreePath, 'status', '--porcelain'].map(shellQuote).join(' ');
  const res = sshExec(target, cmd, { timeoutMs: 20000, multiplex: true, extraSshArgs: opts.extraSshArgs });
  if (res.code !== 0) return false;
  return res.stdout.trim().length > 0;
}

/**
 * Remove a host worktree and (optionally) its branch. Best-effort: prunes on a
 * "not a working tree" error and ignores a missing branch, matching local
 * `removeWorktree` semantics so cleanup never throws on a half-gone worktree.
 */
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
    // Branch may not exist (removed already, or never created) — ignore failure.
    sshExec(target, ['git', '-C', gitRoot, 'branch', '-D', branchName].map(shellQuote).join(' '), {
      timeoutMs: 20000,
      multiplex: true,
      extraSshArgs: opts.extraSshArgs,
    });
  }
}
