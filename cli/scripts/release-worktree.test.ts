import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, 'release-worktree.sh');
const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function fixture(stubBody: string): { root: string; remote: string; caller: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-worktree-'));
  roots.push(root);
  const remote = path.join(root, 'remote.git');
  const caller = path.join(root, 'caller');
  git(root, 'init', '--bare', remote);
  git(root, 'clone', remote, caller);
  git(caller, 'config', 'user.name', 'Release Test');
  git(caller, 'config', 'user.email', 'release-test@example.com');
  fs.mkdirSync(path.join(caller, 'cli/scripts'), { recursive: true });
  fs.mkdirSync(path.join(caller, '.agents/worktrees'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(caller, 'cli/scripts/release-worktree.sh'));
  fs.writeFileSync(path.join(caller, 'cli/scripts/release.sh'), `#!/usr/bin/env bash\nset -euo pipefail\n${stubBody}\n`, { mode: 0o755 });
  git(caller, 'add', '.');
  git(caller, 'commit', '-m', 'initial');
  git(caller, 'branch', '-M', 'main');
  git(caller, 'push', '-u', 'origin', 'main');
  git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(caller, 'remote', 'set-head', 'origin', '--auto');
  return { root, remote, caller };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('release-worktree.sh', () => {
  it('runs the release from a clean detached origin/main without touching dirty checkouts', () => {
    const { root, caller } = fixture([
      'test "$(git rev-parse --abbrev-ref HEAD)" = HEAD',
      'test -z "$(git status --porcelain)"',
      'printf "isolated:%s:%s\\n" "$1" "${*: -1}"',
    ].join('\n'));
    fs.writeFileSync(path.join(caller, 'dirty-main.txt'), 'main work\n');
    const feature = path.join(root, 'feature');
    git(caller, 'worktree', 'add', '-b', 'feature', feature, 'origin/main');
    fs.writeFileSync(path.join(feature, 'dirty.txt'), 'feature work\n');

    const result = spawnSync('bash', [path.join(feature, 'cli/scripts/release-worktree.sh'), caller, '9.8.7', '--apply', '--yes'], {
      cwd: feature,
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('isolated:9.8.7:--orchestration-phase');
    expect(fs.readFileSync(path.join(caller, 'dirty-main.txt'), 'utf-8')).toBe('main work\n');
    expect(fs.readFileSync(path.join(feature, 'dirty.txt'), 'utf-8')).toBe('feature work\n');
    expect(fs.readdirSync(path.join(caller, '.agents/worktrees'))).toEqual([]);
  });

  it('always uses the current origin/main so the release branch contains the current workflow', () => {
    const { caller } = fixture('printf "HEAD=%s\\n" "$(git rev-parse HEAD)"');
    fs.writeFileSync(path.join(caller, 'new-workflow.txt'), 'branch publisher\n');
    git(caller, 'add', 'new-workflow.txt');
    git(caller, 'commit', '-m', 'add release workflow');
    git(caller, 'push', 'origin', 'main');
    const tip = git(caller, 'rev-parse', 'origin/main');

    const result = spawnSync('bash', [path.join(caller, 'cli/scripts/release-worktree.sh'), caller, '9.8.7'], {
      cwd: os.tmpdir(),
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`HEAD=${tip}`);
  });

  it('retains a release worktree when the release process leaves evidence behind', () => {
    const { caller } = fixture('printf evidence > retained.txt');
    const result = spawnSync('bash', [path.join(caller, 'cli/scripts/release-worktree.sh'), caller, '9.8.7'], {
      cwd: caller,
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('Retained release worktree for inspection');
    const retained = result.stderr.match(/inspection: (.+)$/m)?.[1];
    expect(retained).toBeTruthy();
    expect(fs.readFileSync(path.join(retained!, 'cli/retained.txt'), 'utf-8')).toBe('evidence');
  });
});
