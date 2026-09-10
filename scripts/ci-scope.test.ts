import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  IMPACT_BUDGET_SEC,
  type ImpactPlan,
  canReuseProof,
  changedFilesBetween,
  isVitestWorkerCrashWithZeroFailures,
  classifyCiScope,
  classifyPackageJsonChange,
  commandForTestFile,
  commandsForPlan,
  companionCandidates,
  installCommandsForPlan,
  existingCompanions,
  formatGitHubOutputs,
  loadOwnershipManifest,
  matchGlob,
  parseRenameAwareRawDiff,
  planIsFailing,
  proofFromPlan,
  relatedTestFiles,
  runtimeReadTestsBySource,
  selectImpact,
  validateOwnershipManifest,
} from './ci-scope';

function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync({
    cmd: ['git', ...args],
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: 'ci-scope@example.invalid',
      GIT_AUTHOR_NAME: 'CI Scope Test',
      GIT_COMMITTER_EMAIL: 'ci-scope@example.invalid',
      GIT_COMMITTER_NAME: 'CI Scope Test',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) {
    throw new Error(Buffer.from(proc.stderr).toString('utf8'));
  }
  return Buffer.from(proc.stdout).toString('utf8').trim();
}

function writeFixture(root: string, file: string, body = `${file}\n`): void {
  const target = join(root, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
}

const REPO = join(import.meta.dir, '..');
const MANIFEST = loadOwnershipManifest();

describe('classifyCiScope', () => {
  test('runs only CLI checks for CLI source', () => {
    expect(classifyCiScope(['cli/src/lib/state.ts'], REPO)).toEqual({
      cli: true,
      cliDocs: false,
      sessionTracker: false,
      windows: false,
    });
  });

  test('a .changelog edit brings the CLI job with it, for gen-changelog.test.ts', () => {
    // `cli` is true because the changelog-sources group selects
    // cli/scripts/gen-changelog.test.ts, and scopeFromPlan's
    // testUnder('cli/') reports "a test under cli/ was selected" --
    // the same generic derivation every other group gets. It costs nothing
    // extra: tests.yml has ONE job, driven by plan.tests/plan.checks, and
    // nothing in .github/ reads steps.plan.outputs.cli. Before this group
    // existed the value read `cli: false` -- and a hand-edited CHANGELOG.md that
    // no source reproduces reached main three times in one day, each caught only
    // by the full suite at release time.
    expect(classifyCiScope([
      'cli/docs/architecture.md',
      'cli/.changelog/next/ci.md',
    ], REPO)).toEqual({
      cli: true,
      cliDocs: true,
      sessionTracker: false,
      windows: false,
    });
  });

  test('a docs-only diff with no .changelog file still skips the CLI suite', () => {
    // The counterpart: widening must be scoped to the changelog sources, not to
    // every docs edit.
    expect(classifyCiScope(['cli/docs/architecture.md'], REPO)).toEqual({
      cli: false,
      cliDocs: true,
      sessionTracker: false,
      windows: false,
    });
  });

  test('runs each affected component for a mixed change', () => {
    expect(classifyCiScope([
      'cli/src/index.ts',
      'cli/AGENTS.md',
      'packages/session-tracker/src/index.ts',
    ], REPO)).toEqual({
      cli: true,
      cliDocs: true,
      sessionTracker: true,
      windows: false,
    });
  });

  test.each([
    'cli/src/lib/hooks/install.ts',
    'cli/src/lib/hooks/loader.ts',
    'cli/src/lib/platform/paths.ts',
    'cli/src/lib/shims-windows.ts',
    'cli/src/lib/binary-shadow.ts',
    'cli/src/lib/binary-shadow.test.ts',
    'cli/hooks/session-start.sh',
    'cli/src/lib/hosts/dispatch.ts',
  ])('does not require Windows for %s', (file) => {
    const scope = classifyCiScope([file], REPO);
    expect(scope.cli || scope.windows === false).toBe(true);
    expect(scope.windows).toBe(false);
  });

  test('policy and workflow changes select the planner tests, not Windows', () => {
    for (const file of [
      '.github/workflows/tests.yml',
      'scripts/ci-scope.ts',
      'scripts/ci-scope.test.ts',
      'cli/ci/test-ownership.yaml',
    ]) {
      expect(classifyCiScope([file], REPO)).toMatchObject({
        cli: true,
        windows: false,
      });
    }
  });

  test('does not spend component runners on unrelated repository files', () => {
    expect(classifyCiScope(['website/app/page.tsx', 'apps/ios/README.md'], REPO)).toEqual({
      cli: false,
      cliDocs: false,
      sessionTracker: false,
      windows: false,
    });
  });
});

describe('ownership globs and companions', () => {
  test('matchGlob handles prefix and exact paths', () => {
    expect(matchGlob('cli/src/commands/**', 'cli/src/commands/run.ts')).toBe(true);
    expect(matchGlob('cli/src/commands/**', 'cli/src/commands')).toBe(true);
    expect(matchGlob('LICENSE', 'LICENSE')).toBe(true);
    expect(matchGlob('LICENSE', 'cli/LICENSE')).toBe(false);
  });

  test('direct static imports do not fan out through the whole CLI graph', () => {
    const plan = selectImpact({
      files: ['cli/src/lib/artifact-actions.ts'],
      repoRoot: REPO,
      related: true,
    });
    expect(plan.tests.map((t) => t.file)).toEqual(['cli/tests/artifact-actions.test.ts']);
    expect(plan.tests[0].reason).toBe('static-import');
    expect(plan.tests.some((t) => t.file.endsWith('daemon.test.ts'))).toBe(false);
    expect(plan.tests.some((t) => t.file.endsWith('sessions.test.ts'))).toBe(false);
  });

  test('a leaf source file selects its companion test', () => {
    const leaf = 'cli/src/lib/state.ts';
    expect(existingCompanions(leaf, REPO)).toContain('cli/src/lib/state.test.ts');
    const plan = selectImpact({ files: [leaf], repoRoot: REPO, related: false });
    expect(plan.tests.some((t) => t.file === 'cli/src/lib/state.test.ts' && t.reason === 'companion')).toBe(true);
    expect(plan.unmapped).toEqual([]);
    expect(plan.suite).toBe('selected');
    expect(plan.tests.some((t) => t.file.includes('sessions.test.ts'))).toBe(false);
    expect(plan.tests.some((t) => t.file.includes('daemon.test.ts'))).toBe(false);
  });

  test('a changed test file always selects itself', () => {
    const plan = selectImpact({
      files: ['cli/src/lib/state.test.ts'],
      repoRoot: REPO,
      related: false,
    });
    expect(plan.tests.some((t) => t.file === 'cli/src/lib/state.test.ts' && t.reason === 'changed-test')).toBe(true);
  });

  test('companion candidates include the colocated test', () => {
    expect(companionCandidates('cli/src/lib/foo.ts')).toContain('cli/src/lib/foo.test.ts');
  });
});

describe('selectImpact policy', () => {
  test('a command definition selects command-index and docs, not daemon', () => {
    const plan = selectImpact({
      files: ['cli/src/commands/run.ts'],
      repoRoot: REPO,
      related: false,
    });
    expect(plan.checks).toEqual(expect.arrayContaining(['command-index', 'docs', 'typecheck']));
    expect(plan.tests.some((t) => t.file.includes('daemon.test.ts'))).toBe(false);
  });

  test('a subprocess entrypoint selects non-interactive tests via ownership', () => {
    const plan = selectImpact({
      files: ['cli/src/bootstrap.ts'],
      repoRoot: REPO,
      related: false,
    });
    expect(plan.tests.some((t) => t.file === 'cli/tests/non-interactive.test.ts')).toBe(true);
    expect(plan.checks).toEqual(expect.arrayContaining(['typecheck', 'binary-smoke']));
  });

  test('a bootstrap change carries the group budget, not the 85s default', () => {
    // Grouped --help lives in bootstrap.ts; a one-line surface edit selects
    // non-interactive.test.ts (54s) plus command-surface tests. PR #2826 run
    // 32431700986 measured 93s and failed the 85s gate.
    const plan = selectImpact({
      files: ['cli/src/bootstrap.ts'],
      repoRoot: REPO,
      related: false,
    });
    expect(plan.suite).toBe('selected');
    expect(plan.budget_sec).toBe(120);
    expect(plan.budget_sec).toBeGreaterThan(IMPACT_BUDGET_SEC);
  });

  test('a sessions change carries the group budget, not the 85s default', () => {
    // Registering a subcommand must touch sessions.ts, which selects the whole
    // sessions* suite. Extracting width/short-id/relative-time (PR #2796, run
    // 32392267349) still touches session/* re-export shims, so the sessions
    // group is selected; impact was 198s and failed the previous 180s ceiling.
    // Under the flat 85s default no new `agents sessions <verb>` could merge.
    const plan = selectImpact({
      files: ['cli/src/commands/sessions.ts'],
      repoRoot: REPO,
      related: false,
    });
    expect(plan.suite).toBe('selected');
    expect(plan.budget_sec).toBe(240);
    expect(plan.budget_sec).toBeGreaterThan(IMPACT_BUDGET_SEC);
  });

  test('a hooks change carries the group budget, not the 85s default', () => {
    const plan = selectImpact({
      files: ['cli/src/lib/hooks/install.ts'],
      repoRoot: REPO,
      related: false,
    });
    expect(plan.suite).toBe('selected');
    expect(plan.budget_sec).toBe(150);
    expect(plan.budget_sec).toBeGreaterThan(IMPACT_BUDGET_SEC);
  });

  test('an installations change carries the group budget, not the 85s default', () => {
    // versions.ts is the install/sync hub. PR #2840 run 32436359101 measured
    // 97s of a passing vitest run and failed the 85s gate.
    const plan = selectImpact({
      files: ['cli/src/lib/installations/versions.ts'],
      repoRoot: REPO,
      related: false,
    });
    expect(plan.suite).toBe('selected');
    expect(plan.budget_sec).toBe(120);
    expect(plan.budget_sec).toBeGreaterThan(IMPACT_BUDGET_SEC);
  });

  test('a daemon change carries the group budget, not the 85s default', () => {
    // runner.ts lives in daemon/; retargeting commands/routines.ts onto it
    // selects routines.test.ts (78 tests / 174s) inside a 213s impact run
    // (PR #2803, run 32395701692). Under 85s the move cannot merge.
    const plan = selectImpact({
      files: ['cli/src/lib/daemon/runner.ts'],
      repoRoot: REPO,
      related: false,
    });
    expect(plan.suite).toBe('selected');
    expect(plan.budget_sec).toBe(240);
    expect(plan.budget_sec).toBeGreaterThan(IMPACT_BUDGET_SEC);
  });

  test('a group with no budget keeps the default, so the ceiling only rises where declared', () => {
    // Uses a genuinely unbudgeted group. This previously pointed at
    // cli/src/commands/** (command-surface), which acquired a budget in
    // RUSH-3062 — the invariant held, only the example went stale. Pick a group
    // whose entry in test-ownership.yaml has no budget_sec today.
    const plan = selectImpact({
      files: ['packages/session-tracker/src/index.ts'],
      repoRoot: REPO,
      related: false,
    });
    expect(plan.budget_sec).toBeUndefined();
  });

  test('the highest budget among matched groups wins', () => {
    // A change spanning a budgeted and an unbudgeted group must not be capped by
    // the unbudgeted one — the run still has to execute the union of both.
    const plan = selectImpact({
      // sessions (240) spanning a genuinely unbudgeted group — commands/** is no
      // longer one, so pairing two command files would compare 240 against 120
      // rather than against the default, and stop testing the stated case.
      files: ['cli/src/commands/sessions.ts', 'packages/session-tracker/src/index.ts'],
      repoRoot: REPO,
      related: false,
    });
    expect(plan.budget_sec).toBe(240);
  });

  test('a budget below the default cannot tighten the gate', () => {
    // The docblock promises budget_sec only ever RAISES the ceiling. Enforce it in
    // code: a group asking for less than IMPACT_BUDGET_SEC gets the default.
    const dir = mkdtempSync(join(tmpdir(), 'budget-floor-'));
    try {
      mkdirSync(join(dir, 'cli/ci'), { recursive: true });
      writeFileSync(join(dir, 'cli/ci/test-ownership.yaml'), [
        'policy_version: impact-v1',
        'areas: []',
        'testless: []',
        'groups:',
        '  - id: tiny',
        '    when: [cli/src/tiny.ts]',
        '    budget_sec: 10',
      ].join('\n'));
      const manifest = loadOwnershipManifest(join(dir, 'cli/ci/test-ownership.yaml'));
      const plan = selectImpact({ files: ['cli/src/tiny.ts'], repoRoot: dir, related: false, manifest });
      expect(plan.budget_sec).toBe(IMPACT_BUDGET_SEC);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a malformed budget_sec fails loud instead of silently defaulting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'budget-bad-'));
    try {
      mkdirSync(join(dir, 'cli/ci'), { recursive: true });
      const path = join(dir, 'cli/ci/test-ownership.yaml');
      for (const bad of ['"soon"', '-30', '0']) {
        writeFileSync(path, [
          'policy_version: impact-v1',
          'areas: []',
          'testless: []',
          'groups:',
          '  - id: bad',
          '    when: [cli/src/bad.ts]',
          `    budget_sec: ${bad}`,
        ].join('\n'));
        expect(() => loadOwnershipManifest(path)).toThrow(/invalid budget_sec on group 'bad'/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('lockfile selects the explicit cli-full group', () => {
    const plan = selectImpact({
      files: ['cli/bun.lock'],
      repoRoot: REPO,
      related: false,
    });
    expect(plan.suite).toBe('cli-full');
    expect(plan.checks).toContain('typecheck');
  });

  test('a deleted tree selects no tests and does not fail the plan', () => {
    // The PR shape that removes a whole mapped tree (apps/ext/** moved to
    // phnx-labs/agi-ext, RUSH-3189): deleted test files must not be queued as
    // work, and a deleted source is not the missing-coverage signal
    // zero_selection exists to catch. None of these paths exist at head.
    const plan = selectImpact({
      files: [
        'apps/ext/app/floorData.test.ts', // testless-exempted tree, deleted
        'scripts/release.test.sh', // mapped scripts/ area, deleted test
        'scripts/release.sh', // mapped scripts/ area, deleted source
      ],
      repoRoot: REPO,
      related: false,
    });
    expect(plan.tests).toEqual([]);
    expect(plan.unmapped).toEqual([]);
    expect(plan.zero_selection).toEqual([]);
    expect(planIsFailing(plan)).toBe(false);
  });

  test('an unmapped production path fails the plan', () => {
    const plan = selectImpact({
      files: ['secret-new-module/exploit.ts'],
      repoRoot: REPO,
      related: false,
    });
    expect(plan.unmapped).toEqual(['secret-new-module/exploit.ts']);
    expect(planIsFailing(plan)).toBe(true);
  });

  test('executable source with no test and no testless entry is zero-selection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agents-ci-zero-'));
    try {
      writeFixture(dir, 'scripts/orphan-no-test.sh', '#!/bin/sh\n');
      const plan = selectImpact({
        files: ['scripts/orphan-no-test.sh'],
        repoRoot: dir,
        manifest: MANIFEST,
        related: false,
      });
      expect(plan.zero_selection).toEqual(['scripts/orphan-no-test.sh']);
      expect(planIsFailing(plan)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('static imports select the importing test', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agents-ci-related-'));
    try {
      writeFixture(dir, 'cli/src/lib/leaf.ts', 'export const x = 1;\n');
      writeFixture(
        dir,
        'cli/src/lib/leaf-user.test.ts',
        "import { x } from './leaf';\nexport const y = x;\n",
      );
      const related = relatedTestFiles(['cli/src/lib/leaf.ts'], dir, [
        'cli/src/lib/leaf.ts',
        'cli/src/lib/leaf-user.test.ts',
      ]);
      expect(related).toContain('cli/src/lib/leaf-user.test.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the reviewed manifest classifies every tracked production path', () => {
    const result = validateOwnershipManifest(MANIFEST, REPO);
    expect(result.missingTests).toEqual([]);
    expect(result.unmapped).toEqual([]);
  });

  test('a runtime readFileSync of a literal script path selects the reading test (RUSH-3097)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agents-ci-runtime-read-'));
    try {
      writeFixture(dir, 'cli/scripts/thing.sh', '#!/bin/sh\necho hi\n');
      writeFixture(
        dir,
        'cli/scripts/thing-var.test.ts',
        "import * as fs from 'node:fs';\n"
          + "import * as path from 'node:path';\n"
          + "const SCRIPT = path.resolve(__dirname, 'thing.sh');\n"
          + 'const body = fs.readFileSync(SCRIPT, \'utf-8\');\n'
          + 'export const y = body;\n',
      );
      writeFixture(
        dir,
        'cli/scripts/thing-inline.test.ts',
        "import * as fs from 'node:fs';\n"
          + "import * as path from 'node:path';\n"
          + 'const body = fs.readFileSync(path.resolve(__dirname, \'thing.sh\'), \'utf-8\');\n'
          + 'export const y = body;\n',
      );
      writeFixture(
        dir,
        'cli/scripts/thing-unrelated.test.ts',
        "export const y = 1;\n",
      );
      const files = [
        'cli/scripts/thing.sh',
        'cli/scripts/thing-var.test.ts',
        'cli/scripts/thing-inline.test.ts',
        'cli/scripts/thing-unrelated.test.ts',
      ];
      const related = runtimeReadTestsBySource(['cli/scripts/thing.sh'], dir, files);
      expect(related.get('cli/scripts/thing.sh')).toEqual(expect.arrayContaining([
        'cli/scripts/thing-var.test.ts',
        'cli/scripts/thing-inline.test.ts',
      ]));
      expect(related.get('cli/scripts/thing.sh')).not.toContain('cli/scripts/thing-unrelated.test.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('release.sh selects every scripts/*.test.ts that reads it via readFileSync at runtime, not just its companion (RUSH-3097)', () => {
    const plan = selectImpact({ files: ['cli/scripts/release.sh'], repoRoot: REPO, manifest: MANIFEST });
    const byFile = new Map(plan.tests.map((t) => [t.file, t.reason]));
    expect(byFile.get('cli/scripts/release.test.ts')).toBe('companion');
    expect(byFile.get('cli/scripts/promote-home-base-probe.test.ts')).toBe('runtime-read');
    expect(byFile.get('cli/scripts/signing-home-base-probe.test.ts')).toBe('runtime-read');
    expect(byFile.get('cli/scripts/stuck-release.test.ts')).toBe('runtime-read');
    expect(plan.unmapped).toEqual([]);
  });
});

describe('rename-aware changed files (PHNX-3200)', () => {
  test('parseRenameAwareRawDiff: a same-mode R100 selects nothing; edits and a mode flip select the new path', () => {
    // `git diff --raw -z` records: ":<oldmode> <newmode> <oldsha> <newsha> <status>" then path(s).
    const z = [
      ':100644 100644 aaa bbb R100', 'cli/src/old.ts', 'cli/lib/old.ts', // pure move, same mode -> nothing
      ':100644 100644 aaa bbb M', 'cli/src/b.ts', // modified -> b
      ':100644 100644 aaa bbb R080', 'cli/src/c.ts', 'cli/lib/c.ts', // rename with edits -> new
      ':000000 100644 000 ddd A', 'cli/src/d.ts', // added -> d
      ':100644 000000 eee 000 D', 'cli/src/e.ts', // deleted -> e (consumer exempts from zero-selection)
      ':100644 100755 fff ggg R100', 'cli/scripts/g.sh', 'cli/lib/g.sh', // move + chmod +x: R100 by content, mode flipped -> new
      '',
    ].join('\0');
    // Source order; the same-mode R100 move contributes nothing, the +x move does.
    expect(parseRenameAwareRawDiff(z)).toEqual([
      'cli/src/b.ts',
      'cli/lib/c.ts',
      'cli/src/d.ts',
      'cli/src/e.ts',
      'cli/lib/g.sh',
    ]);
  });

  function initRenameHistory(
    setup: (repo: string) => void,
    mutate: (repo: string) => void,
  ): { repo: string; base: string; head: string } {
    const dir = mkdtempSync(join(tmpdir(), 'agents-ci-rename-'));
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-b', 'main');
    setup(repo);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');
    mutate(repo);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'head');
    const head = git(repo, 'rev-parse', 'HEAD');
    return { repo, base, head };
  }

  test('a pure git mv is moved-not-changed: it selects neither the old nor the new path', () => {
    const { repo, base, head } = initRenameHistory(
      (r) => writeFixture(r, 'cli/src/foo.ts', 'export const foo = 1;\n'),
      (r) => {
        mkdirSync(join(r, 'cli/lib'), { recursive: true });
        renameSync(join(r, 'cli/src/foo.ts'), join(r, 'cli/lib/foo.ts'));
      },
    );
    try {
      const changed = changedFilesBetween(base, head, repo);
      expect(changed).not.toContain('cli/src/foo.ts');
      expect(changed).not.toContain('cli/lib/foo.ts');
      expect(changed).toEqual([]);
    } finally {
      rmSync(dirname(repo), { recursive: true, force: true });
    }
  });

  test('a rename that also flips the executable bit selects the new path (R100 by content, mode changed)', () => {
    // git reports this as R100 (content identical), but chmod +x is a real change
    // to a script the repo runs directly -- --name-status would have hidden it.
    const { repo, base, head } = initRenameHistory(
      (r) => writeFixture(r, 'cli/scripts/tool.sh', '#!/usr/bin/env bash\necho hi\n'),
      (r) => {
        mkdirSync(join(r, 'cli/lib'), { recursive: true });
        renameSync(join(r, 'cli/scripts/tool.sh'), join(r, 'cli/lib/tool.sh'));
        chmodSync(join(r, 'cli/lib/tool.sh'), 0o755);
      },
    );
    try {
      const changed = changedFilesBetween(base, head, repo);
      expect(changed).toContain('cli/lib/tool.sh');
      expect(changed).not.toContain('cli/scripts/tool.sh');
    } finally {
      rmSync(dirname(repo), { recursive: true, force: true });
    }
  });

  test('a rename WITH an edit selects the new path (content changed there)', () => {
    const { repo, base, head } = initRenameHistory(
      (r) => writeFixture(r, 'cli/src/foo.ts', 'a\nb\nc\nd\ne\nf\ng\nh\n'),
      (r) => {
        mkdirSync(join(r, 'cli/lib'), { recursive: true });
        renameSync(join(r, 'cli/src/foo.ts'), join(r, 'cli/lib/foo.ts'));
        writeFileSync(join(r, 'cli/lib/foo.ts'), 'a\nb\nc\nCHANGED\ne\nf\ng\nh\n');
      },
    );
    try {
      const changed = changedFilesBetween(base, head, repo);
      expect(changed).toContain('cli/lib/foo.ts');
      expect(changed).not.toContain('cli/src/foo.ts');
    } finally {
      rmSync(dirname(repo), { recursive: true, force: true });
    }
  });
});

describe('metadata-class diffs stop selecting the full suite (RUSH-2666)', () => {
  function initPackageJsonHistory(before: object, after: object): { repo: string; base: string; head: string } {
    const dir = mkdtempSync(join(tmpdir(), 'agents-ci-pkg-'));
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-b', 'main');
    writeFixture(repo, 'cli/package.json', `${JSON.stringify(before, null, 2)}\n`);
    git(repo, 'add', 'cli/package.json');
    git(repo, 'commit', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');
    writeFixture(repo, 'cli/package.json', `${JSON.stringify(after, null, 2)}\n`);
    git(repo, 'add', 'cli/package.json');
    git(repo, 'commit', '-m', 'head');
    const head = git(repo, 'rev-parse', 'HEAD');
    return { repo, base, head };
  }

  test('classifyPackageJsonChange: a version-only bump is version-only', () => {
    const { repo, base, head } = initPackageJsonHistory(
      { name: '@phnx-labs/agents-cli', version: '1.22.35', dependencies: { chalk: '^5.0.0' } },
      { name: '@phnx-labs/agents-cli', version: '1.22.36', dependencies: { chalk: '^5.0.0' } },
    );
    try {
      expect(classifyPackageJsonChange('cli/package.json', repo, base, head)).toBe('version-only');
    } finally {
      rmSync(dirname(repo), { recursive: true, force: true });
    }
  });

  test('classifyPackageJsonChange: a dependency edit is not metadata', () => {
    const { repo, base, head } = initPackageJsonHistory(
      { name: '@phnx-labs/agents-cli', version: '1.22.35', dependencies: { chalk: '^5.0.0' } },
      { name: '@phnx-labs/agents-cli', version: '1.22.36', dependencies: { chalk: '^5.1.0' } },
    );
    try {
      expect(classifyPackageJsonChange('cli/package.json', repo, base, head)).toBe('dependency');
    } finally {
      rmSync(dirname(repo), { recursive: true, force: true });
    }
  });

  test('classifyPackageJsonChange: no base/head shas fails closed to unknown', () => {
    expect(classifyPackageJsonChange('cli/package.json', REPO)).toBe('unknown');
  });

  test('a version-only package.json bump selects the minimal set, never cli-full', () => {
    const { repo, base, head } = initPackageJsonHistory(
      { name: '@phnx-labs/agents-cli', version: '1.22.35' },
      { name: '@phnx-labs/agents-cli', version: '1.22.36' },
    );
    try {
      const plan = selectImpact({
        files: ['cli/package.json'],
        repoRoot: repo,
        manifest: MANIFEST,
        related: false,
        baseSha: base,
        headSha: head,
      });
      expect(plan.suite).toBe('selected');
      expect(plan.unmapped).toEqual([]);
      expect(plan.tests.map((t) => t.file)).toEqual(['cli/src/lib/version.test.ts']);
      expect(plan.checks).toEqual(['typecheck']);
    } finally {
      rmSync(dirname(repo), { recursive: true, force: true });
    }
  });

  test('a dependency-changing package.json diff still fails safe to cli-full', () => {
    const { repo, base, head } = initPackageJsonHistory(
      { name: '@phnx-labs/agents-cli', version: '1.22.35', dependencies: { chalk: '^5.0.0' } },
      { name: '@phnx-labs/agents-cli', version: '1.22.35', dependencies: { chalk: '^5.1.0' } },
    );
    try {
      const plan = selectImpact({
        files: ['cli/package.json'],
        repoRoot: repo,
        manifest: MANIFEST,
        related: false,
        baseSha: base,
        headSha: head,
      });
      expect(plan.suite).toBe('cli-full');
    } finally {
      rmSync(dirname(repo), { recursive: true, force: true });
    }
  });

  test('a package.json diff with no base/head shas fails closed to cli-full', () => {
    const plan = selectImpact({
      files: ['cli/package.json'],
      repoRoot: REPO,
      manifest: MANIFEST,
      related: false,
    });
    expect(plan.suite).toBe('cli-full');
  });

  test('a CHANGELOG-only diff selects its generator test, never cli-full', () => {
    // CHANGELOG.md is GENERATED from .changelog/<version>.md, and
    // gen-changelog.test.ts is what asserts the committed file still matches
    // those sources. Selecting nothing here is what let three separate
    // hand-edits reach main on 2026-08-20, each surfacing only when the full
    // suite ran at release time and refused to attest a red tree. The point of
    // the assertion is still that this stays `selected` -- one fast test, not
    // cli-full.
    const plan = selectImpact({
      files: ['CHANGELOG.md', 'cli/CHANGELOG.md'],
      repoRoot: REPO,
      manifest: MANIFEST,
      related: false,
    });
    expect(plan.suite).toBe('selected');
    expect(plan.unmapped).toEqual([]);
    expect(plan.tests.map((t) => t.file)).toEqual(['cli/scripts/gen-changelog.test.ts']);
    expect(plan.checks).toEqual(['docs']);
  });
});

describe('exact-tree proof reuse', () => {
  test('reuses a passing proof only for the same tree, policy, and lockfile', () => {
    const plan = selectImpact({
      files: ['cli/src/lib/state.ts'],
      repoRoot: REPO,
      related: false,
      treeSha: 'tree-aaa',
    });
    const proof = proofFromPlan(plan, Bun.version);
    expect(canReuseProof(proof, plan, Bun.version)).toBe(true);
    expect(canReuseProof({ ...proof, candidate_tree_sha: 'tree-bbb' }, plan, Bun.version)).toBe(false);
    expect(canReuseProof({ ...proof, policy_digest: 'sha256:nope' }, plan, Bun.version)).toBe(false);
    expect(canReuseProof({ ...proof, bun: '0.0.0' }, plan, Bun.version)).toBe(false);
  });

  test('parent-commit evidence is not a reuse key', () => {
    const child = selectImpact({
      files: ['cli/src/lib/state.ts'],
      repoRoot: REPO,
      related: false,
      treeSha: 'child-tree',
    });
    const parentProof = proofFromPlan({ ...child, candidate_tree_sha: 'parent-tree' }, Bun.version);
    expect(canReuseProof(parentProof, child, Bun.version)).toBe(false);
  });
});

describe('commandsForPlan', () => {
  test('small shared-state selections retain their existing budget, as do unrelated leaves', () => {
    const plan = selectImpact({ files: ['cli/src/lib/state.ts'], repoRoot: REPO, related: false });
    expect(plan.budget_sec ?? IMPACT_BUDGET_SEC).toBe(85);
    expect(plan.suite).toBe('selected');
    expect(plan.tests.length).toBeGreaterThan(0);
    expect(plan.checks).toContain('typecheck');
    expect(selectImpact({ files: ['cli/src/lib/device-config.ts'], repoRoot: REPO, related: false }).budget_sec ?? IMPACT_BUDGET_SEC).toBe(85);
    expect(selectImpact({ files: ['cli/src/commands/view.ts'], repoRoot: REPO, related: false }).budget_sec).toBe(120);
    expect(selectImpact({ files: ['cli/src/lib/daemon/harness-update-service.ts'], repoRoot: REPO, related: false }).budget_sec).toBe(240);
  });

  test('the shared-state allowance requires 250 distinct CLI tests without changing coverage', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-budget-size-'));
    try {
      const files = Array.from({ length: 250 }, (_, i) => `cli/tests/selection-${i}.test.ts`);
      for (const file of files) writeFixture(root, file, '');
      const select = (tests: string[], state = true) => selectImpact({
        files: [...(state ? ['cli/src/lib/state.ts'] : []), ...tests],
        repoRoot: root, manifest: MANIFEST, related: false,
      });
      const small = select([...files.slice(0, 249), files[0]]);
      expect(small.tests).toHaveLength(249);
      expect(small.budget_sec ?? IMPACT_BUDGET_SEC).toBe(85);
      const broad = select(files);
      expect(broad.budget_sec).toBe(420);
      expect(broad.tests.map(({ file }) => file).sort()).toEqual([...files].sort());
      expect(broad.checks).toEqual(['typecheck']);
      expect(broad.suite).toBe('selected');
      expect(select(files, false).budget_sec ?? IMPACT_BUDGET_SEC).toBe(85);
      writeFixture(root, 'scripts/extra.test.ts', '');
      expect(select([...files.slice(0, 249), 'scripts/extra.test.ts']).budget_sec ?? IMPACT_BUDGET_SEC).toBe(85);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('selection-size budgets reject invalid thresholds and missing seconds', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-budget-validation-'));
    try {
      const path = join(root, 'ownership.yaml');
      for (const threshold of ['0', '-1', '1.5', '"250"', 'null', 'true']) {
        writeFileSync(path, `policy_version: test\ngroups:\n  - id: sized\n    when: []\n    budget_sec: 420\n    budget_min_selected_cli_tests: ${threshold}\n`);
        expect(() => loadOwnershipManifest(path)).toThrow(/invalid budget_min_selected_cli_tests/);
      }
      writeFileSync(path, 'policy_version: test\ngroups:\n  - id: sized\n    when: []\n    budget_min_selected_cli_tests: 250\n');
      expect(() => loadOwnershipManifest(path)).toThrow(/invalid budget_min_selected_cli_tests/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a changed workflow test is invoked as a path, not a name filter', () => {
    const cmd = commandForTestFile('.github/workflows/tests-gate.test.ts', REPO);
    expect(cmd.cmd).toEqual(['bun', 'test', './.github/workflows/tests-gate.test.ts']);
  });

  test('a changed root script test is executed, not dropped', () => {
    const plan = selectImpact({
      files: ['scripts/bottle.test.sh'],
      repoRoot: REPO,
      related: false,
    });
    expect(plan.tests.some((t) => t.file === 'scripts/bottle.test.sh')).toBe(true);
    const cmds = commandsForPlan(plan, REPO);
    expect(cmds.some((c) => c.cmd[0] === 'bash' && c.cmd[1] === 'bottle.test.sh')).toBe(true);
  });

  test('a session library change selects the session bench', () => {
    const plan = selectImpact({
      files: ['cli/src/lib/session/db.ts'],
      repoRoot: REPO,
      related: false,
    });
    expect(plan.checks).toContain('sessions-bench');
  });

  test('the reviewed manifest has no dead owner globs', () => {
    const result = validateOwnershipManifest(MANIFEST, REPO);
    expect(result.deadGlobs).toEqual([]);
  });

  test('selected CLI tests invoke vitest with those files only', () => {
    const cmds = commandsForPlan({
      ...selectImpact({ files: ['cli/src/lib/state.ts'], repoRoot: REPO, related: false }),
      tests: [{ file: 'cli/src/lib/state.test.ts', reason: 'companion' }],
      checks: [],
      suite: 'selected',
    }, REPO);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].cmd.slice(0, 3)).toEqual(['node', './node_modules/vitest/vitest.mjs', 'run']);
    expect(cmds[0].cmd).toContain('src/lib/state.test.ts');
    expect(cmds[0].cmd.join(' ')).not.toContain('--shard');
  });

  // RUSH-2666 (wave 6): vitest's CLI treats every arg after a literal `--`
  // as opaque pass-through, not a file filter. `vitest run -- state.test.ts`
  // silently falls back to the full `include` glob. Measured on PR #2770:
  // the plan selected 3 files, the `--` invocation ran all 864 (883.72s)
  // instead of the selected files (~13s single-file). Guard the exact
  // token shape so this regression can't sneak back in.
  test('vitest invocations never carry a bare `--` before the file list', () => {
    const single = commandForTestFile('cli/src/lib/state.test.ts', REPO);
    expect(single.cmd).not.toContain('--');

    const batched = commandsForPlan({
      ...selectImpact({ files: ['cli/src/lib/state.ts'], repoRoot: REPO, related: false }),
      tests: [
        { file: 'cli/src/lib/state.test.ts', reason: 'companion' },
        { file: 'cli/src/commands/webhook.test.ts', reason: 'companion' },
      ],
      checks: [],
      suite: 'selected',
    }, REPO);
    for (const c of batched) expect(c.cmd).not.toContain('--');
  });
});

describe('typecheck runs once per selected run (PR #3568)', () => {
  test('the CLI install is the typecheck: prepare builds with tsc, and the check adds no second build', () => {
    // Half one: the package's install lifecycle really is a tsc build. If this
    // ever stops being true the `typecheck` check must run a build again.
    const pkg = JSON.parse(readFileSync(join(REPO, 'cli', 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.prepare).toBe('npm run build');
    expect(pkg.scripts.build.startsWith('tsc')).toBe(true);

    // Half two: a plan that asks for typecheck installs the CLI (which builds)
    // and runs no separate build command.
    const plan = {
      ...selectImpact({ files: ['cli/src/commands/webhook.ts'], repoRoot: REPO, related: false }),
      tests: [],
      checks: ['typecheck'] as ImpactPlan['checks'],
      suite: 'selected' as const,
    };
    const install = installCommandsForPlan(plan, REPO);
    expect(install.map((c) => c.cmd.join(' '))).toEqual(['bun install --frozen-lockfile']);
    const cmds = commandsForPlan(plan, REPO);
    expect(cmds.some((c) => c.cmd.join(' ') === 'bun run build')).toBe(false);
    expect(cmds.some((c) => c.cmd.includes('tsc'))).toBe(false);
  });
});

test('ordinary impact budget is 85 seconds', () => {
  expect(IMPACT_BUDGET_SEC).toBe(85);
});

test('the executable writes GitHub outputs from NUL-delimited git paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-ci-scope-'));
  const output = join(dir, 'github-output');
  try {
    const proc = Bun.spawnSync({
      cmd: ['bun', join(import.meta.dir, 'ci-scope.ts'), output],
      stdin: Buffer.from('packages/session-tracker/src/index.ts\0cli/docs/README.md\0'),
      cwd: REPO,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(proc.exitCode).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe(formatGitHubOutputs({
      cli: false,
      cliDocs: true,
      sessionTracker: true,
      windows: false,
    }, {
      unmapped: 'false',
      reused: 'false',
      suite: 'selected',
      tree: '',
      policy_digest: loadOwnershipManifest() && (selectImpact({
        files: ['packages/session-tracker/src/index.ts', 'cli/docs/README.md'],
        repoRoot: REPO,
        related: false,
      }).policy_digest),
    }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the executable fails loud on an unmapped path', () => {
  const proc = Bun.spawnSync({
    cmd: ['bun', join(import.meta.dir, 'ci-scope.ts'), '--json'],
    stdin: Buffer.from('brand-new-unmapped/module.ts\n'),
    cwd: REPO,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(proc.exitCode).toBe(1);
  const plan = JSON.parse(Buffer.from(proc.stdout).toString('utf8'));
  expect(plan.unmapped).toEqual(['brand-new-unmapped/module.ts']);
});

test('--base --head --json is the canonical planner interface', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-ci-json-'));
  const repo = join(dir, 'repo');
  try {
    mkdirSync(repo);
    git(repo, 'init', '-b', 'main');
    writeFixture(repo, 'README.md');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');
    writeFixture(repo, 'apps/ios/README.md', 'ios\n');
    git(repo, 'add', 'apps/ios/README.md');
    git(repo, 'commit', '-m', 'ios docs');
    const head = git(repo, 'rev-parse', 'HEAD');
    const proc = Bun.spawnSync({
      cmd: ['bun', join(import.meta.dir, 'ci-scope.ts'), '--base', base, '--head', head, '--json'],
      cwd: repo,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(proc.exitCode).toBe(0);
    const plan = JSON.parse(Buffer.from(proc.stdout).toString('utf8'));
    expect(plan.policy_version).toBe('impact-v1');
    expect(plan.platforms).toEqual(['linux']);
    expect(plan.unmapped).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('changedFilesBetween ignores changes made only on the updated base branch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-ci-merge-base-'));
  const repo = join(dir, 'repo');
  const headWorktree = join(dir, 'head');
  try {
    mkdirSync(repo);
    git(repo, 'init', '-b', 'main');
    writeFixture(repo, 'README.md');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-m', 'base');
    const mergeBase = git(repo, 'rev-parse', 'HEAD');

    git(repo, 'worktree', 'add', '-b', 'pr-head', headWorktree, mergeBase);
    writeFixture(headWorktree, 'cli/src/lib/head-only.ts');
    git(headWorktree, 'add', 'cli/src/lib/head-only.ts');
    git(headWorktree, 'commit', '-m', 'head-only change');
    const head = git(headWorktree, 'rev-parse', 'HEAD');

    writeFixture(repo, 'cli/src/lib/base-only.ts');
    git(repo, 'add', 'cli/src/lib/base-only.ts');
    git(repo, 'commit', '-m', 'base-only change');
    const updatedBase = git(repo, 'rev-parse', 'HEAD');

    expect(changedFilesBetween(updatedBase, head, repo)).toEqual([
      'cli/src/lib/head-only.ts',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('changedFilesBetween treats a pure cross-component move as moved-not-changed (PHNX-3200)', () => {
  // Was: `--no-renames` reported this as a delete of the old path PLUS an add of
  // the new one, so a pure move read as two changed files (and the #3033 flatten
  // of ~2100 files read as ~2100 changes → suite=cli-full). Rename-aware, a
  // 100%-similarity move selects nothing: the content is unchanged, and any
  // importer whose path broke shows up as its own content change.
  const repo = mkdtempSync(join(tmpdir(), 'agents-ci-rename-'));
  try {
    git(repo, 'init', '-b', 'main');
    const oldPath = 'cli/src/lib/hooks.ts';
    const newPath = 'website/hooks.ts';
    writeFixture(repo, oldPath);
    git(repo, 'add', oldPath);
    git(repo, 'commit', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');

    mkdirSync(join(repo, 'website'), { recursive: true });
    renameSync(join(repo, oldPath), join(repo, newPath));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'move hook');
    const head = git(repo, 'rev-parse', 'HEAD');

    const files = changedFilesBetween(base, head, repo);
    expect(files).toEqual([]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

describe('isVitestWorkerCrashWithZeroFailures', () => {
  const greenWithWorkerCrash = `
 Test Files  863 passed | 6 skipped (870)
      Tests  12206 passed | 112 skipped (12318)
   Start at  14:31:12
   Duration  667.12s

⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯

Error: Worker exited unexpectedly
 ❯ process.<anonymous> ../../node_modules/vitest/dist/chunks/cli-api.B7PN_QUv.js
`;

  const realFailures = `
 Test Files  2 failed | 861 passed (863)
      Tests  3 failed | 12203 passed (12206)
   Start at  14:31:12
   Duration  667.12s

⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯

Error: Worker exited unexpectedly
`;

  test('treats a worker crash after a fully green suite as non-fatal', () => {
    expect(isVitestWorkerCrashWithZeroFailures(greenWithWorkerCrash)).toBe(true);
  });

  test('does not swallow a worker crash that also has failed tests', () => {
    expect(isVitestWorkerCrashWithZeroFailures(realFailures)).toBe(false);
  });

  test('ignores a green suite that did not crash a worker', () => {
    expect(isVitestWorkerCrashWithZeroFailures(`
 Test Files  863 passed | 6 skipped (870)
      Tests  12206 passed | 112 skipped (12318)
`)).toBe(false);
  });
});
