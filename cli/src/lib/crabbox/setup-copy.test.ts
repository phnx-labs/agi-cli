import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as secretsClient from '../secrets-client.js';
import * as stateModule from '../state.js';
import { resetCrabboxSecretsMemosForTest } from './cli.js';
import {
  enumerateTrackedFiles,
  buildSetupRsyncArgs,
  sshTransportFromArgv,
  copySetupToBox,
} from './setup-copy.js';

function makeGitRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-copy-'));
  spawnSync('git', ['-C', dir, 'init', '-q'], { encoding: 'utf-8' });
  spawnSync('git', ['-C', dir, 'config', 'user.email', 't@t.com']);
  spawnSync('git', ['-C', dir, 'config', 'user.name', 'T']);
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return dir;
}

describe('enumerateTrackedFiles', () => {
  it('returns only git-tracked files (untracked / gitignored excluded)', () => {
    const dir = makeGitRepo({
      'skills/foo.md': 'x',
      '.gitignore': '.history/\ncache.tmp\n',
      '.history/log.txt': 'noise',
      'cache.tmp': 'noise',
    });
    try {
      spawnSync('git', ['-C', dir, 'add', 'skills/foo.md', '.gitignore']);
      const files = enumerateTrackedFiles(dir).sort();
      expect(files).toEqual(['.gitignore', 'skills/foo.md']);
      expect(files).not.toContain('.history/log.txt');
      expect(files).not.toContain('cache.tmp');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never enumerates .claude or .claude.json even if tracked', () => {
    const dir = makeGitRepo({
      '.claude.json': '{}',
      '.claude/settings.json': '{}',
      'commands/x.md': 'x',
    });
    try {
      spawnSync('git', ['-C', dir, 'add', '-A', '-f']);
      const files = enumerateTrackedFiles(dir);
      expect(files).toContain('commands/x.md');
      expect(files).not.toContain('.claude.json');
      expect(files.some((f) => f.startsWith('.claude/'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns [] for a non-git directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-copy-nogit-'));
    try {
      expect(enumerateTrackedFiles(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sshTransportFromArgv', () => {
  it('splits crabbox ssh argv into the -e transport and the crabbox@host endpoint', () => {
    const argv = ['ssh', '-i', '/k/id_ed25519', '-o', 'IdentitiesOnly=yes', '-p', '2222', 'crabbox@203.0.113.5'];
    const { rsh, host } = sshTransportFromArgv(argv);
    expect(host).toBe('crabbox@203.0.113.5');
    expect(rsh).toBe('ssh -i /k/id_ed25519 -o IdentitiesOnly=yes -p 2222');
  });
});

describe('buildSetupRsyncArgs', () => {
  it('pushes the file list to ~/.agents on the box over the given ssh transport', () => {
    const args = buildSetupRsyncArgs({
      rsh: 'ssh -i /k/id_ed25519 -p 2222',
      host: 'crabbox@203.0.113.5',
      filesFrom: '/tmp/list',
      source: '/home/u/.agents',
    });
    expect(args).toContain('-az');
    expect(args).toContain('--files-from');
    expect(args).toContain('/tmp/list');
    expect(args).toContain('--from0');
    expect(args).toContain('/home/u/.agents/');
    expect(args).toContain('crabbox@203.0.113.5:.agents/');
    const eIdx = args.indexOf('-e');
    expect(eIdx).toBeGreaterThan(-1);
    expect(args[eIdx + 1]).toBe('ssh -i /k/id_ed25519 -p 2222');
  });

  it('can target an isolated lease home', () => {
    const args = buildSetupRsyncArgs({
      rsh: 'ssh -i /k/id_ed25519',
      host: 'crabbox@203.0.113.5',
      filesFrom: '/tmp/list',
      source: '/home/u/.agents',
      remoteDir: 'lease-homes/run-a/.agents/',
    });
    expect(args).toContain('crabbox@203.0.113.5:lease-homes/run-a/.agents/');
  });
});

describe('copySetupToBox', () => {
  const itPosix = it.skipIf(process.platform === 'win32');

  beforeEach(() => {
    resetCrabboxSecretsMemosForTest();
    vi.spyOn(stateModule, 'readMeta').mockReturnValue({} as ReturnType<typeof stateModule.readMeta>);
    vi.spyOn(secretsClient, 'listBundlesSync').mockReturnValue([]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetCrabboxSecretsMemosForTest();
  });

  function withFakeTransport(
    exit: { rsync: number; ssh: number; crabboxResolves?: boolean },
    fn: (ctx: { rsyncLog: string; sshLog: string }) => Promise<void>,
  ): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-copy-fake-'));
    const rsyncLog = path.join(dir, 'rsync.log');
    const sshLog = path.join(dir, 'ssh.log');
    const crabboxResolves = exit.crabboxResolves !== false;
    fs.writeFileSync(
      path.join(dir, 'crabbox'),
      [
        '#!/bin/sh',
        'case "$1" in',
        '  --help) exit 0 ;;',
        crabboxResolves
          ? `  ssh) printf "%s\\n" "'ssh' '-i' '/fake/id_ed25519' '-o' 'BatchMode=yes' '-p' '2222' 'crabbox@203.0.113.7'"; exit 0 ;;`
          : '  ssh) exit 1 ;;',
        '  *) exit 1 ;;',
        'esac',
      ].join('\n'),
      'utf-8',
    );
    for (const [name, code, log] of [
      ['rsync', exit.rsync, rsyncLog],
      ['ssh', exit.ssh, sshLog],
    ] as const) {
      fs.writeFileSync(
        path.join(dir, name),
        ['#!/bin/sh', `printf "%s\\n" "$*" >> "${log}"`, `exit ${code}`].join('\n'),
        'utf-8',
      );
    }
    for (const n of ['crabbox', 'rsync', 'ssh']) fs.chmodSync(path.join(dir, n), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ''}`;
    return fn({ rsyncLog, sshLog }).finally(() => {
      process.env.PATH = oldPath;
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }

  itPosix('enumerates tracked files, rsyncs them over crabbox ssh, then refreshes on the box', async () => {
    const repo = makeGitRepo({ 'skills/a.md': 'x', 'commands/b.md': 'y' });
    spawnSync('git', ['-C', repo, 'add', '-A']);
    try {
      await withFakeTransport({ rsync: 0, ssh: 0 }, async ({ rsyncLog, sshLog }) => {
        const result = await copySetupToBox({ slug: 'blue-box', userAgentsDir: repo });
        expect(result.files.sort()).toEqual(['commands/b.md', 'skills/a.md']);
        expect(result.pushExitCode).toBe(0);
        expect(result.refreshExitCode).toBe(0);
        const rlog = fs.readFileSync(rsyncLog, 'utf-8');
        expect(rlog).toContain('crabbox@203.0.113.7:.agents/');
        expect(rlog).toContain('/fake/id_ed25519');
        expect(fs.readFileSync(sshLog, 'utf-8')).toContain('agents sync --local');
      });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  itPosix('refresh=false leaves the box refresh to the bootstrap (no ssh)', async () => {
    const repo = makeGitRepo({ 'skills/a.md': 'x' });
    spawnSync('git', ['-C', repo, 'add', '-A']);
    try {
      await withFakeTransport({ rsync: 0, ssh: 0 }, async ({ sshLog }) => {
        const result = await copySetupToBox({ slug: 'blue-box', userAgentsDir: repo, refresh: false });
        expect(result.pushExitCode).toBe(0);
        expect(result.refreshExitCode).toBeNull();
        expect(fs.existsSync(sshLog)).toBe(false);
      });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  itPosix('creates and targets an isolated lease home before copying setup', async () => {
    const repo = makeGitRepo({ 'skills/a.md': 'x' });
    spawnSync('git', ['-C', repo, 'add', '-A']);
    try {
      await withFakeTransport({ rsync: 0, ssh: 0 }, async ({ rsyncLog, sshLog }) => {
        const result = await copySetupToBox({
          slug: 'blue-box',
          userAgentsDir: repo,
          remoteDir: 'lease-homes/run-a/.agents/',
          refresh: false,
        });
        expect(result.pushExitCode).toBe(0);
        expect(fs.readFileSync(sshLog, 'utf-8')).toContain('mkdir -p');
        expect(fs.readFileSync(sshLog, 'utf-8')).toContain('lease-homes/run-a/.agents');
        expect(fs.readFileSync(rsyncLog, 'utf-8')).toContain('crabbox@203.0.113.7:lease-homes/run-a/.agents/');
      });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  itPosix('skips the refresh when the rsync push fails', async () => {
    const repo = makeGitRepo({ 'skills/a.md': 'x' });
    spawnSync('git', ['-C', repo, 'add', '-A']);
    try {
      await withFakeTransport({ rsync: 23, ssh: 0 }, async ({ sshLog }) => {
        const result = await copySetupToBox({ slug: 'blue-box', userAgentsDir: repo });
        expect(result.pushExitCode).toBe(23);
        expect(result.refreshExitCode).toBeNull();
        expect(fs.existsSync(sshLog)).toBe(false);
      });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  itPosix('no-ops when crabbox cannot resolve the box (best-effort)', async () => {
    const repo = makeGitRepo({ 'skills/a.md': 'x' });
    spawnSync('git', ['-C', repo, 'add', '-A']);
    try {
      await withFakeTransport({ rsync: 0, ssh: 0, crabboxResolves: false }, async ({ rsyncLog }) => {
        const result = await copySetupToBox({ slug: 'gone', userAgentsDir: repo });
        expect(result.pushExitCode).toBeNull();
        expect(result.refreshExitCode).toBeNull();
        expect(fs.existsSync(rsyncLog)).toBe(false);
      });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('is a no-op when there are no tracked files', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-copy-empty-'));
    spawnSync('git', ['-C', repo, 'init', '-q']);
    try {
      await withFakeTransport({ rsync: 0, ssh: 0 }, async ({ rsyncLog, sshLog }) => {
        const result = await copySetupToBox({ slug: 'blue-box', userAgentsDir: repo });
        expect(result.files).toEqual([]);
        expect(result.pushExitCode).toBeNull();
        expect(result.refreshExitCode).toBeNull();
        expect(fs.existsSync(rsyncLog)).toBe(false);
        expect(fs.existsSync(sshLog)).toBe(false);
      });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
