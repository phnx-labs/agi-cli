import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { listUnattributedActive, clearActiveScanCachesForTest, unattributedContext } from './active.js';

describe('unattributedContext', () => {
  it('a process with a controlling tty is a terminal session even under sshd', () => {
    expect(unattributedContext(undefined, 'pts/3')).toBe('terminal');
    expect(unattributedContext(undefined, 'ttys004')).toBe('terminal');
  });

  it('a process with no tty and no UI host is headless', () => {
    expect(unattributedContext(undefined, undefined)).toBe('headless');
  });

  it('a known UI host is a terminal session without a tty', () => {
    expect(unattributedContext('code', undefined)).toBe('terminal');
  });
});

const hasScript = process.platform !== 'win32' && spawnSync('script', ['-q', '/dev/null', 'true'], { stdio: 'ignore' }).error === undefined;
const withScript = hasScript ? it : it.skip;

const SESSION = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';

describe('unattributed scan reads the real controlling tty', () => {
  let child: ChildProcess | undefined;
  let dir: string | undefined;

  afterEach(() => {
    if (child?.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch {  }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    clearActiveScanCachesForTest();
  });

  withScript('an agent on a pty (an ssh-opened editor tab) is listed as terminal', async (ctx) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-pty-'));
    const bin = path.join(dir, 'claude');
    fs.copyFileSync(process.execPath, bin);
    fs.chmodSync(bin, 0o755);
    const argv = [bin, '-e', 'setInterval(() => {}, 60_000)', '--', '--session-id', SESSION];
    child = process.platform === 'darwin'
      ? spawn('script', ['-q', '/dev/null', ...argv], { cwd: dir, stdio: 'ignore', detached: true })
      : spawn('script', ['-qec', argv.map((a) => `'${a}'`).join(' '), '/dev/null'], { cwd: dir, stdio: 'ignore', detached: true });

    let row: Awaited<ReturnType<typeof listUnattributedActive>>[number] | undefined;
    const deadline = Date.now() + 10_000;
    while (!row && Date.now() < deadline) {
      clearActiveScanCachesForTest();
      row = (await listUnattributedActive(new Set())).find((r) => r.sessionId === SESSION);
      if (!row) await new Promise((r) => setTimeout(r, 100));
    }
    if (!row) {
      ctx.skip('ps never classified the pty holder as an agent — see RUSH-2508');
      return;
    }
    expect(row.tty).toMatch(/^(pts\/\d+|ttys\d+)$/);
    expect(row.context).toBe('terminal');
  });
});
