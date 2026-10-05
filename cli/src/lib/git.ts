/** Git operations for the agents-cli system repo and package repositories: clone, pull, sync,
 * inspect, and source parsing (GitHub shorthand, SSH, HTTPS, local paths). */
import simpleGit, { SimpleGit } from 'simple-git';
import { execFileSync } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IS_WINDOWS, isWindowsAbsolutePath, toNativePath } from './platform/index.js';
import { getPackageLocalPath } from './state.js';
import { DEFAULT_SYSTEM_REPO, systemRepoSlug } from './types.js';

/** Validates that a clone/pull source uses a safe transport. Remote-helper transports (`ext::`,
 * `fd::`) run arbitrary commands at clone time, `file://`/`git://` are unauthenticated, and a
 * leading `-` is parsed as a flag (option injection). */
export function assertSafeGitTransport(source: string): void {
  // Only HTTPS, SSH/SCP, and local paths reach git; remote helpers can execute commands.
  const s = source.trim();

  if (s.startsWith('-')) {
    throw new Error(
      `Refusing to use git source "${source}": a source starting with "-" is interpreted as a git option.`,
    );
  }

  const helper = s.match(/^[a-zA-Z][a-zA-Z0-9+.-]*::/);
  if (helper) {
    throw new Error(
      `Refusing to use git source "${source}": git remote-helper transports (ext::, fd::, …) are not allowed.`,
    );
  }

  const scheme = s.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
  if (scheme) {
    const name = scheme[1].toLowerCase();
    if (name !== 'https' && name !== 'ssh') {
      throw new Error(
        `Refusing to use git source "${source}": "${name}://" is not an allowed transport (use https:// or ssh://).`,
      );
    }
  }
}

/** Validates a branch name before `git push`/`git pull`: a leading `-` is parsed as an option
 * (`--mirror`, `--receive-pack=...`), not a ref. Pure string check; throws if empty or
 * option-like. */
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

/** `git push origin <branch>` hardened against option injection: assertValidBranchName rejects a
 * leading `-` and `--` ends option parsing. Prefer it over `git.push` when the branch comes
 * from repo state. */
export async function pushOrigin(
  git: SimpleGit,
  branch: string,
  targetBranch?: string,
): Promise<void> {
  // Branch validation and raw `--` jointly prevent option injection; keep them paired.
  assertValidBranchName(branch);
  if (targetBranch && targetBranch !== branch) {
    assertValidBranchName(targetBranch);
    await git.raw(['push', '--', 'origin', `${branch}:${targetBranch}`]);
    return;
  }
  await git.raw(['push', '--', 'origin', branch]);
}

/** Whether installing a cloned repo's `.githooks/` is enabled. Installed hooks run on the next
 * commit/checkout/merge, and a repo added via `agents repo add` is untrusted, so auto-install
 * would be remote code execution; explicit opt-in via `AGENTS_ENABLE_GITHOOKS=1`. */
function githooksEnabled(): boolean {
  // Cloned hooks execute code, so installation is explicit opt-in for trusted repos.
  const v = process.env.AGENTS_ENABLE_GITHOOKS;
  return v === '1' || v === 'true';
}

/** Installs `.githooks/` by symlinking each entry into `.git/hooks/`, gated behind
 * `AGENTS_ENABLE_GITHOOKS=1` since the source may be untrusted. Symlinks rather than
 * `core.hooksPath`, a known sandbox-escape vector that some sandboxes (e.g. Claude Code) block. */
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

  // Repo-local symlinks preserve the sandbox boundary; never set core.hooksPath.
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
      if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
    }
  }
}

interface GitSource {
  type: 'github' | 'url' | 'local';
  url: string;
  ref?: string;
}

/** Parses a source string into a GitSource. */
export function parseSource(source: string): GitSource {
  let ref: string | undefined;
  let cleanSource = source;

  const atIndex = source.lastIndexOf('@');
  if (atIndex > 0 && !source.startsWith('git@') && !source.slice(0, atIndex).includes('://')) {
    const possibleRef = source.slice(atIndex + 1);
    if (possibleRef && !possibleRef.includes('/') && !possibleRef.includes(':')) {
      ref = possibleRef;
      cleanSource = source.slice(0, atIndex);
    }
  }

  if (cleanSource.startsWith('gh:')) {
    const repo = cleanSource.slice(3).replace(/\.git$/, '');
    return {
      type: 'github',
      url: `https://github.com/${repo}.git`,
      ref: ref || 'main',
    };
  }

  if (cleanSource.startsWith('git@github.com:')) {
    const repo = cleanSource.slice(15).replace(/\.git$/, '');
    return {
      type: 'github',
      url: `https://github.com/${repo}.git`,
      ref: ref || 'main',
    };
  }

  if (cleanSource.startsWith('github.com:')) {
    const repo = cleanSource.slice(11).replace(/\.git$/, '');
    return {
      type: 'github',
      url: `https://github.com/${repo}.git`,
      ref: ref || 'main',
    };
  }

  if (cleanSource.startsWith('github.com/')) {
    const repo = cleanSource.slice(11).replace(/\.git$/, '');
    return {
      type: 'github',
      url: `https://github.com/${repo}.git`,
      ref: ref || 'main',
    };
  }

  if (cleanSource.startsWith('http://') || cleanSource.startsWith('https://')) {
    const githubMatch = cleanSource.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
    if (githubMatch) {
      return {
        type: 'github',
        url: `https://github.com/${githubMatch[1]}.git`,
        ref: ref || 'main',
      };
    }

    assertSafeGitTransport(cleanSource);
    return {
      type: 'url',
      url: cleanSource.endsWith('.git') ? cleanSource : `${cleanSource}.git`,
      ref,
    };
  }

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

  if (fs.existsSync(cleanSource)) {
    return {
      type: 'local',
      url: path.resolve(cleanSource),
    };
  }

  if (cleanSource.includes('/') && !cleanSource.includes(':') && !cleanSource.includes('.')) {
    const repo = cleanSource.replace(/\.git$/, '');
    return {
      type: 'github',
      url: `https://github.com/${repo}.git`,
      ref: ref || 'main',
    };
  }

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

export async function getRepoCommit(repoPath: string): Promise<string> {
  try {
    const git = simpleGit(repoPath);
    const log = await git.log({ maxCount: 1 });
    return log.latest?.hash.slice(0, 8) || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Compact state of a git repo (branch, short HEAD, dirty flag) for cross-device comparison
 * (RUSH-2027). Synchronous and best-effort: a non-repo or unreadable path yields `null` fields,
 * never a throw, so a device's `doctor --json` always serializes. */
interface RepoStateSnapshot {
  branch: string | null;
  head: string | null;
  dirty: boolean;
}

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
  if (runGit(['rev-parse', '--is-inside-work-tree']) !== 'true') return null;
  const branchRaw = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchRaw && branchRaw !== 'HEAD' ? branchRaw : null;
  const headRaw = runGit(['rev-parse', 'HEAD']);
  const head = headRaw ? headRaw.slice(0, 8) : null;
  const porcelain = runGit(['status', '--porcelain']);
  const dirty = porcelain != null && porcelain.length > 0;
  return { branch, head, dirty };
}

const _snapshotShaCache = new Map<string, string | undefined>();

/** The short HEAD sha of the repo at `repoRoot`, for provenance of which commit a
 * resource/plugin resolved from. `undefined` when not a git repo or no commits, never a throw. */
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

export function _resetSnapshotShaCacheForTest(): void {
  _snapshotShaCache.clear();
}

export async function getRemoteUrl(repoPath: string): Promise<string | null> {
  try {
    const git = simpleGit(repoPath);
    const remotes = await git.getRemotes(true);
    const origin = remotes.find(r => r.name === 'origin');
    return origin?.refs?.fetch || origin?.refs?.push || null;
  } catch {
    return null;
  }
}

/** Canonical `host/owner/repo` form of a git remote, transport-agnostic so SSH and HTTPS clones
 * compare equal: strips protocol, `user@` and `.git`, folds the scp-style colon to a slash,
 * lower-cases. */
export function canonicalGitRemote(url: string): string {
  const canonical = url
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(':', '/')
    .toLowerCase();
  return RENAMED_REMOTE_ALIASES[canonical] ?? canonical;
}

/** Remotes that denote the same repository under an old and new name, keyed by canonical
 * `host/owner/repo`: `phnx-labs/.agents-system` was renamed `phnx-labs/.agents` (PHNX-3394)
 * while DEFAULT_SYSTEM_REPO keeps the old slug (GitHub redirects). */
const RENAMED_REMOTE_ALIASES: Record<string, string> = {
  'github.com/phnx-labs/.agents': 'github.com/phnx-labs/.agents-system',
};

/** True when a git remote URL (any transport) points at the system DotAgents repo:
 * DEFAULT_SYSTEM_REPO's slug or its `phnx-labs/.agents` rename (PHNX-3394), folded by
 * canonicalGitRemote. */
export function isSystemRepoRemote(remote: string | null | undefined): boolean {
  if (!remote) return false;
  const c = canonicalGitRemote(remote);
  return c === canonicalGitRemote(`https://github.com/${systemRepoSlug(DEFAULT_SYSTEM_REPO)}`);
}

/** True when `remote` is the origin the system repo is expected to track, honouring an
 * `AGENTS_SYSTEM_REPO` override. Every system-repo auto-pull checks this: its hooks run as shell,
 * so fast-forwarding from a repointed origin or fork is remote code execution (PHNX-2957). */
export function isExpectedSystemRepoRemote(remote: string | null | undefined): boolean {
  // Automatic pulls are trusted only from the canonical or operator-selected system origin.
  if (!remote) return false;
  const override = process.env.AGENTS_SYSTEM_REPO?.trim();
  if (override) {
    return (
      sameGitRemote(remote, `https://github.com/${systemRepoSlug(override)}`) ||
      sameGitRemote(remote, override.replace(/^gh:/, ''))
    );
  }
  return isSystemRepoRemote(remote);
}

export function sameGitRemote(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return canonicalGitRemote(a) === canonicalGitRemote(b);
}

type CommitAndPushResult = {
  success: boolean;
  error?: string;
  detail?: string;
  branch?: string;
  committed?: boolean;
  pushed?: boolean;
};

/** Commits (if dirty) and pushes a repo. A clean tree with local ahead of origin still pushes;
 * "already up to date" is reported only when `ahead === 0` and nothing to commit. */
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
    const pushedBranch = targetBranch || branch;

    let committed = false;
    if (status.files.length > 0) {
      await git.add('-A');
      await git.commit(message);
      committed = true;
      status = await git.status();
    }

    const ahead = status.ahead ?? 0;
    if (!committed && ahead === 0 && pushedBranch === branch) {
      return {
        success: true,
        detail: 'already up to date',
        branch,
        committed: false,
        pushed: false,
      };
    }

    let before = '';
    try {
      before = (await git.raw(['rev-parse', '--short=8', `origin/${pushedBranch}`])).trim();
    } catch {
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

export async function hasUncommittedChanges(repoPath: string): Promise<boolean> {
  try {
    const git = simpleGit(repoPath);
    const status = await git.status();
    return status.files.length > 0;
  } catch {
    return false;
  }
}

/** Whether `dir` is a git repository: synchronous and root-only (checks for a `.git` entry
 * directly under `dir`), so false in a subdirectory. Deliberate: system-repo sync callers pass
 * a known root. */
export function isGitRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'));
}

/** Absolute path of the git working-tree root containing `dir`, via `git rev-parse
 * --show-toplevel` (works from subdirectories and linked worktrees). Throws outside a repo. */
export async function getGitRoot(dir: string): Promise<string> {
  const root = await simpleGit(dir).revparse(['--show-toplevel']);
  return toNativePath(root.trim());
}

/** Absolute path of the main working-tree root for `dir`. Unlike getGitRoot it stays correct in
 * a linked worktree, where `--show-toplevel` returns the worktree's path: `--git-common-dir`
 * always points at the primary `.git`. Throws outside a repo; */
export async function getMainRepoRoot(dir: string): Promise<string> {
  const common = await simpleGit(dir).raw(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return toNativePath(path.dirname(common.trim()));
}

export async function initRepo(dir: string): Promise<void> {
  const git = simpleGit(dir);
  await git.init();
}

/** Clones a repo into an existing directory (for initializing ~/.agents/): clones to a temp dir,
 * moves .git, then checks out tracked files. */
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
    fs.mkdirSync(tempDir, { recursive: true });
    await git.clone(parsed.url, tempDir);

    const repoGit = simpleGit(tempDir);
    if (parsed.ref) {
      await repoGit.checkout(parsed.ref);
    }

    const gitDir = path.join(tempDir, '.git');
    const targetGitDir = path.join(targetDir, '.git');
    if (fs.existsSync(targetGitDir)) {
      fs.rmSync(targetGitDir, { recursive: true });
    }
    fs.renameSync(gitDir, targetGitDir);

    fs.rmSync(tempDir, { recursive: true });

    const targetGit = simpleGit(targetDir);
    await targetGit.checkout('.');

    installGithooksSymlinks(targetDir);

    const log = await targetGit.log({ maxCount: 1 });

    return {
      success: true,
      commit: log.latest?.hash.slice(0, 8) || 'unknown',
    };
  } catch (err) {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
    return { success: false, commit: '', error: (err as Error).message };
  }
}

/** Git-backs an existing populated directory from a remote without deleting local files, so
 * `agents repo pull/push` and `agents sync` work on a box setup only `mkdirSync`ed. Tracked files
 * differing locally are first backed up to sibling `<dir>.pre-adopt-backup/` (outside the repo). */
export async function adoptRepo(
  source: string,
  targetDir: string,
): Promise<{ success: boolean; commit: string; backupDir?: string; backedUp: string[]; error?: string }> {
  const trimmed = source.trim();
  if (fs.existsSync(path.join(targetDir, '.git'))) {
    return { success: false, commit: '', backedUp: [], error: 'Already a git repo — nothing to adopt' };
  }

  // Preserve the user's transport: `parseSource` throws on `ssh://` and non-github `git@host:`
  // URLs and rewrites `git@github.com:x` to https, breaking SSH-key auth. Clone SSH URLs as-is;
  // parse the rest inside the try so a malformed URL returns an error, not a stack trace.
  const isSsh = trimmed.startsWith('git@') || trimmed.startsWith('ssh://');
  const tempDir = path.join(targetDir, '.git-adopt-temp');
  try {
    let cloneUrl: string;
    let ref: string | undefined;
    if (isSsh) {
      cloneUrl = trimmed;
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
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });

    // Clone to temp, then move its .git in so index equals remote HEAD.
    process.env.GIT_TERMINAL_PROMPT = '0';
    await simpleGit().clone(cloneUrl, tempDir);
    const repoGit = simpleGit(tempDir);
    if (ref) await repoGit.checkout(ref);
    fs.renameSync(path.join(tempDir, '.git'), path.join(targetDir, '.git'));
    fs.rmSync(tempDir, { recursive: true, force: true });

    const targetGit = simpleGit(targetDir);

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

    await targetGit.checkout('.');
    installGithooksSymlinks(targetDir);

    const log = await targetGit.log({ maxCount: 1 });
    return { success: true, commit: log.latest?.hash.slice(0, 8) || 'unknown', backupDir, backedUp };
  } catch (err) {
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    return { success: false, commit: '', backedUp: [], error: (err as Error).message };
  }
}


/** Device-local record of the user config repo's remote URL, kept outside the git tree
 * (`.history/` is gitignored) so it survives a lost `.git`, letting `agents repo sync user`
 * adopt in place without the operator re-typing the URL. */
function userRepoRemoteRecordPath(dir: string): string {
  return path.join(dir, '.history', 'user-repo-remote.json');
}

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

/** Persists the user repo's remote URL to device-local runtime state so a later adopt-in-place
 * can recover it after a `.git` loss. Best-effort; a write failure never blocks a sync. */
export function recordUserRepoRemote(dir: string, url: string): void {
  try {
    const file = userRepoRemoteRecordPath(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ url }, null, 2) + '\n', { mode: 0o600 });
  } catch {
  }
}

/** Resolves the user config repo's remote URL without hardcoding it, in priority order: an
 * existing `origin` on the dir; the `AGENTS_USER_REPO_URL` env override; the device-local
 * record from a prior healthy sync. */
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
  }
  return null;
}

/** Decides whether a local top-level `agents.yaml` is a stale install stub to restore from the
 * committed copy or a customized file to preserve. A stub is shorter and lacks `config:`/`hooks:`;
 * device settings live in `devices/<host>/agents.yaml`, so restoring the top-level file is safe. */
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
  materialized: number;
  reconciledAgentsYaml: boolean;
  /** The path the pre-reconcile local agents.yaml was saved to first, so even a false-positive
   * stub match (e.g. a deliberately removed block) is recoverable. */
  agentsYamlBackup?: string;
  /** Tracked paths whose local copy differs from origin/main and was not touched: local edits
   * surfaced rather than silently overwritten. */
  localEdits: string[];
  error?: string;
}

/** Adopts an existing non-git `~/.agents` in place (PHNX-3301 self-heal): git-backs it without
 * re-cloning or destroying gitignored runtime state. Plumbing only, so the git-guard never trips;
 * missing tracked files are materialized, existing ones never overwritten (edits in localEdits). */
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
    // The URL is always a resolved git remote (origin, env or record), never a `gh:` shorthand, so
    // skip parseSource (it throws on ssh:// and rewrites git@github to https, breaking SSH-key-only
    // auth). assertSafeGitTransport still blocks ext::, file:// and option injection.
    assertSafeGitTransport(trimmed);
    if (!fs.existsSync(dir)) {
      return { ...empty, error: `Target directory does not exist: ${dir}` };
    }
    process.env.GIT_TERMINAL_PROMPT = '0';

    const git = simpleGit(dir);

    // init + HEAD to main (idempotent). Set HEAD via symbolic-ref rather than `init -b main` so it
    // works on git < 2.28 and lands on `main` even if the repo was initialized as `master`.
    if (!isGitRepo(dir)) await git.init();
    await git.raw(['symbolic-ref', 'HEAD', 'refs/heads/main']);

    const remotes = await git.getRemotes(true);
    if (!remotes.some((r) => r.name === 'origin')) {
      await git.raw(['remote', 'add', 'origin', trimmed]);
    }

    await git.raw(['fetch', 'origin', 'main']);
    await git.raw(['update-ref', 'refs/heads/main', 'origin/main']);
    await git.raw(['branch', '--set-upstream-to=origin/main', 'main']);

    await git.raw(['read-tree', 'origin/main']);

    // Materialize only the tracked files missing on disk. Passing the explicit missing set (never
    // `checkout-index -a`) guarantees no existing local file is overwritten. Chunked to stay under
    // the argv limit on a cold box where most files are missing.
    const tracked = (await git.raw(['ls-files', '-z'])).split('\0').filter(Boolean);
    const missing = tracked.filter((rel) => !fs.existsSync(path.join(dir, rel)));
    for (let i = 0; i < missing.length; i += 500) {
      await git.raw(['checkout-index', '-f', '--', ...missing.slice(i, i + 500)]);
    }

    let reconciledAgentsYaml = false;
    let agentsYamlBackup: string | undefined;
    if (tracked.includes('agents.yaml')) {
      const abs = path.join(dir, 'agents.yaml');
      const local = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : '';
      const committed = await git.raw(['show', 'origin/main:agents.yaml']);
      if (isStaleAgentsYamlStub(local, committed)) {
        // The stub heuristic cannot perfectly distinguish a partial-install stub from a
        // deliberately removed block, so save the local copy to gitignored runtime state before
        // restoring; a false positive is recoverable and surfaced.
        if (local) {
          agentsYamlBackup = path.join(dir, '.history', 'agents.yaml.pre-adopt.bak');
          fs.mkdirSync(path.dirname(agentsYamlBackup), { recursive: true });
          fs.writeFileSync(agentsYamlBackup, local);
        }
        await git.raw(['restore', '--source=origin/main', '--', 'agents.yaml']);
        reconciledAgentsYaml = true;
      }
    }

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

/** Self-heal entry point for the user config repo: when `dir` is not a repo (or has no
 * `origin`), resolve its remote URL and adopt in place, else null. */
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

/** Checks whether the repo's origin points to the system repo (`phnx-labs/.agents-system` or its
 * rename `phnx-labs/.agents`, PHNX-3394), any transport. Reads the dir's origin and delegates
 * to the pure isSystemRepoRemote. */
export async function isSystemRepoOrigin(dir: string): Promise<boolean> {
  try {
    const git = simpleGit(dir);
    const remotes = await git.getRemotes(true);
    const origin = remotes.find(r => r.name === 'origin');
    return isSystemRepoRemote(origin?.refs?.fetch);
  } catch {
    return false;
  }
}

/** Renders an absolute path in ~-relative form with forward slashes, matching how the CLI prints
 * home-anchored paths (e.g. `~/.agents/.system`). */
export function displayHomePath(dir: string): string {
  const home = os.homedir();
  const rel = dir.startsWith(home) ? '~' + dir.slice(home.length) : dir;
  return rel.replace(/\\/g, '/');
}

/** Pulls changes in an existing repo. A dirty tree no longer refuses outright: a fast-forward
 * touching no uncommitted path still runs (`dirtyTreeRefusal`). RUSH-2282: after fetch, use
 * `merge --ff-only` or rebase onto the tracking ref; never `git pull` (multi-entry FETCH_HEAD). */
export interface PullRepoOptions {
  /** `'default-branch-fast-forward'` is strict mode for `projects pull`: blocks on a dirty tree,
   * refuses unless the current branch is the remote default or HEAD is ahead of upstream,
   * fast-forwards only (never rebases), and never installs hook symlinks. */
  mode?: 'preserve-local' | 'default-branch-fast-forward';
}

export async function pullRepo(
  dir: string,
  options: PullRepoOptions = {},
): Promise<{ success: boolean; commit: string; error?: string; branch?: string }> {
  const strict = options.mode === 'default-branch-fast-forward';
  try {
    const git = simpleGit(dir);

    // A rebase left in progress by an earlier run must be reported as itself; otherwise the
    // dirty-tree guard says 'Blocked by local changes'. Use `rev-parse --git-path`: in a worktree
    // `.git` is a file, so joining `.git/rebase-merge` would never exist.
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
    const isDirty = !status.isClean();
    if (strict && isDirty) {
      return {
        success: false,
        commit: '',
        error: `Blocked: dirty working tree. Commit or discard local changes before pulling.\n\n  cd ${displayHomePath(dir)} && git status`,
      };
    }
    // A dirty tree is not decided here: whether a fast-forward is safe depends on the incoming
    // changes, which needs a fetched upstream ref, so the check sits before the integrate step.
    if (!strict && isDirty && (await git.getRemotes()).length === 0) {
      return {
        success: false,
        commit: '',
        error: `Blocked by local changes: the repo has no remote to pull from. Commit or discard them before pulling.\n\n  cd ${displayHomePath(dir)} && git status`,
      };
    }

    const branch = status.current || 'main';

    // Resolve the upstream ref. Strict mode always fetches origin, resolves its default branch and
    // refuses if the current branch is not it. Preserve-local prefers the branch's tracking config
    // and fetches only when none is set.
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

    // Split the tracking ref (`<remote>/<branch>`) on the first separator only, since branch names
    // may contain slashes. The integrate step uses `tracking` directly, not a second `git pull
    // <remote> <branch>`, so a multi-entry FETCH_HEAD cannot break a clean fast-forward.
    const sep = tracking.indexOf('/');
    const remoteBranch = sep > 0 ? tracking.slice(sep + 1) : branch;
    assertValidBranchName(remoteBranch);

    // Bare fetch updates every remote so the revparse sees a fresh ref whichever the branch tracks.
    // Deliberately argument-less: simple-git's fetchTask forwards a remote only when remote and
    // branch are both passed, so `fetch(remoteName)` would drop it anyway.
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

    // Behind-only means tracking has commits we lack and we have none on top. Use rev-list counts:
    // simple-git does not reject on the exit 1 of `merge-base --is-ancestor` for a non-ancestor, so
    // a try/catch around it would always say "can ff" (RUSH-2282).
    const aheadCount = parseInt(
      (await git.raw(['rev-list', '--count', `${tracking}..HEAD`])).trim(),
      10,
    );
    const behindCount = parseInt(
      (await git.raw(['rev-list', '--count', `HEAD..${tracking}`])).trim(),
      10,
    );
    // Both counts are the only inputs to the fast-forward decision, so an unreadable count is a
    // refusal, not a guess. Failing here avoids the old fall-through to the rebase arm
    // (preserve-local) or a "HEAD diverged" message naming the wrong cause (strict).
    if (!Number.isFinite(aheadCount) || !Number.isFinite(behindCount)) {
      return {
        success: false,
        commit: '',
        error: `Could not read how far HEAD is from ${tracking} — 'git rev-list --count' returned no usable count. Check the checkout, then pull again:\n\n  cd ${displayHomePath(dir)} && git status`,
      };
    }

    const canFastForward = aheadCount === 0 && behindCount > 0;

    if (strict && aheadCount > 0) {
      return {
        success: false,
        commit: '',
        error: `Blocked: HEAD is ${aheadCount} commit${aheadCount === 1 ? '' : 's'} ahead of ${tracking}. Push or discard local commits before pulling.`,
      };
    }

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
        await git.raw(['merge', '--ff-only', tracking]);
      } else {
        // Diverged or local-only commits: rebase onto the tracking tip without re-fetching.
        // Preserve-local only: strict mode never reaches here, so the fleet pull never rewrites
        // history. Keep the three strict returns above intact if you change this.
        await git.raw(['rebase', tracking]);
      }
    } catch (err) {
      // Abort so the tree is restored, matching the atomicity --ff-only gave. Otherwise a conflict
      // leaves the repo detached mid-rebase with conflict markers in live config (agents.yaml,
      // AGENTS.md) and later pulls misreport the cause;
      await git.raw(['rebase', '--abort']).catch(() => { /* not mid-rebase */ });
      const verb = canFastForward ? 'Fast-forward' : 'Rebase';
      return {
        success: false,
        commit: '',
        error: `${verb} onto ${tracking} failed — the pull was rolled back, nothing changed.\n\nResolve the divergence, then pull again:\n\n  cd ${displayHomePath(dir)} && git log --oneline HEAD...${tracking}\n\n${(err as Error).message}`,
      };
    }

    // Strict/read-model pulls must never mutate executable hook wiring.
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

/** Every repo-relative path a status reports as locally touched, from `status.files` (the source
 * `isClean()` uses, so the set and the dirty decision cannot disagree). Hand-unioning the
 * per-category arrays misses categories nobody thought of. */
function dirtyPathSet(status: { files: Array<{ path: string; from?: string }> }): Set<string> {
  const out = new Set<string>();
  for (const f of status.files || []) {
    if (f?.path) out.add(f.path);
    if (f?.from) out.add(f.from);
  }
  return out;
}

/** Why a dirty tree must not fast-forward to `upstreamRef`, or null when it safely can. The single
 * home of the rule for `syncRepoGit` and `pullRepo`. Refuse on local commits ahead or a dirty
 * incoming path. `-z` on the diff because it C-quotes unicode paths while status.files does not. */
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
    // Central agents.yaml is authoritative and not regenerable; a dirty copy equals
    // serializeCentral(meta), so no byte check tells a stranded edit from a stale one. Refuse,
    // never discard: commit-on-write and daemon publish commit it, so next pull works (PHNX-3968).
    const shown = collisions.slice(0, 5).join(', ');
    const more = collisions.length > 5 ? ` (+${collisions.length - 5} more)` : '';
    return `incoming changes touch uncommitted paths: ${shown}${more}`;
  }
  return null;
}

/** Rebases a repo onto its remote, optionally pushing: the one-repo counterpart to `pullRepo`.
 * Clean tree: `git pull --rebase`. Dirty tree: `--ff-only` only with no local commits ahead and no
 * incoming path colliding with a dirty one, else refuse. System repos pass push: false. */
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

/** Git status for sync display: files categorized by status relative to HEAD. */
interface GitSyncStatus {
  synced: string[];
  modified: string[];
  new: string[];
  staged: string[];
  deleted: string[];
}

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

    const filterPath = (file: string) => {
      if (!subdir) return true;
      return file.startsWith(subdir + '/') || file === subdir;
    };

    const trackedOutput = await git.raw(['ls-files', subdir || '.']);
    const trackedFiles = new Set(trackedOutput.split('\n').filter(Boolean));

    const untrackedOutput = await git.raw(['ls-files', '--others', '--exclude-standard', subdir || '.']);
    const untrackedFiles = untrackedOutput.split('\n').filter(Boolean);

    const changedFiles = new Set<string>();
    for (const file of status.modified.filter(filterPath)) {
      result.modified.push(file);
      changedFiles.add(file);
    }
    for (const file of status.deleted.filter(filterPath)) {
      result.deleted.push(file);
      changedFiles.add(file);
    }

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

    for (const file of untrackedFiles.filter(filterPath)) {
      result.new.push(file);
    }

    for (const file of trackedFiles) {
      if (filterPath(file) && !changedFiles.has(file)) {
        result.synced.push(file);
      }
    }

    return result;
  } catch {
    return null;
  }
}

export async function getTrackedFiles(dir: string, subdir?: string): Promise<string[]> {
  if (!isGitRepo(dir)) {
    return [];
  }

  try {
    const git = simpleGit(dir);
    const result = await git.raw(['ls-files', subdir || '.']);
    return result.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** Auto-pulls a git repo if it is clean and has a remote, using --ff-only so divergence fails
 * instead of creating merge commits. Silent on success; returns an error message on failure. */
async function tryAutoPull(dir: string): Promise<{ pulled: boolean; error?: string }> {
  if (!isGitRepo(dir)) {
    return { pulled: false };
  }

  try {
    const git = simpleGit(dir);

    const remotes = await git.getRemotes(true);
    const origin = remotes.find(r => r.name === 'origin');
    if (!origin?.refs?.fetch) {
      return { pulled: false };
    }

    const status = await git.status();
    if (!status.isClean()) {
      return { pulled: false, error: 'Has local changes' };
    }

    await git.fetch('origin');

    const localRef = await git.revparse(['HEAD']);
    const trackingBranch = status.tracking;
    if (!trackingBranch) {
      return { pulled: false };
    }

    const remoteRef = await git.revparse([trackingBranch]).catch(() => null );
    if (!remoteRef || localRef === remoteRef) {
      return { pulled: false };
    }

    await git.pull(['--ff-only']);

    return { pulled: true };
  } catch (err) {
    return { pulled: false, error: (err as Error).message };
  }
}

interface SystemRepoPullResult {
  pulled: boolean;
  error?: string;
  refused?: boolean;
  actualRemote?: string;
}

/** Auto-pulls the system repo only after verifying its origin (PHNX-2957): its hooks run as shell,
 * so fast-forwarding from a repointed origin is remote code execution. A bad origin is refused
 * loud (`refused: true`); no origin at all is a plain no-op (`pulled: false`). */
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

/** How many commits `dir`'s branch is behind its upstream, read from the last-fetched tracking
 * ref with no network call. Null if not a repo, no upstream, or git errors. Used by `agents
 * doctor` to flag a source layer reconciled against stale truth. */
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
  const branch = run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (!branch) return null;
  const raw = run(['rev-list', '--count', 'HEAD..@{upstream}']);
  if (raw === null) return null;
  const behind = parseInt(raw, 10);
  if (!Number.isFinite(behind)) return null;
  return { behind, branch };
}
