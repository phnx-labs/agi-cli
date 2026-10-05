/** Pin the required Tests workflow to one affected Linux check (RUSH-2666): branch protection and
 * release.sh wait on the stable `Tests / test` context, so shards, preflight and Windows must not
 * sit on that path. */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TESTS_YML = readFileSync(join(import.meta.dir, 'tests.yml'), 'utf8');

describe('tests.yml required Linux gate', () => {
  test('keeps a single job named test as the required check', () => {
    expect(TESTS_YML).toMatch(/^  test:\s*$/m);
    expect(TESTS_YML).not.toMatch(/^  cli-test-shard:\s*$/m);
    expect(TESTS_YML).not.toMatch(/^  cli-preflight:\s*$/m);
    expect(TESTS_YML).not.toMatch(/^  cli-docs:\s*$/m);
    expect(TESTS_YML).not.toMatch(/^  scope:\s*$/m);
    expect(TESTS_YML).not.toMatch(/shard: \[1, 2, 3\]/);
  });

  test('Windows is not on the required path', () => {
    expect(TESTS_YML).not.toMatch(/needs: \[.*windows/);
    expect(TESTS_YML).toMatch(/if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
    expect(TESTS_YML).toMatch(/continue-on-error: true/);
  });

  test('the Linux job plans with ci-scope and enforces the selected budget', () => {
    expect(TESTS_YML).toContain('bun scripts/ci-scope.ts');
    expect(TESTS_YML).toContain('--fail-unmapped');
    expect(TESTS_YML).toContain('--validate-manifest');
    expect(TESTS_YML).toContain('impact-proof-');
    // RUSH-2666 (wave 6): the workflow must not pass --deadline-sec. ci-scope.ts's --run already
    // picks 1200s for a cli-full plan and IMPACT_BUDGET_SEC (85s) for a selected plan; a hardcoded
    // value overrides that and silently disables the 85s budget check on every PR.
    expect(TESTS_YML).not.toContain('--deadline-sec');
  });

  test('the comment ratchet scans the checked-out merge tree before proof reuse', () => {
    expect(TESTS_YML).toContain('bun scripts/comment-lines.ts --check --base "$(git rev-parse HEAD^1)"');
    expect(TESTS_YML.indexOf('- name: Enforce the exact comment-line ratchet')).toBeLessThan(
      TESTS_YML.indexOf('- name: Restore exact-tree proof'),
    );
  });

  test('fork code stays on GitHub-hosted runners', () => {
    expect(TESTS_YML).toMatch(/runs-on: ubuntu-latest/);
    expect(TESTS_YML).not.toMatch(/runs-on: \[self-hosted/);
    expect(TESTS_YML).not.toMatch(/phnx-trusted/);
  });
});

describe('dependency cache on the required check (R1)', () => {
  // The required check spends 14-22s installing and 0.27s testing on a release PR, so install is
  // the budget. These pin the cache's correctness, not presence: a cache restoring the wrong tree
  // would test something other than the committed lockfile.
  const cacheBlock = TESTS_YML.slice(
    TESTS_YML.indexOf('- name: Restore dependencies'),
    TESTS_YML.indexOf('- name: Guard public artifacts'),
  );

  test('the required job restores dependencies from cache', () => {
    expect(TESTS_YML).toContain('- name: Restore dependencies');
    expect(cacheBlock).toContain('uses: actions/cache@');
  });

  test('keys on the toolchain, because a cached native addon is Node-ABI-specific', () => {
    expect(cacheBlock).toContain('steps.toolchain.outputs.fp');
    expect(TESTS_YML).toContain('fp=$(node -v)-$(bun -v)');
  });

  test('keys on EVERY lockfile whose node_modules it caches', () => {
    expect(cacheBlock).toContain("hashFiles('cli/bun.lock', 'packages/session-tracker/bun.lock')");
    expect(cacheBlock).toContain('runner.os');
  });

  test('has NO restore-keys, so a partial restore cannot layer onto another lockfile', () => {
    // A prefix `restore-keys` fallback is tempting but wrong: bun would install over a different
    // lockfile's node_modules, and --frozen-lockfile only guarantees the tree matches the lock
    // from a clean or exact-match state. Correct beats warm.
    expect(cacheBlock).not.toContain('restore-keys');
  });

  test('covers every directory installCommandsForPlan installs into', () => {
    expect(cacheBlock).toContain('cli/node_modules');
    expect(cacheBlock).toContain('packages/session-tracker/node_modules');
    expect(cacheBlock).toContain('~/.bun/install/cache');
  });

  test('a push-to-main job warms the cache, or PRs can never hit it', () => {
    // GitHub scopes caches per ref. The required `test` job is pull_request-only, so its entries
    // land under refs/pull/<N>/merge and are invisible to other PRs; after the cache shipped,
    // unrelated PRs measured deps-cache-hit=0 (a permanent cold miss).
    expect(TESTS_YML).toContain('warm-dep-cache:');
    const warm = TESTS_YML.slice(TESTS_YML.indexOf('warm-dep-cache:'), TESTS_YML.indexOf('  windows:'));
    expect(warm).toContain("github.event_name == 'push' && github.ref == 'refs/heads/main'");
  });

  test('the warm job uses the IDENTICAL key and paths, or it warms nothing usable', () => {
    const warm = TESTS_YML.slice(TESTS_YML.indexOf('warm-dep-cache:'), TESTS_YML.indexOf('  windows:'));
    const keyLine = "key: bun-deps-${{ runner.os }}-${{ steps.toolchain.outputs.fp }}-${{ hashFiles('cli/bun.lock', 'packages/session-tracker/bun.lock') }}";
    expect(cacheBlock).toContain(keyLine);
    expect(warm).toContain(keyLine);
    for (const dir of ['~/.bun/install/cache', 'cli/node_modules', 'packages/session-tracker/node_modules']) {
      expect(warm).toContain(dir);
    }
  });

  test('the warm job is NOT on the required check identity', () => {
    const warm = TESTS_YML.slice(TESTS_YML.indexOf('warm-dep-cache:'), TESTS_YML.indexOf('  windows:'));
    expect(warm).not.toContain('pull_request');
  });

  test('restores BEFORE the step that installs, or it saves nothing', () => {
    expect(TESTS_YML.indexOf('- name: Restore dependencies'))
      .toBeLessThan(TESTS_YML.indexOf('- name: Selected proof'));
  });
});
