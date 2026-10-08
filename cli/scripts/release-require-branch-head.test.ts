import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, 'release-require-branch-head.sh');

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-branch-head-'));
  const remote = path.join(root, 'remote.git');
  const repo = path.join(root, 'repo');
  git(root, 'init', '--bare', remote);
  fs.mkdirSync(repo);
  git(repo, 'init');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'version'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'A');
  const a = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', 'origin', 'HEAD:refs/heads/release/1.2.3');
  return { repo, a };
}

function requireHead(repo: string, expected: string) {
  return spawnSync('bash', [SCRIPT, 'origin', 'release/1.2.3', expected], {
    cwd: repo,
    encoding: 'utf-8',
  });
}

describe('release workflow branch identity', () => {
  it('accepts the exact event head and rejects a later same-version push', () => {
    const { repo, a } = fixture();
    expect(requireHead(repo, a).status).toBe(0);
    fs.writeFileSync(path.join(repo, 'version'), 'b\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'B');
    git(repo, 'push', '--force', 'origin', 'HEAD:refs/heads/release/1.2.3');
    const stale = requireHead(repo, a);
    expect(stale.status).not.toBe(0);
    expect(`${stale.stdout}${stale.stderr}`).toContain('not workflow head');
  });
});
