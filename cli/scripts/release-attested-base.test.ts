import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, 'release-attested-base.sh');

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function repoWithHistory(n: number): { root: string; shas: string[]; trees: string[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attested-base-'));
  spawnSync('git', ['init', '-q', '-b', 'main', root], { encoding: 'utf-8' });
  git(root, 'config', 'user.name', 'Attestation Test');
  git(root, 'config', 'user.email', 'attestation-test@example.com');
  const shas: string[] = [];
  const trees: string[] = [];
  const env = {
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e.com',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e.com',
  };
  for (let i = 0; i < n; i++) {
    fs.writeFileSync(path.join(root, `f${i}.txt`), `${i}\n`);
    spawnSync('git', ['add', '-A'], { cwd: root, encoding: 'utf-8' });
    spawnSync('git', ['commit', '-q', '-m', `c${i}`], { cwd: root, encoding: 'utf-8', env: { ...process.env, ...env } });
    shas.push(git(root, 'rev-parse', 'HEAD'));
    trees.push(git(root, 'rev-parse', 'HEAD^{tree}'));
  }
  git(root, 'update-ref', 'refs/remotes/origin/main', shas[shas.length - 1]);
  return { root, shas, trees };
}

function resolve(root: string, assets: string[], lookback = '40') {
  return spawnSync('bash', [SCRIPT, root, 'main', lookback], {
    encoding: 'utf-8',
    env: { ...process.env, RELEASE_ATTEST_ASSETS: assets.join('\n') },
  });
}

describe('release-attested-base.sh (PHNX-3705)', () => {
  it('returns the tip when the tip itself is attested', () => {
    const { root, shas, trees } = repoWithHistory(3);
    const r = resolve(root, [`attest-${trees[2]}.json`]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(shas[2]);
  });

  it('walks back to the newest attested ANCESTOR when the tip is not attested', () => {
    const { root, shas, trees } = repoWithHistory(4);
    const r = resolve(root, [`attest-${trees[1]}.json`]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(shas[1]);
  });

  it('prefers the NEWEST attested ancestor, not merely any attested one', () => {
    const { root, shas, trees } = repoWithHistory(5);
    const r = resolve(root, [`attest-${trees[0]}.json`, `attest-${trees[2]}.json`]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(shas[2]);
  });

  it('rejects an older proof when the target changed CLI bytes', () => {
    const { root, shas, trees } = repoWithHistory(2);
    fs.mkdirSync(path.join(root, 'cli'), { recursive: true });
    fs.writeFileSync(path.join(root, 'cli/package.json'), '{"version":"2.0.0"}\n');
    git(root, 'add', 'cli/package.json');
    git(root, 'commit', '-m', 'change CLI');
    const r = resolve(root, [`attest-${trees[1]}.json`]);
    expect(r.status).not.toBe(0);
    expect(r.stdout.trim()).toBe('');
    expect(git(root, 'merge-base', shas[1], 'HEAD')).toBe(shas[1]);
  });

  it('rejects an older proof when the packaged session-tracker changed', () => {
    const { root, trees } = repoWithHistory(2);
    fs.mkdirSync(path.join(root, 'packages/session-tracker/src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages/session-tracker/src/index.ts'), 'export const changed = true;\n');
    git(root, 'add', 'packages/session-tracker/src/index.ts');
    git(root, 'commit', '-m', 'change packaged helper');
    const r = resolve(root, [`attest-${trees[1]}.json`]);
    expect(r.status).not.toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('fails loud (non-zero, no sha) when nothing in history is attested', () => {
    const { root } = repoWithHistory(3);
    const r = resolve(root, ['attest-deadbeef.json']);
    expect(r.status).not.toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('refuses an ATTESTED commit that is not on the branch history', () => {
    const { root, shas } = repoWithHistory(2);
    const blob = spawnSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], {
      input: 'evil\n', encoding: 'utf-8',
    }).stdout.trim();
    const evilTree = spawnSync('git', ['-C', root, 'mktree'], {
      input: `100644 blob ${blob}\tevil.txt\n`, encoding: 'utf-8',
    }).stdout.trim();
    spawnSync('git', ['-C', root, 'commit-tree', evilTree, '-p', shas[0], '-m', 'evil'], { encoding: 'utf-8' });

    const r = resolve(root, [`attest-${evilTree}.json`]);
    expect(r.status, 'an off-history commit must never be selected').not.toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('respects the lookback bound rather than walking all of history', () => {
    const { root, trees } = repoWithHistory(6);
    const r = resolve(root, [`attest-${trees[0]}.json`], '2');
    expect(r.status).not.toBe(0);
  });

  it('fails closed on a blank asset list instead of returning the tip', () => {
    const { root } = repoWithHistory(2);
    const r = spawnSync('bash', [SCRIPT, root, 'main'], {
      encoding: 'utf-8',
      env: { ...process.env, RELEASE_ATTEST_ASSETS: ' ' },
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout.trim()).toBe('');
  });
});

