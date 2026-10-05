import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// `agents import <agent> --version <v>` was unreachable: the program's `.version(VERSION)` claims
// `-V, --version` globally and wins over the subcommand option, so it printed the CLI version and
// exited. Renamed to `--as`; these tests assert the flag actually reaches the command.
describe.skipIf(process.platform === 'win32')('agents import --as', () => {
  let home: string;

  const versionsRoot = () => path.join(home, '.agents', '.history', 'versions', 'codex');
  const realConfig = () => path.join(home, '.codex');

  function run(...args: string[]): { out: string; status: number } {
    try {
      const out = execFileSync('bun', [path.resolve(process.cwd(), 'src/index.ts'), ...args], {
        cwd: process.cwd(),
        env: {
          ...process.env, HOME: home, AGENTS_REAL_HOME: home, SHELL: '/bin/bash',
          AGENTS_NO_NUDGE: '1', FORCE_COLOR: '0',
          PATH: `${path.join(home, 'npm-global', 'bin')}:${process.env.PATH}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString('utf-8');
      return { out, status: 0 };
    } catch (e) {
      const err = e as { stdout?: Buffer; stderr?: Buffer; status?: number };
      return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, status: err.status ?? 1 };
    }
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'import-as-'));
    const pkgDir = path.join(home, 'npm-global', 'lib', 'node_modules', '@openai', 'codex');
    fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(home, 'npm-global', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
      name: '@openai/codex', version: '0.144.6', bin: { codex: 'bin/codex.js' },
    }));
    fs.writeFileSync(path.join(pkgDir, 'bin', 'codex.js'), '#!/bin/sh\necho LOCAL\n');
    fs.chmodSync(path.join(pkgDir, 'bin', 'codex.js'), 0o755);
    fs.symlinkSync('../lib/node_modules/@openai/codex/bin/codex.js',
      path.join(home, 'npm-global', 'bin', 'codex'));
    fs.mkdirSync(realConfig(), { recursive: true });
    fs.writeFileSync(path.join(realConfig(), 'config.toml'), 'model = "my-local-setting"\n');
    const systemDir = path.join(home, '.agents', '.system');
    fs.mkdirSync(systemDir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: systemDir, stdio: 'ignore' });
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('reaches the command instead of printing the CLI version', () => {
    const r = run('import', 'codex', '--isolated', '--as', '9.9.9', '-y');
    // The regression: this used to be the CLI's own version and nothing else.
    expect(r.out).not.toMatch(/^\d+\.\d+\.\d+\s*$/);
    expect(fs.existsSync(path.join(versionsRoot(), '9.9.9'))).toBe(true);
  }, 180_000);

  it('imports under the given label rather than the detected one', () => {
    expect(run('import', 'codex', '--isolated', '--as', '9.9.9', '-y').status).toBe(0);
    // Local package.json says 0.144.6; --as wins.
    expect(fs.readdirSync(versionsRoot())).toEqual(['9.9.9']);
  }, 180_000);

  it('re-seeds an EXISTING isolated copy at a different version than the local one', () => {
    // Unblocks a sandbox on 0.146.0 with a local 0.144.6. Also the regression test for a Bun quirk:
    // `fs.cpSync` drops its default `force: true` when a `filter` is given; it shows only here
    // because the CLI is spawned under bun, while vitest runs on node.
    const target = path.join(versionsRoot(), '0.146.0');
    fs.mkdirSync(path.join(target, 'node_modules', '.bin'), { recursive: true });
    fs.mkdirSync(path.join(target, 'home', '.codex'), { recursive: true });
    fs.writeFileSync(path.join(target, 'package.json'), '{}');
    fs.writeFileSync(path.join(target, 'node_modules', '.bin', 'codex'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(target, 'node_modules', '.bin', 'codex'), 0o755);
    fs.writeFileSync(path.join(target, '.isolated'), 'x\n');
    fs.writeFileSync(path.join(target, 'home', '.codex', 'config.toml'), 'model = "stale"\n');

    expect(run('import', 'codex', '--isolated', '--as', '0.146.0', '-y').status).toBe(0);

    // The existing sandbox picked up the local settings...
    expect(fs.readFileSync(path.join(target, 'home', '.codex', 'config.toml'), 'utf-8'))
      .toContain('my-local-setting');
    // ...no second copy was created at the local version...
    expect(fs.readdirSync(versionsRoot()).sort()).toEqual(['0.146.0']);
    // ...and the real config is still a real directory, untouched.
    expect(fs.lstatSync(realConfig()).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(realConfig(), 'config.toml'), 'utf-8')).toContain('my-local-setting');
  }, 180_000);

  it('still auto-detects the version when --as is omitted', () => {
    expect(run('import', 'codex', '--isolated', '-y').status).toBe(0);
    expect(fs.readdirSync(versionsRoot())).toEqual(['0.144.6']);
  }, 180_000);
});
