/**
 * Git operations for the agents-cli system repo and package repositories.
 *
 * Handles cloning, pulling, syncing, and inspecting git repos used by
 * the agents version management and plugin/package system. Includes
 * source parsing for GitHub shorthand, SSH, HTTPS, and local paths.
 */
import simpleGit, { SimpleGit } from 'simple-git';
import { execFileSync } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IS_WINDOWS, isWindowsAbsolutePath, toNativePath } from './platform/index.js';
import { getPackageLocalPath } from './state.js';
import { DEFAULT_SYSTEM_REPO, systemRepoSlug } from './types.js';

/**
 * Validate that a clone/pull source uses a safe git transport before it is
 * handed to `git`.
 *
 * Git's remote-helper transports (`ext::`, `fd::`, …) execute arbitrary
 * commands at clone time, `file://`/`git://` are unauthenticated, and a source
 * beginning with `-` is parsed by `git` as a command-line flag (option
 * injection). We therefore allow only:
 *   - `https://`                         (encrypted + authenticated)
 *   - `ssh://` and SCP-style `git@host:path` / `host:path`
 *   - local filesystem paths (callers handle these before reaching `git clone`)
 *
 * Pure string inspection — no filesystem or platform calls — so it behaves
 * identically on Linux, macOS, and Windows.
 *
 * @throws Error if the source uses a disallowed transport.
 */
export function assertSafeGitTransport(source: string): void {
  const s = source.trim();

  // A leading dash is interpreted by git as an option, not a source.
  if (s.startsWith('-')) {
    throw new Error(
      `Refusing to use git source "${source}": a source starting with "-" is interpreted as a git option.`,
    );
  }

  // Remote-helper transports look like "<name>::…" (ext::, fd::, …). SCP-style
  // "git@host:path" uses a single ":" and is intentionally not matched here.
  const helper = s.match(/^[a-zA-Z][a-zA-Z0-9+.-]*::/);
  if (helper) {
    throw new Error(
      `Refusing to use git source "${source}": git remote-helper transports (ext::, fd::, …) are not allowed.`,
    );
  }

  // Explicit "<scheme>://" URLs: permit only https and ssh.
  const scheme = s.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
  if (scheme) {
    const name = scheme[1].toLowerCase();
    if (name !== 'https' && name !== 'ssh') {
      throw new Error(
        `Refusing to use git source "${source}": "${name}://" is not an allowed transport (use https:// or ssh://).`,
      );
    }
  }
  // No scheme -> SCP-style SSH ("git@host:path") or a local path; both safe.
}

/**
 * Validate a branch name before it is passed to `git push` / `git pull`.
 *
 * A name beginning with `-` is parsed by git as a command-line option
 * (e.g. `--mirror`, `--receive-pack=…`), not a ref. Pure string check —
 * identical on every OS, no spawn.
 *
 * @throws Error if the name is empty or would be interpreted as a git option.
 */
export function assertValidBranchName(branch: string): void {
  const b = branch.trim();
  if (!b) {
    throw new Error(
      `Invalid branch name ${JSON.stringify(branch)}: branch name is empty.`,
    );
  }
  if (b.startsWith('-')) {
    throw new Error(
      `Invalid branch name ${JSON.stringify(branch)}: a name starting with "-" is interpreted as a git option.`,
    );
  }
}

/**
 * `git push origin <branch>` with option-injection hardening:
 *   1. {@link assertValidBranchName} rejects leading `-`
 *   2. `--` ends option parsing so a hostile ref cannot be read as a flag
 *
 * Prefer this over `git.push(remote, branch)` whenever the branch comes from
 * repo state rather than a hard-coded literal.
 *
 * Pass `targetBranch` to push the local `branch` to a differently-named remote
 * branch (`git push origin <branch>:<targetBranch>`) — used when publishing the
 * working tree to a branch other than the checked-out one.
 */
export async function pushOrigin(
  git: SimpleGit,
  branch: string,
  targetBranch?: string,
): Promise<void> {
  assertValidBranchName(branch);
  if (targetBranch && targetBranch !== branch) {
    assertValidBranchName(targetBranch);
    await git.raw(['push', '--', 'origin', `${branch}:${targetBranch}`]);
    return;
  }
  await git.raw(['push', '--', 'origin', branch]);
}

/**
 * Whether installing a cloned/pulled repo's `.githooks/` is enabled.
 *
 * Installing hooks wires those scripts into `.git/hooks/`, so `git` EXECUTES
 * them on the next commit/checkout/merge. A repo added via `agents repo add
 * <source>` is untrusted, so auto-installing its hooks is remote code
 * execution. We require explicit opt-in via `AGENTS_ENABLE_GITHOOKS=1`.
 */
function githooksEnabled(): boolean {
  const v = process.env.AGENTS_ENABLE_GITHOOKS;
  return v === '1' || v === 'true';
}

/**
 * Install hooks from `.githooks/` by symlinking each entry into `.git/hooks/`.
 *
 * Gated behind `AGENTS_ENABLE_GITHOOKS=1` (see {@link githooksEnabled}) because
 * the hooks run code on git operations and the source repo may be untrusted.
 *
 * Why symlinks rather than `git config core.hooksPath`: `core.hooksPath` is a
 * known sandbox-escape vector and is blocked by some sandboxed environments
 * (e.g. Claude Code). Symlinks inside `.git/hooks/` run the same way.
 */
function installGithooksSymlinks(repoDir: string): void {
  const githooksDir = path.join(repoDir, '.githooks');
  if (!fs.existsSync(githooksDir)) return;

  if (!githooksEnabled()) {
    console.error(
      `Skipped installing git hooks from ${githooksDir} (they run code on git operations).\n` +
        `  Set AGENTS_ENABLE_GITHOOKS=1 to enable hooks for repos you trust.`,
    );
    return;
  }

  const hooksDir = path.join(repoDir, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  for (const name of fs.readdirSync(githooksDir)) {
    const src = path.join(githooksDir, name);
    if (!fs.statSync(src).isFile()) continue;

    const dest = path.join(hooksDir, name);
    const target = path.join('..', '..', '.githooks', name);

    if (fs.lstatSync(dest, { throwIfNoEntry: false })) {
      fs.rmSync(dest);
    }
    try {
      fs.symlinkSync(target, dest);
    } catch (err) {
      // Windows requires Developer Mode or elevated privileges for symlinks; skip gracefully.
      if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
    }
  }
}

/** Parsed representation of a git source string (GitHub, generic URL, or local path). */
interface GitSource {
  type: 'github' | 'url' | 'local';
  url: string;
  ref?: string;
}

/**
 * Parse a source string into a GitSource object.
 *
 * Supported formats:
 *   gh:owner/repo                    -> https://github.com/owner/repo.git
 *   gh:owner/repo@branch             -> https://github.com/owner/repo.git (ref: branch)
 *   owner/repo                       -> https://github.com/owner/repo.git
 *   owner/repo@branch                -> https://github.com/owner/repo.git (ref: branch)
 *   github.com/owner/repo            -> https://github.com/owner/repo.git
 *   github.com:owner/repo            -> https://github.com/owner/repo.git
 *   github.com:owner/repo.git        -> https://github.com/owner/repo.git
 *   git@github.com:owner/repo.git    -> https://github.com/owner/repo.git
 *   https://github.com/owner/repo    -> https://github.com/owner/repo.git
 *   https://github.com/owner/repo.git -> https://github.com/owner/repo.git
 *   /path/to/local                   -> local path
 *   ./relative/path                  -> local path
 */
export function parseSource(source: string): GitSource {
  // Split off @ref suffix (but not from URLs with @ in them like git@)
  let ref: string | undefined;
  let cleanSource = source;

  // Handle @ref suffix (only if it's at the end and not part of git@)
  const atIndex = source.lastIndexOf('@');
  if (atIndex > 0 && !source.startsWith('git@') && !source.slice(0, atIndex).includes('://')) {
    // Check if what's after @ looks like a ref (no slashes, no dots except in branch names)
    const possibleRef = source.slice(atIndex + 1);
    if (possibleRef && !possibleRef.includes('/') && !possibleRef.includes(':')) {
      ref = possibleRef;
      cleanSource = source.slice(0, atIndex);
    }
  }

  // gh:owner/repo shorthand
  if (cleanSource.startsWith('gh:')) {
    const repo = cleanSource.slice(3).replace(/\.git$/, '');
    return {
      type: 'github',
      url: `https://github.com/${repo}.git`,
      ref: ref || 'main',
    };
  }

  // git@github.com:owner/repo.git (SSH URL)
  if (cleanSource.startsWith('git@github.com:')) {
    const repo = cleanSource.slice(15).replace(/\.git$/, '');
    return {
      type: 'github',
      url: `https://github.com/${repo}.git`,
      ref: ref || 'main',
    };
  }

  // github.com:owner/repo.git (SSH-style without git@)
  if (cleanSource.startsWith('github.com:')) {
    const repo = cleanSource.slice(11).replace(/\.git$/, '');
    return {
      type: 'github',
      url: `https://github.com/${repo}.git`,
      ref: ref || 'main',
    };
  }

  // github.com/owner/repo (domain without protocol)
  if (cleanSource.startsWith('github.com/')) {
    const repo = cleanSource.slice(11).replace(/\.git$/, '');
    return {
      type: 'github',
      url: `https://github.com/${repo}.git`,
      ref: ref || 'main',
    };
  }

  // https:// or http:// URLs
  if (cleanSource.startsWith('http://') || cleanSource.startsWith('https://')) {
    // Check if it's a GitHub URL
    const githubMatch = cleanSource.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
    if (githubMatch) {
      return {
        type: 'github',
        url: `https://github.com/${githubMatch[1]}.git`,
        ref: ref || 'main',
      };
    }

    // Generic URL -- must be an encrypted, authenticated transport
    // (rejects http://, file://, git://, ext::, and leading "-").
    assertSafeGitTransport(cleanSource);
    return {
      type: 'url',
      url: cleanSource.endsWith('.git') ? cleanSource : `${cleanSource}.git`,
      ref,
    };
  }

  // Local path (absolute or relative). On Windows also recognize drive-letter
  // (C:\…) and UNC (\\…) roots, which the POSIX prefixes miss.
  if (
    cleanSource.startsWith('/') || cleanSource.startsWith('./') || cleanSource.startsWith('../')
    || (IS_WINDOWS && isWindowsAbsolutePath(cleanSource))
  ) {
    if (fs.existsSync(cleanSource)) {
      return {
        type: 'local',
        url: path.resolve(cleanSource),
      };
    }
  }

  // Check if it exists as a local path (could be a directory name without ./)
  if (fs.existsSync(cleanSource)) {
    return {
      type: 'local',
      url: path.resolve(cleanSource),
    };
  }

  // Bare owner/repo format (assumes GitHub)
  if (cleanSource.includes('/') && !cleanSource.includes(':') && !cleanSource.includes('.')) {
    const repo = cleanSource.replace(/\.git$/, '');
    return {
      type: 'github',
      url: `https://github.com/${repo}.git`,
      ref: ref || 'main',
    };
  }

  // Last attempt: treat as GitHub if it looks like owner/repo (with possible .git)
  if (/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(cleanSource)) {
    const repo = cleanSource.replace(/\.git$/, '');
    return {
      type: 'github',
      url: `https://github.com/${repo}.git`,
      ref: ref || 'main',
    };
  }

  throw new Error(`Invalid source: ${source}. Supported formats: gh:owner/repo, owner/repo, github.com/owner/repo, https://github.com/owner/repo, or local path`);
}

/** Clone a remote repo or pull updates if it already exists locally. */
async function cloneOrPull(
  source: GitSource,
  targetDir: string
): Promise<{ isNew: boolean; commit: string }> {
  const git: SimpleGit = simpleGit();

  if (source.type === 'local') {
    return { isNew: false, commit: 'local' };
  }

  const exists = fs.existsSync(path.join(targetDir, '.git'));

  if (exists) {
    const repoGit = simpleGit(targetDir);
    await repoGit.fetch();
    if (source.ref) {
      await repoGit.checkout(source.ref);
    }
    await repoGit.pull();
    const log = await repoGit.log({ maxCount: 1 });
    return { isNew: false, commit: log.latest?.hash.slice(0, 8) || 'unknown' };
  }

  assertSafeGitTransport(source.url);
  fs.mkdirSync(targetDir, { recursive: true });
  await git.clone(source.url, targetDir);

  const repoGit = simpleGit(targetDir);
  if (source.ref) {
    await repoGit.checkout(source.ref);
  }
  const log = await repoGit.log({ maxCount: 1 });
  return { isNew: true, commit: log.latest?.hash.slice(0, 8) || 'unknown' };
}

/** Clone a repository from a source string, returning the local path and commit hash. */
export async function cloneRepo(source: string): Promise<{
  localPath: string;
  commit: string;
  isNew: boolean;
}> {
  const parsed = parseSource(source);

  if (parsed.type === 'local') {
    return {
      localPath: parsed.url,
      commit: 'local',
      isNew: false,
    };
  }

  const localPath = getPackageLocalPath(source);
  const result = await cloneOrPull(parsed, localPath);

  return {
    localPath,
    commit: result.commit,
    isNew: result.isNew,
  };
}

/** Get the short commit hash (8 chars) of the latest commit in a repo. */
export async function getRepoCommit(repoPath: string): Promise<string> {
  try {
    const git = simpleGit(repoPath);
    const log = await git.log({ maxCount: 1 });
    return log.latest?.hash.slice(0, 8) || 'unknown';
  } catch {
    /* not a git repo or no commits */
    return 'unknown';
  }
}

/** Compact, self-contained state of a git repo — branch, short HEAD, and a
 *  dirty flag — for cross-device comparison (RUSH-2027). Synchronous and
 *  best-effort: a non-repo or unreadable path yields `null` fields, never a
 *  throw, so a device's `doctor --json` payload always serializes. */
interface RepoStateSnapshot {
  branch: string | null;
  head: string | null;
  dirty: boolean;
}

/** Read {@link RepoStateSnapshot} for `repoPath` using plumbing commands so the
 *  result is stable across git versions and never mutates the tree. Returns null
 *  when the path is not a git worktree. */
export function readRepoState(repoPath: string): RepoStateSnapshot | null {
  const runGit = (args: string[]): string | null => {
    try {
      return execFileSync('git', ['-C', repoPath, ...args], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim();
    } catch {
      return null;
    }
  };
  // Gate on a real worktree first; `rev-parse --is-inside-work-tree` prints
  // `true` only inside one, and returns non-zero (→ null) otherwise.
  if (runGit(['rev-parse', '--is-inside-work-tree']) !== 'true') return null;
  const branchRaw = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchRaw && branchRaw !== 'HEAD' ? branchRaw : null; // detached → null
  const headRaw = runGit(['rev-parse', 'HEAD']);
  const head = headRaw ? headRaw.slice(0, 8) : null;
  const porcelain = runGit(['status', '--porcelain']);
  const dirty = porcelain != null && porcelain.length > 0;
  return { branch, head, dirty };
}

/** Memoized per repoRoot — a resolveResource()/listResources()/plugin-discovery
 *  call that touches many resources from the SAME DotAgents repo must not shell
 *  out to git once per resource. */
const _snapshotShaCache = new Map<string, string | undefined>();

/**
 * The short HEAD sha of the git repo at `repoRoot` (`git -C <repoRoot>
 * rev-parse --short HEAD`), for provenance — "which commit of this DotAgents
 * repo was this resource/plugin resolved from". `undefined` when `repoRoot`
 * isn't a git repo (or has no commits yet), never a throw.
 *
 * Deliberately synchronous + resolved once and cached: callers (resources.ts,
 * plugins.ts) attach this as a lazy getter on the resolved object, so a
 * consumer that never inspects provenance never pays for the git shell-out —
 * see {@link ResolvedResource.snapshotSha} / {@link DiscoveredPlugin.snapshotSha}.
 */
export function resolveSnapshotSha(repoRoot: string): string | undefined {
  const cached = _snapshotShaCache.get(repoRoot);
  if (cached !== undefined || _snapshotShaCache.has(repoRoot)) return cached;
  let sha: string | undefined;
  try {
    const raw = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--short', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    sha = raw || undefined;
  } catch {
    sha = undefined;
  }
  _snapshotShaCache.set(repoRoot, sha);
  return sha;
}

/** Test seam: clear the memoized snapshot-sha cache between test cases. */
export function _resetSnapshotShaCacheForTest(): void {
  _snapshotShaCache.clear();
}

/**
 * Get the remote URL for origin in a git repo.
 */
export async function getRemoteUrl(repoPath: string): Promise<string | null> {
  try {
    const git = simpleGit(repoPath);
    const remotes = await git.getRemotes(true);
    const origin = remotes.find(r => r.name === 'origin');
    return origin?.refs?.fetch || origin?.refs?.push || null;
  } catch {
    /* not a git repo or no remotes */
    return null;
  }
}

/**
 * Canonical `host/owner/repo` form of a git remote, transport-agnostic, so the
 * same repo cloned over SSH vs HTTPS compares equal. Strips protocol, any
 * `user@`, a trailing `.git`, and folds the scp-style `host:owner/repo` colon to
 * a slash. Lower-cased. Used to decide whether an existing checkout is "the same
 * repo" as a requested source before adopting it.
 */
export function canonicalGitRemote(url: string): string {
  const canonical = url
    .trim()
    .replace(/\/+$/, '') // trailing slashes first, so a trailing-slash-after-.git still strips
    .replace(/\.git$/i, '')
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') // strip scheme (https://, ssh://, git://)
    .replace(/^[^@/]+@/, '') // strip user@ (git@, ssh user)
    .replace(':', '/') // scp-style host:owner/repo → host/owner/repo (first colon only)
    .toLowerCase();
  // Fold a renamed repo's old name onto its new one so both compare equal
  // everywhere (see RENAMED_REMOTE_ALIASES).
  return RENAMED_REMOTE_ALIASES[canonical] ?? canonical;
}

/**
 * Git remotes that denote the SAME repository under an old and a new name,
 * keyed by canonical `host/owner/repo`. `phnx-labs/.agents-system` was renamed
 * to `phnx-labs/.agents` on GitHub (PHNX-3394); {@link DEFAULT_SYSTEM_REPO}
 * still points at the pre-rename slug (GitHub's own redirect makes that
 * resolve fine), so folding the new name onto it here means both compare equal
 * everywhere remotes are compared: {@link sameGitRemote} (repo adoption),
 * {@link isSystemRepoRemote} (the system-origin check), and the
 * DotAgents-layer classifier in state.ts.
 */
const RENAMED_REMOTE_ALIASES: Record<string, string> = {
  'github.com/phnx-labs/.agents': 'github.com/phnx-labs/.agents-system',
};

/**
 * True when a git remote URL (any transport form: ssh, https, scp-style) points
 * at the system DotAgents repo — {@link DEFAULT_SYSTEM_REPO}'s current slug OR
 * its `phnx-labs/.agents` rename target (PHNX-3394), which
 * {@link canonicalGitRemote} folds onto it via {@link RENAMED_REMOTE_ALIASES}.
 * Pure string check with no git spawn, so it is unit-testable off a live
 * checkout; {@link isSystemRepoOrigin} reads a dir's origin and delegates here.
 */
export function isSystemRepoRemote(remote: string | null | undefined): boolean {
  if (!remote) return false;
  const c = canonicalGitRemote(remote);
  return c === canonicalGitRemote(`https://github.com/${systemRepoSlug(DEFAULT_SYSTEM_REPO)}`);
}

/**
 * True when `remote` is the origin the system repo is EXPECTED to track on this
 * machine, honouring an operator's `AGENTS_SYSTEM_REPO` override.
 *
 * The system repo ships hooks that register as shell `command` strings run on
 * every tool event, and its checkout auto-fast-forwards from origin — so a
 * fast-forward from an origin the operator never chose is remote code execution
 * on the next command that loads a system resource (PHNX-2957). This is the
 * pinning predicate every auto-pull of the system repo gates on: pull only when
 * origin is the canonical {@link isSystemRepoRemote} repo, or the exact
 * `AGENTS_SYSTEM_REPO` the operator pointed at instead. Anything else — a
 * repointed origin, a fork, an unset-then-swapped remote — is refused, not
 * pulled. Pure string check; no git spawn.
 */
export function isExpectedSystemRepoRemote(remote: string | null | undefined): boolean {
  if (!remote) return false;
  const override = process.env.AGENTS_SYSTEM_REPO?.trim();
  if (override) {
    // The override is a source spec (`gh:owner/repo`) or a full clone URL. Match
    // the GitHub-slug form the setup path clones, and the raw spec itself, so a
    // non-GitHub override URL still verifies.
    return (
      sameGitRemote(remote, `https://github.com/${systemRepoSlug(override)}`) ||
      sameGitRemote(remote, override.replace(/^gh:/, ''))
    );
  }
  return isSystemRepoRemote(remote);
}

/** True when two git remote URLs point at the same repo across transport forms. */
export function sameGitRemote(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return canonicalGitRemote(a) === canonicalGitRemote(b);
}

/** Result of {@link commitAndPush}. */
type CommitAndPushResult = {
  success: boolean;
  error?: string;
  /** Human detail for success: "already up to date", "pushed abc..def", "committed and pushed …". */
  detail?: string;
  branch?: string;
  committed?: boolean;
  pushed?: boolean;
};

/**
 * Commit (if dirty) and push a repo.
 *
 * Clean tree + local ahead of origin still pushes — "nothing to commit" is not
 * "nothing to push". Reports "already up to date" only when `ahead === 0` and
 * there is nothing to commit.
 *
 * `targetBranch` pushes the working tree to a differently-named remote branch
 * (`<current>:<targetBranch>`) and is reported back as the result `branch`, so
 * callers that print a branch-scoped URL reference where the commit actually
 * landed — not the checked-out branch.
 */
export async function commitAndPush(
  repoPath: string,
  message: string,
  targetBranch?: string,
): Promise<CommitAndPushResult> {
  try {
    const git = simpleGit(repoPath);
    let status = await git.status();
    const branch = status.current || 'main';
    assertValidBranchName(branch);
    if (targetBranch) assertValidBranchName(targetBranch);
    // The branch the commit ends up on remotely — the checked-out branch unless
    // an explicit target was requested.
    const pushedBranch = targetBranch || branch;

    let committed = false;
    if (status.files.length > 0) {
      await git.add('-A');
      await git.commit(message);
      committed = true;
      status = await git.status();
    }

    const ahead = status.ahead ?? 0;
    // A same-branch push short-circuits when there is nothing new; a push to a
    // different target branch must still run even from a clean, non-ahead tree,
    // since the target may not carry these commits yet.
    if (!committed && ahead === 0 && pushedBranch === branch) {
      return {
        success: true,
        detail: 'already up to date',
        branch,
        committed: false,
        pushed: false,
      };
    }

    // Capture remote tip before push for a real ref range in the detail string.
    let before = '';
    try {
      before = (await git.raw(['rev-parse', '--short=8', `origin/${pushedBranch}`])).trim();
    } catch {
      /* origin/<branch> may not exist yet (first push) */
    }

    await pushOrigin(git, branch, targetBranch);

    let after = '';
    try {
      after = (await git.raw(['rev-parse', '--short=8', 'HEAD'])).trim();
    } catch {
      after = 'unknown';
    }

    const range =
      before && after && before !== after
        ? `${before}..${after}`
        : after || undefined;
    const detail = committed
      ? range
        ? `committed and pushed ${range}`
        : 'committed and pushed'
      : range
        ? `pushed ${range}`
        : 'pushed';

    return {
      success: true,
      detail,
      branch: pushedBranch,
      committed,
      pushed: true,
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Check if repo has uncommitted changes.
 */
export async function hasUncommittedChanges(repoPath: string): Promise<boolean> {
  try {
    const git = simpleGit(repoPath);
    const status = await git.status();
    return status.files.length > 0;
  } catch {
    /* not a git repo */
    return false;
  }
}

/**
 * Check if a directory is a git repository (**synchronous, root-only**).
 *
 * Tests for a `.git` entry directly under `dir`, so it recognizes only a
 * repository *root* — it returns false inside a subdirectory and for linked
 * worktrees (whose `.git` is a file pointing elsewhere is caught, but a nested
 * cwd is not). This is deliberate: the system-repo sync callers here always
 * pass a known root. For the async, worktree-correct predicate used by teams,
 * see `isGitRepo` in `lib/teams/worktree.ts` (which shells out to
 * `git rev-parse --git-dir`). The two are intentionally **not** merged.
 */
export function isGitRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'));
}

/**
 * Return the absolute path to the git working-tree root containing `dir`.
 *
 * Shells out to `git rev-parse --show-toplevel`, so it resolves correctly from
 * any subdirectory and for linked worktrees (unlike the root-only, synchronous
 * {@link isGitRepo} above). Throws if `dir` is not inside a git repository.
 *
 * Git prints POSIX separators even on Windows (`C:/Users/...`); we fold them to
 * the native separator so the result is a real filesystem path that compares
 * equal to one built with `path.*`. On POSIX this is a no-op.
 */
export async function getGitRoot(dir: string): Promise<string> {
  const root = await simpleGit(dir).revparse(['--show-toplevel']);
  return toNativePath(root.trim());
}

/**
 * Return the absolute path to the **main** working-tree root for `dir`.
 *
 * Unlike {@link getGitRoot}, this stays correct when `dir` is inside a *linked*
 * worktree: `--show-toplevel` there returns the worktree's own path, but the
 * common git dir (`--git-common-dir`) always points at the primary repo's
 * `.git`, whose parent is the main checkout. Throws if `dir` is not in a repo.
 *
 * Git prints POSIX separators even on Windows (`C:/Users/...`); we fold them to
 * the native separator so the result is a real filesystem path that compares
 * equal to one built with `path.*`. On POSIX this is a no-op.
 */
export async function getMainRepoRoot(dir: string): Promise<string> {
  const common = await simpleGit(dir).raw(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return toNativePath(path.dirname(common.trim()));
}

/**
 * Initialize a git repo in an existing directory.
 */
export async function initRepo(dir: string): Promise<void> {
  const git = simpleGit(dir);
  await git.init();
}

/**
 * Clone a repo into an existing directory (for initializing ~/.agents/).
 * This clones into a temp dir, moves .git, then checks out tracked files.
 */
export async function cloneIntoExisting(
  source: string,
  targetDir: string
): Promise<{ success: boolean; commit: string; error?: string }> {
  const parsed = parseSource(source);
  if (parsed.type === 'local') {
    return { success: false, commit: '', error: 'Cannot clone local source' };
  }

  const git = simpleGit();
  const tempDir = path.join(targetDir, '.git-clone-temp');

  try {
    assertSafeGitTransport(parsed.url);
    // Clone to temp directory
    fs.mkdirSync(tempDir, { recursive: true });
    await git.clone(parsed.url, tempDir);

    const repoGit = simpleGit(tempDir);
    if (parsed.ref) {
      await repoGit.checkout(parsed.ref);
    }

    // Move .git directory to target
    const gitDir = path.join(tempDir, '.git');
    const targetGitDir = path.join(targetDir, '.git');
    if (fs.existsSync(targetGitDir)) {
      fs.rmSync(targetGitDir, { recursive: true });
    }
    fs.renameSync(gitDir, targetGitDir);

    // Clean up temp
    fs.rmSync(tempDir, { recursive: true });

    // Checkout tracked files from git (restores repo files, respects .gitignore)
    const targetGit = simpleGit(targetDir);
    await targetGit.checkout('.');

    installGithooksSymlinks(targetDir);

    const log = await targetGit.log({ maxCount: 1 });

    return {
      success: true,
      commit: log.latest?.hash.slice(0, 8) || 'unknown',
    };
  } catch (err) {
    // Clean up temp on error
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
    return { success: false, commit: '', error: (err as Error).message };
  }
}

/**
 * Git-back an EXISTING, populated directory from a remote — clone it in place
 * without deleting the local files. Turns a plain `~/.agents` folder (which setup
 * creates as a bare `mkdirSync` and never git-clones — see state.ts ensureAgentsDir)
 * into a real clone of the user's config remote, so `agents repo pull/push` and
 * `agents sync` work on a fresh or Windows machine that never got the manual clone.
 *
 * Unlike cloneIntoExisting (which blindly `checkout .`s over local files), this
 * BACKS UP every tracked file whose local copy differs from the remote — into a
 * sibling `<dir>.pre-adopt-backup/` OUTSIDE the repo so it can't be re-committed —
 * before overwriting it. So a box with local edits to agents.yaml/hooks/rules
 * doesn't silently lose them. Untracked runtime state (.cache/.history/.system,
 * all gitignored) is never touched because `checkout .` only restores tracked paths.
 */
export async function adoptRepo(
  source: string,
  targetDir: string,
): Promise<{ success: boolean; commit: string; backupDir?: string; backedUp: string[]; error?: string }> {
  const trimmed = source.trim();
  if (fs.existsSync(path.join(targetDir, '.git'))) {
    return { success: false, commit: '', backedUp: [], error: 'Already a git repo — nothing to adopt' };
  }

  // Preserve the user's transport. `parseSource` THROWS for `ssh://` and any
  // non-github `git@host:` URL, and rewrites `git@github.com:x` → https (breaking
  // SSH-key-only auth — the common config-repo setup — so a private clone hangs on
  // a credential prompt). So for an SSH URL, clone it AS-IS and never call
  // parseSource; for everything else, normalize + reject local via parseSource —
  // inside the try, so a malformed URL returns a graceful error, not a stack trace.
  const isSsh = trimmed.startsWith('git@') || trimmed.startsWith('ssh://');
  const tempDir = path.join(targetDir, '.git-adopt-temp');
  try {
    let cloneUrl: string;
    let ref: string | undefined;
    if (isSsh) {
      cloneUrl = trimmed; // SSH stays SSH; clone the remote's default HEAD.
    } else {
      const parsed = parseSource(source);
      if (parsed.type === 'local') {
        return { success: false, commit: '', backedUp: [], error: 'Cannot adopt from a local source' };
      }
      cloneUrl = parsed.url;
      ref = parsed.ref;
    }
    assertSafeGitTransport(cloneUrl);
    fs.mkdirSync(targetDir, { recursive: true });
    // Idempotency: clear a stale temp left by an interrupted prior run.
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });

    // Clone to temp, then move its .git in so the index == remote HEAD.
    // Fail fast on a missing credential instead of hanging on a prompt: set
    // GIT_TERMINAL_PROMPT=0 on the inherited env directly rather than via
    // simple-git's `.env()`, which validates and rejects command-like vars the
    // harness may set (GIT_EDITOR, PAGER, …) — the child inherits process.env,
    // and non-interactive git is what we always want in the CLI anyway.
    process.env.GIT_TERMINAL_PROMPT = '0';
    await simpleGit().clone(cloneUrl, tempDir);
    const repoGit = simpleGit(tempDir);
    if (ref) await repoGit.checkout(ref);
    fs.renameSync(path.join(tempDir, '.git'), path.join(targetDir, '.git'));
    fs.rmSync(tempDir, { recursive: true, force: true });

    const targetGit = simpleGit(targetDir);

    // Back up any TRACKED file whose local copy differs from the remote before the
    // checkout clobbers it. `diff --name-only` (worktree vs the moved-in index) is
    // exactly that set; a deleted-locally file has nothing to preserve.
    const diff = await targetGit.diff(['--name-only']);
    const clobbered = diff.split('\n').map((s) => s.trim()).filter(Boolean);
    let backupDir: string | undefined;
    const backedUp: string[] = [];
    if (clobbered.length > 0) {
      backupDir = path.join(path.dirname(targetDir), path.basename(targetDir) + '.pre-adopt-backup');
      for (const rel of clobbered) {
        const src = path.join(targetDir, rel);
        if (!fs.existsSync(src)) continue;
        const dst = path.join(backupDir, rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        backedUp.push(rel);
      }
    }

    // Materialize the remote's tracked files (respects .gitignore, so
    // .cache/.history/.system stay put), overwriting the now-backed-up locals.
    await targetGit.checkout('.');
    installGithooksSymlinks(targetDir);

    const log = await targetGit.log({ maxCount: 1 });
    return { success: true, commit: log.latest?.hash.slice(0, 8) || 'unknown', backupDir, backedUp };
  } catch (err) {
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    return { success: false, commit: '', backedUp: [], error: (err as Error).message };
  }
}


/**
 * Device-local record of the user config repo's remote URL, kept OUTSIDE the git
 * tree so it survives a lost `.git` (`.history/` is gitignored runtime state).
 * This is what lets `agents repo sync user` adopt-in-place a box that was healthy
 * once and later lost its checkout, without the operator re-typing the URL.
 */
function userRepoRemoteRecordPath(dir: string): string {
  return path.join(dir, '.history', 'user-repo-remote.json');
}

/** Read an origin remote URL from a git dir, or null when there is none. */
export function readOriginUrl(dir: string): string | null {
  if (!isGitRepo(dir)) return null;
  try {
    const url = execFileSync('git', ['-C', dir, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf-8',
    }).trim();
    return url || null;
  } catch {
    return null;
  }
}

/**
 * Persist the user repo's remote URL to device-local runtime state so a future
 * adopt-in-place can recover it after a `.git` loss. Best-effort — a write
 * failure never blocks a sync.
 */
export function recordUserRepoRemote(dir: string, url: string): void {
  try {
    const file = userRepoRemoteRecordPath(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ url }, null, 2) + '\n', { mode: 0o600 });
  } catch {
    /* runtime cache write is best-effort */
  }
}

/**
 * Resolve the user config repo's remote URL WITHOUT hardcoding it, for the
 * adopt-in-place self-heal. In priority order:
 *   1. an existing `origin` remote on the dir (a partial repo that kept its
 *      `.git` but drifted) — the same source `agents repo sync` already reads;
 *   2. the `AGENTS_USER_REPO_URL` env override (a fresh/never-cloned box);
 *   3. the device-local record written by a prior healthy sync (a box that lost
 *      its `.git` but kept `.history/` runtime state).
 * Returns null when none is known — the caller then guides the operator to
 * `agents repo pull user <git-url>` instead of crashing.
 */
export function resolveUserRepoRemoteUrl(dir: string): string | null {
  const fromOrigin = readOriginUrl(dir);
  if (fromOrigin) return fromOrigin;

  const fromEnv = process.env.AGENTS_USER_REPO_URL?.trim();
  if (fromEnv) return fromEnv;

  try {
    const raw = fs.readFileSync(userRepoRemoteRecordPath(dir), 'utf-8');
    const url = (JSON.parse(raw) as { url?: string }).url?.trim();
    if (url) return url;
  } catch {
    /* no record yet */
  }
  return null;
}

/**
 * Decide whether a local top-level `agents.yaml` is a stale install stub that
 * should be restored from the committed copy, vs. a legitimately customized file
 * that must be preserved.
 *
 * The stub a partial install leaves behind (createDefaultMeta + a few config
 * writes) is strictly SHORTER than the committed config AND missing whole
 * top-level blocks the committed one carries (`config:` / `hooks:` — the fleet
 * browser hub and hook registrations). Device-specific settings live in
 * `devices/<host>/agents.yaml`, never here, so restoring the top-level file is
 * safe. A file that already carries those blocks (or is longer) is treated as a
 * real local edit and left alone — it surfaces as a modified path instead.
 */
export function isStaleAgentsYamlStub(local: string, committed: string): boolean {
  if (local.trim() === committed.trim()) return false;
  const shorter = local.split('\n').length < committed.split('\n').length;
  const missingBlock =
    (/^config:/m.test(committed) && !/^config:/m.test(local)) ||
    (/^hooks:/m.test(committed) && !/^hooks:/m.test(local));
  return shorter && missingBlock;
}

interface AdoptInPlaceResult {
  success: boolean;
  commit: string;
  /** Tracked files that were absent locally and materialized from origin/main. */
  materialized: number;
  /** True when the stale-stub top-level agents.yaml was restored from origin. */
  reconciledAgentsYaml: boolean;
  /**
   * When agents.yaml was reconciled, the path the PRE-reconcile local copy was
   * saved to first — so even a false-positive stub match (e.g. a user who
   * deliberately removed a whole `hooks:`/`config:` block) is recoverable, never
   * silently lost.
   */
  agentsYamlBackup?: string;
  /**
   * Tracked paths whose local copy differs from origin/main and was NOT touched
   * — un-gitignored local edits surfaced rather than silently overwritten.
   */
  localEdits: string[];
  error?: string;
}

/**
 * Adopt an EXISTING, non-git (or origin-less) `~/.agents` directory in place —
 * git-back it against its remote WITHOUT re-cloning and WITHOUT destroying the
 * runtime state it carries (`.cache` / `.history` / `scratch` / `.system`, all
 * gitignored). The self-heal for a partial install (PHNX-3301): the current code
 * hard-fails with "Not a git repo", and the only manual fix is a destructive
 * re-clone that wipes that runtime state.
 *
 * Plumbing-only, so it never trips the fleet git-guard (no `reset` / `checkout
 * <branch>` / `stash` / `git config`):
 *   1. `git init` + point HEAD at `main`.
 *   2. `git remote add origin <url>`.
 *   3. `git fetch origin main`.
 *   4. `git update-ref refs/heads/main origin/main`; set upstream to origin/main.
 *   5. `git read-tree origin/main` — index = origin/main, working tree untouched.
 *   6. Materialize only the tracked files MISSING from the working tree
 *      (`checkout-index` on that set) — existing local files are never overwritten.
 *   7. Reconcile the top-level `agents.yaml`: restore it from origin/main only
 *      when the local copy is a stale stub ({@link isStaleAgentsYamlStub}).
 *
 * Idempotent: a second run finds the remote/refs already present and simply
 * re-materializes nothing. Any tracked path with real local edits is returned in
 * `localEdits` (surfaced, never clobbered).
 */
export async function adoptRepoInPlace(
  dir: string,
  remoteUrl: string,
): Promise<AdoptInPlaceResult> {
  const empty: AdoptInPlaceResult = {
    success: false,
    commit: '',
    materialized: 0,
    reconciledAgentsYaml: false,
    localEdits: [],
  };
  const trimmed = remoteUrl.trim();
  try {
    // The URL is always a resolved git remote (origin / env / record), never a
    // `gh:` shorthand — so skip parseSource (which THROWS on ssh:// and rewrites
    // git@github -> https, breaking SSH-key-only auth). assertSafeGitTransport
    // still blocks the dangerous transports (ext::, file://, option injection)
    // while permitting https / ssh / scp-style / a local bare repo.
    assertSafeGitTransport(trimmed);
    if (!fs.existsSync(dir)) {
      return { ...empty, error: `Target directory does not exist: ${dir}` };
    }
    // Non-interactive git — fail fast on a missing credential instead of hanging
    // on a prompt (same rationale as adoptRepo).
    process.env.GIT_TERMINAL_PROMPT = '0';

    const git = simpleGit(dir);

    // 1. init + HEAD -> main (idempotent: init on an existing repo is a no-op).
    //    Set HEAD via symbolic-ref rather than `init -b main` so it works on git
    //    < 2.28, and lands on `main` even if the repo already initialized as
    //    `master`.
    if (!isGitRepo(dir)) await git.init();
    await git.raw(['symbolic-ref', 'HEAD', 'refs/heads/main']);

    // 2. origin — add only when absent, so a re-run keeps the existing remote.
    const remotes = await git.getRemotes(true);
    if (!remotes.some((r) => r.name === 'origin')) {
      await git.raw(['remote', 'add', 'origin', trimmed]);
    }

    // 3-4. fetch, plant the local main on origin/main, set upstream.
    await git.raw(['fetch', 'origin', 'main']);
    await git.raw(['update-ref', 'refs/heads/main', 'origin/main']);
    await git.raw(['branch', '--set-upstream-to=origin/main', 'main']);

    // 5. index = origin/main, working tree untouched.
    await git.raw(['read-tree', 'origin/main']);

    // 6. Materialize only the tracked files MISSING on disk. Passing the explicit
    //    missing set (never `checkout-index -a`) guarantees no existing local
    //    file — a stub agents.yaml, a modified rule — is overwritten. Chunked to
    //    stay under the argv limit on a cold box where most files are missing.
    const tracked = (await git.raw(['ls-files', '-z'])).split('\0').filter(Boolean);
    const missing = tracked.filter((rel) => !fs.existsSync(path.join(dir, rel)));
    for (let i = 0; i < missing.length; i += 500) {
      await git.raw(['checkout-index', '-f', '--', ...missing.slice(i, i + 500)]);
    }

    // 7. Reconcile a stale-stub top-level agents.yaml from origin/main. `restore`
    //    is plumbing the git-guard allows; it rewrites only this one path.
    let reconciledAgentsYaml = false;
    let agentsYamlBackup: string | undefined;
    if (tracked.includes('agents.yaml')) {
      const abs = path.join(dir, 'agents.yaml');
      const local = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : '';
      const committed = await git.raw(['show', 'origin/main:agents.yaml']);
      if (isStaleAgentsYamlStub(local, committed)) {
        // The stub heuristic can't perfectly distinguish a partial-install stub
        // from a user who deliberately removed a whole block, so save the local
        // copy to gitignored runtime state BEFORE restoring — a false positive is
        // then recoverable and surfaced, never silent data loss.
        if (local) {
          agentsYamlBackup = path.join(dir, '.history', 'agents.yaml.pre-adopt.bak');
          fs.mkdirSync(path.dirname(agentsYamlBackup), { recursive: true });
          fs.writeFileSync(agentsYamlBackup, local);
        }
        await git.raw(['restore', '--source=origin/main', '--', 'agents.yaml']);
        reconciledAgentsYaml = true;
      }
    }

    // Surface — never silently keep — any tracked path whose local copy still
    // differs from origin/main after the reconcile (real un-gitignored edits).
    const dirty = (await git.raw(['status', '--porcelain', '--untracked-files=no']))
      .split('\n')
      .map((l) => l.slice(3).trim())
      .filter(Boolean);

    installGithooksSymlinks(dir);
    recordUserRepoRemote(dir, trimmed);

    const commit = (await git.raw(['rev-parse', '--short', 'HEAD'])).trim();
    return {
      success: true,
      commit,
      materialized: missing.length,
      reconciledAgentsYaml,
      ...(agentsYamlBackup ? { agentsYamlBackup } : {}),
      localEdits: dirty,
    };
  } catch (err) {
    return { ...empty, error: (err as Error).message };
  }
}

/**
 * Self-heal entry point for the USER config repo: when `dir` is not a git repo
 * (or is a repo with no `origin`), resolve its remote URL and adopt it in place;
 * otherwise return null (nothing to adopt — the normal sync path runs). Returns a
 * failed result carrying `needsUrl` when the URL cannot be resolved, so the
 * caller can print the `agents repo pull user <git-url>` remediation instead of
 * the old "Not a git repo" crash.
 */
export async function adoptUserRepoIfNeeded(
  dir: string,
  opts: { explicitUrl?: string } = {},
): Promise<(AdoptInPlaceResult & { needsUrl?: boolean }) | null> {
  const hasOrigin = isGitRepo(dir) && readOriginUrl(dir) !== null;
  if (hasOrigin) return null;

  const url = opts.explicitUrl?.trim() || resolveUserRepoRemoteUrl(dir);
  if (!url) {
    return {
      success: false,
      commit: '',
      materialized: 0,
      reconciledAgentsYaml: false,
      localEdits: [],
      needsUrl: true,
      error: `${displayHomePath(dir)} is not a git repo and no remote URL is known.`,
    };
  }
  return adoptRepoInPlace(dir, url);
}

/**
 * Check if the repo's origin points to the system repo — `phnx-labs/.agents-system`
 * or its GitHub rename target `phnx-labs/.agents` (PHNX-3394), across any
 * transport form. Reads the dir's origin and delegates the match to the pure
 * {@link isSystemRepoRemote}.
 */
export async function isSystemRepoOrigin(dir: string): Promise<boolean> {
  try {
    const git = simpleGit(dir);
    const remotes = await git.getRemotes(true);
    const origin = remotes.find(r => r.name === 'origin');
    return isSystemRepoRemote(origin?.refs?.fetch);
  } catch {
    /* not a git repo or no remotes */
    return false;
  }
}

/**
 * Render an absolute path in ~-relative form with forward slashes, matching the
 * way the rest of the CLI prints home-anchored paths (e.g. `~/.agents/.system`).
 */
export function displayHomePath(dir: string): string {
  const home = os.homedir();
  const rel = dir.startsWith(home) ? '~' + dir.slice(home.length) : dir;
  return rel.replace(/\\/g, '/');
}

/**
 * Pull changes in an existing repo.
 * A dirty working tree no longer refuses outright: a fast-forward that touches
 * no uncommitted path still runs (see `dirtyTreeRefusal`). It refuses when the
 * branch has local commits to rebase, or when an incoming path is also dirty.
 *
 * Strategy (RUSH-2282):
 *   1. Fetch, then compare HEAD to the resolved tracking ref.
 *   2. Clean behind-only (HEAD is an ancestor of tracking) → `merge --ff-only`
 *      against the tracking ref. Never re-enter `git pull` after a bare fetch —
 *      multi-entry FETCH_HEAD (concurrent fetch, multi-branch remote) makes
 *      `git pull --rebase` die with "Cannot rebase onto multiple branches" even
 *      when the checkout is a pure fast-forward.
 *   3. Genuinely diverged (local commits not on tracking) → `rebase` onto the
 *      tracking ref (same outcome as {@link syncRepoGit}, without a second pull).
 */
export interface PullRepoOptions {
  /**
   * `'default-branch-fast-forward'` — strict mode for `projects pull`:
   *   - Blocks immediately if the tree is dirty (no remote read needed).
   *   - Fetches origin, resolves the remote default branch, and refuses if the
   *     current branch is not the remote default.
   *   - Refuses if HEAD is ahead of the upstream (local commits not on remote).
   *   - Fast-forwards only (`merge --ff-only`). NEVER rebases.
   *   - NEVER installs git hook symlinks (read-only model path).
   *
   * `'preserve-local'` (default) — the existing behavior: tolerates dirty trees
   * when the incoming diff does not collide, and rebases a diverged branch.
   */
  mode?: 'preserve-local' | 'default-branch-fast-forward';
}

export async function pullRepo(
  dir: string,
  options: PullRepoOptions = {},
): Promise<{ success: boolean; commit: string; error?: string; branch?: string }> {
  const strict = options.mode === 'default-branch-fast-forward';
  try {
    const git = simpleGit(dir);

    // A rebase left in progress by an earlier run must be reported as itself.
    // Without this the dirty-tree guard below claims "Blocked by local changes",
    // which is both wrong and actively harmful advice mid-rebase on a detached
    // HEAD.
    // Ask git where the state dirs live rather than assuming `<dir>/.git/` is a
    // directory. In a worktree `.git` is a FILE containing `gitdir: <path>`, so
    // path.join(dir, '.git', 'rebase-merge') can never exist and the check would
    // silently never fire. `rev-parse --git-path` resolves both layouts.
    const gitPath = async (name: string): Promise<string | null> => {
      try {
        const raw = (await git.raw(['rev-parse', '--git-path', name])).trim();
        return path.isAbsolute(raw) ? raw : path.join(dir, raw);
      } catch {
        return null;
      }
    };
    const [rebaseMerge, rebaseApply] = await Promise.all([
      gitPath('rebase-merge'),
      gitPath('rebase-apply'),
    ]);
    const rebaseInProgress =
      (rebaseMerge !== null && fs.existsSync(rebaseMerge)) ||
      (rebaseApply !== null && fs.existsSync(rebaseApply));
    if (rebaseInProgress) {
      return {
        success: false,
        commit: '',
        error:
          `A previous rebase is still in progress — finish or abort it, then pull again.\n\n` +
          `  cd ${displayHomePath(dir)} && git status\n` +
          `  git rebase --continue   # after resolving\n` +
          `  git rebase --abort      # to discard the attempt`,
      };
    }

    const status = await git.status();
    // Strict mode (projects pull): refuse a dirty tree immediately — no fetch
    // needed to know the answer, and the caller must not risk touching staged
    // or modified files with an incoming fast-forward.
    const isDirty = !status.isClean();
    if (strict && isDirty) {
      return {
        success: false,
        commit: '',
        error: `Blocked: dirty working tree. Commit or discard local changes before pulling.\n\n  cd ${displayHomePath(dir)} && git status`,
      };
    }
    // A dirty tree is not decided here: whether a fast-forward is safe depends
    // on what is actually incoming, and that needs a fetched upstream ref. The
    // gate therefore sits just before the integrate step below. The exception is
    // a repo with no remote at all — there is nothing to fast-forward from, so
    // the dirt is the whole answer and the resolution below would only fail
    // with a less useful message.
    if (!strict && isDirty && (await git.getRemotes()).length === 0) {
      return {
        success: false,
        commit: '',
        error: `Blocked by local changes: the repo has no remote to pull from. Commit or discard them before pulling.\n\n  cd ${displayHomePath(dir)} && git status`,
      };
    }

    const branch = status.current || 'main';

    // Resolve the upstream ref to fast-forward against.
    // Strict mode: always fetch origin and resolve its default branch — then
    // verify the current branch IS the remote default (refuse otherwise).
    // Preserve-local mode: prefer the local branch's tracking config; only
    // fetch when no tracking is set.
    let tracking = status.tracking;
    if (strict || !tracking) {
      try {
        await git.fetch('origin');
        await git.raw(['remote', 'set-head', 'origin', '--auto']);
        const sym = await git.raw(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
        tracking = sym.trim();
      } catch {
        tracking = `origin/${branch}`;
      }
    }
    // Strict: the checkout must be on the remote default branch — never pull a
    // feature branch across the fleet unattended.
    if (strict) {
      const sep = tracking.indexOf('/');
      const expectedBranch = sep > 0 ? tracking.slice(sep + 1) : tracking;
      if (branch !== expectedBranch) {
        return {
          success: false,
          commit: '',
          error: `Blocked: HEAD is on "${branch}" but origin defaults to "${expectedBranch}". Switch to "${expectedBranch}" before pulling.`,
        };
      }
    }

    // Split the remote-tracking ref (<remote>/<branch>) so callers/logs can name
    // the remote. Branch names may contain slashes, so split on the FIRST
    // separator only. The integrate step below uses `tracking` directly (not a
    // second `git pull <remote> <branch>`) so a multi-entry FETCH_HEAD cannot
    // turn a clean fast-forward into "Cannot rebase onto multiple branches".
    const sep = tracking.indexOf('/');
    const remoteBranch = sep > 0 ? tracking.slice(sep + 1) : branch;
    // Keep branch-name validation on the ref we would have passed to pull —
    // rejects traversal / flag-smuggling shapes before any integrate command.
    assertValidBranchName(remoteBranch);

    // Bare fetch: updates every remote, so the revparse below sees a fresh ref
    // whichever one the branch tracks. Deliberately argument-less — simple-git's
    // fetchTask only forwards a remote when BOTH remote and branch are passed,
    // so `fetch(remoteName)` would silently drop the argument and do exactly
    // this anyway. Saying so beats an inert argument that reads as targeted.
    await git.fetch();

    const localRef = await git.revparse(['HEAD']);
    const remoteRef = await git.revparse([tracking]).catch(() => null);
    if (!remoteRef) {
      return { success: false, commit: '', error: `Could not resolve upstream ref ${tracking}` };
    }

    if (localRef === remoteRef) {
      const log = await git.log({ maxCount: 1 });
      return {
        success: true,
        commit: log.latest?.hash.slice(0, 8) || 'unknown',
        branch,
      };
    }

    // Behind-only when tracking has commits we lack AND we have none of our own
    // on top. Use rev-list counts — simple-git does not reject on the exit-1
    // that `merge-base --is-ancestor` returns for a non-ancestor, so a try/catch
    // around that call would always report "can ff" (RUSH-2282).
    const aheadCount = parseInt(
      (await git.raw(['rev-list', '--count', `${tracking}..HEAD`])).trim(),
      10,
    );
    const behindCount = parseInt(
      (await git.raw(['rev-list', '--count', `HEAD..${tracking}`])).trim(),
      10,
    );
    // Both counts are the ONLY inputs to the fast-forward decision, so a count
    // we cannot read is a refusal, not a reason to guess. Fail here rather than
    // downstream: an unreadable count used to fall through to the rebase arm in
    // preserve-local mode, and to a "HEAD diverged" message in strict mode that
    // named the wrong cause.
    if (!Number.isFinite(aheadCount) || !Number.isFinite(behindCount)) {
      return {
        success: false,
        commit: '',
        error: `Could not read how far HEAD is from ${tracking} — 'git rev-list --count' returned no usable count. Check the checkout, then pull again:\n\n  cd ${displayHomePath(dir)} && git status`,
      };
    }

    const canFastForward = aheadCount === 0 && behindCount > 0;

    // Strict: block if HEAD has local commits not on the remote — fast-forward
    // requires the local tip to be an ancestor of the remote tip.
    if (strict && aheadCount > 0) {
      return {
        success: false,
        commit: '',
        error: `Blocked: HEAD is ${aheadCount} commit${aheadCount === 1 ? '' : 's'} ahead of ${tracking}. Push or discard local commits before pulling.`,
      };
    }

    // Dirty tree (preserve-local only): same rule `syncRepoGit` applies —
    // a fast-forward that touches nothing the author is holding may proceed; a
    // rebase or a colliding path may not. Strict mode already refused above.
    if (!strict && isDirty) {
      const refusal = await dirtyTreeRefusal(git, status, tracking);
      if (refusal) {
        return {
          success: false,
          commit: '',
          error: `Blocked by local changes: ${refusal}. Commit or discard them before pulling.\n\n  cd ${displayHomePath(dir)} && git status`,
        };
      }
    }

    try {
      if (canFastForward) {
        // Integrate the already-fetched tracking ref. No network, no FETCH_HEAD.
        await git.raw(['merge', '--ff-only', tracking]);
      } else {
        // Diverged (or local-only commits). Rebase onto the tracking tip —
        // same outcome as `git pull --rebase <remote> <branch>` without
        // re-fetching or consulting FETCH_HEAD.
        //
        // PRESERVE-LOCAL ONLY — strict mode can never reach this arm, so the
        // fleet pull never rewrites history. Strict has already returned for
        // every case that leaves `canFastForward` false: an identical local and
        // remote ref, `aheadCount > 0` (which is also what "diverged" means),
        // and a count that would not parse. That leaves `aheadCount === 0` with
        // a differing ref, i.e. `behindCount > 0` — a fast-forward. Keep those
        // three returns above intact if you change this.
        await git.raw(['rebase', tracking]);
      }
    } catch (err) {
      // Abort so the tree is restored, matching the atomicity --ff-only gave us.
      // Without this a conflict leaves the repo detached, mid-rebase, with
      // conflict markers written into live config (this repo is ~/.agents —
      // agents.yaml and AGENTS.md are in it), and every later pull misreports
      // the cause. `agents sync` reaches this path unattended across the fleet,
      // so a wedged checkout would be worse than the bug this fixes.
      await git.raw(['rebase', '--abort']).catch(() => { /* not mid-rebase */ });
      const verb = canFastForward ? 'Fast-forward' : 'Rebase';
      return {
        success: false,
        commit: '',
        error: `${verb} onto ${tracking} failed — the pull was rolled back, nothing changed.\n\nResolve the divergence, then pull again:\n\n  cd ${displayHomePath(dir)} && git log --oneline HEAD...${tracking}\n\n${(err as Error).message}`,
      };
    }

    // Strict mode never installs git hook symlinks — the command is a read-model
    // operation (update pointers only; never reconfigure the checkout).
    if (!strict) installGithooksSymlinks(dir);

    const log = await git.log({ maxCount: 1 });
    return {
      success: true,
      commit: log.latest?.hash.slice(0, 8) || 'unknown',
      branch,
    };
  } catch (err) {
    return { success: false, commit: '', error: (err as Error).message };
  }
}

/**
 * Every repo-relative path a status reports as locally touched, in one set.
 *
 * Reads `status.files`, which `simple-git` documents as "all files" and which is
 * the same source `isClean()` is computed from — so this set and the decision to
 * treat the tree as dirty can never disagree. The per-category arrays
 * (`modified`, `staged`, `not_added`, …) are projections of that list; unioning
 * them by hand means a category nobody thought of contributes nothing. `from`
 * carries a rename's original path, and the incoming side may collide with
 * either end.
 */
function dirtyPathSet(status: { files: Array<{ path: string; from?: string }> }): Set<string> {
  const out = new Set<string>();
  for (const f of status.files || []) {
    if (f?.path) out.add(f.path);
    if (f?.from) out.add(f.from);
  }
  return out;
}

/**
 * Why a dirty working tree must NOT fast-forward to `upstreamRef` — or `null`
 * when it safely can.
 *
 * The single home for that decision: `syncRepoGit` and `pullRepo` both integrate
 * upstream and both meet dirty trees, and two copies of this rule would drift
 * into two different answers for one question. Refusing outright is the thing
 * being replaced — it strands merged changes behind unrelated local files —
 * so the rule is narrow and stated once:
 *
 *   - local commits ahead of upstream → refuse (they need a rebase, which
 *     requires a clean tree);
 *   - an incoming path that is also dirty → refuse, and name it;
 *   - otherwise the fast-forward touches nothing the author is holding.
 *
 * `-z` on the diff because `git diff --name-only` C-quotes paths containing
 * unicode or control characters — `café.txt` comes back as `"caf\303\251.txt"`,
 * while `status.files` reports it raw. Without `-z` the two sides are in
 * different encodings and a collision on such a path silently misses. (A plain
 * space does NOT trigger quoting; `my file.txt` is emitted as-is either way.)
 */
async function dirtyTreeRefusal(
  git: SimpleGit,
  status: { files: Array<{ path: string; from?: string }> },
  upstreamRef: string,
): Promise<string | null> {
  const ahead = parseInt(
    (await git.raw(['rev-list', '--count', `${upstreamRef}..HEAD`])).trim(),
    10,
  );
  if (Number.isNaN(ahead)) return 'the upstream ref could not be compared with HEAD';
  if (ahead > 0) {
    return `the branch has ${ahead} local commit(s) to rebase, which needs a clean tree`;
  }

  const dirty = dirtyPathSet(status);
  const incoming = (await git.raw(['diff', '--name-only', '-z', `HEAD..${upstreamRef}`]))
    .split('\0')
    .filter(Boolean);
  const collisions = incoming.filter((p) => dirty.has(p));
  if (collisions.length > 0) {
    // Central agents.yaml is AUTHORITATIVE (account labels/rows), not regenerable,
    // and a dirty copy always equals serializeCentral(current meta) — so no
    // byte check can tell a stranded real edit from a stale one. Refuse rather
    // than discard: it is data-safe and self-heals, because commit-on-write
    // (lib/state.ts) and the daemon's publish tick both commit agents.yaml,
    // after which the very next pull succeeds normally. See PHNX-3968.
    const shown = collisions.slice(0, 5).join(', ');
    const more = collisions.length > 5 ? ` (+${collisions.length - 5} more)` : '';
    return `incoming changes touch uncommitted paths: ${shown}${more}`;
  }
  return null;
}

/**
 * Rebase a repo onto its remote, optionally pushing local commits back up.
 *
 * The one-repo counterpart to `pullRepo` used by `agents sync <repo>`:
 *   1. `git fetch origin`.
 *   2. Clean tree → `git pull --rebase origin <branch>`: rebase, not merge, so a
 *      local commit lands cleanly on top of upstream with no merge bubble.
 *   3. Dirty tree → fast-forward instead, but only when that is provably safe:
 *      no local commits ahead of upstream, and no incoming path collides with a
 *      dirty one. Otherwise refuse, naming the paths that collided.
 *   4. When `push` is set, `git push origin <branch>` to send local commits up.
 *
 * The branch is read from the repo's current HEAD (falls back to `main`) rather
 * than hardcoded. System repos pass `push: false` — they are pull-only mirrors
 * of the npm-shipped upstream.
 *
 * Why step 3 exists: refusing on *any* dirt strands merged changes indefinitely.
 * A DotAgents repo accumulates unrelated local state — a modified `agents.yaml`,
 * a session's scratch file, a machine-local dotfile — and under the old rule one
 * such file froze that box's layer forever, silently. Measured 2026-08-10: a
 * merged fix could not reach three of three boxes, each blocked by files the
 * incoming commits never touched. A `--ff-only` merge is the safe primitive
 * here: it cannot rewrite local commits, and git itself aborts rather than
 * overwrite a modified file, so the path check is belt-and-braces, not the only
 * guard.
 */
export async function syncRepoGit(
  dir: string,
  opts: { push: boolean },
): Promise<{ success: boolean; commit: string; pushed: boolean; error?: string }> {
  try {
    if (!isGitRepo(dir)) {
      return { success: false, commit: '', pushed: false, error: `Not a git repo: ${dir}` };
    }
    const git = simpleGit(dir);
    const status = await git.status();

    const branch = status.current || 'main';
    assertValidBranchName(branch);
    await git.fetch('origin');

    if (status.isClean()) {
      await git.pull('origin', branch, { '--rebase': 'true' });
    } else {
      // Dirty tree: a rebase would refuse outright, so fast-forward instead —
      // but only when nothing local can be lost. One shared rule, see above.
      const refusal = await dirtyTreeRefusal(git, status, `origin/${branch}`);
      if (refusal) {
        return {
          success: false,
          commit: '',
          pushed: false,
          error: `Working tree has uncommitted changes and ${refusal}. Commit or discard them first.\n\n  cd ${dir} && git status`,
        };
      }
      await git.raw(['merge', '--ff-only', `origin/${branch}`]);
    }

    installGithooksSymlinks(dir);

    let pushed = false;
    if (opts.push) {
      await pushOrigin(git, branch);
      pushed = true;
    }

    const log = await git.log({ maxCount: 1 });
    return { success: true, commit: log.latest?.hash.slice(0, 8) || 'unknown', pushed };
  } catch (err) {
    return { success: false, commit: '', pushed: false, error: (err as Error).message };
  }
}

/**
 * Get git status for sync display.
 * Returns files categorized by their status relative to HEAD.
 */
interface GitSyncStatus {
  /** Tracked and unchanged files. */
  synced: string[];
  /** Modified but not staged files. */
  modified: string[];
  /** Untracked files. */
  new: string[];
  /** Staged for commit. */
  staged: string[];
  /** Deleted files. */
  deleted: string[];
}

/** Compute the sync status of a git repo, optionally scoped to a subdirectory. */
export async function getGitSyncStatus(dir: string, subdir?: string): Promise<GitSyncStatus | null> {
  if (!isGitRepo(dir)) {
    return null;
  }

  try {
    const git = simpleGit(dir);
    const status = await git.status();

    const result: GitSyncStatus = {
      synced: [],
      modified: [],
      new: [],
      staged: [],
      deleted: [],
    };

    // Filter to subdir if specified
    const filterPath = (file: string) => {
      if (!subdir) return true;
      return file.startsWith(subdir + '/') || file === subdir;
    };

    // Get all tracked files in the subdir
    const trackedOutput = await git.raw(['ls-files', subdir || '.']);
    const trackedFiles = new Set(trackedOutput.split('\n').filter(Boolean));

    // Get untracked files in the subdir
    const untrackedOutput = await git.raw(['ls-files', '--others', '--exclude-standard', subdir || '.']);
    const untrackedFiles = untrackedOutput.split('\n').filter(Boolean);

    // Working tree changes (not staged)
    const changedFiles = new Set<string>();
    for (const file of status.modified.filter(filterPath)) {
      result.modified.push(file);
      changedFiles.add(file);
    }
    for (const file of status.deleted.filter(filterPath)) {
      result.deleted.push(file);
      changedFiles.add(file);
    }

    // Staged changes (in index, ready to commit)
    for (const file of status.created.filter(filterPath)) {
      result.staged.push(file);
      changedFiles.add(file);
    }
    for (const file of status.staged.filter(filterPath)) {
      if (!result.staged.includes(file)) {
        result.staged.push(file);
        changedFiles.add(file);
      }
    }

    // Untracked files (new/local-only)
    for (const file of untrackedFiles.filter(filterPath)) {
      result.new.push(file);
    }

    // Synced = tracked and not changed
    for (const file of trackedFiles) {
      if (filterPath(file) && !changedFiles.has(file)) {
        result.synced.push(file);
      }
    }

    return result;
  } catch {
    /* git status failed */
    return null;
  }
}

/**
 * Get list of files tracked by git in a directory.
 */
export async function getTrackedFiles(dir: string, subdir?: string): Promise<string[]> {
  if (!isGitRepo(dir)) {
    return [];
  }

  try {
    const git = simpleGit(dir);
    const result = await git.raw(['ls-files', subdir || '.']);
    return result.split('\n').filter(Boolean);
  } catch {
    /* git ls-files failed */
    return [];
  }
}

/**
 * Try to auto-pull a git repo if it's clean and has a remote.
 * Uses --ff-only for safety (fails if diverged instead of creating merge commits).
 * Returns silently on success, returns error message on failure.
 */
async function tryAutoPull(dir: string): Promise<{ pulled: boolean; error?: string }> {
  // Must be a git repo
  if (!isGitRepo(dir)) {
    return { pulled: false };
  }

  try {
    const git = simpleGit(dir);

    // Must have origin remote
    const remotes = await git.getRemotes(true);
    const origin = remotes.find(r => r.name === 'origin');
    if (!origin?.refs?.fetch) {
      return { pulled: false };
    }

    // Must be clean (no uncommitted changes)
    const status = await git.status();
    if (!status.isClean()) {
      return { pulled: false, error: 'Has local changes' };
    }

    // Fetch and try fast-forward pull
    await git.fetch('origin');

    // Check if we're behind
    const localRef = await git.revparse(['HEAD']);
    const trackingBranch = status.tracking;
    if (!trackingBranch) {
      return { pulled: false };
    }

    const remoteRef = await git.revparse([trackingBranch]).catch(() => null /* remote ref unavailable */);
    if (!remoteRef || localRef === remoteRef) {
      // Already up to date
      return { pulled: false };
    }

    // Try fast-forward only pull
    await git.pull(['--ff-only']);

    return { pulled: true };
  } catch (err) {
    return { pulled: false, error: (err as Error).message };
  }
}

/** Result of {@link tryAutoPullSystemRepo}. `refused` is set only when the pull
 *  was blocked because origin is not the expected system remote. */
interface SystemRepoPullResult {
  pulled: boolean;
  error?: string;
  /** True when origin is present but is NOT the expected system remote; no
   *  fast-forward was attempted. `actualRemote` names what was found. */
  refused?: boolean;
  /** The origin fetch URL that was examined (present when a remote exists). */
  actualRemote?: string;
}

/**
 * Auto-pull the system repo ONLY after verifying its origin is the expected
 * system remote (PHNX-2957). The system repo ships hooks that run as shell on
 * tool events, so fast-forwarding it from an unexpected/repointed origin is
 * remote code execution. An origin that fails {@link isExpectedSystemRepoRemote}
 * is REFUSED loud (`refused: true`), never pulled — the canonical system repo
 * (or an operator's `AGENTS_SYSTEM_REPO`) still fast-forwards exactly as before.
 *
 * A system dir with no origin at all is a plain no-op (`pulled: false`), not a
 * refusal — there is nothing to pull from and nothing to distrust.
 */
export async function tryAutoPullSystemRepo(dir: string): Promise<SystemRepoPullResult> {
  if (!isGitRepo(dir)) return { pulled: false };

  let remote: string | undefined;
  try {
    const git = simpleGit(dir);
    const remotes = await git.getRemotes(true);
    remote = remotes.find(r => r.name === 'origin')?.refs?.fetch;
  } catch {
    return { pulled: false };
  }

  if (!remote) return { pulled: false };
  if (!isExpectedSystemRepoRemote(remote)) {
    return { pulled: false, refused: true, actualRemote: remote };
  }

  const res = await tryAutoPull(dir);
  return { ...res, actualRemote: remote };
}

/**
 * How many commits `dir`'s checked-out branch is behind its upstream, read from
 * the LAST-FETCHED remote-tracking ref — no network call. Returns null when the
 * dir is not a git repo, has no upstream configured, or git errors.
 *
 * Used by `agents doctor` to flag a source layer (`~/.agents`, `~/.agents/.system`)
 * that is reconciled against stale truth. Staleness relative to origin is a
 * background auto-pull concern; this surfaces the same fact synchronously in the
 * per-version verdict.
 */
export function commitsBehindUpstream(dir: string): { behind: number; branch: string } | null {
  if (!isGitRepo(dir)) return null;
  const run = (args: string[]): string | null => {
    try {
      return execFileSync('git', ['-C', dir, ...args], {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
      }).trim();
    } catch {
      return null;
    }
  };
  // Name of the upstream ref (e.g. `origin/main`) for the human-readable message.
  const branch = run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (!branch) return null;
  // `--count HEAD..@{upstream}` = commits on upstream not yet in HEAD = behind.
  const raw = run(['rev-list', '--count', 'HEAD..@{upstream}']);
  if (raw === null) return null;
  const behind = parseInt(raw, 10);
  if (!Number.isFinite(behind)) return null;
  return { behind, branch };
}
