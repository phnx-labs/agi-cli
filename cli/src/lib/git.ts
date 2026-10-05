import simpleGit, { SimpleGit } from 'simple-git';
import { execFileSync } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IS_WINDOWS, isWindowsAbsolutePath, toNativePath } from './platform/index.js';
import { getPackageLocalPath } from './state.js';
import { DEFAULT_SYSTEM_REPO, systemRepoSlug } from './types.js';

export function assertSafeGitTransport(source: string): void {

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

function githooksEnabled(): boolean {

  const v = process.env.AGENTS_ENABLE_GITHOOKS;
  return v === '1' || v === 'true';
}

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
      if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
    }
  }
}

interface GitSource {
  type: 'github' | 'url' | 'local';
  url: string;
  ref?: string;
}

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

const RENAMED_REMOTE_ALIASES: Record<string, string> = {
  'github.com/phnx-labs/.agents': 'github.com/phnx-labs/.agents-system',
};

export function isSystemRepoRemote(remote: string | null | undefined): boolean {
  if (!remote) return false;
  const c = canonicalGitRemote(remote);
  return c === canonicalGitRemote(`https://github.com/${systemRepoSlug(DEFAULT_SYSTEM_REPO)}`);
}

export function isExpectedSystemRepoRemote(remote: string | null | undefined): boolean {

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

export function isGitRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'));
}

export async function getGitRoot(dir: string): Promise<string> {
  const root = await simpleGit(dir).revparse(['--show-toplevel']);
  return toNativePath(root.trim());
}

export async function getMainRepoRoot(dir: string): Promise<string> {
  const common = await simpleGit(dir).raw(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return toNativePath(path.dirname(common.trim()));
}

export async function initRepo(dir: string): Promise<void> {
  const git = simpleGit(dir);
  await git.init();
}

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

export async function adoptRepo(
  source: string,
  targetDir: string,
): Promise<{ success: boolean; commit: string; backupDir?: string; backedUp: string[]; error?: string }> {
  const trimmed = source.trim();
  if (fs.existsSync(path.join(targetDir, '.git'))) {
    return { success: false, commit: '', backedUp: [], error: 'Already a git repo — nothing to adopt' };
  }

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

export function recordUserRepoRemote(dir: string, url: string): void {
  try {
    const file = userRepoRemoteRecordPath(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ url }, null, 2) + '\n', { mode: 0o600 });
  } catch {
  }
}

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
  agentsYamlBackup?: string;
  localEdits: string[];
  error?: string;
}

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
    assertSafeGitTransport(trimmed);
    if (!fs.existsSync(dir)) {
      return { ...empty, error: `Target directory does not exist: ${dir}` };
    }
    process.env.GIT_TERMINAL_PROMPT = '0';

    const git = simpleGit(dir);

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

export function displayHomePath(dir: string): string {
  const home = os.homedir();
  const rel = dir.startsWith(home) ? '~' + dir.slice(home.length) : dir;
  return rel.replace(/\\/g, '/');
}

export interface PullRepoOptions {
  mode?: 'preserve-local' | 'default-branch-fast-forward';
}

export async function pullRepo(
  dir: string,
  options: PullRepoOptions = {},
): Promise<{ success: boolean; commit: string; error?: string; branch?: string }> {
  const strict = options.mode === 'default-branch-fast-forward';
  try {
    const git = simpleGit(dir);

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
    if (!strict && isDirty && (await git.getRemotes()).length === 0) {
      return {
        success: false,
        commit: '',
        error: `Blocked by local changes: the repo has no remote to pull from. Commit or discard them before pulling.\n\n  cd ${displayHomePath(dir)} && git status`,
      };
    }

    const branch = status.current || 'main';

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

    const sep = tracking.indexOf('/');
    const remoteBranch = sep > 0 ? tracking.slice(sep + 1) : branch;
    assertValidBranchName(remoteBranch);

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

    const aheadCount = parseInt(
      (await git.raw(['rev-list', '--count', `${tracking}..HEAD`])).trim(),
      10,
    );
    const behindCount = parseInt(
      (await git.raw(['rev-list', '--count', `HEAD..${tracking}`])).trim(),
      10,
    );
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
        await git.raw(['rebase', tracking]);
      }
    } catch (err) {
      await git.raw(['rebase', '--abort']).catch(() => {  });
      const verb = canFastForward ? 'Fast-forward' : 'Rebase';
      return {
        success: false,
        commit: '',
        error: `${verb} onto ${tracking} failed — the pull was rolled back, nothing changed.\n\nResolve the divergence, then pull again:\n\n  cd ${displayHomePath(dir)} && git log --oneline HEAD...${tracking}\n\n${(err as Error).message}`,
      };
    }

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

function dirtyPathSet(status: { files: Array<{ path: string; from?: string }> }): Set<string> {
  const out = new Set<string>();
  for (const f of status.files || []) {
    if (f?.path) out.add(f.path);
    if (f?.from) out.add(f.from);
  }
  return out;
}

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
    const shown = collisions.slice(0, 5).join(', ');
    const more = collisions.length > 5 ? ` (+${collisions.length - 5} more)` : '';
    return `incoming changes touch uncommitted paths: ${shown}${more}`;
  }
  return null;
}

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
