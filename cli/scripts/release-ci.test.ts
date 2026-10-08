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

  for (const name of ['release-ci.sh', 'release.sh', 'release-attestation.sh', 'release-install-smoke.sh']) {
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
});
