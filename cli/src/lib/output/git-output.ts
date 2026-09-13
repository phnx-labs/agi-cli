/**
 * Git / GitHub "output" collector — the shipped-work half of `agents insights output`.
 *
 * `agents insights cost` answers "what did we burn?"; this answers "what did we ship?".
 * It counts commits (across every author identity, so multi-account totals stay
 * correct regardless of which `gh` login is active) and PRs opened / merged in a
 * time window. Pure `git`/`gh` over child_process — no server, no telemetry,
 * mirroring the offline spirit of the cost rollup.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const execFileAsync = promisify(execFile);

/** Commit tally for one author email. */
interface AuthorCommits {
  author: string;
  commits: number;
}

/** The shipped-work rollup for a window. */
interface GitOutputSummary {
  reposScanned: number;
  commits: number;
  byAuthor: AuthorCommits[];
  prsOpened: number;
  prsMerged: number;
  /**
   * Deduped commit SHAs authored by us in the window. Carried so `--all-hosts`
   * can UNION across machines — a repo cloned on several boxes exposes the same
   * commits to `git log` on each, so summing counts would multi-count.
   */
  commitShas: string[];
  /** false when `gh` is missing/unauthed — PR counts are then 0 and not trustworthy. */
  ghAvailable: boolean;
  /** Author emails counted as "ours". */
  authors: string[];
  /** gh logins queried for PRs. */
  logins: string[];
  sinceIso: string;
}

interface GitOutputOptions {
  /** Root scanned for git repos (e.g. ~/src). */
  reposDir: string;
  /** Window start, epoch ms. */
  sinceMs: number;
  /** Restrict commit authorship to these emails; default: identities discovered from git config. */
  authors?: string[];
  /** gh logins to search PRs for; default: the current `gh api user` login. */
  logins?: string[];
  /** Repo discovery depth below reposDir (default 4 — covers ~/src/host/org/repo). */
  maxDepth?: number;
  /** Query PRs via gh (default true). */
  includePrs?: boolean;
}

/** Directory names never descended into during repo discovery. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.agents', '.worktrees', 'dist', 'build', '.next', '.cache']);

/**
 * Find git repositories under `root` up to `maxDepth` levels deep. A directory
 * with a `.git` entry is a repo and is NOT descended into (so nested worktrees
 * / submodules don't double-count).
 */
export function findGitRepos(root: string, maxDepth = 4): string[] {
  const repos: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip
    }
    if (entries.some(e => e.name === '.git')) {
      repos.push(dir);
      return; // don't descend into a repo
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

/** One commit's identity: its SHA and author email. */
interface CommitRef {
  sha: string;
  email: string;
}

/** git log for one repo (SHA + author email per commit), tolerant of empty/broken repos. */
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
    return []; // no commits yet / not a real repo / detached weirdness
  }
}

/**
 * Discover the user's own author emails so commit counts exclude teammates.
 * Union of `git config --global user.email` and each repo's local `user.email`.
 */
async function discoverAuthorEmails(repos: string[]): Promise<string[]> {
  const emails = new Set<string>();
  try {
    const { stdout } = await execFileAsync('git', ['config', '--global', 'user.email']);
    const e = stdout.trim();
    if (e) emails.add(e.toLowerCase());
  } catch {
    /* no global identity */
  }
  await Promise.all(
    repos.map(async repo => {
      try {
        const { stdout } = await execFileAsync('git', ['-C', repo, 'config', '--get', 'user.email']);
        const e = stdout.trim();
        if (e) emails.add(e.toLowerCase());
      } catch {
        /* repo has no local identity */
      }
    }),
  );
  return [...emails];
}

/**
 * Count commits by our authors across all repos, deduped by SHA (so the same
 * commit reachable via multiple repo clones/worktrees on this machine — or, at
 * the fleet layer, across machines — is counted once), tallied per email.
 */
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
      if (seen.has(sha)) continue; // same commit seen via another clone/ref
      seen.add(sha);
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
  }
  const byAuthor = [...tally.entries()]
    .map(([author, commits]) => ({ author, commits }))
    .sort((a, b) => b.commits - a.commits);
  return { total: seen.size, byAuthor, shas: [...seen] };
}

/** Resolve the current gh login, or null if gh is unavailable/unauthed. */
async function currentGhLogin(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('gh', ['api', 'user', '--jq', '.login']);
    const login = stdout.trim();
    return login || null;
  } catch {
    return null;
  }
}

/** Count PRs matching a gh search query (author + date), returning null on failure. */
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

/**
 * Count PRs opened and merged in the window across the given logins. `gh search
 * prs` searches all of GitHub, so one authed gh can cover multiple accounts'
 * logins. Returns ghAvailable=false if gh can't be reached at all.
 */
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

/** Format an epoch-ms as a YYYY-MM-DD date (UTC), for gh's date-range search. */
export function toSearchDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Collect the full shipped-work summary for a window: commits (across accounts)
 * plus PRs opened/merged.
 */
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
