/** Exercises release-attestation-produce.sh against a real git repo, with fake bun/npm binaries for
 * the toolchain. Covers orchestration only: worktree isolation, fail-closed on a red suite,
 * attestation and tarball placement. */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_SCRIPT = path.resolve(__dirname, 'test.sh');
const BUILD_SCRIPT = path.resolve(__dirname, 'build.sh');
const PRODUCE_SCRIPT = path.resolve(__dirname, 'release-attestation-produce.sh');
const ATTEST_SCRIPT = path.resolve(__dirname, 'release-attestation.sh');
const MANIFEST_SCRIPT = path.resolve(__dirname, 'release-manifest.sh');
const STAGE_SCRIPT = path.resolve(__dirname, 'stage-menubar-helper.sh');
const roots: string[] = [];

function tmp(prefix: string): string {
  // realpath: macOS os.tmpdir() resolves under /var, a symlink to /private/var, and git
  // subprocesses print the resolved path (RUSH-2750).
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

// Builds a caller repo (bare remote + clone) shaped enough like the monorepo for
// release-attestation.sh's identity() to resolve. A fake bun/npm on PATH stands in for the
// toolchain; `failSuite` makes the fake `bun run test` exit non-zero.
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
  fs.copyFileSync(path.resolve(__dirname, '../../.gitignore'), path.join(caller, '.gitignore'));

  fs.mkdirSync(path.join(caller, 'cli/scripts'), { recursive: true });
  fs.mkdirSync(path.join(caller, 'cli/ci'), { recursive: true });
  fs.mkdirSync(path.join(caller, 'scripts'), { recursive: true });
  // RUSH-3178: the producer calls scripts/test.sh, which owns where the suite runs, so the fixture
  // carries the real test.sh. runProduce passes --test-here so the fake `bun run test` still
  // executes; this pins the producer -> test.sh contract.
  fs.copyFileSync(TEST_SCRIPT, path.join(caller, 'cli/scripts/test.sh'));
  fs.chmodSync(path.join(caller, 'cli/scripts/test.sh'), 0o755);
  fs.copyFileSync(BUILD_SCRIPT, path.join(caller, 'cli/scripts/build.sh'));
  fs.chmodSync(path.join(caller, 'cli/scripts/build.sh'), 0o755);
  const tracker = path.join(caller, 'packages/session-tracker');
  fs.mkdirSync(path.join(tracker, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tracker, 'package.json'), '{"name":"@agents/session-tracker","scripts":{"build":"tsc"}}\n');
  fs.copyFileSync(path.resolve(__dirname, '../../packages/session-tracker/src/hook.sh'), path.join(tracker, 'src/hook.sh'));
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
      // The producer reads the menubar floor via `bun -e`; the stub returns the fixture's
      // helper-versions.ts floor (1.0.0), so the fetch targets menubar/v1.0.0.
      'if [[ "$1" == "-e" ]]; then echo "1.0.0"; exit 0; fi',
      'if [[ "$1" == "install" ]]; then exit 0; fi',
      'if [[ "$1" == "run" && "$2" == "test" ]]; then',
      // RUSH-3007: the producer must run the suite with AGENTS_ATTEST_PRODUCER=1
      // and CI unset, never CI=true -- see the "sets AGENTS_ATTEST_PRODUCER..."
      // test below, which asserts on this exact line.
      '  echo "RUSH-3007-ENV: producer=${AGENTS_ATTEST_PRODUCER:-<unset>} ci=${CI:-<unset>}"',
      fakeSuiteBody(opts),
      'fi',
      'if [[ "$1" == "run" && "$2" == "build" ]]; then',
      '  mkdir -p dist',
      '  if [[ "$PWD" == */packages/session-tracker ]]; then echo "export {};" > dist/install-hook.js; fi',
      '  exit 0',
      'fi',
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
      '  [[ -f dist/session-tracker/dist/install-hook.js && -f dist/session-tracker/dist/hook.sh ]] || { echo "missing session tracker" >&2; exit 1; }',
      '  cmp ../packages/session-tracker/src/hook.sh dist/session-tracker/dist/hook.sh || exit 1',
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
    // `--help` once printed a hardcoded `sed -n '3,32p'` slice that silently dropped
    // --with-helpers. This derives the flag set from the parser's case arms and compares it to
    // real --help output.
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
    // Replaces the RUSH-3026 seeding test: seeding existed only because `prepack` refused to pack
    // without signed .apps, a coupling RUSH-3100 removed. The assertion that matters is the
    // negative one: a non-Mac producer must still succeed.
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
    // test.sh has three lanes and the producer exposed only two, so a release could never ask for
    // the crabbox. The fixture has no scripts/sandbox.sh, so the prerequisite message is reachable
    // only by routing to crabbox; a silent fallback would exit 0.
    const fx = buildFixture(tmp('attest-produce-crabbox-'));
    const r = runProduce(fx, ['--test-crabbox']);
    const out = `${r.stdout}${r.stderr}`;
    expect(r.status, out).not.toBe(0);
    expect(out).toMatch(/sandbox\.sh missing -- cannot offload/);
    expect(out).not.toMatch(/tests passed/);
  });

  // The default (no --test-* flag) shards the suite across the fleet so a release stops pinning
  // one box at --maxWorkers=2 for ~880s. These tests pin that decision using a committed recording
  // test.sh stub and a stubbed `agents devices pick --json`; only headroom != "loaded" counts.
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
    // A release must not run ~13k tests on one box. With >=2 eligible workers the producer fans
    // out via test.sh --shard N. Each shard still passes --maxWorkers=2 --retry=2, keeping the
    // RUSH-3015 per-box flake mitigation.
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
    // Cutting 1.22.44, an operator exported CI=true, which armed tests/setup.ts's real-~/.agents
    // leak tripwires and false-failed 129/129 test files. The producer must set its own
    // AGENTS_ATTEST_PRODUCER flag and unset any ambient CI.
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
    // release.sh's `require` calls never pass --suite, so bind_tree_lock_policy defaults to
    // "selected" and any other tag is invisible to the consumer. Assert the consumer contract, not
    // just the literal, so producer/consumer drift fails the suite.
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

    // The isolated worktree used to run the suite must not survive the run; only the caller
    // checkout stays registered. Match on content: `git worktree list` pads columns by path
    // length, which differs between CI and local.
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

    // The script cd's to its own cli directory before resolving --dir, so a relative --dir
    // resolves there, not in the caller's cwd or the throwaway worktree deleted on exit.
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

// Extends the base fixture with the real release-manifest.sh and stage-menubar-helper.sh plus the
// menubar floor table (PHNX-4036). The published menubar release is a fixture directory served by
// a fake `curl`; the real stage script still does sha256 verification and provenance parsing.
/** A prior release's `release-manifest.json`, built with the shipped generator so the seed fixture
 * matches a real GitHub release. */
function priorReleaseManifest(root: string, menubarDigest: string): string {
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
  const asset = path.join(root, 'dist/MenubarHelper.app.zip');
  fs.writeFileSync(asset, 'prior release helper asset\n');
  // put refuses a declared digest that does not match the real bytes, so
  // compute it rather than asserting a placeholder.
  const assetDigest =
    'sha256:' + createHash('sha256').update(fs.readFileSync(asset)).digest('hex');
  const put = spawnSync(
    'bash',
    [
      MANIFEST_SCRIPT, 'put', '--file', file,
      '--helper', 'menubar',
      '--helper-version', 'prev-1.0.0',
      '--input-digest', menubarDigest,
      '--asset-digest', assetDigest,
      '--asset-path', 'dist/MenubarHelper.app.zip',
      '--platform', 'darwin',
    ],
    { encoding: 'utf-8', cwd: root },
  );
  if (put.status !== 0) throw new Error(put.stderr || put.stdout);
  return fs.readFileSync(file, 'utf-8').trim();
}

/** A published menubar/v1.0.0 release as a directory: zip, .sha256, and optionally the
 * menubar-source.txt sidecar. `wrongSha` publishes a checksum that does not match the bytes. */
function publishMenubarRelease(
  dir: string,
  opts: { sidecar?: boolean; wrongSha?: boolean; empty?: boolean } = {},
): { zipSha: string } {
  fs.mkdirSync(dir, { recursive: true });
  if (opts.empty) return { zipSha: '' };
  const zip = Buffer.from('PK published menubar helper bytes\n');
  const zipSha = createHash('sha256').update(zip).digest('hex');
  fs.writeFileSync(path.join(dir, 'MenubarHelper.app.zip'), zip);
  fs.writeFileSync(
    path.join(dir, 'MenubarHelper.app.zip.sha256'),
    `${opts.wrongSha ? 'e'.repeat(64) : zipSha}  MenubarHelper.app.zip\n`,
  );
  if (opts.sidecar !== false) {
    fs.writeFileSync(
      path.join(dir, 'menubar-source.txt'),
      'repo=phnx-labs/agi-menu\ncommit=abcdef0123456789abcdef0123456789abcdef01\ntag=v1.0.0\nversion=1.0.0\n',
    );
  }
  return { zipSha };
}

/** A `curl` that serves the fixture release dir, matching the invocation shape of
 * stage-menubar-helper.sh's fetch(): prints 200 for a present file, 404 otherwise. */
function installFakeCurl(fakebin: string, releaseDir: string) {
  fs.writeFileSync(
    path.join(fakebin, 'curl'),
    [
      '#!/usr/bin/env bash',
      'out=""; url=""',
      'while [[ $# -gt 0 ]]; do',
      '  case "$1" in',
      '    -o) out="$2"; shift 2 ;;',
      '    -w|--retry|--connect-timeout) shift 2 ;;',
      '    -*) shift ;;',
      '    *) url="$1"; shift ;;',
      '  esac',
      'done',
      `dir=${JSON.stringify(releaseDir)}`,
      'name="$(basename "$url")"',
      'if [[ -f "$dir/$name" ]]; then cp "$dir/$name" "$out"; printf 200; else : > "$out"; printf 404; fi',
      '',
    ].join('\n'),
  );
  fs.chmodSync(path.join(fakebin, 'curl'), 0o755);
}

function buildManifestFixture(
  root: string,
  menubarRelease: { sidecar?: boolean; wrongSha?: boolean; empty?: boolean } = {},
): ReturnType<typeof buildFixture> & {
  manifestDigests: Record<'menubar', string>;
  menubarZipSha: string;
} {
  const fx = buildFixture(root);
  const { caller } = fx;

  // The producer reads the menubar floor from this module to pick the published helper release to
  // verify; a minimal standalone copy suffices. No computer-mac entry: it left with the standalone
  // `computer` engine (PHNX-4075).
  fs.mkdirSync(path.join(caller, 'cli/src/lib'), { recursive: true });
  fs.writeFileSync(
    path.join(caller, 'cli/src/lib/helper-versions.ts'),
    [
      "const FLOORS = { menubar: '1.0.0' };",
      'export function helperFloor(h) { return FLOORS[h]; }',
      "export function helperTag(h, v) { return `${h}/v${v}`; }",
      '',
    ].join('\n'),
  );

  fs.copyFileSync(MANIFEST_SCRIPT, path.join(caller, 'cli/scripts/release-manifest.sh'));
  fs.chmodSync(path.join(caller, 'cli/scripts/release-manifest.sh'), 0o755);
  fs.copyFileSync(STAGE_SCRIPT, path.join(caller, 'cli/scripts/stage-menubar-helper.sh'));
  fs.chmodSync(path.join(caller, 'cli/scripts/stage-menubar-helper.sh'), 0o755);

  // The published menubar/v1.0.0 release the producer records the helper from.
  const releaseDir = path.join(root, 'menubar-release');
  const { zipSha } = publishMenubarRelease(releaseDir, menubarRelease);
  installFakeCurl(fx.fakebin, releaseDir);

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
      menubar: digestFor('menubar'),
    },
    menubarZipSha: zipSha,
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
  // The manifest step is opt-in via --with-helpers, so a CLI-only attestation does not abort when
  // a helper's source moves (this blocked 1.22.49). Every test here is about the manifest and
  // passes the flag; a separate test pins that the default skips it.
  const runProduceWithHelpers = (
    fx: ReturnType<typeof buildFixture>,
    extra: string[] = [],
    env: NodeJS.ProcessEnv = {},
  ) => runProduce(fx, ['--with-helpers', ...extra], env);

  it('carries forward an unchanged helper rather than re-recording it', () => {
    const root = tmp('attest-produce-manifest-');
    const fx = buildManifestFixture(root);
    // Pre-seed menubar matching its current digest -- it must be carried forward
    // untouched, since this producer never rebuilds a helper and the published
    // release it would otherwise re-fetch has not moved.
    seedManifest(fx.store, { menubar: { inputDigest: fx.manifestDigests.menubar } });

    const result = runProduceWithHelpers(fx);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toContain('helper menubar unchanged');

    const manifestFile = path.join(fx.store, 'release-manifest.json');
    expect(fs.existsSync(manifestFile)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));

    // Untouched, still the seeded placeholder record — and NOT re-fetched.
    expect(manifest.helpers.menubar.helperVersion).toBe('prev-1.0.0');
    expect(manifest.helpers.menubar.inputDigest).toBe(fx.manifestDigests.menubar);
    expect(result.stdout + result.stderr).not.toContain('Recorded menubar from published');
  });

  it('records a changed helper from its PUBLISHED release, never a rebuild', () => {
    const root = tmp('attest-produce-manifest-record-');
    const fx = buildManifestFixture(root);
    // A stale digest: menubar reads as changed, so the record-from-published
    // path runs. Nothing in this tree can build it (PHNX-4036).
    seedManifest(fx.store, { menubar: { inputDigest: 'sha256:' + '0'.repeat(64) } });

    const result = runProduceWithHelpers(fx);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const manifestFile = path.join(fx.store, 'release-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));

    // Keyed by the same input digest an independent checkout computes, proving the RUSH-2766
    // relative-path fix. The asset digest is the sha256 of the published zip, the version is the
    // helper's floor, and the provenance sidecar rides along as `source`.
    expect(result.stdout + result.stderr).toContain('Recorded menubar from published menubar/v1.0.0');
    const menubar = manifest.helpers.menubar;
    expect(menubar.inputDigest).toBe(fx.manifestDigests.menubar);
    expect(menubar.assetDigest).toBe(`sha256:${fx.menubarZipSha}`);
    expect(menubar.helperVersion).toBe('1.0.0');
    expect(menubar.assetUrl).toBe(
      'https://github.com/phnx-labs/agi-cli/releases/download/menubar/v1.0.0/MenubarHelper.app.zip',
    );
    expect(menubar.source).toEqual({
      repo: 'phnx-labs/agi-menu',
      commit: 'abcdef0123456789abcdef0123456789abcdef01',
      tag: 'v1.0.0',
      version: '1.0.0',
    });

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

  /** RUSH-2970 trap 1: a fresh attestation store has no inputDigest, so helpers read "input
   * changed", and the producer used to die telling the operator to run a script that wrote no
   * manifest. The producer now seeds the manifest from the last release; `gh` is stubbed. */
  it('seeds the manifest from the last release instead of dead-ending on a fresh store', () => {
    const root = tmp('attest-produce-manifest-seed-');
    const fx = buildManifestFixture(root);
    // Built with the real generator, so the fixture is a manifest the shipped
    // tooling actually produces rather than a hand-rolled shape.
    const priorManifest = priorReleaseManifest(root, fx.manifestDigests.menubar);
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
    expect(result.stdout + result.stderr).not.toContain('helper menubar input changed');

    const manifest = JSON.parse(fs.readFileSync(path.join(fx.store, 'release-manifest.json'), 'utf-8'));
    // The seeded menubar record carried forward, so the unchanged helper
    // needed no re-fetch — the whole point.
    expect(manifest.helpers.menubar.inputDigest).toBe(fx.manifestDigests.menubar);
    // …and the seed did not disable the check: the other helper was still
    // recorded fresh against this tree.
    for (const helper of ['menubar'] as const) {
      expect(manifest.helpers[helper].inputDigest).toBe(fx.manifestDigests[helper]);
    }
  });

  // PHNX-4036: the menubar source is in phnx-labs/agi-menu, so the producer can only record its
  // published release. A missing release or sha256 mismatch must fail closed naming the agi-menu
  // publish step, never rebuild or record unverified bytes.
  it('records menubar without provenance when the published release predates the sidecar', () => {
    const root = tmp('attest-produce-mb-nosidecar-');
    const fx = buildManifestFixture(root, { sidecar: false });
    // A stale menubar digest: the manifest file exists, so the seed branch is not under test,
    // while menubar still reads as changed. Before PHNX-4075 this seeded computer-mac.
    seedManifest(fx.store, { menubar: { inputDigest: 'sha256:' + '0'.repeat(64) } });
    const result = runProduceWithHelpers(fx);
    const out = result.stdout + result.stderr;
    expect(result.status, out).toBe(0);
    expect(out).toContain('release carries no menubar-source.txt');
    const manifest = JSON.parse(fs.readFileSync(path.join(fx.store, 'release-manifest.json'), 'utf-8'));
    expect(manifest.helpers.menubar.assetDigest).toBe(`sha256:${fx.menubarZipSha}`);
    expect(manifest.helpers.menubar).not.toHaveProperty('source');
  });

  it('fails closed when the published menubar asset does not match its .sha256', () => {
    const root = tmp('attest-produce-mb-badsha-');
    const fx = buildManifestFixture(root, { wrongSha: true });
    // A stale menubar digest: the manifest file exists, so the seed branch is not under test,
    // while menubar still reads as changed. Before PHNX-4075 this seeded computer-mac.
    seedManifest(fx.store, { menubar: { inputDigest: 'sha256:' + '0'.repeat(64) } });
    const result = runProduceWithHelpers(fx);
    const out = result.stdout + result.stderr;
    expect(result.status, out).not.toBe(0);
    expect(out).toContain('sha256 mismatch');
    expect(out).toContain('phnx-labs/agi-menu');
    // Fail CLOSED: the stale seeded record must still be stale. Recording the
    // corrupt download's digest would bind the release to unverified bytes.
    const written = JSON.parse(fs.readFileSync(path.join(fx.store, 'release-manifest.json'), 'utf-8'));
    expect(written.helpers.menubar.inputDigest).toBe('sha256:' + '0'.repeat(64));
    expect(written.helpers.menubar.inputDigest).not.toBe(fx.manifestDigests.menubar);
  });

  it('fails closed when the floor names a menubar release that was never published', () => {
    const root = tmp('attest-produce-mb-missing-');
    const fx = buildManifestFixture(root, { empty: true });
    // A stale menubar digest: the manifest file exists, so the seed branch is not under test,
    // while menubar still reads as changed. Before PHNX-4075 this seeded computer-mac.
    seedManifest(fx.store, { menubar: { inputDigest: 'sha256:' + '0'.repeat(64) } });
    const result = runProduceWithHelpers(fx);
    const out = result.stdout + result.stderr;
    expect(result.status, out).not.toBe(0);
    expect(out).toContain('no MenubarHelper.app.zip.sha256 on release menubar/v1.0.0');
    expect(out).toContain('scripts/release.sh');
  });

  /** The seed is a convenience, never a way to smuggle a changed helper through: if the prior
   * helper digest does not match this tree, the producer must still fail closed. */
  /** The seed's diagnostic must name the real cause: a gh auth failure must not read as "no prior
   * release", and an empty list must not print the literal `null`. Each branch is asserted against
   * its triggering condition. */
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
    // per-helper gate below is what fails closed.
    expect(output).toContain('Starting a fresh helper manifest');
  });

  it('skips a helper-only release and seeds from the newest one that has a manifest', () => {
    // RUSH-3191: Windows computer-helper releases share the `v<version>` tag namespace, and taking
    // the newest release unconditionally let one shadow the last CLI release (v1.22.48 over
    // v1.22.47). The seed then missed and every helper read as changed.
    const root = tmp('attest-produce-seed-shadowed-');
    const fx = buildManifestFixture(root);
    const priorManifest = priorReleaseManifest(root, fx.manifestDigests.menubar);
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


  /** PHNX-3699: an ordinary CLI-only run must sign nothing, even on a signing box. The sign branch
   * needs Darwin `uname`, `agents` on PATH and an executable sign script; this fixture fakes all
   * three so the branch is reachable on any host. */
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
    // The sign block signs only the CLI binary; the menu-bar helper is never built here
    // (PHNX-4036). The producer runs in an isolated worktree, so fixture files must be committed
    // or the sign branch is never reached.
    git(fx.caller, 'add', '-A');
    git(fx.caller, 'commit', '-q', '-m', 'fixture: signable tree');
    return { ...fx, marker, headCommit: git(fx.caller, 'rev-parse', 'HEAD') };
  }

  it('does NOT sign on an ordinary CLI-only run, even with a reachable signing path (PHNX-3699)', () => {
    // R3 (../AGENTS.md): no signing or notarization on the ordinary path. The block used to gate
    // on `uname == Darwin` alone and codesigned output that ships nowhere; a 1.22.69 release died
    // because `agents secrets exec apple.com` cannot unlock a Touch-ID bundle headlessly.
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
    // ...and it signs the CLI binary only: no helper build ran (PHNX-4036).
    expect(out).not.toContain('swift build');
    expect(fs.existsSync(path.join(fx.caller, 'cli/bin/MenubarHelper.app'))).toBe(false);
    // Status, so the title is earned: the run COMPLETES, not merely starts.
    expect(result.status, out).toBe(0);
  });

  it('skips the helper manifest by default even when a helper would fail closed', () => {
    // Pair of the fail-closed test above: same fixture without --with-helpers. This is the 1.22.49
    // abort, where a helper source digest move killed a CLI-only attestation. buildFixture cannot
    // reproduce it, since it never copies release-manifest.sh.
    const root = tmp('attest-produce-default-skip-');
    const fx = buildManifestFixture(root);
    const result = runProduce(fx);
    const out = (result.stdout + result.stderr).replace(/\[[0-9;]*m/g, '');
    expect(result.status, out).toBe(0);
    expect(out).toContain('CLI-only attestation: skipping the helper manifest');
    expect(out).toMatch(/Wrote .*\.json/);
    expect(out).not.toContain('helper menubar input changed');
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
