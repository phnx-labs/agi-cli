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
const COMMON_SCRIPT = path.resolve(__dirname, 'lib/common.sh');
const MANIFEST_SCRIPT = path.resolve(__dirname, 'release-manifest.sh');
const STAGE_SCRIPT = path.resolve(__dirname, 'stage-menubar-helper.sh');
const roots: string[] = [];

function tmp(prefix: string): string {
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

function fakeSuiteBody(opts: { failSuite?: boolean; suite?: 'greenWorkerCrash' | 'redWorkerCrash' }): string {
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
  fs.mkdirSync(path.join(caller, 'cli/scripts/lib'), { recursive: true });
  fs.copyFileSync(COMMON_SCRIPT, path.join(caller, 'cli/scripts/lib/common.sh'));
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
      'if [[ "$1" == "-e" ]]; then echo "1.0.0"; exit 0; fi',
      'if [[ "$1" == "install" ]]; then exit 0; fi',
      'if [[ "$1" == "run" && "$2" == "test" ]]; then',
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
    const root = tmp('attest-produce-noseed-');
    const fx = buildFixture(root);
    for (const [app, binName] of [
      ['MenubarHelper.app', 'AGI Menu'],
    ] as const) {
      const dir = path.join(fx.caller, 'cli/bin', app, 'Contents/MacOS');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, binName), 'signed-bytes\n');
    }
    const result = runProduce(fx, ['--keep']);
    const out = (result.stdout + result.stderr).replace(/\[[0-9;]*m/g, '');

    expect(result.status, out).toBe(0);
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
    const fx = buildFixture(tmp('attest-produce-crabbox-'));
    const r = runProduce(fx, ['--test-crabbox']);
    const out = `${r.stdout}${r.stderr}`;
    expect(r.status, out).not.toBe(0);
    expect(out).toMatch(/sandbox\.sh missing -- cannot offload/);
    expect(out).not.toMatch(/tests passed/);
  });

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
    const root = tmp('attest-produce-loaded-');
    const fx = buildFixture(root);
    const { r, argsLog } = withRecordingTestSh(fx, root, ['idle', 'idle', 'loaded', 'loaded']);
    const out = `${r.stdout}${r.stderr}`;
    expect(r.status, out).toBe(0);
    const argv = fs.readFileSync(argsLog, 'utf-8');
    expect(argv).toContain('--shard 2');
  });

  it('falls back to a single auto-picked box when fewer than 2 workers are eligible (no thin-fleet release break)', () => {
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
    expect(result.status, out).toBe(0);
    expect(out).not.toContain('seeded bin/');
  });

  it('runs the suite with AGENTS_ATTEST_PRODUCER=1 and CI unset, even when the caller shell exports CI=true (RUSH-3007)', () => {
    const root = tmp('attest-produce-envflag-');
    const fx = buildFixture(root);
    const result = spawnSync(
      'bash',
      [
        path.join(fx.caller, 'cli/scripts/release-attestation-produce.sh'),
        fx.headCommit,
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
    expect(record.suite).toBe('selected');
    expect(record.candidateTree).toBe(git(fx.caller, 'rev-parse', 'HEAD^{tree}'));
    expect(record.lockfileDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(record.policyVersion).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(record.tarball.filename).toBe('phnx-labs-agents-cli-9.9.9.tgz');
    expect(record.tarball.digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const tgzPath = path.join(fx.store, record.tarball.filename);
    expect(fs.existsSync(tgzPath)).toBe(true);
    const actualDigest = spawnSync('sha256sum', [tgzPath], { encoding: 'utf-8' }).stdout.trim().split(/\s+/)[0];
    expect(record.tarball.digest).toBe(`sha256:${actualDigest}`);

    const worktrees = git(fx.caller, 'worktree', 'list')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0]).toMatch(new RegExp(`^${fx.caller.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+${fx.headCommit.slice(0, 7)}`));

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
        '--test-here',
        '--repo-root',
        fx.caller,
        '--dir',
        relativeStore,
      ],
      { encoding: 'utf-8', env: { ...process.env, PATH: `${fx.fakebin}:${process.env.PATH}` } },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);

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

function priorReleaseManifest(root: string, menubarDigest: string): string {
  const file = path.join(root, 'prior-release-manifest.json');
  const created = spawnSync(
    'bash',
    [MANIFEST_SCRIPT, 'new', '--cli-version', 'prev-1.0.0', '--cli-tree', 'deadbeef'],
    { encoding: 'utf-8' },
  );
  if (created.status !== 0) throw new Error(created.stderr || created.stdout);
  fs.writeFileSync(file, created.stdout);
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  const asset = path.join(root, 'dist/MenubarHelper.app.zip');
  fs.writeFileSync(asset, 'prior release helper asset\n');
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
  const runProduceWithHelpers = (
    fx: ReturnType<typeof buildFixture>,
    extra: string[] = [],
    env: NodeJS.ProcessEnv = {},
  ) => runProduce(fx, ['--with-helpers', ...extra], env);

  it('carries forward an unchanged helper rather than re-recording it', () => {
    const root = tmp('attest-produce-manifest-');
    const fx = buildManifestFixture(root);
    seedManifest(fx.store, { menubar: { inputDigest: fx.manifestDigests.menubar } });

    const result = runProduceWithHelpers(fx);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toContain('helper menubar unchanged');

    const manifestFile = path.join(fx.store, 'release-manifest.json');
    expect(fs.existsSync(manifestFile)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));

    expect(manifest.helpers.menubar.helperVersion).toBe('prev-1.0.0');
    expect(manifest.helpers.menubar.inputDigest).toBe(fx.manifestDigests.menubar);
    expect(result.stdout + result.stderr).not.toContain('Recorded menubar from published');
  });

  it('records a changed helper from its PUBLISHED release, never a rebuild', () => {
    const root = tmp('attest-produce-manifest-record-');
    const fx = buildManifestFixture(root);
    seedManifest(fx.store, { menubar: { inputDigest: 'sha256:' + '0'.repeat(64) } });

    const result = runProduceWithHelpers(fx);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const manifestFile = path.join(fx.store, 'release-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));

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

    const required = spawnSync(
      'bash',
      [MANIFEST_SCRIPT, 'require', '--file', manifestFile, '--repo-root', fx.caller],
      { encoding: 'utf-8' },
    );
    expect(required.status, required.stdout + required.stderr).toBe(0);
  });

  it('seeds the manifest from the last release instead of dead-ending on a fresh store', () => {
    const root = tmp('attest-produce-manifest-seed-');
    const fx = buildManifestFixture(root);
    const priorManifest = priorReleaseManifest(root, fx.manifestDigests.menubar);
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
    expect(result.stdout + result.stderr).not.toContain('helper menubar input changed');

    const manifest = JSON.parse(fs.readFileSync(path.join(fx.store, 'release-manifest.json'), 'utf-8'));
    expect(manifest.helpers.menubar.inputDigest).toBe(fx.manifestDigests.menubar);
    for (const helper of ['menubar'] as const) {
      expect(manifest.helpers[helper].inputDigest).toBe(fx.manifestDigests[helper]);
    }
  });

  it('records menubar without provenance when the published release predates the sidecar', () => {
    const root = tmp('attest-produce-mb-nosidecar-');
    const fx = buildManifestFixture(root, { sidecar: false });
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
    seedManifest(fx.store, { menubar: { inputDigest: 'sha256:' + '0'.repeat(64) } });
    const result = runProduceWithHelpers(fx);
    const out = result.stdout + result.stderr;
    expect(result.status, out).not.toBe(0);
    expect(out).toContain('sha256 mismatch');
    expect(out).toContain('phnx-labs/agi-menu');
    const written = JSON.parse(fs.readFileSync(path.join(fx.store, 'release-manifest.json'), 'utf-8'));
    expect(written.helpers.menubar.inputDigest).toBe('sha256:' + '0'.repeat(64));
    expect(written.helpers.menubar.inputDigest).not.toBe(fx.manifestDigests.menubar);
  });

  it('fails closed when the floor names a menubar release that was never published', () => {
    const root = tmp('attest-produce-mb-missing-');
    const fx = buildManifestFixture(root, { empty: true });
    seedManifest(fx.store, { menubar: { inputDigest: 'sha256:' + '0'.repeat(64) } });
    const result = runProduceWithHelpers(fx);
    const out = result.stdout + result.stderr;
    expect(result.status, out).not.toBe(0);
    expect(out).toContain('no MenubarHelper.app.zip.sha256 on release menubar/v1.0.0');
    expect(out).toContain('scripts/release.sh');
  });

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
    expect(output).toContain('Starting a fresh helper manifest');
  });

  it('skips a helper-only release and seeds from the newest one that has a manifest', () => {
    const root = tmp('attest-produce-seed-shadowed-');
    const fx = buildManifestFixture(root);
    const priorManifest = priorReleaseManifest(root, fx.manifestDigests.menubar);
    fs.writeFileSync(
      path.join(fx.fakebin, 'gh'),
      '#!/usr/bin/env bash\n' +
        'if [[ "$1" == release && "$2" == list ]]; then printf "%s\\n" v9.9.9 v9.9.8; exit 0; fi\n' +
        'if [[ "$1" == release && "$2" == view ]]; then\n' +
        '  if [[ "$3" == v9.9.9 ]]; then echo ""; else echo 0; fi\n' +
        '  exit 0\n' +
        'fi\n' +
        'if [[ "$1" == release && "$2" == download ]]; then\n' +
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


  function signableFixture(root: string) {
    const fx = buildFixture(root);
    const marker = path.join(root, 'signed.marker');
    fs.writeFileSync(path.join(fx.fakebin, 'uname'), '#!/usr/bin/env bash\necho Darwin\n');
    fs.chmodSync(path.join(fx.fakebin, 'uname'), 0o755);
    fs.writeFileSync(
      path.join(fx.fakebin, 'agents'),
      '#!/usr/bin/env bash\nfor a in "$@"; do shift; [ "$a" = "--" ] && break; done\nexec "$@"\n',
    );
    fs.chmodSync(path.join(fx.fakebin, 'agents'), 0o755);
    const signer = path.join(fx.caller, 'cli/scripts/sign-cli-binary.sh');
    fs.writeFileSync(signer, `#!/usr/bin/env bash\necho SIGNER_RAN >> ${JSON.stringify(marker)}\n`);
    fs.chmodSync(signer, 0o755);
    fs.writeFileSync(path.join(fx.caller, 'cli/scripts/headless-sign-context.sh'), ': \n');
    git(fx.caller, 'add', '-A');
    git(fx.caller, 'commit', '-q', '-m', 'fixture: signable tree');
    return { ...fx, marker, headCommit: git(fx.caller, 'rev-parse', 'HEAD') };
  }

  it('does NOT sign on an ordinary CLI-only run, even with a reachable signing path (PHNX-3699)', () => {
    const fx = signableFixture(tmp('attest-produce-no-sign-'));
    const result = runProduce(fx);
    const out = (result.stdout + result.stderr).replace(/\[[0-9;]*m/g, '');
    expect(result.status, out).toBe(0);
    expect(out).not.toContain('Signing + notarizing');
    expect(fs.existsSync(fx.marker), 'the signer must never run on a CLI-only release').toBe(false);
    expect(out).toMatch(/Wrote .*\.json/);
  });

  it('DOES sign with --with-helpers, so cutting a helper release still works (PHNX-3699)', () => {
    const fx = signableFixture(tmp('attest-produce-sign-'));
    const result = runProduce(fx, ['--with-helpers']);
    const out = (result.stdout + result.stderr).replace(/\[[0-9;]*m/g, '');
    expect(out).toContain('Signing + notarizing');
    expect(fs.existsSync(fx.marker), 'the signer must run for a helper release').toBe(true);
    expect(out).not.toContain('swift build');
    expect(fs.existsSync(path.join(fx.caller, 'cli/bin/MenubarHelper.app'))).toBe(false);
    expect(result.status, out).toBe(0);
  });

  it('skips the helper manifest by default even when a helper would fail closed', () => {
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
    const baseRun = runProduce(fx);
    const baseOut = (baseRun.stdout + baseRun.stderr).replace(/\[[0-9;]*m/g, '');
    expect(baseRun.status, baseOut).toBe(0);
    const baseJson = baseOut.match(/Wrote (\S+\.json)/)?.[1];
    expect(baseJson).toBeTruthy();

    fs.writeFileSync(
      path.join(fx.caller, 'cli/package.json'),
      '{"name":"@phnx-labs/agents-cli","version":"9.9.10"}\n',
    );
    fs.mkdirSync(path.join(fx.caller, 'cli/.changelog'), { recursive: true });
    fs.writeFileSync(path.join(fx.caller, 'cli/.changelog/9.9.10.md'), '- note\n');
    git(fx.caller, 'add', '-A');
    git(fx.caller, 'commit', '-q', '-m', 'chore(release): 9.9.10');
    const relCommit = git(fx.caller, 'rev-parse', 'HEAD');

    const r = runInherit(fx, relCommit, baseJson!);
    const out = (r.stdout + r.stderr).replace(/\[[0-9;]*m/g, '');
    expect(r.status, out).toBe(0);
    expect(out).toContain('Inheriting the suite result');
    expect(out).not.toContain('RUSH-3007-ENV');
    expect(out).not.toContain('tests passed');

    const relJson = out.match(/Wrote (\S+\.json)/)?.[1];
    expect(relJson, out).toBeTruthy();
    const rec = JSON.parse(fs.readFileSync(relJson!, 'utf-8'));
    expect(rec.candidateTree).toBe(git(fx.caller, 'rev-parse', `${relCommit}^{tree}`));
    expect(rec.conclusion).toBe('pass');
    const baseRec = JSON.parse(fs.readFileSync(baseJson!, 'utf-8'));
    expect(rec.derivedFrom.baseTree).toBe(baseRec.candidateTree);
    expect(rec.lockfileDigest).toBe(baseRec.lockfileDigest);
    expect(rec.policyVersion).toBe(baseRec.policyVersion);
  });

  it('fails closed when the release tree carries code beyond version/changelog', () => {
    const root = tmp('attest-inherit-code-');
    const fx = buildFixture(root);
    const baseRun = runProduce(fx);
    const baseJson = (baseRun.stdout + baseRun.stderr).replace(/\[[0-9;]*m/g, '').match(/Wrote (\S+\.json)/)?.[1];
    expect(baseJson).toBeTruthy();
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
