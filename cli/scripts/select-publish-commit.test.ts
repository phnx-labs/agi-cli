/** Which commit a release tags and publishes, run against the real script and a real git repo. This
 * integrity rule stops a busy default branch from publishing an untested tarball: when the
 * squash-merge tree diverges from what CI tested, release.sh falls back to the CI-tested commit. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.resolve(__dirname, 'select-publish-commit.sh');

let repo: string;

function git(...args: string[]): string {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** Commit a file's content on top of the current HEAD, return the new commit SHA. */
function commit(file: string, content: string, message: string): string {
  fs.writeFileSync(path.join(repo, file), content);
  git('add', file);
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
}

/** Run the real script; return { sha, status }. */
function select(mergedSha: string, ciSha: string) {
  const r = spawnSync('bash', [SCRIPT, mergedSha, ciSha], { cwd: repo, encoding: 'utf-8' });
  return { sha: r.stdout.trim(), status: r.status, stderr: r.stderr };
}

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'select-publish-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('select-publish-commit', () => {
  it('tags the merge commit when its tree still matches the CI-tested tree', () => {
    // The clean, no-drift case: a distinct commit whose tree is identical to the
    // CI-tested one. An empty commit on top shares its parent's tree but has a new
    // SHA — exactly a fast-forward-equivalent squash-merge with no drift.
    const ci = commit('pkg', 'v=1.20.80', 'release commit (CI-tested)');
    git('commit', '-q', '--allow-empty', '-m', 'squash-merge, no drift');
    const merged = git('rev-parse', 'HEAD');
    expect(git('rev-parse', `${ci}^{tree}`)).toBe(git('rev-parse', `${merged}^{tree}`));
    expect(ci).not.toBe(merged);
    expect(select(merged, ci).sha).toBe(merged);
  });

  it('falls back to the CI-tested commit when the merge tree drifted', () => {
    // Busy main: a source file changed between the CI-tested commit and the merge,
    // so the merge tree differs. The script must publish the CI-tested commit.
    const ci = commit('pkg', 'v=1.20.81', 'release commit (CI-tested)');
    const merged = commit('src', 'unrelated PR merged during CI', 'squash-merge onto drifted main');
    expect(git('rev-parse', `${ci}^{tree}`)).not.toBe(git('rev-parse', `${merged}^{tree}`));
    expect(select(merged, ci).sha).toBe(ci);
  });

  it('is a pure function of the trees: identical sha in both slots returns that sha', () => {
    const c = commit('pkg', 'v=1.20.82', 'lone commit');
    expect(select(c, c).sha).toBe(c);
  });

  it('exits 2 on the wrong argument count', () => {
    expect(spawnSync('bash', [SCRIPT, 'only-one'], { cwd: repo, encoding: 'utf-8' }).status).toBe(2);
  });
});
