/**
 * Daemon lifecycle: spawning, single-instance takeover, and the self-terminate
 * guard.
 *
 * RUSH-2819: split out of daemon.test.ts (2201 lines / 88 tests / ~112s in CI)
 * so vitest can parallelize the process-spawning integration suites across
 * worker forks. This slice drives the REAL compiled CLI (`DIST_ENTRY`) as a
 * subprocess — `startDetached`, `startDaemon`'s launchd/systemd lock-release
 * race, the #414 single-instance last-wins takeover, and the RUSH-2367
 * self-terminate guard on a deleted state dir. Shared helpers live in
 * daemon.test-fixture.ts; the manifest/plist/systemd tests live in
 * daemon.test.ts; shutdown semantics live in daemon.stop.test.ts; registry and
 * misc daemon utilities live in daemon.registry.test.ts.
 */

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

/** Open a real connection to the daemon endpoint; resolve true only if a
 * process is accepting on it (mirrors the client's own liveness probe). */
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


// #556 / #561 (missing e2e coverage): drive the REAL startDetached path and
// prove the daemon it spawns is always-on — the socket comes up AND is still up
// after >1s, i.e. it did not self-terminate the way the bug report describes
// ("Browser IPC server started" then "Daemon shutting down" ~36ms later).
describe('startDetached (integration: daemon stays alive)', () => {
  it('spawns a detached daemon whose socket comes up and stays up past 1s', async () => {
    // Exercises the built CLI entry the way `browser start` does. CI runs the
    // build before tests; self-heal for a bare `vitest` run without a prior build.
    if (!fs.existsSync(DIST_ENTRY)) {
      execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'ignore' });
    }

    // The daemon's browser IPC binds an AF_UNIX socket at
    // <HOME>/.agents/.cache/helpers/browser/browser.sock. macOS caps AF_UNIX
    // paths at 104 bytes (sun_path); os.tmpdir() there is the long
    // /var/folders/…/T/… (~48 chars), so nesting the socket under it overflows
    // to ~116 chars and bind() fails with EADDRINUSE. Root the fake HOME at a
    // short base on POSIX so the socket path stays well under the limit. Windows
    // uses named pipes (no path-length limit), so os.tmpdir() is fine there.
    const tmpRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
    const tmpHome = fs.mkdtempSync(path.join(tmpRoot, 'agd-'));
    // Satisfy the setup gate (`ensureInitialized`): ~/.agents/.system must be a repo.
    const systemDir = path.join(tmpHome, '.agents', '.system');
    fs.mkdirSync(systemDir, { recursive: true });
    execFileSync('git', ['init', '-q', systemDir]);

    const logPath = path.join(tmpHome, 'daemon-stdio.log');
    const socketPath = path.join(tmpHome, '.agents', '.cache', 'helpers', 'browser', 'browser.sock');
    const endpoint = ipcEndpoint(socketPath);
    const daemonLog = path.join(tmpHome, '.agents', '.cache', 'helpers', 'daemon', 'logs.jsonl');

    const childEnv = { ...process.env, HOME: tmpHome };
    delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;

    const { pid } = startDetached({ agentsBin: DIST_ENTRY, logPath, env: childEnv });
    expect(pid).toBeTruthy();
    const alive = () => { try { process.kill(pid!, 0); return true; } catch { return false; } };

    try {
      // Wait for the browser IPC socket to accept connections (issue: ~400ms).
      let up = false;
      for (let i = 0; i < 80 && !up; i++) {
        up = await probeEndpoint(endpoint);
        if (!up) await new Promise((r) => setTimeout(r, 100));
      }
      expect(up).toBe(true);

      // The crux of #556: it must NOT tear itself down. Wait well past the 36ms
      // window and re-probe.
      await new Promise((r) => setTimeout(r, 1500));
      expect(await probeEndpoint(endpoint)).toBe(true);
      expect(alive()).toBe(true);

      // The daemon's own structured log confirms it came up and never shut down.
      const logText = fs.existsSync(daemonLog) ? fs.readFileSync(daemonLog, 'utf-8') : '';
      expect(logText).toContain('Browser IPC server started');
      expect(logText).not.toContain('Daemon shutting down');
    } finally {
      try {
        if (pid && process.platform === 'win32') {
          execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
        } else if (pid) {
          process.kill(pid, 'SIGKILL');
        }
      } catch { /* already gone */ }
      for (let i = 0; i < 100 && alive(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(alive()).toBe(false);
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 30_000);
});

// RUSH-2417: `agents daemon start` self-contended on its own lock file.
// `startDaemon` (daemon.ts) and the freshly-launched child's
// `claimDaemonInstance` both resolve `getLockPath()` -> `<daemonDir>/daemon.lock`,
// and the launchd/systemd branches busy-waited on `waitForPid(3000)` while STILL
// holding it (release only happened in startDaemon's outer `finally`). The child
// therefore always hit EEXIST against a holder that was alive — the parent CLI —
// and exited with the false "another daemon is mid-takeover" warning, defeating
// the service-manager fast-start path on every fresh install.
//
// The existing last-wins takeover test above calls `startDetached` directly and
// never opens this window, which is why the bug survived it. These drive the REAL
// `startDaemon()` sequence with `systemctl` / `launchctl` shims on PATH: the shim
// launches a stand-in daemon that records whether the start lock was present when
// it went to claim, then writes the pid file the parent is waiting on.
describe('startDaemon (RUSH-2417: the start lock is released before the child-pid wait)', () => {
  let tmpHome = '';
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'agd-2417-'));
    for (const k of ['HOME', 'PATH', 'AGENTS_DAEMON_DIR', 'AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME', 'AGENTS_ALLOW_TEST_DAEMON']) saved[k] = process.env[k];
    process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME = '1';
    // W4: these tests deliberately launch daemons under a sandbox HOME.
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

      // The stand-in daemon: waits well inside the parent's 3s pid wait, records
      // what `claimDaemonInstance` would have seen, then records its pid.
      fs.writeFileSync(childPath, [
        `import fs from 'fs';`,
        `setTimeout(() => {`,
        `  fs.writeFileSync(process.env.AGD_RESULT, JSON.stringify({ lockPresent: fs.existsSync(process.env.AGD_LOCK) }));`,
        `  fs.writeFileSync(process.env.AGD_PID, String(process.pid));`,
        `  setTimeout(() => {}, 3000);`,
        `}, 400);`,
      ].join('\n'), 'utf-8');

      // One shim serves both managers: launch on the arg that actually starts the
      // service (`systemctl --user start`, `launchctl load`), no-op on the rest
      // (`daemon-reload`, `enable`, `unload`), always exit 0.
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

        // The assertion this test exists for: the child saw NO lock file, so its
        // claim would have succeeded. Pre-fix this read `true`.
        const recorded = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
        expect(recorded.lockPresent).toBe(false);

        // ...and the parent left nothing behind for the next start to trip over.
        expect(fs.existsSync(lockPath)).toBe(false);
      } finally {
        for (const k of ['AGD_LOCK', 'AGD_PID', 'AGD_RESULT']) delete process.env[k];
        const pid = fs.existsSync(pidPath) ? parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10) : NaN;
        if (!isNaN(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
      }
    },
    30_000,
  );

  // The early release must not reintroduce the race it guards: two concurrent
  // `agents daemon start` invocations must still not both launch. The entry gate
  // is unchanged — a lock held by a LIVE holder still turns the second caller
  // into a waiter rather than a second launcher.
  it.skipIf(process.platform === 'win32')(
    'a concurrent start still defers instead of launching a second daemon',
    () => {
      const daemonDir = path.join(tmpHome, 'daemon');
      fs.mkdirSync(daemonDir, { recursive: true });
      process.env.HOME = tmpHome;
      process.env.AGENTS_DAEMON_DIR = daemonDir;
      // A live holder: this very process, so the stale-lock reclaim can't fire.
      fs.writeFileSync(path.join(daemonDir, 'daemon.lock'), String(process.pid), 'utf-8');

      // No shim on PATH and no service manifest written: reaching a launch at all
      // would be the regression. `already-starting` proves it did not.
      const res = startDaemon(DIST_ENTRY);
      expect(res.method).toBe('already-starting');
      expect(res.pid).toBeNull();
      expect(fs.existsSync(path.join(daemonDir, 'daemon.pid'))).toBe(false);
    },
    15_000,
  );
});

// #414: enforce a single daemon instance and never report a null PID.
//  - A second concurrent `__daemon-run` must exit without clobbering the live
//    daemon's pid file (else two schedulers double-fire every routine).
//  - A start that produced no OS pid must fail loudly, never surface null.
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
      // This process stands in for stopDaemon() while it owns the lifecycle
      // lock through teardown. The child drives the real claim implementation.
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
        // Pre-fix claimDaemonInstance returned false and this child exited while
        // stop still held the lock, guaranteeing no replacement after teardown.
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
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it('startDetached fails loudly instead of returning a null PID when the binary is unspawnable', () => {
    // A non-JS entry is spawned directly (getDaemonLaunch), so a missing binary
    // makes spawn() yield an undefined pid — the exact `child.pid || null`
    // footgun. Pre-fix this returned { pid: null }; now it throws.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-null-'));
    const logPath = path.join(tmpDir, 'stdio.log');
    expect(() =>
      startDetached({ agentsBin: '/nonexistent/agents-cli-does-not-exist', logPath }),
    ).toThrow(/no PID/i);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('last-wins takeover (RUSH-2352): a second daemon evicts the incumbent and becomes the sole owner', async () => {
    // CI builds before tests; self-heal for a bare `vitest` run.
    if (!fs.existsSync(DIST_ENTRY)) {
      execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'ignore' });
    }

    // Short POSIX base keeps the daemon's AF_UNIX browser socket under the
    // 104-byte sun_path cap.
    const tmpRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
    const tmpHome = fs.mkdtempSync(path.join(tmpRoot, 'agd-si-'));
    // Satisfy the setup gate (`ensureInitialized`): ~/.agents/.system must be a repo.
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
      // Daemon A comes up and records itself as the pid-file owner.
      pidA = startDetached({ agentsBin: DIST_ENTRY, logPath: path.join(tmpHome, 'a.log'), env: childEnv }).pid!;
      expect(pidA).toBeTruthy();
      expect(await waitFor(() => readPid() === pidA, 20_000)).toBe(true);

      // Daemon B — a second `__daemon-run` — must EVICT A (last-wins), not defer.
      // claimDaemonInstance SIGTERMs A, waits for its graceful shutdown to
      // release its broker socket + browser IPC, then binds and writes its own
      // pid. Exactly one daemon is ever alive.
      pidB = startDetached({ agentsBin: DIST_ENTRY, logPath: path.join(tmpHome, 'b.log'), env: childEnv }).pid!;
      expect(pidB).toBeTruthy();
      expect(pidB).not.toBe(pidA);

      // A is evicted and gone; B owns the pid file and keeps running.
      expect(await waitFor(() => !alive(pidA!), 20_000)).toBe(true);
      expect(await waitFor(() => readPid() === pidB, 20_000)).toBe(true);
      expect(alive(pidB)).toBe(true);
    } finally {
      for (const p of [pidA, pidB]) { try { if (p) process.kill(p, 'SIGKILL'); } catch { /* already gone */ } }
      // SIGKILL is async: the kernel delivers it but the daemon can still be
      // mid-write into tmpHome/.agents when we start removing it. Reap both PIDs
      // first, then retry rmSync — otherwise a write landing during the tree walk
      // makes rmdir throw ENOTEMPTY (flaky teardown, unrelated to the assertions).
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

  // THE CRITICAL REGRESSION TEST (RUSH-2352 correction). The refuted premise of
  // this ticket's original version was that several `__daemon-run` processes on
  // one box proved cross-install duplicate schedulers — when in fact three of the
  // four ran under separate HOMEs (leaked vitest fixtures) and never shared state.
  // A last-wins takeover that widened its blast radius to "every daemon on the
  // box" would make that misreading real: it would start SIGTERMing genuinely
  // separate daemons. This proves the opposite — a daemon serving its OWN state
  // dir is never a takeover or reap target, no matter what else runs on the box.
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
        // Daemon C — a completely separate state dir, standing in for a
        // developer's own live daemon or another test's leaked fixture (the real
        // shape behind the refuted premise). Started first and ticking through
        // the whole A/B takeover below.
        pidC = startDetached({ agentsBin: DIST_ENTRY, logPath: path.join(tmpHomeC, 'c.log'), env: envFor(tmpHomeC) }).pid!;
        expect(pidC).toBeTruthy();
        expect(await waitFor(() => readPid(tmpHomeC) === pidC, 20_000)).toBe(true);

        // Daemon A, then B — last-wins takeover within their OWN (different from
        // C's) state dir, exactly like the LAST-WINS test above.
        pidA = startDetached({ agentsBin: DIST_ENTRY, logPath: path.join(tmpHomeAB, 'a.log'), env: envFor(tmpHomeAB) }).pid!;
        expect(pidA).toBeTruthy();
        expect(await waitFor(() => readPid(tmpHomeAB) === pidA, 20_000)).toBe(true);

        pidB = startDetached({ agentsBin: DIST_ENTRY, logPath: path.join(tmpHomeAB, 'b.log'), env: envFor(tmpHomeAB) }).pid!;
        expect(pidB).toBeTruthy();
        expect(await waitFor(() => !alive(pidA!), 20_000)).toBe(true);
        expect(await waitFor(() => readPid(tmpHomeAB) === pidB, 20_000)).toBe(true);

        // C — a different state dir entirely — was never a candidate for either
        // claimDaemonInstance's eviction or B's post-claim reapStrayDaemons()
        // sweep: its pid file and its process are both intact throughout.
        expect(readPid(tmpHomeC)).toBe(pidC);
        expect(alive(pidC)).toBe(true);
      } finally {
        for (const p of [pidA, pidB, pidC]) { try { if (p) process.kill(p, 'SIGKILL'); } catch { /* already gone */ } }
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

/**
 * Self-terminate guard (RUSH-2367). A real daemon whose own state dir
 * disappears out from under it — the exact shape of a leaked test fixture
 * whose /tmp HOME got removed while the process itself somehow survived — has
 * no other way to be reached: a different HOME resolves a different
 * getDaemonDir() and therefore a different instance registry, so no `agents
 * daemon` command, reaper, or takeover can ever see it. Real path: spawns the
 * actual built CLI, deletes its HOME while it is running, and asserts the
 * process exits on its own within a bounded time — no mocking of the check.
 */
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
        // Poll every 300ms instead of the 60s production default so the test
        // does not need to wait a full minute for the guard to fire.
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

        // Removing the lifetime marker is the durable effect of deleting and
        // recreating the state tree, without racing live heartbeat writes during
        // recursive removal. Keep the canonical directory present so the old
        // existsSync(dir) guard would stay alive; only the token guard can exit.
        fs.unlinkSync(lifetimeFile);
        expect(fs.existsSync(stateDir)).toBe(true);
        expect(fs.existsSync(lifetimeFile)).toBe(false);

        // The guard polls every 300ms above; give it several cycles of margin.
        expect(await waitFor(() => !alive(pid!), 10_000)).toBe(true);
      } finally {
        if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
        if (pid) await waitFor(() => !alive(pid!), 5_000);
        try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* already gone */ }
      }
    },
    30_000,
  );
});

/**
 * Test-home tripwire (PHNX-2545). The pure guard, plus a REAL boot: a daemon
 * whose AGENTS_DAEMON_TEST_HOME marker names a home that does NOT contain its
 * resolved state dir — the shape of a test spawn whose isolated HOME override
 * failed to reach the child — must refuse to start rather than schedule its
 * scheduler/watchdog against the operator's real host.
 */
describe('daemon test-home tripwire (PHNX-2545)', () => {
  it('no-op when the marker is unset (production)', () => {
    expect(() => assertTestDaemonHome('/anywhere/.agents/.cache/helpers/daemon', undefined)).not.toThrow();
  });

  it('passes when the daemon dir sits under the marked test home', () => {
    const home = '/tmp/agents-routines-add-abc';
    const dir = path.join(home, '.agents', '.cache', 'helpers', 'daemon');
    expect(() => assertTestDaemonHome(dir, home)).not.toThrow();
    // The home itself as the dir is degenerate-but-under, still allowed.
    expect(() => assertTestDaemonHome(home, home)).not.toThrow();
  });

  it('throws when the daemon dir escapes the marked test home', () => {
    const testHome = '/tmp/agents-routines-add-abc';
    const realDir = path.join(os.homedir(), '.agents', '.cache', 'helpers', 'daemon');
    expect(() => assertTestDaemonHome(realDir, testHome)).toThrow(/test-home tripwire/i);
    // A sibling prefix must not satisfy the startsWith check (path.sep boundary).
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
        // Marker names a DIFFERENT home than the one HOME resolves the state dir
        // under — the tripwire must fire and the daemon must never come up.
        AGENTS_DAEMON_TEST_HOME: otherHome,
      };
      delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;

      let pid: number | null = null;
      try {
        pid = startDetached({ agentsBin: DIST_ENTRY, logPath: path.join(tmpHome, 'daemon.log'), env: childEnv }).pid!;
        expect(pid).toBeTruthy();
        // It aborts at boot: the process dies quickly and never writes its pid file.
        expect(await waitFor(() => !alive(pid!), 15_000)).toBe(true);
        expect(fs.existsSync(pidFile)).toBe(false);
      } finally {
        if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
        if (pid) await waitFor(() => !alive(pid!), 5_000);
        try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* already gone */ }
        try { fs.rmSync(otherHome, { recursive: true, force: true }); } catch { /* already gone */ }
      }
    },
    30_000,
  );
});
