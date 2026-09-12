import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(__dirname, 'release-worktree.sh');
const roots: string[] = [];

describe('release cleanup preserves work', () => {
  it('retains a dirty linked worktree and removes it only after it is clean', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-cleanup-'));
    roots.push(root);
    git(root, 'init');
    git(root, '-c', 'user.name=Release Test', '-c', 'user.email=release@example.com', 'commit', '--allow-empty', '-m', 'base');
    const worktree = path.join(root, '.agents/worktrees/release');
    git(root, 'worktree', 'add', '--detach', worktree, 'HEAD');
    const pending = path.join(worktree, 'pending.txt');
    fs.writeFileSync(pending, 'keep this work\n');
    const cleanup = fs.readFileSync(SCRIPT, 'utf8').match(/cleanup\(\) \{[\s\S]*?\n\}/)![0];
    const run = () => spawnSync('bash', ['-c', `${cleanup}\ncleanup`], {
      cwd: root, encoding: 'utf8', env: { ...process.env, REPO_ROOT: root, WORKTREE: worktree },
    });
    const retained = run();
    expect(retained.status, retained.stderr).toBe(0);
    expect(retained.stderr).toContain(worktree);
    expect(fs.readFileSync(pending, 'utf8')).toBe('keep this work\n');
    fs.unlinkSync(pending);
    expect(run().status).toBe(0);
    expect(fs.existsSync(worktree)).toBe(false);
  });

  it.each(['saved', 'unpublished', 'edited', 'restaged'])('restores only saved, unchanged release output: %s', (state) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-restore-'));
    roots.push(root);
    git(root, 'init');
    git(root, 'config', 'user.name', 'Release Test');
    git(root, 'config', 'user.email', 'release@example.com');
    const files = ['package.json', 'CHANGELOG.md', '.changelog/next/note.md', 'docs/command-index.md', 'docs/command-index.json', 'docs/command-reference.html'];
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), 'original\n');
    }
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'base');
    fs.writeFileSync(path.join(root, 'package.json'), 'release\n');
    fs.writeFileSync(path.join(root, '.changelog/9.8.7.md'), 'release note\n');
    fs.unlinkSync(path.join(root, '.changelog/next/note.md'));
    git(root, 'add', '.');
    const saved = git(root, 'commit-tree', git(root, 'write-tree'), '-p', 'HEAD', '-m', 'release');
    if (state === 'edited' || state === 'restaged') {
      fs.writeFileSync(path.join(root, 'package.json'), 'subsequent edit\n');
      if (state === 'restaged') {
        git(root, 'add', 'package.json');
        fs.writeFileSync(path.join(root, 'package.json'), 'release\n');
      }
    }
    const before = git(root, 'status', '--porcelain');
    const beforeIndex = git(root, 'write-tree');
    const body = fs.readFileSync(path.resolve(__dirname, 'release.sh'), 'utf8')
      .match(/restore_release_tree\(\) \{[\s\S]*?\n\}/)![0];
    const result = spawnSync('bash', ['-c', `set -e\nyellow() { printf '%s\\n' "$*"; }\n${body}\nrestore_release_tree`], {
      cwd: root, encoding: 'utf8', env: { ...process.env, ROOT: root, RELEASE_CI_HEAD: state === 'unpublished' ? '' : saved },
    });
    expect(result.status, result.stderr).toBe(0);
    if (state === 'saved') {
      expect(git(root, 'status', '--porcelain')).toBe('');
      expect(fs.readFileSync(path.join(root, '.changelog/next/note.md'), 'utf8')).toBe('original\n');
    } else {
      expect(git(root, 'status', '--porcelain')).toBe(before);
      expect(git(root, 'write-tree')).toBe(beforeIndex);
      expect(fs.readFileSync(path.join(root, '.changelog/9.8.7.md'), 'utf8')).toBe('release note\n');
    }
  });
});

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('release-worktree.sh', () => {
  it('runs from clean origin/main while leaving dirty main and feature checkouts untouched', () => {
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
    fs.writeFileSync(
      path.join(caller, 'cli/scripts/release.sh'),
      '#!/usr/bin/env bash\nset -euo pipefail\n' +
        'test "$(git rev-parse --abbrev-ref HEAD)" = HEAD\n' +
        'test -z "$(git status --porcelain)"\n' +
        'target=""\n' +
        'for arg in "$@"; do [[ "$arg" == --* ]] || { target="$arg"; break; }; done\n' +
        'printf "isolated:%s:%s\\n" "$target" "${*: -1}"\n',
    );
    fs.chmodSync(path.join(caller, 'cli/scripts/release.sh'), 0o755);
    git(caller, 'add', '.');
    git(caller, 'commit', '-m', 'initial');
    git(caller, 'branch', '-M', 'main');
    git(caller, 'push', '-u', 'origin', 'main');
    git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    git(caller, 'remote', 'set-head', 'origin', '--auto');
    fs.writeFileSync(path.join(caller, 'dirty-main.txt'), 'shared main work in progress\n');
    git(caller, 'worktree', 'add', '-b', 'feature', path.join(root, 'feature'), 'origin/main');
    const feature = path.join(root, 'feature');
    fs.writeFileSync(path.join(feature, 'dirty.txt'), 'caller work in progress\n');

    const result = spawnSync(
      'bash',
      [path.join(feature, 'cli/scripts/release-worktree.sh'), caller, '--skip-tests', '9.8.7'],
      { cwd: feature, encoding: 'utf-8' },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('isolated:9.8.7:--orchestration-phase');
    expect(fs.readFileSync(path.join(caller, 'dirty-main.txt'), 'utf-8')).toBe(
      'shared main work in progress\n',
    );
    expect(fs.readFileSync(path.join(feature, 'dirty.txt'), 'utf-8')).toBe('caller work in progress\n');
    expect(git(caller, 'status', '--porcelain')).toBe('?? dirty-main.txt');
    expect(git(feature, 'status', '--porcelain')).toBe('?? dirty.txt');
    expect(fs.readdirSync(path.join(caller, '.agents/worktrees'))).toEqual([]);
  });
});

/**
 * Builds a caller repo whose `release.sh` stub records the environment it was
 * handed, so a test can assert what the wrapper exported into it.
 */
function callerRepoRecordingEnv(root: string): string {
  const remote = path.join(root, 'remote.git');
  const caller = path.join(root, 'caller');
  git(root, 'init', '--bare', remote);
  git(root, 'clone', remote, caller);
  git(caller, 'config', 'user.name', 'Release Test');
  git(caller, 'config', 'user.email', 'release-test@example.com');
  fs.mkdirSync(path.join(caller, 'cli/scripts'), { recursive: true });
  fs.mkdirSync(path.join(caller, '.agents/worktrees'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(caller, 'cli/scripts/release-worktree.sh'));
  fs.writeFileSync(
    path.join(caller, 'cli/scripts/release.sh'),
    '#!/usr/bin/env bash\nset -euo pipefail\n' +
      'printf "STORE=%s\\n" "${RELEASE_ATTESTATION_DIR:-<unset>}"\n',
  );
  fs.chmodSync(path.join(caller, 'cli/scripts/release.sh'), 0o755);
  git(caller, 'add', '.');
  git(caller, 'commit', '-m', 'initial');
  git(caller, 'branch', '-M', 'main');
  git(caller, 'push', '-u', 'origin', 'main');
  git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(caller, 'remote', 'set-head', 'origin', '--auto');
  return caller;
}

/**
 * RUSH-2970 trap 2: `release.sh` re-execs into a throwaway worktree, where
 * REPO_ROOT resolves to the worktree — so the attestation store the producer
 * wrote in the CALLER's checkout was invisible and `require` reported
 * "missing exact attestation key" with `?` for every key component, reading
 * like a key mismatch rather than a wrong directory.
 */
describe('release-worktree.sh — the attestation store the caller owns', () => {
  it('exports RELEASE_ATTESTATION_DIR to the caller store when the caller has one', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-worktree-store-'));
    roots.push(root);
    const caller = callerRepoRecordingEnv(root);
    fs.mkdirSync(path.join(caller, '.release-attestations'), { recursive: true });

    const result = spawnSync(
      'bash',
      [path.join(caller, 'cli/scripts/release-worktree.sh'), caller, '--skip-tests', '9.8.7'],
      { cwd: caller, encoding: 'utf-8', env: { ...process.env, RELEASE_ATTESTATION_DIR: '' } },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(`STORE=${path.join(caller, '.release-attestations')}`);
  });

  it('never overrides an explicit RELEASE_ATTESTATION_DIR', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-worktree-store-'));
    roots.push(root);
    const caller = callerRepoRecordingEnv(root);
    fs.mkdirSync(path.join(caller, '.release-attestations'), { recursive: true });
    const explicit = path.join(root, 'operator-chosen-store');
    fs.mkdirSync(explicit, { recursive: true });

    const result = spawnSync(
      'bash',
      [path.join(caller, 'cli/scripts/release-worktree.sh'), caller, '--skip-tests', '9.8.7'],
      { cwd: caller, encoding: 'utf-8', env: { ...process.env, RELEASE_ATTESTATION_DIR: explicit } },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(`STORE=${explicit}`);
  });

  it('leaves it unset when the caller has no store, rather than inventing a path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-worktree-store-'));
    roots.push(root);
    const caller = callerRepoRecordingEnv(root);

    const result = spawnSync(
      'bash',
      [path.join(caller, 'cli/scripts/release-worktree.sh'), caller, '--skip-tests', '9.8.7'],
      { cwd: caller, encoding: 'utf-8', env: { ...process.env, RELEASE_ATTESTATION_DIR: '' } },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('STORE=<unset>');
  });
});

/**
 * PHNX-3705 — the release worktree must be cut at the newest ATTESTED ANCESTOR,
 * not the bare tip.
 *
 * These are integration tests on purpose. The resolver has its own unit tests in
 * release-attested-base.test.ts, but the bug that mattered lived at the SEAM:
 * the first version of this change called the resolver by a relative path from a
 * script that does not cd into cli/ until its last line, so it never ran and the
 * `|| true` quietly fell back to the tip — the whole change was a no-op, and no
 * test noticed. So these assert on the worktree's resolved HEAD.
 */
describe('release-worktree.sh cuts from the attested ancestor (PHNX-3705)', () => {
  /** Caller repo whose release.sh stub prints the HEAD it was actually run at. */
  function callerRepoRecordingHead(root: string): string {
    const remote = path.join(root, 'remote.git');
    const caller = path.join(root, 'caller');
    git(root, 'init', '--bare', remote);
    git(root, 'clone', remote, caller);
    git(caller, 'config', 'user.name', 'Release Test');
    git(caller, 'config', 'user.email', 'release-test@example.com');
    fs.mkdirSync(path.join(caller, 'cli/scripts'), { recursive: true });
    fs.mkdirSync(path.join(caller, '.agents/worktrees'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(caller, 'cli/scripts/release-worktree.sh'));
    // The real resolver, beside the real wrapper — exercising the path seam.
    fs.copyFileSync(
      path.resolve(__dirname, 'release-attested-base.sh'),
      path.join(caller, 'cli/scripts/release-attested-base.sh'),
    );
    fs.chmodSync(path.join(caller, 'cli/scripts/release-attested-base.sh'), 0o755);
    fs.writeFileSync(
      path.join(caller, 'cli/scripts/release.sh'),
      '#!/usr/bin/env bash\nset -euo pipefail\nprintf "HEAD=%s\\n" "$(git rev-parse HEAD)"\n',
    );
    fs.chmodSync(path.join(caller, 'cli/scripts/release.sh'), 0o755);
    git(caller, 'add', '.');
    git(caller, 'commit', '-m', 'initial');
    git(caller, 'branch', '-M', 'main');
    git(caller, 'push', '-u', 'origin', 'main');
    git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    git(caller, 'remote', 'set-head', 'origin', '--auto');
    return caller;
  }

  /** Add `n` more commits on main and push, so the tip moves past the base. */
  function advanceMain(caller: string, n: number): void {
    for (let i = 0; i < n; i++) {
      fs.writeFileSync(path.join(caller, `later-${i}.txt`), `${i}\n`);
      git(caller, 'add', '-A');
      git(caller, 'commit', '-m', `later ${i}`);
    }
    git(caller, 'push', 'origin', 'main');
  }

  function run(caller: string, assets: string | undefined) {
    return spawnSync(
      'bash',
      [path.join(caller, 'cli/scripts/release-worktree.sh'), caller, '--skip-tests', '9.8.7'],
      {
        cwd: os.tmpdir(), // deliberately NOT inside the repo: the seam that broke
        encoding: 'utf-8',
        env: assets === undefined
          ? { ...process.env, RELEASE_ATTEST_ASSETS: '' }
          : { ...process.env, RELEASE_ATTEST_ASSETS: assets },
      },
    );
  }

  it('checks the worktree out at the attested ancestor when the tip is unattested', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-worktree-anc-'));
    roots.push(root);
    const caller = callerRepoRecordingHead(root);
    const base = git(caller, 'rev-parse', 'HEAD');
    const baseTree = git(caller, 'rev-parse', 'HEAD^{tree}');
    advanceMain(caller, 2); // tip is now 2 ahead and NOT attested

    const r = run(caller, `attest-${baseTree}.json`);
    expect(r.status, r.stderr).toBe(0);
    // The release ran at the ancestor, not the tip. This is the assertion that
    // fails if the resolver is not wired in (relative path, missing call, etc).
    expect(r.stdout).toContain(`HEAD=${base}`);
    expect(r.stderr).toContain('newest ATTESTED ancestor');
    expect(r.stderr).toContain('2 commit(s) behind');
  });

  it('uses the tip when the tip itself is attested', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-worktree-tip-'));
    roots.push(root);
    const caller = callerRepoRecordingHead(root);
    advanceMain(caller, 2);
    const tip = git(caller, 'rev-parse', 'origin/main');
    const tipTree = git(caller, 'rev-parse', 'origin/main^{tree}');

    const r = run(caller, `attest-${tipTree}.json`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`HEAD=${tip}`);
    // No "behind" note when we are releasing from the tip.
    expect(r.stderr).not.toContain('newest ATTESTED ancestor');
  });

  it('falls back to the tip when nothing is attested, so phase 2 still fails loud', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-worktree-none-'));
    roots.push(root);
    const caller = callerRepoRecordingHead(root);
    advanceMain(caller, 2);
    const tip = git(caller, 'rev-parse', 'origin/main');

    const r = run(caller, 'attest-deadbeef.json');
    expect(r.status, r.stderr).toBe(0);
    // Deliberately the tip: the wrapper must not invent a base, it hands the
    // unattested tip to release.sh so phase 2 dies with its usual message.
    expect(r.stdout).toContain(`HEAD=${tip}`);
  });
});
