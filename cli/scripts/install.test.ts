import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

const makeTempHome = () => makeTempDir('agents-install-home-');

/** Hermetic package tree: the real scripts/install.sh beside a stub dist/ and a dependency-free
 * package.json. install.sh cd's to its parent and packs what is there, so this exercises the real
 * pack, npm install and link path without a built dist/. */
function stagePackageTree(): string {
  const root = makeTempDir('agents-install-pkg-');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, 'scripts', 'install.sh'),
    path.join(root, 'scripts', 'install.sh'),
  );
  fs.chmodSync(path.join(root, 'scripts', 'install.sh'), 0o755);
  fs.writeFileSync(
    path.join(root, 'dist', 'index.js'),
    '#!/usr/bin/env node\nconsole.log("0.0.0-stub");\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(root, 'scripts', 'postinstall.js'), '// stub\n');
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: '@phnx-labs/agents-cli',
        version: '9.9.9',
        bin: { agents: 'dist/index.js', ag: 'dist/index.js', browser: 'dist/index.js' },
        files: ['dist'],
      },
      null,
      2,
    ),
  );
  return root;
}

function runInstall(
  root: string,
  home: string,
  extraArgs: string[] = [],
  extraEnv: Record<string, string | undefined> = {},
) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CI: undefined,
    AGENTS_NO_HEAL: undefined,
    ...extraEnv,
  };
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key];
  }
  return spawnSync(
    'bash',
    [path.join(root, 'scripts', 'install.sh'), '--skip-build', '--skip-tests', ...extraArgs],
    { env: env as NodeJS.ProcessEnv, encoding: 'utf-8', cwd: root },
  );
}

const linkDir = (home: string) => path.join(home, '.local', 'bin');
const devPrefix = (home: string) => path.join(home, '.local', 'agents-cli-dev');

const resolves = (p: string) => fs.existsSync(p);
const present = (p: string) => fs.existsSync(p) || fs.lstatSync(p, { throwIfNoEntry: false }) != null;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === 'win32')('install.sh dev bin naming', () => {
  it('publishes agents-dev/ag-dev and never the production names', () => {
    const home = makeTempHome();
    const root = stagePackageTree();
    const result = runInstall(root, home);

    expect(result.status, result.stderr).toBe(0);

    expect(resolves(path.join(linkDir(home), 'agents-dev'))).toBe(true);
    expect(resolves(path.join(linkDir(home), 'ag-dev'))).toBe(true);
    expect(fs.realpathSync(path.join(linkDir(home), 'agents-dev'))).toContain(devPrefix(home));

    for (const name of ['agents', 'ag', 'browser']) {
      expect(present(path.join(linkDir(home), name)), `${name} must not be created`).toBe(false);
    }
  });

  it('removes a dangling shadow link a previous run left in the dev prefix', () => {
    const home = makeTempHome();
    const root = stagePackageTree();
    fs.mkdirSync(linkDir(home), { recursive: true });

    const shadow = path.join(linkDir(home), 'agents');
    fs.symlinkSync(path.join(devPrefix(home), 'bin', 'agents'), shadow);
    expect(fs.existsSync(shadow)).toBe(false);
    expect(fs.lstatSync(shadow).isSymbolicLink()).toBe(true);

    const result = runInstall(root, home);
    expect(result.status, result.stderr).toBe(0);

    expect(fs.lstatSync(shadow, { throwIfNoEntry: false })).toBeUndefined();
    expect(result.stdout).toContain('Removed stale dev link');
  });

  it('removes a marker-less wrapper FILE that execs into the dev prefix', () => {
    const home = makeTempHome();
    const root = stagePackageTree();
    fs.mkdirSync(linkDir(home), { recursive: true });

    const wrapper = path.join(linkDir(home), 'agents');
    fs.writeFileSync(
      wrapper,
      '#!/usr/bin/env bash\nexec "$HOME/.local/agents-cli-dev/agents" "$@"\n',
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(linkDir(home), 'agents.cmd'),
      '@"%USERPROFILE%\\.local\\agents-cli-dev\\agents.cmd" %*\r\n',
    );

    const result = runInstall(root, home);
    expect(result.status, result.stderr).toBe(0);

    expect(fs.existsSync(wrapper)).toBe(false);
    expect(fs.existsSync(path.join(linkDir(home), 'agents.cmd'))).toBe(false);
    expect(result.stdout).toContain('Removed stale dev wrapper');
  });

  it('leaves a wrapper FILE that does not reference the dev prefix untouched', () => {
    const home = makeTempHome();
    const root = stagePackageTree();
    fs.mkdirSync(linkDir(home), { recursive: true });

    const wrapper = path.join(linkDir(home), 'agents');
    const body = '#!/usr/bin/env bash\nexec "$HOME/.nvm/versions/node/v22/bin/agents" "$@"\n';
    fs.writeFileSync(wrapper, body, { mode: 0o755 });

    const result = runInstall(root, home);
    expect(result.status, result.stderr).toBe(0);

    expect(fs.readFileSync(wrapper, 'utf-8')).toBe(body);
  });

  it('leaves a production `agents` link that points outside the dev prefix untouched', () => {
    const home = makeTempHome();
    const root = stagePackageTree();
    fs.mkdirSync(linkDir(home), { recursive: true });

    const decoyTarget = path.join(home, 'registry-install', 'agents');
    fs.mkdirSync(path.dirname(decoyTarget), { recursive: true });
    fs.writeFileSync(decoyTarget, '#!/bin/sh\necho registry\n', { mode: 0o755 });
    const link = path.join(linkDir(home), 'agents');
    fs.symlinkSync(decoyTarget, link);

    const result = runInstall(root, home);
    expect(result.status, result.stderr).toBe(0);

    expect(fs.readlinkSync(link)).toBe(decoyTarget);
  });

  it('names a daemon service manifest still pointing at a link it removed', () => {
    const home = makeTempHome();
    const root = stagePackageTree();
    fs.mkdirSync(linkDir(home), { recursive: true });
    fs.symlinkSync(path.join(devPrefix(home), 'bin', 'agents'), path.join(linkDir(home), 'agents'));

    const unitDir = path.join(home, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(
      path.join(unitDir, 'agents-daemon.service'),
      `[Service]\nExecStart="/usr/bin/node" "${path.join(linkDir(home), 'agents')}" "__daemon-run"\n`,
    );

    const result = runInstall(root, home);
    expect(result.status, result.stderr).toBe(0);

    expect(result.stdout).toContain('agents daemon restart');
    expect(result.stdout).toContain('agents-daemon.service');
  });

  it('does not warn when the manifest points at agents-dev and only a sibling was removed', () => {
    const home = makeTempHome();
    const root = stagePackageTree();
    fs.mkdirSync(linkDir(home), { recursive: true });

    // A leftover `browser` shadow gets cleaned, but the manifest was pinned by a --bounce-daemon
    // run to agents-dev, which is healthy. A bare substring test for "<linkdir>/agents" also
    // matches "<linkdir>/agents-dev" and would send the user to restart a working shared daemon.
    fs.symlinkSync(
      path.join(devPrefix(home), 'bin', 'browser'),
      path.join(linkDir(home), 'browser'),
    );
    const unitDir = path.join(home, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(
      path.join(unitDir, 'agents-daemon.service'),
      `[Service]\nExecStart="/usr/bin/node" "${path.join(linkDir(home), 'agents-dev')}" "__daemon-run"\n`,
    );

    const result = runInstall(root, home);
    expect(result.status, result.stderr).toBe(0);

    expect(result.stdout).toContain('Removed stale dev link');
    expect(result.stdout).not.toContain('agents daemon restart');
  });

  it('tells you how to restore `agents` when it no longer resolves', () => {
    const home = makeTempHome();
    const root = stagePackageTree();

    // The real PATH minus every directory providing an `agents`, reproducing a box where the dev
    // shadow was the only `agents` (postinstall.js:311 skips its own link when `agents` resolves).
    // node/npm/git get their own shim dir, since filtering dirs would drop them on Homebrew boxes.
    const shimDir = makeTempDir('agents-install-shim-');
    for (const bin of ['node', 'npm', 'git']) {
      const resolved = spawnSync('/bin/sh', ['-c', `command -v ${bin}`], {
        encoding: 'utf-8',
      }).stdout.trim();
      if (resolved) fs.symlinkSync(resolved, path.join(shimDir, bin));
    }
    const pathWithoutAgents = [
      shimDir,
      ...(process.env.PATH ?? '')
        .split(path.delimiter)
        .filter((dir) => dir && !fs.existsSync(path.join(dir, 'agents'))),
    ].join(path.delimiter);
    expect(
      spawnSync('/bin/sh', ['-c', 'command -v agents'], {
        env: { PATH: pathWithoutAgents },
        encoding: 'utf-8',
      }).stdout,
    ).toBe('');

    const result = runInstall(root, home, [], { PATH: pathWithoutAgents });
    expect(result.status, result.stderr).toBe(0);

    expect(result.stdout).toContain("'agents' does not resolve on this PATH");
    expect(result.stdout).toContain('npm install -g @phnx-labs/agents-cli');
    expect(result.stdout).not.toContain("Your installed 'agents' is untouched");
  });

  it('leaves the shared daemon on production code unless --bounce-daemon is passed', () => {
    const home = makeTempHome();
    const root = stagePackageTree();
    const result = runInstall(root, home);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Shared daemon left on production code');
    expect(result.stdout).not.toContain('Reloading daemon onto this build');
  });
});
