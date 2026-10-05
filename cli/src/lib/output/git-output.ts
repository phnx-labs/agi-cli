import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const execFileAsync = promisify(execFile);

interface AuthorCommits {
  author: string;
  commits: number;
}

// Carry SHAs so multi-clone/host aggregation unions duplicates rather than summing them.
interface GitOutputSummary {
  reposScanned: number;
  commits: number;
  byAuthor: AuthorCommits[];
  prsOpened: number;
  prsMerged: number;
  commitShas: string[];
  ghAvailable: boolean;
  authors: string[];
  logins: string[];
  sinceIso: string;
}

interface GitOutputOptions {
  reposDir: string;
  sinceMs: number;
  authors?: string[];
  logins?: string[];
  maxDepth?: number;
  includePrs?: boolean;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.agents', '.worktrees', 'dist', 'build', '.next', '.cache']);

// Stop descent once a repository is found to avoid counting nested worktrees or submodules twice.
export function findGitRepos(root: string, maxDepth = 4): string[] {
  const repos: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some(e => e.name === '.git')) {
      repos.push(dir);
      return;
    }
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return repos;
}

interface CommitRef {
  sha: string;
  email: string;
}

async function repoLog(repoDir: string, sinceIso: string): Promise<CommitRef[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoDir, 'log', '--all', '--no-merges', `--since=${sinceIso}`, '--pretty=format:%H%x09%ae'],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const refs: CommitRef[] = [];
    for (const line of stdout.split('\n')) {
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      refs.push({ sha: line.slice(0, tab).trim(), email: line.slice(tab + 1).trim() });
    }
    return refs;
  } catch {
    return [];
  }
}

// Discover every local/global author email, not only the active gh identity.
async function discoverAuthorEmails(repos: string[]): Promise<string[]> {
  const emails = new Set<string>();
  try {
    const { stdout } = await execFileAsync('git', ['config', '--global', 'user.email']);
    const e = stdout.trim();
    if (e) emails.add(e.toLowerCase());
  } catch {
  }
  await Promise.all(
    repos.map(async repo => {
      try {
        const { stdout } = await execFileAsync('git', ['-C', repo, 'config', '--get', 'user.email']);
        const e = stdout.trim();
        if (e) emails.add(e.toLowerCase());
      } catch {
      }
    }),
  );
  return [...emails];
}

// Deduplicate by SHA before computing per-author totals.
export async function collectCommits(
  repos: string[],
  sinceIso: string,
  authors: string[],
): Promise<{ total: number; byAuthor: AuthorCommits[]; shas: string[] }> {
  const ours = new Set(authors.map(a => a.toLowerCase()));
  const tally = new Map<string, number>();
  const seen = new Set<string>();
  const logs = await Promise.all(repos.map(r => repoLog(r, sinceIso)));
  for (const refs of logs) {
    for (const { sha, email } of refs) {
      const key = email.toLowerCase();
      if (ours.size > 0 && !ours.has(key)) continue;
      if (seen.has(sha)) continue;
      seen.add(sha);
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
  }
  const byAuthor = [...tally.entries()]
    .map(([author, commits]) => ({ author, commits }))
    .sort((a, b) => b.commits - a.commits);
  return { total: seen.size, byAuthor, shas: [...seen] };
}

async function currentGhLogin(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('gh', ['api', 'user', '--jq', '.login']);
    const login = stdout.trim();
    return login || null;
  } catch {
    return null;
  }
}

async function ghSearchCount(args: string[]): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('gh', [...args, '--limit', '1000', '--json', 'number'], {
      maxBuffer: 32 * 1024 * 1024,
    });
    const rows = JSON.parse(stdout);
    return Array.isArray(rows) ? rows.length : 0;
  } catch {
    return null;
  }
}

async function collectPrs(
  logins: string[],
  sinceDate: string,
): Promise<{ opened: number; merged: number; logins: string[]; ghAvailable: boolean }> {
  let resolved = logins;
  if (resolved.length === 0) {
    const login = await currentGhLogin();
    if (!login) return { opened: 0, merged: 0, logins: [], ghAvailable: false };
    resolved = [login];
  }
  let opened = 0;
  let merged = 0;
  let anyOk = false;
  for (const login of resolved) {
    const o = await ghSearchCount(['search', 'prs', '--author', login, '--created', `>=${sinceDate}`]);
    const m = await ghSearchCount(['search', 'prs', '--author', login, '--merged', `>=${sinceDate}`]);
    if (o !== null) {
      opened += o;
      anyOk = true;
    }
    if (m !== null) {
      merged += m;
      anyOk = true;
    }
  }
  return { opened, merged, logins: resolved, ghAvailable: anyOk };
}

export function toSearchDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export async function collectGitOutput(options: GitOutputOptions): Promise<GitOutputSummary> {
  const reposDir = options.reposDir.replace(/^~(?=$|\/)/, os.homedir());
  const sinceIso = new Date(options.sinceMs).toISOString();
  const sinceDate = toSearchDate(options.sinceMs);
  const repos = findGitRepos(reposDir, options.maxDepth ?? 4);

  const authors = options.authors && options.authors.length > 0
    ? options.authors.map(a => a.toLowerCase())
    : await discoverAuthorEmails(repos);

  const { total: commits, byAuthor, shas: commitShas } = await collectCommits(repos, sinceIso, authors);

  let prsOpened = 0;
  let prsMerged = 0;
  // false means PR zeroes are unavailable, not measured zero.
  let ghAvailable = false;
  let logins = options.logins ?? [];
  if (options.includePrs !== false) {
    const prs = await collectPrs(logins, sinceDate);
    prsOpened = prs.opened;
    prsMerged = prs.merged;
    ghAvailable = prs.ghAvailable;
    logins = prs.logins;
  }

  return {
    reposScanned: repos.length,
    commits,
    byAuthor,
    commitShas,
    prsOpened,
    prsMerged,
    ghAvailable,
    authors,
    logins,
    sinceIso,
  };
}
