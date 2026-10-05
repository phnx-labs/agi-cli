
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as net from 'net';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { execFileSync, spawn } from 'child_process';
import { startDetached, startDaemon, assertTestDaemonHome } from './daemon.js';
import { ipcEndpoint } from '../platform/index.js';
import { DIST_ENTRY, REPO_ROOT, installKeychainHermeticity } from './daemon.test-fixture.js';

installKeychainHermeticity();

function probeEndpoint(endpoint: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection(endpoint);
    let done = false;
    const finish = (ok: boolean) => { if (done) return; done = true; sock.destroy(); resolve(ok); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.on('connect', () => { clearTimeout(timer); finish(true); });
    sock.on('error', () => { clearTimeout(timer); finish(false); });
  });
}


describe('startDetached (integration: daemon stays alive)', () => {
  it('spawns a detached daemon whose socket comes up and stays up past 1s', async () => {
    if (!fs.existsSync(DIST_ENTRY)) {
      execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'ignore' });
    }

    const tmpRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
    const tmpHome = fs.mkdtempSync(path.join(tmpRoot, 'agd-'));
    const systemDir = path.join(tmpHome, '.agents', '.system');
    fs.mkdirSync(systemDir, { recursive: true });
    execFileSync('git', ['init', '-q', systemDir]);

    const logPath = path.join(tmpHome, 'daemon-stdio.log');
    const socketPath = path.join(tmpHome, '.agents', '.cache', 'helpers', 'feed', 'feed-stream.sock');
    const endpoint = ipcEndpoint(socketPath);
    const daemonLog = path.join(tmpHome, '.agents', '.cache', 'helpers', 'daemon', 'logs.jsonl');

    const childEnv = { ...process.env, HOME: tmpHome };
    delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;

    const { pid } = startDetached({ agentsBin: DIST_ENTRY, logPath, env: childEnv });
    expect(pid).toBeTruthy();
    const alive = () => { try { process.kill(pid!, 0); return true; } catch { return false; } };

    try {
      let up = false;
      for (let i = 0; i < 80 && !up; i++) {
        up = await probeEndpoint(endpoint);
        if (!up) await new Promise((r) => setTimeout(r, 100));
      }
      expect(up).toBe(true);

      await new Promise((r) => setTimeout(r, 1500));
      expect(await probeEndpoint(endpoint)).toBe(true);
      expect(alive()).toBe(true);

      const logText = fs.existsSync(daemonLog) ? fs.readFileSync(daemonLog, 'utf-8') : '';
      expect(logText).toContain('Feed stream hub listening');
      expect(logText).not.toContain('Daemon shutting down');
    } finally {
      try {
        if (pid && process.platform === 'win32') {
          execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
        } else if (pid) {
          process.kill(pid, 'SIGKILL');
        }
      } catch {  }
      for (let i = 0; i < 100 && alive(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(alive()).toBe(false);
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('startDaemon (RUSH-2417: the start lock is released before the child-pid wait)', () => {
  let tmpHome = '';
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'agd-2417-'));
    for (const k of ['HOME', 'PATH', 'AGENTS_DAEMON_DIR', 'AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME', 'AGENTS_ALLOW_TEST_DAEMON']) saved[k] = process.env[k];
    process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME = '1';
    process.env.AGENTS_ALLOW_TEST_DAEMON = '1';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')(
    'a launchd/systemd-shaped start leaves the lock free, so the launched daemon can claim',
    async () => {
      const daemonDir = path.join(tmpHome, 'daemon');
      const shimDir = path.join(tmpHome, 'bin');
      fs.mkdirSync(daemonDir, { recursive: true });
      fs.mkdirSync(shimDir, { recursive: true });

      const lockPath = path.join(daemonDir, 'daemon.lock');
      const pidPath = path.join(daemonDir, 'daemon.pid');
      const resultPath = path.join(tmpHome, 'claim.json');
      const childPath = path.join(tmpHome, 'fake-daemon.mjs');

      fs.writeFileSync(childPath, [
        `import fs from 'fs';`,
        `setTimeout(() => {`,
        `  fs.writeFileSync(process.env.AGD_RESULT, JSON.stringify({ lockPresent: fs.existsSync(process.env.AGD_LOCK) }));`,
        `  fs.writeFileSync(process.env.AGD_PID, String(process.pid));`,
        `  setTimeout(() => {}, 3000);`,
        `}, 400);`,
      ].join('\n'), 'utf-8');

      const shim = [
        '#!/bin/sh',
        'for a in "$@"; do',
        '  if [ "$a" = "start" ] || [ "$a" = "load" ]; then',
        `    "${process.execPath}" "${childPath}" >/dev/null 2>&1 &`,
        '  fi',
        'done',
        'exit 0',
      ].join('\n');
      for (const name of ['systemctl', 'launchctl']) {
        const p = path.join(shimDir, name);
        fs.writeFileSync(p, shim, 'utf-8');
        fs.chmodSync(p, 0o755);
      }

      process.env.HOME = tmpHome;
      process.env.AGENTS_DAEMON_DIR = daemonDir;
      process.env.PATH = `${shimDir}${path.delimiter}${saved.PATH ?? ''}`;
      process.env.AGD_LOCK = lockPath;
      process.env.AGD_PID = pidPath;
      process.env.AGD_RESULT = resultPath;

      try {
        const res = startDaemon(DIST_ENTRY);
        expect(res.method).toBe(process.platform === 'darwin' ? 'launchd' : 'systemd');
        expect(res.pid).toBeTruthy();

        const recorded = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
        expect(recorded.lockPresent).toBe(false);

        expect(fs.existsSync(lockPath)).toBe(false);
      } finally {
        for (const k of ['AGD_LOCK', 'AGD_PID', 'AGD_RESULT']) delete process.env[k];
        const pid = fs.existsSync(pidPath) ? parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10) : NaN;
        if (!isNaN(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {  } }
      }
    },
    30_000,
  );

  it.skipIf(process.platform === 'win32')(
    'a concurrent start still defers instead of launching a second daemon',
    () => {
      const daemonDir = path.join(tmpHome, 'daemon');
      fs.mkdirSync(daemonDir, { recursive: true });
      process.env.HOME = tmpHome;
      process.env.AGENTS_DAEMON_DIR = daemonDir;
      fs.writeFileSync(path.join(daemonDir, 'daemon.lock'), String(process.pid), 'utf-8');

      const res = startDaemon(DIST_ENTRY);
      expect(res.method).toBe('already-starting');
      expect(res.pid).toBeNull();
      expect(fs.existsSync(path.join(daemonDir, 'daemon.pid'))).toBe(false);
    },
    15_000,
  );
});

describe('daemon single-instance (#414)', () => {
  it.skipIf(process.platform === 'win32')(
    'a replacement waits for an in-progress stop lifecycle lock, then claims the singleton',
    async () => {
      if (!fs.existsSync(DIST_ENTRY)) {
        execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'ignore' });
      }

      const tmpHome = fs.mkdtempSync(path.join('/tmp', 'agd-stop-start-'));
      const daemonDir = path.join(tmpHome, 'daemon');
      const lockPath = path.join(daemonDir, 'daemon.lock');
      const pidPath = path.join(daemonDir, 'daemon.pid');
      fs.mkdirSync(daemonDir, { recursive: true });
      fs.writeFileSync(lockPath, String(process.pid), 'utf-8');

      const builtDaemonUrl = new URL('lib/daemon/daemon.js', pathToFileURL(DIST_ENTRY)).href;
      const script = [
        `import { claimDaemonInstance } from ${JSON.stringify(builtDaemonUrl)};`,
        `process.stdout.write(JSON.stringify({ claimed: claimDaemonInstance(), pid: process.pid }));`,
      ].join('\n');
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, HOME: tmpHome, AGENTS_DAEMON_DIR: daemonDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

      try {
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(child.exitCode).toBeNull();

        fs.unlinkSync(lockPath);
        const exitCode = await new Promise<number | null>((resolve) => child.once('close', resolve));
        expect(exitCode, stderr).toBe(0);
        const result = JSON.parse(stdout);
        expect(result.claimed).toBe(true);
        expect(fs.readFileSync(pidPath, 'utf-8').trim()).toBe(String(result.pid));
        expect(fs.existsSync(lockPath)).toBe(false);
      } finally {
        try { child.kill('SIGKILL'); } catch {  }
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it('startDetached fails loudly instead of returning a null PID when the binary is unspawnable', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-null-'));
    const logPath = path.join(tmpDir, 'stdio.log');
    expect(() =>
      startDetached({ agentsBin: '/nonexistent/agents-cli-does-not-exist', logPath }),
    ).toThrow(/no PID/i);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('last-wins takeover (RUSH-2352): a second daemon evicts the incumbent and becomes the sole owner', async () => {
    if (!fs.existsSync(DIST_ENTRY)) {
      execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'ignore' });
    }

    const tmpRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
    const tmpHome = fs.mkdtempSync(path.join(tmpRoot, 'agd-si-'));
    const systemDir = path.join(tmpHome, '.agents', '.system');
    fs.mkdirSync(systemDir, { recursive: true });
    execFileSync('git', ['init', '-q', systemDir]);

    const pidFile = path.join(tmpHome, '.agents', '.cache', 'helpers', 'daemon', 'daemon.pid');
    const childEnv = { ...process.env, HOME: tmpHome };
    delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;

    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const readPid = () => (fs.existsSync(pidFile) ? parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10) : null);
    const waitFor = async (cond: () => boolean, timeoutMs: number) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (cond()) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return cond();
    };

    let pidA: number | null = null;
    let pidB: number | null = null;
    try {
      pidA = startDetached({ agentsBin: DIST_ENTRY, logPath: path.join(tmpHome, 'a.log'), env: childEnv }).pid!;
      expect(pidA).toBeTruthy();
      expect(await waitFor(() => readPid() === pidA, 20_000)).toBe(true);

      pidB = startDetached({ agentsBin: DIST_ENTRY, logPath: path.join(tmpHome, 'b.log'), env: childEnv }).pid!;
      expect(pidB).toBeTruthy();
      expect(pidB).not.toBe(pidA);

      expect(await waitFor(() => !alive(pidA!), 20_000)).toBe(true);
      expect(await waitFor(() => readPid() === pidB, 20_000)).toBe(true);
      expect(alive(pidB)).toBe(true);
    } finally {
      for (const p of [pidA, pidB]) { try { if (p) process.kill(p, 'SIGKILL'); } catch {  } }
      for (const p of [pidA, pidB]) { if (p) await waitFor(() => !alive(p), 5_000); }
      for (let attempt = 0; ; attempt++) {
        try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; }
        catch (err) {
          if (attempt >= 10) throw err;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    }
  }, 60_000);

  it.skipIf(process.platform === 'win32')(
    'DIFFERENT STATE DIR (the regression this correction exists to prevent): a daemon serving its own HOME survives another pair\'s last-wins takeover completely untouched',
    async () => {
      if (!fs.existsSync(DIST_ENTRY)) {
        execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'ignore' });
      }

      const tmpRoot = '/tmp';
      const tmpHomeAB = fs.mkdtempSync(path.join(tmpRoot, 'agd-ds-ab-'));
      const tmpHomeC = fs.mkdtempSync(path.join(tmpRoot, 'agd-ds-c-'));
      for (const home of [tmpHomeAB, tmpHomeC]) {
        const systemDir = path.join(home, '.agents', '.system');
        fs.mkdirSync(systemDir, { recursive: true });
        execFileSync('git', ['init', '-q', systemDir]);
      }

      const pidFileFor = (home: string) => path.join(home, '.agents', '.cache', 'helpers', 'daemon', 'daemon.pid');
      const envFor = (home: string) => {
        const env = { ...process.env, HOME: home };
        delete env.CLAUDE_CODE_OAUTH_TOKEN;
        return env;
      };
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      const readPid = (home: string) => {
        const p = pidFileFor(home);
        return fs.existsSync(p) ? parseInt(fs.readFileSync(p, 'utf-8').trim(), 10) : null;
      };
      const waitFor = async (cond: () => boolean, timeoutMs: number) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          if (cond()) return true;
          await new Promise((r) => setTimeout(r, 50));
        }
        return cond();
      };

      let pidA: number | null = null;
      let pidB: number | null = null;
      let pidC: number | null = null;
      try {
        pidC = startDetached({ agentsBin: DIST_ENTRY, logPath: path.join(tmpHomeC, 'c.log'), env: envFor(tmpHomeC) }).pid!;
        expect(pidC).toBeTruthy();
        expect(await waitFor(() => readPid(tmpHomeC) === pidC, 20_000)).toBe(true);

        pidA = startDetached({ agentsBin: DIST_ENTRY, logPath: path.join(tmpHomeAB, 'a.log'), env: envFor(tmpHomeAB) }).pid!;
        expect(pidA).toBeTruthy();
        expect(await waitFor(() => readPid(tmpHomeAB) === pidA, 20_000)).toBe(true);

        pidB = startDetached({ agentsBin: DIST_ENTRY, logPath: path.join(tmpHomeAB, 'b.log'), env: envFor(tmpHomeAB) }).pid!;
        expect(pidB).toBeTruthy();
        expect(await waitFor(() => !alive(pidA!), 20_000)).toBe(true);
        expect(await waitFor(() => readPid(tmpHomeAB) === pidB, 20_000)).toBe(true);

        expect(readPid(tmpHomeC)).toBe(pidC);
        expect(alive(pidC)).toBe(true);
      } finally {
        for (const p of [pidA, pidB, pidC]) { try { if (p) process.kill(p, 'SIGKILL'); } catch {  } }
        for (const p of [pidA, pidB, pidC]) { if (p) await waitFor(() => !alive(p), 5_000); }
        for (const home of [tmpHomeAB, tmpHomeC]) {
          for (let attempt = 0; ; attempt++) {
            try { fs.rmSync(home, { recursive: true, force: true }); break; }
            catch (err) {
              if (attempt >= 10) throw err;
              await new Promise((r) => setTimeout(r, 100));
            }
          }
        }
      }
    },
    90_000,
  );
});

describe('daemon self-terminate guard on a missing state dir (RUSH-2367)', () => {
  it.skipIf(process.platform === 'win32')(
    'exits on its own once its state dir is deleted, well inside the check interval',
    async () => {
      if (!fs.existsSync(DIST_ENTRY)) {
        execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'ignore' });
      }

      const tmpHome = fs.mkdtempSync(path.join('/tmp', 'agd-selfterm-'));
      const systemDir = path.join(tmpHome, '.agents', '.system');
      fs.mkdirSync(systemDir, { recursive: true });
      execFileSync('git', ['init', '-q', systemDir]);

      const pidFile = path.join(tmpHome, '.agents', '.cache', 'helpers', 'daemon', 'daemon.pid');
      const stateDir = path.dirname(pidFile);
      const lifetimeFile = path.join(stateDir, 'daemon.lifetime');
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      const readPid = () => (fs.existsSync(pidFile) ? parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10) : null);
      const waitFor = async (cond: () => boolean, timeoutMs: number) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          if (cond()) return true;
          await new Promise((r) => setTimeout(r, 50));
        }
        return cond();
      };

      const childEnv = {
        ...process.env,
        HOME: tmpHome,
        AGENTS_DAEMON_STATE_DIR_CHECK_MS: '300',
      };
      delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;

      let pid: number | null = null;
      try {
        pid = startDetached({ agentsBin: DIST_ENTRY, logPath: path.join(tmpHome, 'daemon.log'), env: childEnv }).pid!;
        expect(pid).toBeTruthy();
        expect(await waitFor(() => readPid() === pid, 20_000)).toBe(true);
        expect(await waitFor(() => fs.existsSync(lifetimeFile), 20_000)).toBe(true);
        expect(alive(pid)).toBe(true);

        fs.unlinkSync(lifetimeFile);
        expect(fs.existsSync(stateDir)).toBe(true);
        expect(fs.existsSync(lifetimeFile)).toBe(false);

        expect(await waitFor(() => !alive(pid!), 10_000)).toBe(true);
      } finally {
        if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {  } }
        if (pid) await waitFor(() => !alive(pid!), 5_000);
        try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {  }
      }
    },
    30_000,
  );
});

describe('daemon test-home tripwire (PHNX-2545)', () => {
  it('no-op when the marker is unset (production)', () => {
    expect(() => assertTestDaemonHome('/anywhere/.agents/.cache/helpers/daemon', undefined)).not.toThrow();
  });

  it('passes when the daemon dir sits under the marked test home', () => {
    const home = '/tmp/agents-routines-add-abc';
    const dir = path.join(home, '.agents', '.cache', 'helpers', 'daemon');
    expect(() => assertTestDaemonHome(dir, home)).not.toThrow();
    expect(() => assertTestDaemonHome(home, home)).not.toThrow();
  });

  it('throws when the daemon dir escapes the marked test home', () => {
    const testHome = '/tmp/agents-routines-add-abc';
    const realDir = path.join(os.homedir(), '.agents', '.cache', 'helpers', 'daemon');
    expect(() => assertTestDaemonHome(realDir, testHome)).toThrow(/test-home tripwire/i);
    expect(() => assertTestDaemonHome('/tmp/agents-routines-add-abc-evil/x', testHome)).toThrow(/test-home tripwire/i);
  });

  it.skipIf(process.platform === 'win32')(
    'a real __daemon-run refuses to boot when its marked test home does not contain its state dir',
    async () => {
      if (!fs.existsSync(DIST_ENTRY)) {
        execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'ignore' });
      }

      const tmpHome = fs.mkdtempSync(path.join('/tmp', 'agd-triphome-'));
      const otherHome = fs.mkdtempSync(path.join('/tmp', 'agd-tripother-'));
      const systemDir = path.join(tmpHome, '.agents', '.system');
      fs.mkdirSync(systemDir, { recursive: true });
      execFileSync('git', ['init', '-q', systemDir]);

      const pidFile = path.join(tmpHome, '.agents', '.cache', 'helpers', 'daemon', 'daemon.pid');
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      const waitFor = async (cond: () => boolean, timeoutMs: number) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          if (cond()) return true;
          await new Promise((r) => setTimeout(r, 50));
        }
        return cond();
      };

      const childEnv = {
        ...process.env,
        HOME: tmpHome,
        AGENTS_DAEMON_TEST_HOME: otherHome,
      };
      delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;

      let pid: number | null = null;
      try {
        pid = startDetached({ agentsBin: DIST_ENTRY, logPath: path.join(tmpHome, 'daemon.log'), env: childEnv }).pid!;
        expect(pid).toBeTruthy();
        expect(await waitFor(() => !alive(pid!), 15_000)).toBe(true);
        expect(fs.existsSync(pidFile)).toBe(false);
      } finally {
        if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {  } }
        if (pid) await waitFor(() => !alive(pid!), 5_000);
        try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {  }
        try { fs.rmSync(otherHome, { recursive: true, force: true }); } catch {  }
      }
    },
    30_000,
  );
});
