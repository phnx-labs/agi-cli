import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SOURCE_DIR = __dirname;
const roots: string[] = [];
const describeUnix = process.platform === 'win32' ? describe.skip : describe;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function fixture(version: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-release-'));
  roots.push(root);
  const cli = path.join(root, 'cli');
  const scripts = path.join(cli, 'scripts');
  const assets = path.join(root, 'release-assets');
  fs.mkdirSync(path.join(scripts, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(cli, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(cli, 'ci'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(assets);

  for (const name of [
    'release-ci.sh',
    'release.sh',
    'release-attestation.sh',
    'release-install-smoke.sh',
    'release-other-branch.sh',
    'release-require-branch-head.sh',
  ]) {
    fs.copyFileSync(path.join(SOURCE_DIR, name), path.join(scripts, name));
    fs.chmodSync(path.join(scripts, name), 0o755);
  }
  fs.copyFileSync(path.join(SOURCE_DIR, 'lib/common.sh'), path.join(scripts, 'lib/common.sh'));
  fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({
    name: '@phnx-labs/agents-cli',
    version,
    bin: { agents: 'dist/index.js' },
    files: ['dist'],
  }, null, 2));
  fs.writeFileSync(path.join(cli, 'bun.lock'), 'lock-v1\n');
  fs.writeFileSync(path.join(cli, 'vitest.config.ts'), 'export default {}\n');
  fs.writeFileSync(path.join(cli, 'ci/test-ownership.yaml'), 'policy_version: test\nareas: []\n');
  fs.writeFileSync(path.join(root, 'scripts/ci-scope.ts'), '// release policy fixture\n');
  fs.writeFileSync(
    path.join(cli, 'dist/index.js'),
    `#!/usr/bin/env node\nconsole.log(${JSON.stringify(version)});\n`,
    { mode: 0o755 },
  );

  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Release Test');
  git(root, 'config', 'user.email', 'release-test@example.com');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', `release ${version}`);
  const remote = path.join(root, 'origin.git');
  git(root, 'init', '--bare', remote);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', 'origin', `HEAD:refs/heads/release/${version}`);

  const pack = spawnSync('npm', ['pack', '--silent', '--pack-destination', assets], {
    cwd: cli,
    encoding: 'utf-8',
  });
  expect(pack.status, pack.stderr).toBe(0);
  const filename = pack.stdout.trim().split('\n').at(-1)!;
  const tgz = path.join(assets, filename);
  const digest = createHash('sha256').update(fs.readFileSync(tgz)).digest('hex');
  const identity = spawnSync('bash', [path.join(scripts, 'release-attestation.sh'), 'identity', '--repo-root', root], {
    cwd: cli,
    encoding: 'utf-8',
  });
  expect(identity.status, identity.stderr).toBe(0);
  fs.writeFileSync(path.join(assets, 'release-attestation.json'), JSON.stringify({
    schemaVersion: 1,
    ...JSON.parse(identity.stdout),
    suite: 'selected',
    conclusion: 'pass',
    tarball: { filename, digest: `sha256:${digest}` },
  }));
  return { root, cli, assets, tgz };
}

function run(version: string, branch: string, assets: string, cwd: string) {
  const result = spawnSync(
    'bash',
    [path.join(cwd, 'scripts/release-ci.sh'), version, '--local-assets', assets, '--publish-dry-run'],
    {
      cwd,
      encoding: 'utf-8',
      env: { ...process.env, GITHUB_REF: `refs/heads/${branch}`, NODE_AUTH_TOKEN: '', NPM_TOKEN: '' },
    },
  );
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

function ciModeFixture(version: string, changeMainAfterProof?: (root: string) => void) {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-release-ci-'));
  roots.push(container);
  const root = path.join(container, 'repo');
  const cli = path.join(root, 'cli');
  const scripts = path.join(cli, 'scripts');
  const fakebin = path.join(container, 'fakebin');
  const state = path.join(container, 'state');
  const sourceAssets = path.join(container, 'source-assets');
  const remote = path.join(container, 'origin.git');
  for (const dir of [path.join(scripts, 'lib'), path.join(cli, 'dist'), path.join(cli, 'ci'),
    path.join(root, 'scripts'), fakebin, state, sourceAssets]) fs.mkdirSync(dir, { recursive: true });

  for (const name of [
    'release-ci.sh',
    'release.sh',
    'release-attestation.sh',
    'release-install-smoke.sh',
    'release-other-branch.sh',
    'release-require-branch-head.sh',
    'release-github-state.sh',
    'release-registry-state.sh',
    'release-attested-base.sh',
    'release-ensure-tag.sh',
    'release-tarball-integrity.sh',
    'create-annotated-release-tag.sh',
  ]) {
    fs.copyFileSync(path.join(SOURCE_DIR, name), path.join(scripts, name));
    fs.chmodSync(path.join(scripts, name), 0o755);
  }
  fs.copyFileSync(path.join(SOURCE_DIR, 'lib/common.sh'), path.join(scripts, 'lib/common.sh'));
  fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({
    name: '@phnx-labs/agents-cli',
    version: '9.9.8',
    bin: { agents: 'dist/index.js' },
    files: ['dist'],
  }, null, 2));
  fs.writeFileSync(path.join(cli, 'bun.lock'), 'lock-v1\n');
  fs.writeFileSync(path.join(cli, 'vitest.config.ts'), 'export default {}\n');
  fs.writeFileSync(path.join(cli, 'ci/test-ownership.yaml'), 'policy_version: test\nareas: []\n');
  fs.writeFileSync(path.join(root, 'scripts/ci-scope.ts'), '// release policy fixture\n');
  fs.writeFileSync(path.join(cli, 'dist/index.js'), '#!/usr/bin/env node\nconsole.log(require("../package.json").version);\n', { mode: 0o755 });
  fs.writeFileSync(path.join(scripts, 'release-ci-produce.sh'), `#!/usr/bin/env bash
set -euo pipefail
head="$1"; store="$2"
mkdir -p "$store"
cp "$CI_TEST_TGZ" "$store/$(basename "$CI_TEST_TGZ")"
tmp="$store/input.json"
"${scripts}/release-attestation.sh" identity --repo-root "${root}" --commit "$head" |
  jq --arg name "$(basename "$CI_TEST_TGZ")" --arg digest "sha256:$CI_TEST_TGZ_DIGEST" '. + {schemaVersion:1,suite:"selected",conclusion:"pass",tarball:{filename:$name,digest:$digest}}' > "$tmp"
record="$("${scripts}/release-attestation.sh" write --dir "$store" --file "$tmp")"
rm -f "$tmp"
`, { mode: 0o755 });

  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Release Test');
  git(root, 'config', 'user.email', 'release-test@example.com');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'tested main');
  const baseSha = git(root, 'rev-parse', 'HEAD');
  const baseTree = git(root, 'rev-parse', 'HEAD^{tree}');
  const baseIdentity = spawnSync('bash', [path.join(scripts, 'release-attestation.sh'), 'identity', '--repo-root', root], {
    cwd: cli,
    encoding: 'utf-8',
  });
  expect(baseIdentity.status, baseIdentity.stderr).toBe(0);
  const baseAttestation = path.join(state, `attest-${baseTree}.json`);
  fs.writeFileSync(baseAttestation, JSON.stringify({
    schemaVersion: 1,
    ...JSON.parse(baseIdentity.stdout),
    suite: 'selected',
    conclusion: 'pass',
    tarball: { filename: 'base.tgz', digest: `sha256:${'a'.repeat(64)}` },
  }));

  if (changeMainAfterProof) {
    changeMainAfterProof(root);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'reviewed main change after retained proof');
  }

  git(root, 'init', '--bare', remote);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', 'origin', 'main');
  git(root, 'checkout', '-q', '-b', `release/${version}`);
  const pkg = JSON.parse(fs.readFileSync(path.join(cli, 'package.json'), 'utf-8'));
  pkg.version = version;
  fs.writeFileSync(path.join(cli, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  fs.mkdirSync(path.join(cli, '.changelog'), { recursive: true });
  fs.writeFileSync(path.join(cli, '.changelog', `${version}.md`), `- release ${version}\n`);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', `chore(release): ${version}`);
  git(root, 'push', 'origin', `HEAD:refs/heads/release/${version}`);

  const pack = spawnSync('npm', ['pack', '--silent', '--pack-destination', sourceAssets], { cwd: cli, encoding: 'utf-8' });
  expect(pack.status, pack.stderr).toBe(0);
  const tgz = path.join(sourceAssets, pack.stdout.trim().split('\n').at(-1)!);
  const digest = createHash('sha256').update(fs.readFileSync(tgz)).digest('hex');
  const integrity = `sha512-${createHash('sha512').update(fs.readFileSync(tgz)).digest('base64')}`;

  fs.writeFileSync(path.join(fakebin, 'gh'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$CI_TEST_STATE/gh.log"
if [[ "$1" == api && "$2" == -i ]]; then
  if [[ "$(cat "$CI_TEST_STATE/release-state")" == present ]]; then exit 0; fi
  echo 'HTTP/2 404 Not Found' >&2; exit 1
fi
if [[ "$1" == release && "$2" == download ]]; then
  tag="$3"; dir=""; pattern=""
  shift 3
  while [[ $# -gt 0 ]]; do
    case "$1" in --dir) dir="$2"; shift 2;; --pattern) pattern="$2"; shift 2;; *) shift;; esac
  done
  mkdir -p "$dir"
  if [[ "$tag" == main-attestations ]]; then cp "$CI_TEST_BASE_ATTEST" "$dir/$pattern"; exit 0; fi
  cp "$CI_TEST_STATE/release-assets/"* "$dir/" 2>/dev/null || exit 1
  exit 0
fi
if [[ "$1" == release && ( "$2" == create || "$2" == upload ) ]]; then
  mkdir -p "$CI_TEST_STATE/release-assets"
  for arg in "$@"; do [[ -f "$arg" ]] && cp "$arg" "$CI_TEST_STATE/release-assets/"; done
  echo present > "$CI_TEST_STATE/release-state"
  exit 0
fi
echo "unhandled gh: $*" >&2
exit 1
`, { mode: 0o755 });

  const realNpm = spawnSync('sh', ['-c', 'command -v npm'], { encoding: 'utf-8' }).stdout.trim();
  fs.writeFileSync(path.join(fakebin, 'npm'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$CI_TEST_STATE/npm.log"
if [[ "$1" == --version ]]; then echo 12.2.0; exit 0; fi
if [[ "$1" == install ]]; then exec "$CI_TEST_REAL_NPM" "$@"; fi
if [[ "$1" == view && "$3" == versions ]]; then
  if [[ -f "$CI_TEST_STATE/visible-after" && "$(cat "$CI_TEST_STATE/registry-state")" == present ]]; then
    pending="$(cat "$CI_TEST_STATE/visible-after")"
    if (( pending > 0 )); then echo $((pending - 1)) > "$CI_TEST_STATE/visible-after"; echo '[]'; exit 0; fi
  fi
  if [[ "$(cat "$CI_TEST_STATE/registry-state")" == present ]]; then printf '["%s"]\n' "$CI_TEST_VERSION"; else echo '[]'; fi
  exit 0
fi
if [[ "$1" == view && "$3" == dist.integrity ]]; then cat "$CI_TEST_STATE/integrity"; exit 0; fi
if [[ "$1" == publish ]]; then
  echo present > "$CI_TEST_STATE/registry-state"
  printf '%s\n' "$CI_TEST_INTEGRITY" > "$CI_TEST_STATE/integrity"
  exit 0
fi
echo "unhandled npm: $*" >&2
exit 1
`, { mode: 0o755 });
  fs.writeFileSync(path.join(state, 'release-state'), 'absent\n');
  fs.writeFileSync(path.join(state, 'registry-state'), 'absent\n');
  fs.writeFileSync(path.join(state, 'gh.log'), '');
  fs.writeFileSync(path.join(state, 'npm.log'), '');

  const env = {
    ...process.env,
    PATH: `${fakebin}:${process.env.PATH}`,
    GITHUB_REF: `refs/heads/release/${version}`,
    GITHUB_ACTIONS: 'true',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.invalid/request',
    GH_TOKEN: 'test-token',
    GITHUB_REPOSITORY: 'phnx-labs/agi-cli',
    NODE_AUTH_TOKEN: '',
    NPM_TOKEN: '',
    RUNNER_TEMP: path.join(root, 'runner-temp'),
    RELEASE_ATTEST_ASSETS: `attest-${baseTree}.json`,
    CI_TEST_STATE: state,
    CI_TEST_BASE_ATTEST: baseAttestation,
    CI_TEST_TGZ: tgz,
    CI_TEST_TGZ_DIGEST: digest,
    CI_TEST_INTEGRITY: integrity,
    CI_TEST_REAL_NPM: realNpm,
    CI_TEST_VERSION: version,
  };
  fs.mkdirSync(env.RUNNER_TEMP, { recursive: true });
  return { root, cli, scripts, state, remote, baseSha, baseTree, tgz, integrity, env };
}

function runCiMode(fx: ReturnType<typeof ciModeFixture>) {
  const result = spawnSync('bash', [path.join(fx.scripts, 'release-ci.sh'), fx.env.CI_TEST_VERSION], {
    cwd: fx.cli,
    encoding: 'utf-8',
    env: fx.env,
    timeout: 60_000,
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describeUnix('release branch push path', () => {
  it('install-smokes and npm-publishes the exact stable tarball with a real npm dry run', () => {
    const fx = fixture('9.9.9');
    const result = run('9.9.9', 'release/9.9.9', fx.assets, fx.cli);
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain('9.9.9');
    expect(result.out).toContain('BRANCH_RELEASE_PUBLISH version=9.9.9 tag=latest');
    expect(result.out).toContain('dry_run=true');
    console.log(result.out.split('\n').filter((line) =>
      line.includes('Install-smoke') || line.includes('Publishing') || line.includes('BRANCH_RELEASE_PUBLISH'),
    ).join('\n'));
  }, 30_000);

  it('publishes pre-releases on next so latest remains untouched', () => {
    const fx = fixture('9.9.9-pre.2');
    const result = run('9.9.9-pre.2', 'release/9.9.9-pre.2', fx.assets, fx.cli);
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain('BRANCH_RELEASE_PUBLISH version=9.9.9-pre.2 tag=next');
  }, 30_000);

  it('fails loud before publish when the branch name is not an allowed release version', () => {
    const fx = fixture('9.9.9');
    const result = run('9.9.9', 'release/not-semver', fx.assets, fx.cli);
    expect(result.status).not.toBe(0);
    expect(result.out).toContain('release branch must be release/x.y.z or release/x.y.z-pre.n');
    expect(result.out).not.toContain('BRANCH_RELEASE_PUBLISH');
  });

  it('fails closed when the release asset bytes no longer match the attestation', () => {
    const fx = fixture('9.9.9');
    fs.appendFileSync(fx.tgz, 'tampered');
    const result = run('9.9.9', 'release/9.9.9', fx.assets, fx.cli);
    expect(result.status).not.toBe(0);
    expect(result.out).toContain('does not match its exact-tree attestation');
    expect(result.out).not.toContain('BRANCH_RELEASE_PUBLISH');
  });

  it('fails before publish when another exact-shape release branch exists', () => {
    const fx = fixture('9.9.9');
    git(fx.root, 'push', 'origin', 'HEAD:refs/heads/release/9.9.10');
    const result = run('9.9.9', 'release/9.9.9', fx.assets, fx.cli);
    expect(result.status).not.toBe(0);
    expect(result.out).toContain('release/9.9.10');
    expect(result.out).not.toContain('BRANCH_RELEASE_PUBLISH');
  });

  it('fails before publish when the same release branch moved after the event checkout', () => {
    const fx = fixture('9.9.9');
    const tree = git(fx.root, 'rev-parse', 'HEAD^{tree}');
    const moved = git(fx.root, 'commit-tree', tree, '-p', 'HEAD', '-m', 'superseding push');
    git(fx.root, 'push', 'origin', `${moved}:refs/heads/release/9.9.9`);
    const result = run('9.9.9', 'release/9.9.9', fx.assets, fx.cli);
    expect(result.status).not.toBe(0);
    expect(result.out).toContain('not workflow head');
    expect(result.out).not.toContain('BRANCH_RELEASE_PUBLISH');
  });

  it('executes fresh and rerun CI orchestration, and fails closed on immutable registry state', () => {
    const fx = ciModeFixture('9.9.9');
    const fresh = runCiMode(fx);
    expect(fresh.status, fresh.out).toBe(0);
    expect(fresh.out).toContain('BRANCH_RELEASE_PUBLISH version=9.9.9 tag=latest');
    expect(git(fx.root, 'ls-remote', '--tags', 'origin', 'refs/tags/v9.9.9')).toContain('refs/tags/v9.9.9');
    expect(fs.readFileSync(path.join(fx.state, 'gh.log'), 'utf-8')).toContain('release create v9.9.9');
    expect(fs.readFileSync(path.join(fx.state, 'npm.log'), 'utf-8')).toMatch(/publish .*\.tgz --access=public --provenance/);
    console.log(fresh.out.split('\n').filter((line) =>
      line.includes('Install-smoke') || line.includes('Publishing') || line.includes('BRANCH_RELEASE_PUBLISH'),
    ).join('\n'));

    const rerun = runCiMode(fx);
    expect(rerun.status, rerun.out).toBe(0);
    expect(rerun.out).toContain('BRANCH_RELEASE_PUBLISH version=9.9.9 tag=existing');

    fs.writeFileSync(path.join(fx.state, 'release-assets', 'release-attestation.json'), '{}\n');
    fs.writeFileSync(path.join(fx.state, 'release-assets', 'phnx-labs-agents-cli-9.9.9.tgz'), 'invalid\n');
    const before = fs.readFileSync(path.join(fx.state, 'npm.log'), 'utf-8').match(/^publish /gm)?.length ?? 0;
    const invalid = runCiMode(fx);
    expect(invalid.status).not.toBe(0);
    expect(invalid.out).toContain('npm already exposes the immutable version');
    const after = fs.readFileSync(path.join(fx.state, 'npm.log'), 'utf-8').match(/^publish /gm)?.length ?? 0;
    expect(after).toBe(before);
  }, 60_000);

  it('keeps polling until a published version becomes registry-visible', () => {
    const fx = ciModeFixture('9.9.9');
    fs.writeFileSync(path.join(fx.state, 'visible-after'), '7\n');
    fx.env.RELEASE_VISIBILITY_ATTEMPTS = '10';
    fx.env.RELEASE_VISIBILITY_INTERVAL_S = '0';
    const result = runCiMode(fx);
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain('BRANCH_RELEASE_PUBLISH version=9.9.9 tag=latest');
    expect(fs.readFileSync(path.join(fx.state, 'visible-after'), 'utf-8').trim()).toBe('0');
  }, 60_000);

  it('fails loud when a published version never becomes registry-visible', () => {
    const fx = ciModeFixture('9.9.9');
    fs.writeFileSync(path.join(fx.state, 'visible-after'), '99\n');
    fx.env.RELEASE_VISIBILITY_ATTEMPTS = '3';
    fx.env.RELEASE_VISIBILITY_INTERVAL_S = '0';
    const result = runCiMode(fx);
    expect(result.status).not.toBe(0);
    expect(result.out).toContain('is not registry-visible after 3 checks 0 s apart');
  }, 60_000);

  it('refuses an off-main release parent and code added only on the release branch', () => {
    const offMain = ciModeFixture('9.9.9');
    const parentTree = git(offMain.root, 'rev-parse', `${offMain.baseSha}^{tree}`);
    const foreignParent = git(offMain.root, 'commit-tree', parentTree, '-m', 'foreign parent');
    const releaseTree = git(offMain.root, 'rev-parse', 'HEAD^{tree}');
    const foreignRelease = git(offMain.root, 'commit-tree', releaseTree, '-p', foreignParent, '-m', 'foreign release');
    git(offMain.root, 'reset', '--hard', foreignRelease);
    git(offMain.root, 'push', '--force', 'origin', `HEAD:refs/heads/release/9.9.9`);
    const offMainResult = runCiMode(offMain);
    expect(offMainResult.status).not.toBe(0);
    expect(offMainResult.out).toContain('is not on canonical origin/main');

    const code = ciModeFixture('9.9.10');
    fs.mkdirSync(path.join(code.cli, 'src'), { recursive: true });
    fs.writeFileSync(path.join(code.cli, 'src', 'unreviewed.ts'), 'export const unreviewed = true;\n');
    git(code.root, 'add', '-A');
    git(code.root, 'commit', '--amend', '--no-edit');
    git(code.root, 'push', '--force', 'origin', 'HEAD:refs/heads/release/9.9.10');
    const codeResult = runCiMode(code);
    expect(codeResult.status).not.toBe(0);
    expect(codeResult.out).toContain("release tree changes 'cli/src/unreviewed.ts'");
  }, 60_000);

  it('refuses a publishing-workflow diff between the attested base and release head', () => {
    const fx = ciModeFixture('9.9.11', (root) => {
      fs.mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
      fs.writeFileSync(path.join(root, '.github/workflows/release.yml'), 'permissions: write-all\n');
    });
    const result = runCiMode(fx);
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("'.github/workflows/release.yml' is outside the CLI release-input allowlist");
    expect(result.out).toContain('since attested base');
    expect(fs.readFileSync(path.join(fx.state, 'npm.log'), 'utf-8')).not.toMatch(/^publish /m);
  }, 60_000);
});
