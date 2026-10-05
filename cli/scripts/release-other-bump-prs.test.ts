/** Detects an earlier release's still-open version-bump PR before folding .changelog/next/* for a
 * new target, using the real helper (PHNX-3084). If v1.2.3's bump PR never merged, a later release
 * folds v1.2.3's notes under v1.2.4; the same-target STUCK_BUMP_PR retry cannot see this. */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPT = path.resolve(__dirname, 'release-other-bump-prs.sh');

/** Run the real helper. Returns its stdout lines (the OTHER open bump PRs). */
function otherBumps(current: string, prs: Array<[number, string]>): string[] {
  const input = prs.map(([n, branch]) => `${n} ${branch}`).join('\n') + '\n';
  const r = spawnSync('bash', [SCRIPT, current], { input, encoding: 'utf-8' });
  expect(r.status).toBe(0);
  return r.stdout.trim() === '' ? [] : r.stdout.trim().split('\n');
}

describe('release-other-bump-prs: a stuck earlier bump blocks the fold', () => {
  it('reports an earlier version bump PR still open while a later version releases', () => {
    expect(
      otherBumps('release/v1.2.4', [
        [3200, 'release/v1.2.3'],
        [3210, 'release/v1.2.4'],
      ]),
    ).toEqual(['#3200 release/v1.2.3']);
  });

  it('reports every other open release bump, in input order', () => {
    expect(
      otherBumps('release/v1.2.5', [
        [3200, 'release/v1.2.3'],
        [3205, 'release/v1.2.4'],
        [3210, 'release/v1.2.5'],
      ]),
    ).toEqual(['#3200 release/v1.2.3', '#3205 release/v1.2.4']);
  });
});

describe('release-other-bump-prs: nothing to block on', () => {
  it('excludes the current target — that is release.sh STUCK_BUMP_PR territory', () => {
    expect(otherBumps('release/v1.2.4', [[3210, 'release/v1.2.4']])).toEqual([]);
  });

  it('ignores non-release feature branches that merely start with "release"', () => {
    // A stuck bump is release/v<semver>. A docs/feature branch must never wedge
    // every future release.
    expect(
      otherBumps('release/v1.2.4', [
        [3211, 'release-notes-doc'],
        [3212, 'releasing-guide'],
        [3213, 'fix/ci-scope-rename-aware'],
      ]),
    ).toEqual([]);
  });

  it('reports nothing for an empty PR list', () => {
    expect(otherBumps('release/v1.2.4', [])).toEqual([]);
  });
});

describe('release-other-bump-prs: usage', () => {
  it('fails with exit 2 when no current branch is given', () => {
    const r = spawnSync('bash', [SCRIPT], { input: '', encoding: 'utf-8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage:');
  });
});

describe('release-other-bump-prs: release.sh wires it in before the fold', () => {
  const RELEASE_SH = fs.readFileSync(path.resolve(__dirname, 'release.sh'), 'utf-8');

  it('calls the helper and refuses the fold when an earlier bump is open', () => {
    // The guard must query open PRs and pass the result through the helper.
    expect(RELEASE_SH).toMatch(/scripts\/release-other-bump-prs\.sh "\$RELEASE_BRANCH"/);
    expect(RELEASE_SH).toMatch(/Refusing to fold \.changelog\/next\/\* for \$TARGET/);
  });

  it('uses command substitution, not the fail-open process-substitution form', () => {
    // A die inside `<(helper)` exits only the subshell (see stuck-release.test.ts),
    // so the guard must read the helper via `$(...)` to actually abort the release.
    expect(RELEASE_SH).toMatch(/OTHER_BUMP_PRS="\$\(printf '%s\\n' "\$OPEN_PR_LINES" \| scripts\/release-other-bump-prs\.sh/);
    expect(RELEASE_SH).not.toMatch(/done < <\(scripts\/release-other-bump-prs\.sh/);
  });

  it('fails CLOSED on a gh failure — no `|| true` swallowing the lookup into empty', () => {
    // A `|| true` on the `gh pr list` lookup would fold a rate-limit/network blip
    // into an empty list, and the helper would read "no other bump PRs" — the guard
    // failing open at the one moment it is needed. It must die loudly instead.
    expect(RELEASE_SH).toMatch(/if ! OPEN_PR_LINES="\$\(gh pr list --state open --limit 200/);
    expect(RELEASE_SH).toMatch(/could not list open PRs \(gh pr list failed\)/);
    expect(RELEASE_SH).not.toMatch(/gh pr list --state open --limit 200[^\n]*\|\| true/);
  });

  it('appears before the changelog fold it is guarding', () => {
    const guardIdx = RELEASE_SH.indexOf('release-other-bump-prs.sh');
    const foldIdx = RELEASE_SH.indexOf('bun scripts/release-changelog.ts');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(foldIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(foldIdx);
  });
});
