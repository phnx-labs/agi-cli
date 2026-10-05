import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { findGitRepos, collectCommits, toSearchDate } from '../git-output.js';

let root: string;
let repo: string;

function git(args: string[], dateIso?: string, identity?: { email: string; name: string }): void {
  // Fixture identity overrides ambient Git variables, including in release-attestation runs.
  const env = { ...process.env } as Record<string, string>;
  if (dateIso) {
    env.GIT_AUTHOR_DATE = dateIso;
    env.GIT_COMMITTER_DATE = dateIso;
  }
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
    fs.mkdirSync(path.join(root, 'nested', 'not-a-repo'), { recursive: true });
    const repos = findGitRepos(root, 4);
    expect(repos).toContain(repo);
    expect(repos.every(r => !r.endsWith('.git'))).toBe(true);
  });

  it('respects maxDepth', () => {
    expect(findGitRepos(root, 1)).not.toContain(repo);
  });
});

describe('collectCommits', () => {
  beforeEach(() => {
    commitAs('alice@example.com', 'Alice', 'old by alice', daysAgoIso(30));
    commitAs('bob@example.com', 'Bob', 'recent by bob', daysAgoIso(2));
    commitAs('alice@example.com', 'Alice', 'recent by alice', daysAgoIso(1));
  });

  it('counts commits by all given authors within the window, tallied per author', async () => {
    const since = daysAgoIso(7);
    const { total, byAuthor } = await collectCommits([repo], since, ['alice@example.com', 'bob@example.com']);
    expect(total).toBe(2);
    const map = Object.fromEntries(byAuthor.map(a => [a.author, a.commits]));
    expect(map['alice@example.com']).toBe(1);
    expect(map['bob@example.com']).toBe(1);
  });

  it('restricts to the named author', async () => {
    const since = daysAgoIso(7);
    const { total } = await collectCommits([repo], since, ['alice@example.com']);
    expect(total).toBe(1);
  });

  it('widening the window includes older commits', async () => {
    const since = daysAgoIso(60);
    const { total } = await collectCommits([repo], since, ['alice@example.com']);
    expect(total).toBe(2);
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
    const clone = path.join(root, 'clone');
    execFileSync('git', ['clone', '-q', repo, clone], { stdio: 'pipe' });
    const since = daysAgoIso(7);
    const one = await collectCommits([repo], since, ['alice@example.com', 'bob@example.com']);
    const both = await collectCommits([repo, clone], since, ['alice@example.com', 'bob@example.com']);
    expect(both.total).toBe(one.total);
    expect(both.shas.sort()).toEqual(one.shas.sort());
  });
});

describe('toSearchDate', () => {
  it('formats epoch ms as a UTC YYYY-MM-DD date', () => {
    expect(toSearchDate(0)).toBe('1970-01-01');
    expect(toSearchDate(Date.UTC(2026, 6, 13, 23, 59))).toBe('2026-07-13');
  });
});
