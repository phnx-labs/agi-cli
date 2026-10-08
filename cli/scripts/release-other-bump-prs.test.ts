
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as path from 'path';

const SCRIPT = path.resolve(__dirname, 'release-other-bump-prs.sh');

function otherBumps(current: string, prs: Array<[number, string]>): string[] {
  const input = prs.map(([n, branch]) => `${n} ${branch}`).join('\n') + '\n';
  const r = spawnSync('bash', [SCRIPT, current], { input, encoding: 'utf-8' });
  expect(r.status).toBe(0);
  return r.stdout.trim() === '' ? [] : r.stdout.trim().split('\n');
}

describe('release-other-bump-prs: a stuck earlier bump blocks the fold', () => {
  it('reports an earlier version bump PR still open while a later version releases', () => {
    expect(
      otherBumps('release/1.2.4', [
        [3200, 'release/1.2.3'],
        [3210, 'release/1.2.4'],
      ]),
    ).toEqual(['#3200 release/1.2.3']);
  });

  it('reports every other open release bump, in input order', () => {
    expect(
      otherBumps('release/1.2.5', [
        [3200, 'release/1.2.3'],
        [3205, 'release/1.2.4'],
        [3210, 'release/1.2.5'],
      ]),
    ).toEqual(['#3200 release/1.2.3', '#3205 release/1.2.4']);
  });
});

describe('release-other-bump-prs: nothing to block on', () => {
  it('excludes the current target — that is release.sh STUCK_BUMP_PR territory', () => {
    expect(otherBumps('release/1.2.4', [[3210, 'release/1.2.4']])).toEqual([]);
  });

  it('ignores non-release feature branches that merely start with "release"', () => {
    expect(
      otherBumps('release/1.2.4', [
        [3211, 'release-notes-doc'],
        [3212, 'releasing-guide'],
        [3213, 'fix/ci-scope-rename-aware'],
      ]),
    ).toEqual([]);
  });

  it('reports nothing for an empty PR list', () => {
    expect(otherBumps('release/1.2.4', [])).toEqual([]);
  });

  it('treats pre-release branches as release bumps', () => {
    expect(otherBumps('release/1.2.4-pre.2', [[3200, 'release/1.2.4-pre.1']]))
      .toEqual(['#3200 release/1.2.4-pre.1']);
  });
});

describe('release-other-bump-prs: usage', () => {
  it('fails with exit 2 when no current branch is given', () => {
    const r = spawnSync('bash', [SCRIPT], { input: '', encoding: 'utf-8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage:');
  });
});
