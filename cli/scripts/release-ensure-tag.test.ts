import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, 'release-ensure-tag.sh');

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-ensure-tag-'));
  const remote = path.join(root, 'remote.git');
  const repo = path.join(root, 'repo');
  git(root, 'init', '--bare', remote);
  fs.mkdirSync(repo);
  git(repo, 'init');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  fs.mkdirSync(path.join(repo, 'cli', '.changelog'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'cli', '.changelog', '1.2.3.md'), 'Branch-push release.\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'release 1.2.3');
  git(repo, 'remote', 'add', 'origin', remote);
  return { remote, repo, head: git(repo, 'rev-parse', 'HEAD') };
}

describe('release tag recovery', () => {
  it('recreates a missing annotated tag before publishing existing valid assets', () => {
    const { remote, repo, head } = fixture();
    const result = spawnSync('bash', [SCRIPT, '1.2.3', head, ''], {
      cwd: repo,
      encoding: 'utf-8',
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(git(remote, 'rev-parse', 'refs/tags/v1.2.3^{}')).toBe(head);
    expect(git(remote, 'cat-file', '-t', 'refs/tags/v1.2.3')).toBe('tag');
  });

  it('refuses a tag that belongs to another commit', () => {
    const { repo, head } = fixture();
    const result = spawnSync('bash', [SCRIPT, '1.2.3', head, '0000000000000000000000000000000000000000'], {
      cwd: repo,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('not release branch head');
  });
});
