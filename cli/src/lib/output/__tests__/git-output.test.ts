import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { findGitRepos, collectCommits, toSearchDate } from '../git-output.js';

let root: string;
let repo: string;

/** Runs git in `repo`, optionally stamping author+committer identity and dates. Identity is passed
 * as ENV, not `-c user.email=...`, because `GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_EMAIL` OUTRANK `-c`:
 * boxes exporting them (the fleet does) re-authored fixtures and failed tests and releases. */
function git(args: string[], dateIso?: string, identity?: { email: string; name: string }): void {
  const env = { ...process.env } as Record<string, string>;
  if (dateIso) {
    env.GIT_AUTHOR_DATE = dateIso;
    env.GIT_COMMITTER_DATE = dateIso;
  }
  // Always assign, even with no identity passed, so an ambient GIT_AUTHOR_EMAIL
  // can never decide who authored a fixture commit.
  env.GIT_AUTHOR_EMAIL = identity?.email ?? 'fixture@example.com';
  env.GIT_COMMITTER_EMAIL = identity?.email ?? 'fixture@example.com';
  env.GIT_AUTHOR_NAME = identity?.name ?? 'Fixture';
  env.GIT_COMMITTER_NAME = identity?.name ?? 'Fixture';
  execFileSync('git', ['-C', repo, ...args], { env, stdio: 'pipe' });
}

/** Commit an empty change authored by `email` at `dateIso`. */
function commitAs(email: string, name: string, message: string, dateIso: string): void {
  git(['commit', '--allow-empty', '-m', message], dateIso, { email, name });
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-output-test-'));
  repo = path.join(root, 'nested', 'my-repo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['-C', repo, 'init', '-q'], { stdio: 'pipe' });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('findGitRepos', () => {
  it('discovers a git repo nested below the root and does not descend into it', () => {
    // A repo nested two levels down; a decoy non-repo dir alongside.
    fs.mkdirSync(path.join(root, 'nested', 'not-a-repo'), { recursive: true });
    const repos = findGitRepos(root, 4);
    expect(repos).toContain(repo);
    // The repo's own .git must not be returned as a separate repo.
    expect(repos.every(r => !r.endsWith('.git'))).toBe(true);
  });

  it('respects maxDepth', () => {
    // repo is at depth 2 (nested/my-repo); depth 1 should not find it.
    expect(findGitRepos(root, 1)).not.toContain(repo);
  });
});

describe('collectCommits', () => {
  beforeEach(() => {
    // Commit oldest-first so committer dates are monotonic (newest = HEAD), as in
    // any real repo. `git log --since` stops traversing once it hits a commit
    // older than the window, so an out-of-order HEAD would hide newer ancestors.
    commitAs('alice@example.com', 'Alice', 'old by alice', daysAgoIso(30));
    commitAs('bob@example.com', 'Bob', 'recent by bob', daysAgoIso(2));
    commitAs('alice@example.com', 'Alice', 'recent by alice', daysAgoIso(1));
  });

  it('counts commits by all given authors within the window, tallied per author', async () => {
    const since = daysAgoIso(7);
    const { total, byAuthor } = await collectCommits([repo], since, ['alice@example.com', 'bob@example.com']);
    expect(total).toBe(2); // the 30-day-old one is excluded by the window
    const map = Object.fromEntries(byAuthor.map(a => [a.author, a.commits]));
    expect(map['alice@example.com']).toBe(1);
    expect(map['bob@example.com']).toBe(1);
  });

  it('restricts to the named author', async () => {
    const since = daysAgoIso(7);
    const { total } = await collectCommits([repo], since, ['alice@example.com']);
    expect(total).toBe(1); // bob excluded by author, old-alice excluded by window
  });

  it('widening the window includes older commits', async () => {
    const since = daysAgoIso(60);
    const { total } = await collectCommits([repo], since, ['alice@example.com']);
    expect(total).toBe(2); // both alice commits now in range
  });

  it('is case-insensitive on author email', async () => {
    const since = daysAgoIso(7);
    const { total } = await collectCommits([repo], since, ['ALICE@EXAMPLE.COM']);
    expect(total).toBe(1);
  });

  it('tolerates a non-repo path without throwing', async () => {
    const { total } = await collectCommits([path.join(root, 'does-not-exist')], daysAgoIso(7), ['alice@example.com']);
    expect(total).toBe(0);
  });

  it('dedupes the same commit seen via multiple clones (the --all-hosts fix)', async () => {
    // A second clone of the repo exposes the identical SHAs to git log. Counting
    // both clones must NOT double the commits — SHA identity collapses them.
    const clone = path.join(root, 'clone');
    execFileSync('git', ['clone', '-q', repo, clone], { stdio: 'pipe' });
    const since = daysAgoIso(7);
    const one = await collectCommits([repo], since, ['alice@example.com', 'bob@example.com']);
    const both = await collectCommits([repo, clone], since, ['alice@example.com', 'bob@example.com']);
    expect(both.total).toBe(one.total); // deduped, not 2x
    expect(both.shas.sort()).toEqual(one.shas.sort());
  });
});

describe('toSearchDate', () => {
  it('formats epoch ms as a UTC YYYY-MM-DD date', () => {
    expect(toSearchDate(0)).toBe('1970-01-01');
    expect(toSearchDate(Date.UTC(2026, 6, 13, 23, 59))).toBe('2026-07-13');
  });
});
