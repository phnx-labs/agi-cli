import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t.dev', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

function resolveBin(name: string): string | null {
  try {
    const out = execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
    return out && path.isAbsolute(out) ? out : null;
  } catch {
    return null;
  }
}

const BUN = process.platform === 'win32' ? null : resolveBin('bun');
const WHICH = process.platform === 'win32' ? null : resolveBin('which');

describe.skipIf(process.platform === 'win32' || !BUN || !WHICH)(
  'teams add leaves no orphan branch or worktree when the add fails (RUSH-2356)',
  () => {
    let tmp: string;
    let home: string;
    let repo: string;
    let binDir: string;
    const entry = path.resolve(process.cwd(), 'src/index.ts');

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-add-cleanup-'));
      home = path.join(tmp, 'home');

      const systemDir = path.join(home, '.agents', '.system');
      fs.mkdirSync(systemDir, { recursive: true });
      git(systemDir, ['init', '-q']);
      const deviceDir = path.join(home, '.agents', 'devices', 'test-worker');
      fs.mkdirSync(deviceDir, { recursive: true });
      fs.writeFileSync(path.join(deviceDir, 'agents.yaml'), 'config:\n  role: worker\n');

      const bare = path.join(tmp, 'remote.git');
      const seed = path.join(tmp, 'seed');
      git(tmp, ['init', '--bare', '-q', '-b', 'main', bare]);
      git(tmp, ['init', '-q', '-b', 'main', seed]);
      fs.writeFileSync(path.join(seed, 'base.txt'), 'A\n');
      git(seed, ['add', 'base.txt']);
      git(seed, ['commit', '-qm', 'A']);
      git(seed, ['remote', 'add', 'origin', bare]);
      git(seed, ['push', '-q', '-u', 'origin', 'main']);

      repo = path.join(tmp, 'repo');
      git(tmp, ['clone', '-q', bare, repo]);
      git(repo, ['remote', 'set-head', 'origin', '--auto']);

      binDir = path.join(tmp, 'bin');
      fs.mkdirSync(binDir);
      fs.symlinkSync(resolveBin('git')!, path.join(binDir, 'git'));
      fs.symlinkSync('/bin/sh', path.join(binDir, 'sh'));
      fs.symlinkSync(WHICH!, path.join(binDir, 'which'));
    });

    afterEach(() => {
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          fs.rmSync(tmp, { recursive: true, force: true });
          return;
        } catch {
          const until = Date.now() + 100;
          while (Date.now() < until) {  }
        }
      }
    });

    function runCli(args: string[]): { status: number; out: string } {
      const result = spawnSync(BUN!, [entry, ...args], {
        cwd: repo,
        env: {
          HOME: home,
          PATH: binDir,
          AGENTS_NO_NUDGE: '1',
          AGENTS_SYNC_MACHINE_ID: 'test-worker',
          FORCE_COLOR: '0',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: result.status ?? 1, out: `${result.stdout}${result.stderr}` };
    }

    function branches(): string[] {
      return git(repo, ['branch', '--list', '--format=%(refname:short)'])
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    }

    it('a failed add exits non-zero, strands nothing, and the same name retries clean', () => {
      expect(runCli(['teams', 'create', 'wt-team', '--enable-worktrees']).status).toBe(0);

      const failed = runCli([
        'teams', 'add', 'wt-team', 'claude', 'do a thing',
        '--name', 'surface', '--worktree', 'surface',
      ]);

      expect(failed.status).not.toBe(0);
      expect(failed.out).toContain("CLI tool 'claude' not found in PATH");
      expect(failed.out).not.toContain('Welcomed');

      expect(branches()).not.toContain('agents/surface');

      expect(fs.existsSync(path.join(repo, '.agents', 'worktrees', 'surface'))).toBe(false);
      expect(git(repo, ['worktree', 'list'])).not.toContain('surface');

      const stub = path.join(binDir, 'claude');
      fs.writeFileSync(stub, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(stub, 0o755);

      const retry = runCli([
        'teams', 'add', 'wt-team', 'claude', 'do a thing',
        '--name', 'surface', '--worktree', 'surface',
      ]);

      expect(retry.out).not.toContain('already exists');
      expect(retry.status).toBe(0);
      expect(retry.out).toContain('Welcomed');
      expect(branches()).toContain('agents/surface');
      expect(fs.existsSync(path.join(repo, '.agents', 'worktrees', 'surface'))).toBe(true);
    }, 120_000);

    it('a rejected add never creates the branch in the first place', () => {
      expect(runCli(['teams', 'create', 'dep-team', '--enable-worktrees']).status).toBe(0);

      const rejected = runCli([
        'teams', 'add', 'dep-team', 'claude', 'do a thing',
        '--name', 'second', '--worktree', 'second', '--after', 'nobody',
      ]);

      expect(rejected.status).not.toBe(0);
      expect(rejected.out).toContain("has no teammate named 'nobody'");
      expect(branches()).not.toContain('agents/second');
      expect(fs.existsSync(path.join(repo, '.agents', 'worktrees', 'second'))).toBe(false);

      expect(rejected.out).not.toContain('Could not add');
    }, 120_000);

    it('a failed add never destroys a kept dirty worktree it collided with', () => {
      expect(runCli(['teams', 'create', 'dirty-team', '--enable-worktrees']).status).toBe(0);

      const stub = path.join(binDir, 'claude');
      fs.writeFileSync(stub, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(stub, 0o755);

      const first = runCli([
        'teams', 'add', 'dirty-team', 'claude', 'do a thing',
        '--name', 'alpha', '--worktree', 'shared-name',
      ]);
      expect(first.status).toBe(0);

      const wt = path.join(repo, '.agents', 'worktrees', 'shared-name');
      expect(fs.existsSync(wt)).toBe(true);
      const precious = path.join(wt, 'important.txt');
      fs.writeFileSync(precious, 'PRECIOUS UNCOMMITTED WORK\n');

      const stopped = runCli(['teams', 'stop', 'dirty-team', 'alpha']);
      expect(stopped.out).toContain("Worktree 'shared-name' has uncommitted changes. Keeping it at");
      expect(fs.existsSync(wt)).toBe(true);

      const collide = runCli([
        'teams', 'add', 'dirty-team', 'claude', 'do another thing',
        '--name', 'beta', '--worktree', 'shared-name',
      ]);

      expect(collide.status).not.toBe(0);
      expect(fs.existsSync(precious)).toBe(true);
      expect(fs.readFileSync(precious, 'utf8')).toBe('PRECIOUS UNCOMMITTED WORK\n');
      expect(branches()).toContain('agents/shared-name');
    }, 120_000);
  },
);
