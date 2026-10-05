import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isAlive, killTree, backgroundSpawnOptions } from './process.js';

describe('isAlive', () => {
  it('is true for the current process', () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  it('is false for invalid pids', () => {
    expect(isAlive(0)).toBe(false);
    expect(isAlive(-1)).toBe(false);
  });

  it('is false for a pid that is almost certainly not running', () => {
    expect(isAlive(1 << 30)).toBe(false);
  });
});

describe('killTree', () => {
  it('terminates a running process', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const pid = child.pid!;
    expect(isAlive(pid)).toBe(true);

    killTree(pid);

    for (let i = 0; i < 100 && isAlive(pid); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(isAlive(pid)).toBe(false);
  });

  it('is a no-op for invalid pids (never throws)', () => {
    expect(() => killTree(0)).not.toThrow();
    expect(() => killTree(-1)).not.toThrow();
  });
});

describe('backgroundSpawnOptions', () => {
  it('always supplies an existing stable cwd', () => {
    const options = backgroundSpawnOptions();
    expect(path.isAbsolute(options.cwd)).toBe(true);
    expect(fs.statSync(options.cwd).isDirectory()).toBe(true);
  });

  it('uses a hidden console instead of detach on win32', () => {
    expect(backgroundSpawnOptions({ platform: 'win32' })).toMatchObject({ detached: false, windowsHide: true });
  });

  it('detaches on win32 when stdio is fd-redirected (windowsHide cannot engage)', () => {
    expect(backgroundSpawnOptions({ fdStdio: true, platform: 'win32' })).toMatchObject({
      detached: true,
      windowsHide: true,
    });
  });

  it('detaches into its own process group on POSIX', () => {
    expect(backgroundSpawnOptions({ platform: 'darwin' })).toMatchObject({ detached: true, windowsHide: false });
    expect(backgroundSpawnOptions({ fdStdio: true, platform: 'linux' })).toMatchObject({ detached: true, windowsHide: false });
  });

  it('an fd-redirected background child survives its launcher console closing (#556 regression)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-spawn-'));
    const logPath = path.join(dir, 'child.log');
    const pidPath = path.join(dir, 'child.pid');
    const launcherPath = path.join(dir, 'launcher.cjs');
    fs.writeFileSync(
      launcherPath,
      `const { spawn } = require('child_process');
const fs = require('fs');
const opts = JSON.parse(process.argv[2]);
const fd = fs.openSync(${JSON.stringify(logPath)}, 'a');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: ['ignore', fd, fd],
  ...opts,
});
child.unref();
fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
`,
    );

    const launcher = spawn(
      process.execPath,
      [launcherPath, JSON.stringify(backgroundSpawnOptions({ fdStdio: true }))],
      { stdio: 'ignore', ...backgroundSpawnOptions() },
    );
    const launcherExited = new Promise((r) => launcher.on('exit', r));

    let childPid = 0;
    for (let i = 0; i < 100 && !childPid; i++) {
      await new Promise((r) => setTimeout(r, 50));
      try { childPid = parseInt(fs.readFileSync(pidPath, 'utf-8'), 10); } catch {  }
    }
    expect(childPid).toBeGreaterThan(0);
    await launcherExited;

    await new Promise((r) => setTimeout(r, 2000));
    expect(isAlive(childPid)).toBe(true);

    killTree(childPid);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('a child spawned with the current-platform options outlives its parent and stays killable', async () => {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { ...backgroundSpawnOptions(), stdio: 'ignore' },
    );
    child.unref();
    const pid = child.pid!;
    expect(isAlive(pid)).toBe(true);

    killTree(pid);
    for (let i = 0; i < 100 && isAlive(pid); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(isAlive(pid)).toBe(false);
  });
});
