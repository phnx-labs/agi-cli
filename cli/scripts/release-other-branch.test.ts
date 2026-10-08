import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, 'release-other-branch.sh');

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-other-branch-'));
  const remote = path.join(root, 'remote.git');
  const repo = path.join(root, 'repo');
  git(root, 'init', '--bare', remote);
  fs.mkdirSync(repo);
  git(repo, 'init');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'fixture');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', 'origin', 'HEAD:refs/heads/release/1.2.3');
  return repo;
}

function guard(repo: string) {
  const result = spawnSync('bash', [SCRIPT, 'release/1.2.3'], {
    cwd: repo,
    encoding: 'utf-8',
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

describe('cross-version branch-push exclusion', () => {
  it('allows the current target and ignores legacy non-trigger branch names', () => {
    const repo = fixture();
    git(repo, 'push', 'origin', 'HEAD:refs/heads/release/v1.2.2');
    git(repo, 'push', 'origin', 'HEAD:refs/heads/release/agents-cli-1.2.1');
    const result = guard(repo);
    expect(result.status, result.out).toBe(0);
  });

  it('rejects every other exact-shape stable or prerelease branch', () => {
    const repo = fixture();
    git(repo, 'push', 'origin', 'HEAD:refs/heads/release/1.2.4');
    git(repo, 'push', 'origin', 'HEAD:refs/heads/release/1.3.0-pre.1');
    const result = guard(repo);
    expect(result.status).not.toBe(0);
    expect(result.out).toContain('release/1.2.4');
    expect(result.out).toContain('release/1.3.0-pre.1');
  });
});
