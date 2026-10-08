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
  fs.copyFileSync(path.resolve(__dirname, 'release-attested-base.sh'), path.join(caller, 'cli/scripts/release-attested-base.sh'));
  fs.writeFileSync(path.join(caller, 'cli/scripts/release.sh'), `#!/usr/bin/env bash\nset -euo pipefail\n${stubBody}\n`, { mode: 0o755 });
  git(caller, 'add', '.');
  git(caller, 'commit', '-m', 'initial');
  git(caller, 'branch', '-M', 'main');
  git(caller, 'push', '-u', 'origin', 'main');
  git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(caller, 'remote', 'set-head', 'origin', '--auto');
  return { root, remote, caller };
}

function withAttestation(caller: string, commit = 'origin/main'): NodeJS.ProcessEnv {
  const tree = git(caller, 'rev-parse', `${commit}^{tree}`);
  return { ...process.env, RELEASE_ATTEST_ASSETS: `attest-${tree}.json` };
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
      env: withAttestation(caller),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('isolated:9.8.7:--orchestration-phase');
    expect(fs.readFileSync(path.join(caller, 'dirty-main.txt'), 'utf-8')).toBe('main work\n');
    expect(fs.readFileSync(path.join(feature, 'dirty.txt'), 'utf-8')).toBe('feature work\n');
    expect(fs.readdirSync(path.join(caller, '.agents/worktrees'))).toEqual([]);
  });

  it('uses current origin/main when its exact tree is attested', () => {
    const { caller } = fixture('printf "HEAD=%s\\n" "$(git rev-parse HEAD)"');
    fs.writeFileSync(path.join(caller, 'new-workflow.txt'), 'branch publisher\n');
    git(caller, 'add', 'new-workflow.txt');
    git(caller, 'commit', '-m', 'add release workflow');
    git(caller, 'push', 'origin', 'main');
    const tip = git(caller, 'rev-parse', 'origin/main');

    const result = spawnSync('bash', [path.join(caller, 'cli/scripts/release-worktree.sh'), caller, '9.8.7'], {
      cwd: os.tmpdir(),
      encoding: 'utf-8',
      env: withAttestation(caller),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`HEAD=${tip}`);
  });

  it('keeps current main while inheriting proof across release-irrelevant commits', () => {
    const { caller } = fixture('printf "HEAD=%s\\n" "$(git rev-parse HEAD)"');
    const attested = git(caller, 'rev-parse', 'origin/main');
    fs.writeFileSync(path.join(caller, 'unattested.txt'), 'not release input\n');
    git(caller, 'add', 'unattested.txt');
    git(caller, 'commit', '-m', 'unattested main change');
    git(caller, 'push', 'origin', 'main');
    const tip = git(caller, 'rev-parse', 'origin/main');

    const result = spawnSync('bash', [path.join(caller, 'cli/scripts/release-worktree.sh'), caller, '9.8.7'], {
      cwd: caller,
      encoding: 'utf-8',
      env: withAttestation(caller, attested),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`HEAD=${tip}`);
    expect(result.stderr).toContain('inherits proof from attested ancestor');
  });

  it('keeps current main and delegates relevant drift to impact retesting', () => {
    const { caller } = fixture('printf "HEAD=%s\\n" "$(git rev-parse HEAD)"');
    const attested = git(caller, 'rev-parse', 'origin/main');
    fs.writeFileSync(path.join(caller, 'cli/release-code.sh'), 'changed\n');
    git(caller, 'add', 'cli/release-code.sh');
    git(caller, 'commit', '-m', 'change cli release code');
    git(caller, 'push', 'origin', 'main');
    const tip = git(caller, 'rev-parse', 'origin/main');

    const result = spawnSync('bash', [path.join(caller, 'cli/scripts/release-worktree.sh'), caller, '9.8.7'], {
      cwd: caller,
      encoding: 'utf-8',
      env: withAttestation(caller, attested),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`HEAD=${tip}`);
    expect(result.stderr).toContain('will impact-test');
  });

  it('fails before release preparation when main history has no attested tree', () => {
    const { caller } = fixture('echo must-not-run');
    const result = spawnSync('bash', [path.join(caller, 'cli/scripts/release-worktree.sh'), caller, '9.8.7'], {
      cwd: caller,
      encoding: 'utf-8',
      env: { ...process.env, RELEASE_ATTEST_ASSETS: 'attest-deadbeef.json' },
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('must-not-run');
    expect(result.stderr).toContain('no attested origin/main ancestor');
  });

  it('retains a release worktree when the release process leaves evidence behind', () => {
    const { caller } = fixture('printf evidence > retained.txt');
    const result = spawnSync('bash', [path.join(caller, 'cli/scripts/release-worktree.sh'), caller, '9.8.7'], {
      cwd: caller,
      encoding: 'utf-8',
      env: withAttestation(caller),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('Retained release worktree for inspection');
    const retained = result.stderr.match(/inspection: (.+)$/m)?.[1];
    expect(retained).toBeTruthy();
    expect(fs.readFileSync(path.join(retained!, 'cli/retained.txt'), 'utf-8')).toBe('evidence');
  });
});
