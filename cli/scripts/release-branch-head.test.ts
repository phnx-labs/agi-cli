import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, 'release-branch-head.sh');

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

describe('immutable release branch lookup', () => {
  it('returns the existing exact SHA before a tag exists without moving the branch', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-branch-head-'));
    const remote = path.join(root, 'remote.git');
    const repo = path.join(root, 'repo');
    git(root, 'init', '--bare', remote);
    git(root, 'clone', remote, repo);
    git(repo, 'config', 'user.name', 'Release Test');
    git(repo, 'config', 'user.email', 'release-test@example.com');
    fs.mkdirSync(path.join(repo, 'cli'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'cli/package.json'), '{"version":"9.9.9"}\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'release');
    git(repo, 'push', 'origin', 'HEAD:refs/heads/release/9.9.9');
    const before = git(repo, 'ls-remote', 'origin', 'refs/heads/release/9.9.9').split(/\s/)[0];

    const result = spawnSync('bash', [SCRIPT, 'origin', 'release/9.9.9', '9.9.9'], {
      cwd: repo,
      encoding: 'utf-8',
    });
    const after = git(repo, 'ls-remote', 'origin', 'refs/heads/release/9.9.9').split(/\s/)[0];
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe(before);
    expect(after).toBe(before);
  });

  it('rejects a same-name branch carrying another package version', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-branch-head-version-'));
    const remote = path.join(root, 'remote.git');
    const repo = path.join(root, 'repo');
    git(root, 'init', '--bare', remote);
    git(root, 'clone', remote, repo);
    git(repo, 'config', 'user.name', 'Release Test');
    git(repo, 'config', 'user.email', 'release-test@example.com');
    fs.mkdirSync(path.join(repo, 'cli'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'cli/package.json'), '{"version":"9.9.8"}\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'wrong release');
    git(repo, 'push', 'origin', 'HEAD:refs/heads/release/9.9.9');
    const result = spawnSync('bash', [SCRIPT, 'origin', 'release/9.9.9', '9.9.9'], {
      cwd: repo,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('carries package version 9.9.8, not 9.9.9');
  });
});
