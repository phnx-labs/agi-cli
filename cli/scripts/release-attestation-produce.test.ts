/**
 * release-attestation-produce.sh, exercised against a REAL git repo (no
 * mocks) with fake `bun`/`npm` binaries standing in for the real toolchain --
 * this test is about the script's orchestration (worktree isolation, fail-
 * closed on a red suite, attestation write + tarball placement), not about
 * re-running the real suite or a real `npm pack` inside a test.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_SCRIPT = path.resolve(__dirname, 'test.sh');
const PRODUCE_SCRIPT = path.resolve(__dirname, 'release-attestation-produce.sh');
const ATTEST_SCRIPT = path.resolve(__dirname, 'release-attestation.sh');
const MANIFEST_SCRIPT = path.resolve(__dirname, 'release-manifest.sh');
const roots: string[] = [];

function tmp(prefix: string): string {
  // realpath: on macOS os.tmpdir() resolves under /var, which is itself a
  // symlink to /private/var. `git worktree list` and other subprocesses
  // report the resolved path, so an un-normalized root here diverges from
  // what those commands print back (RUSH-2750).
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

// Builds a caller repo (a bare remote + a clone) shaped enough like the real
// monorepo for release-attestation.sh's identity() to resolve: cli/{
// package.json, bun.lock, vitest.config.ts, ci/test-ownership.yaml } plus a
// root-level scripts/ci-scope.ts. A fake bun/npm on PATH stand in for the
// real toolchain; `failSuite` makes the fake `bun run test` exit non-zero.
function fakeSuiteBody(opts: { failSuite?: boolean; suite?: 'greenWorkerCrash' | 'redWorkerCrash' }): string {
  // Summary lines mirror real vitest output so the producer's
  // suite_green_despite_worker_crash parser is exercised against the shape it
  // sees in production (RUSH-2758).
  if (opts.suite === 'greenWorkerCrash')
    return [
      '  echo " Test Files  861 passed | 8 skipped (870)"',
      '  echo "      Tests  12200 passed | 105 skipped (12325)"',
      '  echo "Error: Worker exited unexpectedly"',
      '  exit 1',
    ].join('\n');
  if (opts.suite === 'redWorkerCrash')
    return [
      '  echo " Test Files  2 failed | 859 passed (870)"',
      '  echo "      Tests  3 failed | 12197 passed (12325)"',
      '  echo "Error: Worker exited unexpectedly"',
      '  exit 1',
    ].join('\n');
  if (opts.failSuite) return '  echo "1 test failed" >&2; exit 1';
  return '  echo "tests passed"; exit 0';
}

function buildFixture(root: string, opts: { failSuite?: boolean; suite?: 'greenWorkerCrash' | 'redWorkerCrash' } = {}): { caller: string; fakebin: string; store: string; headCommit: string } {
  const remote = path.join(root, 'remote.git');
  const caller = path.join(root, 'caller');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(root, 'clone', '-q', remote, caller);
  git(caller, 'config', 'user.email', 'attest-test@example.com');
  git(caller, 'config', 'user.name', 'attest-test');

  fs.mkdirSync(path.join(caller, 'cli/scripts'), { recursive: true });
  fs.mkdirSync(path.join(caller, 'cli/ci'), { recursive: true });
  fs.mkdirSync(path.join(caller, 'scripts'), { recursive: true });
  // RUSH-3178: the producer no longer runs `bun run test` itself -- it calls
  // scripts/test.sh, which owns WHERE the suite runs. The fixture therefore has
  // to carry the real test.sh, and runProduce passes --test-here so the fake
  // `bun run test` below is still what actually executes. Deliberately the real
  // script and not a stub: that is what pins the producer -> test.sh contract.
  fs.copyFileSync(TEST_SCRIPT, path.join(caller, 'cli/scripts/test.sh'));
  fs.chmodSync(path.join(caller, 'cli/scripts/test.sh'), 0o755);
  fs.copyFileSync(PRODUCE_SCRIPT, path.join(caller, 'cli/scripts/release-attestation-produce.sh'));
  fs.copyFileSync(ATTEST_SCRIPT, path.join(caller, 'cli/scripts/release-attestation.sh'));
  fs.chmodSync(path.join(caller, 'cli/scripts/release-attestation-produce.sh'), 0o755);
  fs.chmodSync(path.join(caller, 'cli/scripts/release-attestation.sh'), 0o755);
  fs.writeFileSync(path.join(caller, 'cli/package.json'), '{"name":"@phnx-labs/agents-cli","version":"9.9.9"}\n');
  fs.writeFileSync(path.join(caller, 'cli/bun.lock'), 'lock-v1\n');
  fs.writeFileSync(path.join(caller, 'cli/vitest.config.ts'), 'export default {}\n');
  fs.writeFileSync(path.join(caller, 'cli/ci/test-ownership.yaml'), 'ownership: {}\n');
  fs.writeFileSync(path.join(caller, 'scripts/ci-scope.ts'), '// scope\n');
  git(caller, 'add', '-A');
  git(caller, 'commit', '-q', '-m', 'init');
  git(caller, 'push', '-q', '-u', 'origin', 'main');
  const headCommit = git(caller, 'rev-parse', 'HEAD');

  const fakebin = path.join(root, 'fakebin');
  fs.mkdirSync(fakebin, { recursive: true });
  fs.writeFileSync(
    path.join(fakebin, 'bun'),
    [
      '#!/usr/bin/env bash',
      'if [[ "$1" == "--version" ]]; then echo "1.2.3"; exit 0; fi',
      // PHNX-2943: the producer reads the computer-mac floor via `bun -e "…helperFloor…"`.
      // Real bun evaluates cli/src/lib/helper-versions.ts; the stub returns the same
      // floor the fixture's helper-versions.ts declares (1.0.0), so the fetch targets
      // computer-mac/v1.0.0 exactly as production does.
      'if [[ "$1" == "-e" ]]; then echo "1.0.0"; exit 0; fi',
      'if [[ "$1" == "install" ]]; then exit 0; fi',
      'if [[ "$1" == "run" && "$2" == "test" ]]; then',
      // RUSH-3007: the producer must run the suite with AGENTS_ATTEST_PRODUCER=1
      // and CI unset, never CI=true -- see the "sets AGENTS_ATTEST_PRODUCER..."
      // test below, which asserts on this exact line.
      '  echo "RUSH-3007-ENV: producer=${AGENTS_ATTEST_PRODUCER:-<unset>} ci=${CI:-<unset>}"',
      fakeSuiteBody(opts),
      'fi',
      'if [[ "$1" == "run" && "$2" == "build" ]]; then mkdir -p dist; exit 0; fi',
      'echo "fake bun: unhandled args: $*" >&2; exit 1',
      '',
    ].join('\n'),
  );
  fs.chmodSync(path.join(fakebin, 'bun'), 0o755);
  fs.writeFileSync(
    path.join(fakebin, 'npm'),
    [
      '#!/usr/bin/env bash',
      'if [[ "$1" == "pack" ]]; then',
      '  name="phnx-labs-agents-cli-9.9.9.tgz"',
      '  echo "fake-tarball-bytes-$$" > "$name"',
      '  echo "$name"',
      '  exit 0',
      'fi',
      'echo "fake npm: unhandled args: $*" >&2; exit 1',
      '',
    ].join('\n'),
  );
  fs.chmodSync(path.join(fakebin, 'npm'), 0o755);

  return { caller, fakebin, store: path.join(root, 'store'), headCommit };
}

function runProduce(
  fx: ReturnType<typeof buildFixture>,
  extraArgs: string[] = [],
  envOverride: NodeJS.ProcessEnv = {},
) {
  return spawnSync(
    'bash',
    [
      path.join(fx.caller, 'cli/scripts/release-attestation-produce.sh'),
      fx.headCommit,
      // Run the suite in place: the fixture's fake `bun` IS the suite, and these
      // tests assert on attestation/manifest behavior, not on offload routing.
      '--test-here',
      '--repo-root',
      fx.caller,
      '--dir',
      fx.store,
      ...extraArgs,
    ],
    {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${fx.fakebin}:${process.env.PATH}`, ...envOverride },
    },
  );
}



describe('release-attestation-produce.sh --help', () => {
  it('lists every flag its parser accepts (executed, not grepped)', () => {
    // `--help` printed a hardcoded `sed -n '3,32p'` slice, so --with-helpers —
    // documented around line 40 — never appeared. A magic line range drifts
    // every time the header grows and fails SILENTLY: the help just gets
    // quieter. This derives the flag set from the parser's own case arms and
    // compares against real --help output, so the next flag is covered without
    // anyone remembering to extend the test.
    const help = spawnSync('bash', [PRODUCE_SCRIPT, '--help'], { encoding: 'utf-8' });
    expect(help.status, help.stderr).toBe(0);

    const parsed = new Set<string>();
    for (const arm of fs.readFileSync(PRODUCE_SCRIPT, 'utf-8').matchAll(/^\s{4}(--[^)]+)\)/gm)) {
      for (const flag of arm[1].split('|')) {
        const name = flag.trim();
        if (name === '--*' || name === '--help') continue;
        parsed.add(name);
      }
    }
    expect(parsed.size, 'no flags parsed out of the case arms').toBeGreaterThan(3);

    const missing = [...parsed].filter((f) => !help.stdout.includes(f));
    expect(missing, `--help omits: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('release-attestation-produce.sh', () => {
  it('does NOT seed helper apps on a non-Mac producer — the tarball ships none (RUSH-3100)', () => {
    // This replaces the RUSH-3026 seeding test, and the reversal is the point.
    //
    // Seeding existed ONLY because `prepack` refused to pack without the signed
    // .apps, and the producer's fresh worktree has an empty bin/. That was the
    // workaround for the very coupling RUSH-3100 removed. With the gates gone,
    // copying signed bundles into a tree that will not ship them is pure motion —
    // and the seed's own comment ("the prepack gates still decide … fails the pack
    // exactly as before") became false the moment they were removed.
    //
    // The assertion that matters is the NEGATIVE one: a non-Mac producer must
    // still succeed. Asserting only "no seeding" would pass on a producer that
    // broke outright.
    const root = tmp('attest-produce-noseed-');
    const fx = buildFixture(root);
    // Already-signed apps present in the CALLER checkout — the exact condition
    // that used to trigger seeding.
    for (const [app, binName] of [
      ['MenubarHelper.app', 'AGI Menu'],
    ] as const) {
      const dir = path.join(fx.caller, 'cli/bin', app, 'Contents/MacOS');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, binName), 'signed-bytes\n');
    }
    const result = runProduce(fx, ['--keep']);
    const out = (result.stdout + result.stderr).replace(/\[[0-9;]*m/g, '');

    // It still produces an attestation.
    expect(result.status, out).toBe(0);
    // …without copying either bundle anywhere.
    expect(out).not.toContain('seeded bin/');
    const kept = out.match(/kept worktree for inspection: (\S+)/);
    expect(kept, out).toBeTruthy();
    for (const app of ['MenubarHelper.app']) {
      expect(
        fs.existsSync(path.join(kept![1], 'cli/bin', app)),
        `${app} must not be copied into the producer worktree`,
      ).toBe(false);
    }
  });

  it('routes --test-crabbox to test.sh\'s crabbox lane (surface parity, RUSH-3211)', () => {
    // test.sh has three lanes and the producer used to expose only two, so a
    // release could never ask for the disposable crabbox. runProduce passes
    // --test-here first and extraArgs come after, so this asserts last-wins too.
    // The fixture carries no scripts/sandbox.sh, and that prerequisite check
    // lives INSIDE test.sh's crabbox branch -- so this message can only be
    // reached by routing there. The negative half is what makes it proof: --here
    // would have SUCCEEDED, since the fixture's fake `bun` is a passing suite,
    // so a silent fallback to the default would show up as exit 0 with an
    // attestation written.
    const fx = buildFixture(tmp('attest-produce-crabbox-'));
    const r = runProduce(fx, ['--test-crabbox']);
    const out = `${r.stdout}${r.stderr}`;
    expect(r.status, out).not.toBe(0);
    expect(out).toMatch(/sandbox\.sh missing -- cannot offload/);
    expect(out).not.toMatch(/tests passed/);
  });

  // The default (no --test-* flag) shards the suite across the fleet so a
  // release stops pinning one box at --maxWorkers=2 for ~880s. These two tests
  // pin the DECISION the producer makes about how to call test.sh -- so they
  // commit a recording stub test.sh (the producer runs test.sh from a fresh
  // worktree checkout, hence a commit, not a working-tree edit) and stub
  // `agents devices pick --json` on PATH to control the eligible-worker count.
  // `headrooms` is one entry per candidate `agents devices pick` reports: a string
  // sets that candidate's headroom, null omits the field. The producer must count
  // only headroom != "loaded", matching test.sh's own shard-worker filter.
  function withRecordingTestSh(fx: ReturnType<typeof buildFixture>, root: string, headrooms: Array<string | null>) {
    const cand = headrooms
      .map((h, i) => (h === null ? `{"device":"w${i}"}` : `{"device":"w${i}","headroom":"${h}"}`))
      .join(',');
    fs.writeFileSync(
      path.join(fx.fakebin, 'agents'),
      [
        '#!/usr/bin/env bash',
        'if [[ "$1" == "devices" && "$2" == "pick" ]]; then',
        `  echo '{"candidates":[${cand}]}'`,
        '  exit 0',
        'fi',
        'exit 0',
      ].join('\n'),
    );
    fs.chmodSync(path.join(fx.fakebin, 'agents'), 0o755);
    const argsLog = path.join(root, 'testsh-argv.txt');
    fs.writeFileSync(
      path.join(fx.caller, 'cli/scripts/test.sh'),
      ['#!/usr/bin/env bash', `printf '%s\\n' "$*" > ${JSON.stringify(argsLog)}`, 'echo "tests passed"', 'exit 0'].join('\n'),
    );
    fs.chmodSync(path.join(fx.caller, 'cli/scripts/test.sh'), 0o755);
    git(fx.caller, 'add', '-A');
    git(fx.caller, 'commit', '-q', '-m', 'recording test.sh stub');
    git(fx.caller, 'push', '-q', 'origin', 'main');
    const head = git(fx.caller, 'rev-parse', 'HEAD');
    const r = spawnSync(
      'bash',
      [path.join(fx.caller, 'cli/scripts/release-attestation-produce.sh'), head, '--repo-root', fx.caller, '--dir', fx.store],
      { encoding: 'utf-8', env: { ...process.env, PATH: `${fx.fakebin}:${process.env.PATH}` } },
    );
    return { r, argsLog };
  }

  it('shards the suite across the fleet by default, keeping --maxWorkers=2 per shard (fast release)', () => {
    // The whole point: a release must not run ~13k tests on one box at
    // maxWorkers=2 (~880s). With >=2 eligible workers the producer fans out via
    // test.sh --shard N, and each shard STILL passes --maxWorkers=2 --retry=2 so
    // the RUSH-3015 per-box flake mitigation is unchanged (sharding adds boxes,
    // not per-box concurrency).
    const root = tmp('attest-produce-shard-');
    const fx = buildFixture(root);
    const { r, argsLog } = withRecordingTestSh(fx, root, [null, null, null]);
    const out = `${r.stdout}${r.stderr}`;
    expect(r.status, out).toBe(0);
    const argv = fs.readFileSync(argsLog, 'utf-8');
    expect(argv).toContain('--shard 3');
    expect(argv).toContain('--maxWorkers=2');
  });

  it('counts only headroom != "loaded", matching test.sh\'s shard-worker filter', () => {
    // The producer's count must be the SAME eligible pool test.sh will fan across
    // (scripts/test.sh filters headroom != "loaded"). Counting raw candidates would
    // ask for more shards than test.sh finds eligible. Here 2 idle + 2 loaded -> 2.
    const root = tmp('attest-produce-loaded-');
    const fx = buildFixture(root);
    const { r, argsLog } = withRecordingTestSh(fx, root, ['idle', 'idle', 'loaded', 'loaded']);
    const out = `${r.stdout}${r.stderr}`;
    expect(r.status, out).toBe(0);
    const argv = fs.readFileSync(argsLog, 'utf-8');
    expect(argv).toContain('--shard 2');
  });

  it('falls back to a single auto-picked box when fewer than 2 workers are eligible (no thin-fleet release break)', () => {
    // test.sh --shard has no silent fallback and refuses <2 workers, so a blind
    // default of --shard N would fail a release on a small fleet. The producer
    // resolves the count itself and only shards when >=2 are eligible.
    const root = tmp('attest-produce-thin-');
    const fx = buildFixture(root);
    const { r, argsLog } = withRecordingTestSh(fx, root, [null]);
    const out = `${r.stdout}${r.stderr}`;
    expect(r.status, out).toBe(0);
    const argv = fs.readFileSync(argsLog, 'utf-8');
    expect(argv).not.toContain('--shard');
  });

  it('does not seed when the caller checkout has no apps (nothing to reuse; gates decide)', () => {
    const root = tmp('attest-produce-noseed-');
    const fx = buildFixture(root);
    const result = runProduce(fx);
    const out = result.stdout + result.stderr;
    expect(result.status, out).toBe(0); // fake npm pack has no prepack gates
    expect(out).not.toContain('seeded bin/');
  });

  it('runs the suite with AGENTS_ATTEST_PRODUCER=1 and CI unset, even when the caller shell exports CI=true (RUSH-3007)', () => {
    // Cutting 1.22.44, the operator exported CI=true by hand to get vitest's
    // extended hookTimeout profile, which also armed tests/setup.ts's
    // real-~/.agents leak tripwires against a box with a live daemon +
    // active sessions -- 129/129 test files false-failed on a fully green
    // suite. The producer must set its own AGENTS_ATTEST_PRODUCER flag and
    // unset any ambient CI so this exact operator mistake cannot recur.
    const root = tmp('attest-produce-envflag-');
    const fx = buildFixture(root);
    const result = spawnSync(
      'bash',
      [
        path.join(fx.caller, 'cli/scripts/release-attestation-produce.sh'),
        fx.headCommit,
        // In-place: the fixture's fake `bun` is the suite (see runProduce).
        '--test-here',
        '--repo-root',
        fx.caller,
        '--dir',
        fx.store,
      ],
      { encoding: 'utf-8', env: { ...process.env, PATH: `${fx.fakebin}:${process.env.PATH}`, CI: 'true' } },
    );
    const out = result.stdout + result.stderr;
    expect(result.status, out).toBe(0);
    expect(out).toContain('RUSH-3007-ENV: producer=1 ci=<unset>');
  });

  it('runs the suite, packs the tarball, and writes a passing attestation for the exact tree', () => {
    const root = tmp('attest-produce-');
    const fx = buildFixture(root);
    const result = runProduce(fx);
    expect(result.status, result.stdout + result.stderr).toBe(0);

    const files = fs.readdirSync(fx.store);
    const jsonFile = files.find((f) => f.endsWith('.json'));
    expect(jsonFile).toBeTruthy();
    const record = JSON.parse(fs.readFileSync(path.join(fx.store, jsonFile!), 'utf-8'));

    expect(record.schemaVersion).toBe(1);
    expect(record.conclusion).toBe('pass');
    // release.sh's own `require` calls never pass --suite, so
    // bind_tree_lock_policy defaults to "selected" -- a record tagged
    // anything else is invisible to the consumer regardless of matching
    // tree/lock/policy. Assert the actual consumer contract below, not just
    // this literal, so a producer/consumer drift here fails the suite.
    expect(record.suite).toBe('selected');
    expect(record.candidateTree).toBe(git(fx.caller, 'rev-parse', 'HEAD^{tree}'));
    expect(record.lockfileDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(record.policyVersion).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(record.tarball.filename).toBe('phnx-labs-agents-cli-9.9.9.tgz');
    expect(record.tarball.digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    // The tarball itself must be sitting next to the attestation JSON so
    // release-attestation.sh tarball/promote can resolve it by directory.
    const tgzPath = path.join(fx.store, record.tarball.filename);
    expect(fs.existsSync(tgzPath)).toBe(true);
    const actualDigest = spawnSync('sha256sum', [tgzPath], { encoding: 'utf-8' }).stdout.trim().split(/\s+/)[0];
    expect(record.tarball.digest).toBe(`sha256:${actualDigest}`);

    // The isolated worktree used to run the suite must not survive the run --
    // only the caller checkout itself is left registered. `git worktree list`
    // column-aligns its whitespace by path length, so match on content, not
    // an exact padded string (that padding differs by tmpdir path length,
    // which differs on CI vs locally).
    const worktrees = git(fx.caller, 'worktree', 'list')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0]).toMatch(new RegExp(`^${fx.caller.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+${fx.headCommit.slice(0, 7)}`));

    // The actual consumer: release.sh's require call (no --suite, no
    // --bun/--node/--platform) must find and accept what the producer wrote.
    const required = spawnSync(
      'bash',
      [ATTEST_SCRIPT, 'require', '--dir', fx.store, '--tree', record.candidateTree, '--repo-root', fx.caller],
      { encoding: 'utf-8' },
    );
    expect(required.status, required.stdout + required.stderr).toBe(0);
  });

  it('survives a relative --dir: the attestation lands outside the throwaway worktree, not inside it', () => {
    const root = tmp('attest-produce-relative-dir-');
    const fx = buildFixture(root);
    const relativeStore = '.release-attestations';
    const result = spawnSync(
      'bash',
      [
        path.join(fx.caller, 'cli/scripts/release-attestation-produce.sh'),
        fx.headCommit,
        // In-place: the fixture's fake `bun` is the suite (see runProduce).
        '--test-here',
        '--repo-root',
        fx.caller,
        '--dir',
        relativeStore,
      ],
      { encoding: 'utf-8', env: { ...process.env, PATH: `${fx.fakebin}:${process.env.PATH}` } },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);

    // The script cd's to its own cli directory before resolving --dir
    // (matching how release.sh's own docs invoke release-attestation.sh with
    // a relative path from cli), so a relative --dir resolves there --
    // NOT wherever the caller happened to be, and NOT inside the throwaway
    // worktree the script deletes on exit.
    const resolvedStore = path.join(fx.caller, 'cli', relativeStore);
    expect(fs.existsSync(resolvedStore)).toBe(true);
    const jsonFile = fs.readdirSync(resolvedStore).find((f) => f.endsWith('.json'));
    expect(jsonFile).toBeTruthy();
    const tgzFile = fs.readdirSync(resolvedStore).find((f) => f.endsWith('.tgz'));
    expect(tgzFile).toBeTruthy();
  });

  it('never writes an attestation for a red suite (fail closed)', () => {
    const root = tmp('attest-produce-red-');
    const fx = buildFixture(root, { failSuite: true });
    const result = runProduce(fx);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('refusing to attest a red tree');
    expect(fs.existsSync(fx.store) ? fs.readdirSync(fx.store).filter((f) => f.endsWith('.json')) : []).toEqual([]);
  });

  it('attests a green suite whose only failure is a teardown worker-exit (RUSH-2758)', () => {
    const root = tmp('attest-produce-worker-crash-green-');
    const fx = buildFixture(root, { suite: 'greenWorkerCrash' });
    const result = runProduce(fx);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toContain('treating as pass');
    const jsonFile = fs.readdirSync(fx.store).find((f) => f.endsWith('.json'));
    expect(jsonFile).toBeTruthy();
    expect(JSON.parse(fs.readFileSync(path.join(fx.store, jsonFile!), 'utf-8')).conclusion).toBe('pass');
  });

  it('stays fail-closed when a worker crash accompanies real test failures', () => {
    const root = tmp('attest-produce-worker-crash-red-');
    const fx = buildFixture(root, { suite: 'redWorkerCrash' });
    const result = runProduce(fx);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('refusing to attest a red tree');
    expect(fs.existsSync(fx.store) ? fs.readdirSync(fx.store).filter((f) => f.endsWith('.json')) : []).toEqual([]);
  });

  it('requires a commit-ish argument', () => {
    const root = tmp('attest-produce-usage-');
    const fx = buildFixture(root);
    const result = spawnSync('bash', [path.join(fx.caller, 'cli/scripts/release-attestation-produce.sh')], {
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/usage:/);
  });
});

// Extends the base fixture with a real (copied, not faked) release-manifest.sh
// plus minimal source trees for both known helpers -- computer-mac at repo
// root, menubar under cli -- so the producer's helper-manifest
// step (RUSH-2766) has real inputs to hash. menubar's "signed" asset
// is a plain placeholder file standing in for what the Darwin-only sign block
// would have built; the manifest step only checks the file exists and hashes
// it, so this is enough to exercise it on Linux CI without a real signing box.
/**
 * A prior release's `release-manifest.json`, built with the shipped generator
 * so the seed fixture matches what a real GitHub release carries.
 */
function priorReleaseManifest(root: string, computerMacDigest: string): string {
  const file = path.join(root, 'prior-release-manifest.json');
  const created = spawnSync(
    'bash',
    [MANIFEST_SCRIPT, 'new', '--cli-version', 'prev-1.0.0', '--cli-tree', 'deadbeef'],
    { encoding: 'utf-8' },
  );
  if (created.status !== 0) throw new Error(created.stderr || created.stdout);
  fs.writeFileSync(file, created.stdout);
  // `put` verifies the asset exists on disk, so give it a real one in a temp
  // dist/ and run from there — the same shape a signing box would have.
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  const asset = path.join(root, 'dist/ComputerHelper.app.zip');
  fs.writeFileSync(asset, 'prior release helper asset\n');
  // put refuses a declared digest that does not match the real bytes, so
  // compute it rather than asserting a placeholder.
  const assetDigest =
    'sha256:' + createHash('sha256').update(fs.readFileSync(asset)).digest('hex');
  const put = spawnSync(
    'bash',
    [
      MANIFEST_SCRIPT, 'put', '--file', file,
      '--helper', 'computer-mac',
      '--helper-version', 'prev-1.0.0',
      '--input-digest', computerMacDigest,
      '--asset-digest', assetDigest,
      '--asset-path', 'dist/ComputerHelper.app.zip',
      '--platform', 'darwin',
    ],
    { encoding: 'utf-8', cwd: root },
  );
  if (put.status !== 0) throw new Error(put.stderr || put.stdout);
  return fs.readFileSync(file, 'utf-8').trim();
}

function buildManifestFixture(root: string): ReturnType<typeof buildFixture> & {
  manifestDigests: Record<'computer-mac' | 'menubar', string>;
} {
  const fx = buildFixture(root);
  const { caller } = fx;

  fs.mkdirSync(path.join(caller, 'native/computer-mac/Sources'), { recursive: true });
  fs.mkdirSync(path.join(caller, 'native/computer-mac/scripts'), { recursive: true });
  fs.writeFileSync(path.join(caller, 'native/computer-mac/Sources/dummy.swift'), '// dummy\n');
  fs.writeFileSync(path.join(caller, 'native/computer-mac/scripts/build.sh'), '#!/usr/bin/env bash\n');
  fs.writeFileSync(path.join(caller, 'native/computer-mac/Package.swift'), '// swift package\n');

  // The producer reads the computer-mac floor from this module to know which
  // published helper release to verify+record against (PHNX-2943). A minimal
  // standalone copy is enough — helperFloor/helperTag are pure and import nothing.
  fs.mkdirSync(path.join(caller, 'cli/src/lib'), { recursive: true });
  fs.writeFileSync(
    path.join(caller, 'cli/src/lib/helper-versions.ts'),
    [
      "const FLOORS = { 'computer-mac': '1.0.0', menubar: '1.0.0', 'computer-win': '1.0.0' };",
      'export function helperFloor(h) { return FLOORS[h]; }',
      "export function helperTag(h, v) { return `${h}/v${v}`; }",
      '',
    ].join('\n'),
  );

  fs.copyFileSync(MANIFEST_SCRIPT, path.join(caller, 'cli/scripts/release-manifest.sh'));
  fs.chmodSync(path.join(caller, 'cli/scripts/release-manifest.sh'), 0o755);

  fs.mkdirSync(path.join(caller, 'cli/menubar/Sources'), { recursive: true });
  fs.mkdirSync(path.join(caller, 'cli/menubar/scripts'), { recursive: true });
  fs.writeFileSync(path.join(caller, 'cli/menubar/Sources/dummy.swift'), '// dummy\n');
  fs.writeFileSync(path.join(caller, 'cli/menubar/scripts/build.sh'), '#!/usr/bin/env bash\n');
  fs.writeFileSync(path.join(caller, 'cli/menubar/Package.swift'), '// swift package\n');

  fs.mkdirSync(path.join(caller, 'cli/bin/MenubarHelper.app/Contents/MacOS'), { recursive: true });
  fs.writeFileSync(path.join(caller, 'cli/bin/MenubarHelper.app/Contents/MacOS/AGI Menu'), 'fake-menubar-binary\n');

  git(caller, 'add', '-A');
  git(caller, 'commit', '-q', '-m', 'add helper manifest fixture');
  git(caller, 'push', '-q', '-u', 'origin', 'main');
  const headCommit = git(caller, 'rev-parse', 'HEAD');

  const digestFor = (helper: string) => {
    const r = spawnSync('bash', [MANIFEST_SCRIPT, 'input-digest', '--repo-root', caller, '--helper', helper], {
      encoding: 'utf-8',
    });
    if (r.status !== 0) throw new Error(`input-digest ${helper} failed: ${r.stdout}${r.stderr}`);
    return r.stdout.trim();
  };

  return {
    ...fx,
    headCommit,
    manifestDigests: {
      'computer-mac': digestFor('computer-mac'),
      menubar: digestFor('menubar'),
    },
  };
}

function seedManifest(store: string, helpers: Record<string, { inputDigest: string }>) {
  fs.mkdirSync(store, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    cliVersion: '9.9.8',
    cliTree: 'seed-tree',
    helpers: Object.fromEntries(
      Object.entries(helpers).map(([name, { inputDigest }]) => [
        name,
        {
          helperVersion: 'prev-1.0.0',
          inputDigest,
          assetDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
          assetUrl: '',
          assetPath: '',
          signerTeam: '2HTP252L87',
          architecture: 'universal',
          platform: 'darwin',
        },
      ]),
    ),
  };
  fs.writeFileSync(path.join(store, 'release-manifest.json'), JSON.stringify(manifest));
}

describe('release-attestation-produce.sh -- helper manifest (RUSH-2766)', () => {
  // The manifest step is opt-in since --with-helpers (a CLI-only attestation must
  // not abort because a helper's SOURCE moved — a one-line comment fix in
  // native/computer-mac/scripts/build.sh blocked a real 1.22.49 attestation that
  // way). Every test in this block is ABOUT the manifest, so they all pass the
  // flag; a separate test below pins that the DEFAULT skips it.
  const runProduceWithHelpers = (
    fx: ReturnType<typeof buildFixture>,
    extra: string[] = [],
    env: NodeJS.ProcessEnv = {},
  ) => runProduce(fx, ['--with-helpers', ...extra], env);

  it('carries forward an unchanged helper and records fresh digests for changed ones', () => {
    const root = tmp('attest-produce-manifest-');
    const fx = buildManifestFixture(root);
    // Pre-seed only computer-mac, matching its current digest -- it must be
    // carried forward untouched (this producer never rebuilds it). menubar
    // has no prior record, so it must be freshly recorded from
    // the "signed" asset committed into the fixture.
    seedManifest(fx.store, { 'computer-mac': { inputDigest: fx.manifestDigests['computer-mac'] } });

    const result = runProduceWithHelpers(fx);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toContain('helper computer-mac unchanged');

    const manifestFile = path.join(fx.store, 'release-manifest.json');
    expect(fs.existsSync(manifestFile)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));

    // computer-mac: untouched, still the seeded placeholder record.
    expect(manifest.helpers['computer-mac'].helperVersion).toBe('prev-1.0.0');
    expect(manifest.helpers['computer-mac'].inputDigest).toBe(fx.manifestDigests['computer-mac']);

    // menubar: freshly recorded against the committed placeholder
    // "signed" binary, keyed by the SAME digest a second, independent
    // checkout computes (proving the RUSH-2766 relative-path fix: the
    // producer hashed inside a throwaway $WT, the test hashed the caller
    // clone -- different absolute paths, same relative tree).
    for (const helper of ['menubar'] as const) {
      expect(manifest.helpers[helper].inputDigest).toBe(fx.manifestDigests[helper]);
      expect(manifest.helpers[helper].assetDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(manifest.helpers[helper].helperVersion).toBe('9.9.9');
    }

    // The actual consumer: release-manifest.sh require must accept what the
    // producer wrote, against the SAME caller checkout used to compute the
    // expected digests above.
    const required = spawnSync(
      'bash',
      [MANIFEST_SCRIPT, 'require', '--file', manifestFile, '--repo-root', fx.caller],
      { encoding: 'utf-8' },
    );
    expect(required.status, required.stdout + required.stderr).toBe(0);
  });

  /**
   * RUSH-2970 trap 1. A fresh attestation store has no recorded computer-mac
   * inputDigest, so the helper loop below reads "input changed" and dies
   * telling the operator to run publish-computer-helper-mac.sh — which does
   * not write a manifest, so re-running the producer hits the identical error.
   * Every hand-cut release walked into that loop. The producer now seeds the
   * manifest from the last published release first.
   *
   * `gh` is stubbed on the fixture's fake-bin PATH so this exercises the real
   * seed branch without a network call or a GitHub account.
   */
  it('seeds the manifest from the last release instead of dead-ending on a fresh store', () => {
    const root = tmp('attest-produce-manifest-seed-');
    const fx = buildManifestFixture(root);
    // Built with the real generator, so the fixture is a manifest the shipped
    // tooling actually produces rather than a hand-rolled shape.
    const priorManifest = priorReleaseManifest(root, fx.manifestDigests['computer-mac']);
    // A `gh` that answers exactly the two calls the seed makes.
    fs.writeFileSync(
      path.join(fx.fakebin, 'gh'),
      '#!/usr/bin/env bash\n' +
        'if [[ "$1" == release && "$2" == list ]]; then echo v9.9.8; exit 0; fi\n' +
        'if [[ "$1" == release && "$2" == view ]]; then echo 0; exit 0; fi\n' +
        'if [[ "$1" == release && "$2" == download ]]; then\n' +
        '  dir=""; for ((i=1;i<=$#;i++)); do [[ "${!i}" == --dir ]] && { j=$((i+1)); dir="${!j}"; }; done\n' +
        `  cat > "$dir/release-manifest.json" <<'MANIFEST'\n${priorManifest}\nMANIFEST\n` +
        '  exit 0\n' +
        'fi\n' +
        'exit 1\n',
    );
    fs.chmodSync(path.join(fx.fakebin, 'gh'), 0o755);

    const result = runProduceWithHelpers(fx);

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toContain('Seeded the helper manifest from v9.9.8');
    // The dead-end this fix exists to remove must NOT have fired.
    expect(result.stdout + result.stderr).not.toContain('helper computer-mac input changed');

    const manifest = JSON.parse(fs.readFileSync(path.join(fx.store, 'release-manifest.json'), 'utf-8'));
    // The seeded computer-mac record carried forward, so the unchanged helper
    // needed no rebuild — the whole point.
    expect(manifest.helpers['computer-mac'].inputDigest).toBe(fx.manifestDigests['computer-mac']);
    // …and the seed did not disable the check: the other helper was still
    // recorded fresh against this tree.
    for (const helper of ['menubar'] as const) {
      expect(manifest.helpers[helper].inputDigest).toBe(fx.manifestDigests[helper]);
    }
  });

  /**
   * The seed is a convenience, never a way to smuggle a changed helper through:
   * if the prior release's computer-mac digest does not match this tree, the
   * producer must still fail closed.
   */
  /**
   * The seed's diagnostic must name the REAL cause. A single `&&` chain made a
   * gh that fails on auth read as "no prior release" — hiding the very
   * misconfiguration worth surfacing — and an empty release list print the
   * literal string `null`, because `jq -r '.[0].tagName'` emits "null" for an
   * empty array. Each branch is asserted against the condition that triggers it.
   */
  it.each([
    {
      cause: 'gh cannot list (auth/network)',
      gh: '#!/usr/bin/env bash\nexit 1\n',
      expected: 'gh could not list releases',
      notExpected: 'no published release',
    },
    {
      cause: 'repo has zero releases',
      gh: '#!/usr/bin/env bash\n[[ "$1" == release && "$2" == list ]] && { echo null; exit 0; }\nexit 1\n',
      expected: 'no published release to seed from',
      notExpected: 'null carries no',
    },
    {
      cause: 'release carries no manifest asset',
      gh: '#!/usr/bin/env bash\n[[ "$1" == release && "$2" == list ]] && { echo v9.9.8; exit 0; }\n[[ "$1" == release && "$2" == download ]] && exit 0\nexit 1\n',
      expected: 'v9.9.8 carries no release-manifest.json',
      notExpected: 'no published release',
    },
  ])('names the real reason a seed did not happen: $cause', ({ gh, expected, notExpected }) => {
    const root = tmp('attest-produce-seed-why-');
    const fx = buildManifestFixture(root);
    const ghPath = path.join(fx.fakebin, 'gh');
    fs.writeFileSync(ghPath, gh);
    fs.chmodSync(ghPath, 0o755);

    const output = (() => {
      const r = runProduceWithHelpers(fx);
      return r.stdout + r.stderr;
    })();

    expect(output).toContain(expected);
    expect(output).not.toContain(notExpected);
    // Whatever the cause, it still falls back rather than dying here — the
    // computer-mac gate below is what fails closed.
    expect(output).toContain('Starting a fresh helper manifest');
  });

  it('skips a helper-only release and seeds from the newest one that has a manifest', () => {
    // RUSH-3191. Not every release is a CLI release: the Windows
    // computer-helper workflow publishes helper-only releases into the same
    // `v<version>` tag namespace. Taking the newest release unconditionally let
    // one of those shadow the last real CLI release — the seed missed, EVERY
    // helper read as "changed", and computer-mac (never rebuilt here) fail-closed
    // on every run. Live instance: v1.22.48 shadowed v1.22.47.
    const root = tmp('attest-produce-seed-shadowed-');
    const fx = buildManifestFixture(root);
    const priorManifest = priorReleaseManifest(root, fx.manifestDigests['computer-mac']);
    fs.writeFileSync(
      path.join(fx.fakebin, 'gh'),
      '#!/usr/bin/env bash\n' +
        // Newest first, exactly as `gh release list` orders them.
        'if [[ "$1" == release && "$2" == list ]]; then printf "%s\\n" v9.9.9 v9.9.8; exit 0; fi\n' +
        // v9.9.9 is helper-only; v9.9.8 is the real CLI release.
        'if [[ "$1" == release && "$2" == view ]]; then\n' +
        '  if [[ "$3" == v9.9.9 ]]; then echo ""; else echo 0; fi\n' +
        '  exit 0\n' +
        'fi\n' +
        'if [[ "$1" == release && "$2" == download ]]; then\n' +
        // Fail loudly if the seed asks for the helper-only tag — that is the bug.
        '  for a in "$@"; do [[ "$a" == v9.9.9 ]] && { echo "asked for the helper-only release" >&2; exit 1; }; done\n' +
        '  dir=""; for ((i=1;i<=$#;i++)); do [[ "${!i}" == --dir ]] && { j=$((i+1)); dir="${!j}"; }; done\n' +
        `  cat > "$dir/release-manifest.json" <<'MANIFEST'\n${priorManifest}\nMANIFEST\n` +
        '  exit 0\n' +
        'fi\n' +
        'exit 1\n',
    );
    fs.chmodSync(path.join(fx.fakebin, 'gh'), 0o755);

    const result = runProduceWithHelpers(fx);
    const out = result.stdout + result.stderr;

    expect(out, out).toContain('Seeded the helper manifest from v9.9.8');
    expect(out).not.toContain('Starting a fresh helper manifest');
    expect(result.status, out).toBe(0);
  });

  // PHNX-2943: when computer-mac drifts and has no prior record to carry forward,
  // the producer records it from its PUBLISHED release — but only after the release's
  // `computer-mac-input-digest.txt` sidecar proves the published binary was built from
  // THIS source. These stubs model `gh release download computer-mac/v1.0.0`; the seed
  // is failed (`release list` exit 1) so computer-mac genuinely reaches the drift path.
  //
  // `sidecar` is the source digest the published release claims it was built from;
  // pass fx.manifestDigests['computer-mac'] to match this tree, anything else to force
  // a mismatch. `omitSidecar` publishes the zip WITHOUT the sidecar (a pre-PHNX-2943
  // release). `failDownload` makes the download itself fail (gh offline/unauth).
  const stubComputerMacRelease = (
    fx: ReturnType<typeof buildManifestFixture>,
    opts: { sidecar?: string; omitSidecar?: boolean; failDownload?: boolean } = {},
  ) => {
    const lines = [
      '#!/usr/bin/env bash',
      // No seed: force computer-mac onto the drift path so the published-release
      // record path is what runs.
      'if [[ "$1" == release && "$2" == list ]]; then exit 1; fi',
      'if [[ "$1" == release && "$2" == download ]]; then',
    ];
    if (opts.failDownload) {
      lines.push('  echo "gh: offline" >&2; exit 1');
    } else {
      lines.push(
        '  dir=""; for ((i=1;i<=$#;i++)); do [[ "${!i}" == --dir ]] && { j=$((i+1)); dir="${!j}"; }; done',
        "  printf 'computer-helper-zip-bytes\\n' > \"$dir/ComputerHelper.app.zip\"",
        '  ( cd "$dir" && { command -v sha256sum >/dev/null 2>&1 && sha256sum ComputerHelper.app.zip || shasum -a 256 ComputerHelper.app.zip; } ) > "$dir/ComputerHelper.app.zip.sha256"',
      );
      if (!opts.omitSidecar) {
        lines.push(`  printf '%s\\n' ${JSON.stringify(opts.sidecar ?? '')} > "$dir/computer-mac-input-digest.txt"`);
      }
      lines.push('  exit 0');
    }
    lines.push('fi', 'exit 1', '');
    fs.writeFileSync(path.join(fx.fakebin, 'gh'), lines.join('\n'));
    fs.chmodSync(path.join(fx.fakebin, 'gh'), 0o755);
  };

  it('records computer-mac from its published release when the sidecar proves it was built from this source', () => {
    const root = tmp('attest-produce-cm-record-');
    const fx = buildManifestFixture(root);
    stubComputerMacRelease(fx, { sidecar: fx.manifestDigests['computer-mac'] });

    const result = runProduceWithHelpers(fx);
    const out = result.stdout + result.stderr;
    expect(result.status, out).toBe(0);
    expect(out).toContain('Recorded computer-mac from published computer-mac/v1.0.0');

    const manifestFile = path.join(fx.store, 'release-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));
    // Recorded against the CURRENT source digest and the published binary's sha,
    // keyed to the helper's own floor version (not the CLI's).
    expect(manifest.helpers['computer-mac'].inputDigest).toBe(fx.manifestDigests['computer-mac']);
    expect(manifest.helpers['computer-mac'].helperVersion).toBe('1.0.0');
    expect(manifest.helpers['computer-mac'].assetDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    // The consumer accepts it: require checks the recorded input-digest still
    // matches this tree's source.
    const required = spawnSync(
      'bash',
      [MANIFEST_SCRIPT, 'require', '--file', manifestFile, '--helper', 'computer-mac', '--repo-root', fx.caller],
      { encoding: 'utf-8' },
    );
    expect(required.status, required.stdout + required.stderr).toBe(0);
  });

  it('fails closed when the published release was built from a DIFFERENT source (stale binary)', () => {
    const root = tmp('attest-produce-cm-mismatch-');
    const fx = buildManifestFixture(root);
    // The published sidecar claims a source that is not this tree — recording it
    // would attest a stale binary against changed source.
    stubComputerMacRelease(fx, { sidecar: 'sha256:' + 'b'.repeat(64) });

    const result = runProduceWithHelpers(fx);
    const out = result.stdout + result.stderr;
    expect(result.status, out).not.toBe(0);
    expect(out).toContain('built from a DIFFERENT source');
    expect(out).toContain('publish-computer-helper-mac.sh');
  });

  it('fails closed when the published release predates the input-digest sidecar', () => {
    const root = tmp('attest-produce-cm-nosidecar-');
    const fx = buildManifestFixture(root);
    stubComputerMacRelease(fx, { omitSidecar: true });

    const result = runProduceWithHelpers(fx);
    const out = result.stdout + result.stderr;
    expect(result.status, out).not.toBe(0);
    expect(out).toContain('carries no computer-mac-input-digest.txt');
    expect(out).toContain('publish-computer-helper-mac.sh');
  });

  it('fails closed when the published release cannot be downloaded (gh offline)', () => {
    const root = tmp('attest-produce-cm-dlfail-');
    const fx = buildManifestFixture(root);
    stubComputerMacRelease(fx, { failDownload: true });

    const result = runProduceWithHelpers(fx);
    const out = result.stdout + result.stderr;
    expect(result.status, out).not.toBe(0);
    expect(out).toContain('could not be downloaded');
    expect(out).toContain('publish-computer-helper-mac.sh');
  });

  /**
   * PHNX-3699 — an ordinary CLI-only run must sign NOTHING, even on a signing box.
   *
   * Reaching the sign branch at all needs THREE things true: `uname` says Darwin,
   * `agents` is on PATH, and `scripts/sign-cli-binary.sh` is executable. The plain
   * fixture supplies none of them, so a test written against it passes whether or
   * not the --with-helpers gate exists — it proves nothing. (That was the first
   * version of this test, and the non-author review on #3376 caught it.)
   *
   * So this fixture makes the branch genuinely reachable on ANY host — including
   * Linux CI, where `uname` really would say Linux — by putting a fake `uname`,
   * a fake `agents`, and a real executable sign script on PATH. The signer records
   * that it ran; the assertions are about whether it did.
   */
  function signableFixture(root: string) {
    const fx = buildFixture(root);
    const marker = path.join(root, 'signed.marker');
    fs.writeFileSync(path.join(fx.fakebin, 'uname'), '#!/usr/bin/env bash\necho Darwin\n');
    fs.chmodSync(path.join(fx.fakebin, 'uname'), 0o755);
    // `agents secrets exec apple.com -- <cmd>` → just run <cmd> after the `--`.
    fs.writeFileSync(
      path.join(fx.fakebin, 'agents'),
      '#!/usr/bin/env bash\nfor a in "$@"; do shift; [ "$a" = "--" ] && break; done\nexec "$@"\n',
    );
    fs.chmodSync(path.join(fx.fakebin, 'agents'), 0o755);
    const signer = path.join(fx.caller, 'cli/scripts/sign-cli-binary.sh');
    fs.writeFileSync(signer, `#!/usr/bin/env bash\necho SIGNER_RAN >> ${JSON.stringify(marker)}\n`);
    fs.chmodSync(signer, 0o755);
    // headless-sign-context.sh is sourced before signing; a no-op stand-in.
    fs.writeFileSync(path.join(fx.caller, 'cli/scripts/headless-sign-context.sh'), ': \n');
    // The second `agents secrets exec` call builds + signs the helper .apps. Stub
    // the pieces it shells out to, so a --with-helpers run RUNS TO COMPLETION and
    // the test can assert status 0 -- otherwise the run dies after the signer and
    // the test's title ("cutting a helper release still works") overclaims.
    fs.mkdirSync(path.join(fx.caller, 'cli/menubar/scripts'), { recursive: true });
    // The real build.sh EMITS menubar/dist/MenubarHelper.app, which the block then
    // copies into bin/. Emit it here too rather than pre-creating the directory:
    // git does not track empty dirs, so a pre-created one would not exist in the
    // isolated worktree the producer actually runs in.
    fs.writeFileSync(
      path.join(fx.caller, 'cli/menubar/scripts/build.sh'),
      '#!/usr/bin/env bash\nmkdir -p menubar/dist/MenubarHelper.app bin\n',
    );
    fs.chmodSync(path.join(fx.caller, 'cli/menubar/scripts/build.sh'), 0o755);
    // codesign/stapler/shasum run against the .app the stubbed build would emit.
    for (const b of ['codesign', 'xcrun', 'shasum']) {
      fs.writeFileSync(path.join(fx.fakebin, b), '#!/usr/bin/env bash\nexit 0\n');
      fs.chmodSync(path.join(fx.fakebin, b), 0o755);
    }
    // The producer runs against an ISOLATED WORKTREE checked out at the commit, so
    // uncommitted fixture files simply do not exist there — which is how the first
    // version of this test silently never reached the sign branch at all.
    git(fx.caller, 'add', '-A');
    git(fx.caller, 'commit', '-q', '-m', 'fixture: signable tree');
    return { ...fx, marker, headCommit: git(fx.caller, 'rev-parse', 'HEAD') };
  }

  it('does NOT sign on an ordinary CLI-only run, even with a reachable signing path (PHNX-3699)', () => {
    // R3 (../AGENTS.md): "no signing, no notarization on the ordinary path".
    // The block used to gate on `uname == Darwin` ALONE, so a CLI-only attestation
    // on a Mac codesigned the CLI binary and rebuilt both helper .apps — none of
    // which ship in the tarball (RUSH-3026, RUSH-3100). And because
    // `agents secrets exec apple.com` cannot unlock a Touch-ID bundle headlessly,
    // a real 1.22.69 release DIED here producing output that ships nowhere.
    const fx = signableFixture(tmp('attest-produce-no-sign-'));
    const result = runProduce(fx);
    const out = (result.stdout + result.stderr).replace(/\[[0-9;]*m/g, '');
    expect(result.status, out).toBe(0);
    expect(out).not.toContain('Signing + notarizing');
    expect(fs.existsSync(fx.marker), 'the signer must never run on a CLI-only release').toBe(false);
    expect(out).toMatch(/Wrote .*\.json/);
  });

  it('DOES sign with --with-helpers, so cutting a helper release still works (PHNX-3699)', () => {
    // The other half of the gate: this is what proves the fix narrowed the branch
    // rather than deleting it, and it is what makes the test above non-vacuous —
    // same fixture, only the flag differs.
    const fx = signableFixture(tmp('attest-produce-sign-'));
    const result = runProduce(fx, ['--with-helpers']);
    const out = (result.stdout + result.stderr).replace(/\[[0-9;]*m/g, '');
    expect(out).toContain('Signing + notarizing');
    expect(fs.existsSync(fx.marker), 'the signer must run for a helper release').toBe(true);
    // Status, so the title is earned: the run COMPLETES, not merely starts.
    expect(result.status, out).toBe(0);
  });

  it('skips the helper manifest by default even when computer-mac would fail closed', () => {
    // Pair of the fail-closed test above: same fixture (release-manifest.sh
    // present, no seeded computer-mac digest) WITHOUT --with-helpers. This is
    // the 1.22.49 abort — a helper SOURCE digest move killed a CLI-only
    // attestation. buildFixture cannot reproduce it because it never copies
    // release-manifest.sh, so `-x scripts/release-manifest.sh` is already false
    // and deleting `WITH_HELPERS == true &&` from the producer still passes.
    const root = tmp('attest-produce-default-skip-');
    const fx = buildManifestFixture(root);
    const result = runProduce(fx);
    const out = (result.stdout + result.stderr).replace(/\[[0-9;]*m/g, '');
    expect(result.status, out).toBe(0);
    expect(out).toContain('CLI-only attestation: skipping the helper manifest');
    expect(out).toMatch(/Wrote .*\.json/);
    expect(out).not.toContain('helper computer-mac input changed');
  });
});

describe('release-attestation-produce.sh --inherit-suite-from (PHNX-3237)', () => {
  // Inherit mode forbids any --test-* flag, so it cannot reuse runProduce (which
  // always passes --test-here). Run the producer directly with the fake toolchain.
  function runInherit(
    fx: ReturnType<typeof buildFixture>,
    commit: string,
    base: string,
    extra: string[] = [],
  ) {
    return spawnSync(
      'bash',
      [
        path.join(fx.caller, 'cli/scripts/release-attestation-produce.sh'),
        commit,
        '--repo-root',
        fx.caller,
        '--dir',
        fx.store,
        '--inherit-suite-from',
        base,
        ...extra,
      ],
      { encoding: 'utf-8', env: { ...process.env, PATH: `${fx.fakebin}:${process.env.PATH}` } },
    );
  }

  it('mints the release-tree record from a green base without re-running the suite', () => {
    const root = tmp('attest-inherit-');
    const fx = buildFixture(root);
    // 1. Produce the BASE (default-branch tree) attestation the normal way.
    const baseRun = runProduce(fx);
    const baseOut = (baseRun.stdout + baseRun.stderr).replace(/\[[0-9;]*m/g, '');
    expect(baseRun.status, baseOut).toBe(0);
    const baseJson = baseOut.match(/Wrote (\S+\.json)/)?.[1];
    expect(baseJson).toBeTruthy();

    // 2. Metadata-only release commit: version bump + a changelog fragment.
    fs.writeFileSync(
      path.join(fx.caller, 'cli/package.json'),
      '{"name":"@phnx-labs/agents-cli","version":"9.9.10"}\n',
    );
    fs.mkdirSync(path.join(fx.caller, 'cli/.changelog'), { recursive: true });
    fs.writeFileSync(path.join(fx.caller, 'cli/.changelog/9.9.10.md'), '- note\n');
    git(fx.caller, 'add', '-A');
    git(fx.caller, 'commit', '-q', '-m', 'chore(release): 9.9.10');
    const relCommit = git(fx.caller, 'rev-parse', 'HEAD');

    // 3. Derive the release-tree attestation from the base — no suite run.
    const r = runInherit(fx, relCommit, baseJson!);
    const out = (r.stdout + r.stderr).replace(/\[[0-9;]*m/g, '');
    expect(r.status, out).toBe(0);
    expect(out).toContain('Inheriting the suite result');
    // The fake `bun run test` prints these; inherit must NOT have invoked it.
    expect(out).not.toContain('RUSH-3007-ENV');
    expect(out).not.toContain('tests passed');

    const relJson = out.match(/Wrote (\S+\.json)/)?.[1];
    expect(relJson, out).toBeTruthy();
    const rec = JSON.parse(fs.readFileSync(relJson!, 'utf-8'));
    expect(rec.candidateTree).toBe(git(fx.caller, 'rev-parse', `${relCommit}^{tree}`));
    expect(rec.conclusion).toBe('pass');
    const baseRec = JSON.parse(fs.readFileSync(baseJson!, 'utf-8'));
    expect(rec.derivedFrom.baseTree).toBe(baseRec.candidateTree);
    // lock/policy inherited from base == the release tree's own (allowlist proof)
    expect(rec.lockfileDigest).toBe(baseRec.lockfileDigest);
    expect(rec.policyVersion).toBe(baseRec.policyVersion);
  });

  it('fails closed when the release tree carries code beyond version/changelog', () => {
    const root = tmp('attest-inherit-code-');
    const fx = buildFixture(root);
    const baseRun = runProduce(fx);
    const baseJson = (baseRun.stdout + baseRun.stderr).replace(/\[[0-9;]*m/g, '').match(/Wrote (\S+\.json)/)?.[1];
    expect(baseJson).toBeTruthy();
    // A source change, not a metadata change.
    fs.mkdirSync(path.join(fx.caller, 'cli/src'), { recursive: true });
    fs.writeFileSync(path.join(fx.caller, 'cli/src/foo.ts'), 'export const x = 1;\n');
    git(fx.caller, 'add', '-A');
    git(fx.caller, 'commit', '-q', '-m', 'feat: code');
    const relCommit = git(fx.caller, 'rev-parse', 'HEAD');
    const r = runInherit(fx, relCommit, baseJson!);
    const out = (r.stdout + r.stderr).replace(/\[[0-9;]*m/g, '');
    expect(r.status).not.toBe(0);
    expect(out).toMatch(/cli\/src\/foo\.ts|beyond version\/changelog|not a metadata-only descendant/);
  });

  it('refuses --inherit-suite-from alongside a --test-* flag', () => {
    const root = tmp('attest-inherit-conflict-');
    const fx = buildFixture(root);
    const baseJson = path.join(root, 'base.json');
    fs.writeFileSync(baseJson, '{}');
    const r = runInherit(fx, fx.headCommit, baseJson, ['--test-here']);
    const out = (r.stdout + r.stderr).replace(/\[[0-9;]*m/g, '');
    expect(r.status).not.toBe(0);
    expect(out).toContain('do not also pass a --test-*');
  });

  it('fails when the base attestation is missing', () => {
    const root = tmp('attest-inherit-missing-');
    const fx = buildFixture(root);
    const r = runInherit(fx, fx.headCommit, path.join(root, 'nope.json'));
    const out = (r.stdout + r.stderr).replace(/\[[0-9;]*m/g, '');
    expect(r.status).not.toBe(0);
    expect(out).toContain('base attestation not found');
  });
});
