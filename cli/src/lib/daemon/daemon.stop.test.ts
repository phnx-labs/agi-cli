/** Daemon shutdown semantics: the singleShot guard and `agents daemon stop`'s postcondition
 * contract. The heaviest slice (~18s: wedge/killTree tests each wait out a real 5s SIGTERM grace),
 * split from daemon.test.ts (RUSH-2819) into its own fork. */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as net from 'net';
import * as path from 'path';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { singleShot, startDetached } from './daemon.js';
import { ipcEndpoint } from '../platform/index.js';
import { DIST_ENTRY, REPO_ROOT, installKeychainHermeticity } from './daemon.test-fixture.js';

installKeychainHermeticity();

// RUSH-2423: shutdown must run at most once; it is reachable from SIGTERM, SIGINT and the
// state-dir self-check, and two can arrive together. It was only incidentally safe because each
// step is idempotent. Tested at the mechanism: an e2e test passed with the guard removed.
describe('singleShot (RUSH-2423: shutdown runs at most once)', () => {
  it('runs the body once no matter how many callers fire it', async () => {
    let runs = 0;
    const once = singleShot(async () => { runs++; });
    await once();
    await once();
    await once();
    expect(runs).toBe(1);
  });

  it('excludes a caller that arrives in the SAME tick, before the first await', async () => {
    // The real shape: two signal handlers firing back to back. The flag has to be
    // set synchronously, or both get past it and the body runs twice.
    let runs = 0;
    const once = singleShot(async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 20));
    });
    await Promise.all([once(), once(), once()]);
    expect(runs).toBe(1);
  });

  it('does not swallow the first caller\'s failure', async () => {
    const once = singleShot(async () => { throw new Error('shutdown blew up'); });
    await expect(once()).rejects.toThrow('shutdown blew up');
  });
});

// KNOWN GAP (RUSH-2423): the win32 `skipIf` blocks leave the daemon's Windows behaviour
// (taskkill/`killTree` stop, named-pipe release) with no coverage. Each skips for a real reason
// (`ps`, POSIX signals, AF_UNIX); closing it needs Windows equivalents and a Windows CI runner.
/** stopDaemon postcondition assertion (RUSH-2355 / SING-12), real path with no mocking: a genuine
 * `__daemon-run` or SIGTERM-ignoring process is stopped through the actual `agents daemon stop`
 * under its own HOME, so every path resolves in the temp state dir and no live daemon is touched. */
describe('agents daemon stop — asserts its postcondition (RUSH-2355)', () => {
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const waitFor = async (cond: () => boolean, timeoutMs: number) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (cond()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return cond();
  };
  const mkHome = () => {
    const home = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'agd-stop-'));
    const systemDir = path.join(home, '.agents', '.system');
    fs.mkdirSync(systemDir, { recursive: true });
    execFileSync('git', ['init', '-q', systemDir]);
    return home;
  };
  const daemonPidFile = (home: string) => path.join(home, '.agents', '.cache', 'helpers', 'daemon', 'daemon.pid');
  const readDaemonPidOf = (home: string) => {
    const p = daemonPidFile(home);
    return fs.existsSync(p) ? parseInt(fs.readFileSync(p, 'utf-8').trim(), 10) : null;
  };
  const envFor = (home: string) => {
    const env = { ...process.env, HOME: home };
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    delete env.AGENTS_DAEMON_DIR; // let it derive from HOME
    return env;
  };
  const runStop = (home: string, extraEnv: NodeJS.ProcessEnv = {}) => {
    const r = spawnSync(process.execPath, [DIST_ENTRY, 'daemon', 'stop', '--json'], {
      env: { ...envFor(home), ...extraEnv }, encoding: 'utf-8',
    });
    // The --json action prints only the result object to stdout; be tolerant of
    // any leading banner by slicing to the JSON braces.
    const out = r.stdout || '';
    const first = out.indexOf('{');
    const last = out.lastIndexOf('}');
    const parsed = first >= 0 && last > first ? JSON.parse(out.slice(first, last + 1)) : null;
    return { status: r.status, result: parsed, stdout: out, stderr: r.stderr || '' };
  };
  const parseStopResult = (out: string) => {
    const first = out.indexOf('{');
    const last = out.lastIndexOf('}');
    return first >= 0 && last > first ? JSON.parse(out.slice(first, last + 1)) : null;
  };
  const rmHome = async (home: string) => {
    for (let attempt = 0; ; attempt++) {
      try { fs.rmSync(home, { recursive: true, force: true }); break; }
      catch (err) { if (attempt >= 10) throw err; await new Promise((r) => setTimeout(r, 100)); }
    }
  };

  it.skipIf(process.platform === 'win32')(
    'never signals an unrelated live process from a reused/stale daemon pid',
    async () => {
      const home = mkHome();
      // The literal token appears inside the code argument, so the former
      // /__daemon-run/ substring probe would misidentify and kill this process.
      // A real daemon has the token as its final argv entry; this one does not.
      const innocent = spawn(process.execPath, ['-e', '/* __daemon-run */ setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
      try {
        expect(innocent.pid).toBeTruthy();
        const daemonDir = path.join(home, '.agents', '.cache', 'helpers', 'daemon');
        fs.mkdirSync(daemonDir, { recursive: true });
        fs.writeFileSync(daemonPidFile(home), String(innocent.pid));

        const { status, result } = runStop(home);

        expect(status).toBe(0);
        expect(result.stoppedPid).toBeNull();
        expect(alive(innocent.pid!)).toBe(true);
      } finally {
        try { innocent.kill('SIGKILL'); } catch { /* already gone */ }
        if (innocent.pid) await waitFor(() => !alive(innocent.pid!), 5_000);
        await rmHome(home);
      }
    },
    30_000,
  );

  it.skipIf(process.platform === 'win32')(
    'fails closed without deleting state when a live pid command cannot be inspected',
    async () => {
      const home = mkHome();
      const daemon = spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1e9)', '__daemon-run'],
        { stdio: 'ignore' },
      );
      try {
        expect(daemon.pid).toBeTruthy();
        const daemonDir = path.join(home, '.agents', '.cache', 'helpers', 'daemon');
        fs.mkdirSync(daemonDir, { recursive: true });
        fs.writeFileSync(daemonPidFile(home), String(daemon.pid));

        // An empty PATH makes the subprocess's real `ps` identity inspection unavailable. That
        // uncertainty must preserve the owner record and process rather than permit signaling or
        // cleanup.
        const emptyPath = path.join(home, 'empty-path');
        fs.mkdirSync(emptyPath);
        const { status, result } = runStop(home, { PATH: emptyPath });

        expect(status).toBe(1);
        expect(result.ok).toBe(false);
        expect(result.stoppedPid).toBeNull();
        expect(result.surviving).toContain(
          `daemon pid ${daemon.pid} is live but its __daemon-run identity could not be verified`,
        );
        expect(readDaemonPidOf(home)).toBe(daemon.pid);
        expect(alive(daemon.pid!)).toBe(true);
      } finally {
        try { daemon.kill('SIGKILL'); } catch { /* already gone */ }
        if (daemon.pid) await waitFor(() => !alive(daemon.pid!), 5_000);
        await rmHome(home);
      }
    },
    30_000,
  );

  it.skipIf(process.platform === 'win32')(
    'holds daemon.lock through teardown and never deletes a successor pid/socket inode',
    async () => {
      const home = mkHome();
      const daemonDir = path.join(home, '.agents', '.cache', 'helpers', 'daemon');
      const instancesDir = path.join(daemonDir, 'instances');
      const browserSock = path.join(home, '.agents', '.cache', 'helpers', 'browser', 'browser.sock');
      const incumbentSignaled = path.join(home, 'incumbent-signaled');
      fs.mkdirSync(instancesDir, { recursive: true });
      fs.mkdirSync(path.dirname(browserSock), { recursive: true });

      const socketDaemonScript = [
        "const fs = require('fs');",
        "const net = require('net');",
        "const sock = process.argv[1];",
        "try { fs.unlinkSync(sock); } catch {}",
        "net.createServer(() => {}).listen(sock);",
        "process.on('SIGTERM', () => { if (process.argv[2]) fs.writeFileSync(process.argv[2], 'received'); });",
        "setInterval(() => {}, 1000);",
      ].join(' ');
      const incumbent = spawn(process.execPath, ['-e', socketDaemonScript, browserSock, incumbentSignaled, '__daemon-run'], { stdio: 'ignore' });
      let successor: ReturnType<typeof spawn> | null = null;
      let stopper: ReturnType<typeof spawn> | null = null;
      try {
        expect(incumbent.pid).toBeTruthy();
        expect(await waitFor(() => fs.existsSync(browserSock), 5_000)).toBe(true);
        const incumbentSocket = fs.lstatSync(browserSock);
        fs.writeFileSync(daemonPidFile(home), String(incumbent.pid));
        fs.writeFileSync(path.join(instancesDir, String(incumbent.pid)), '__daemon-run');

        stopper = spawn(process.execPath, [DIST_ENTRY, 'daemon', 'stop', '--json'], {
          env: envFor(home), stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        stopper.stdout!.on('data', (chunk) => { stdout += chunk.toString(); });
        stopper.stderr!.on('data', (chunk) => { stderr += chunk.toString(); });
        expect(await waitFor(() => fs.existsSync(path.join(daemonDir, 'daemon.lock')), 5_000)).toBe(true);
        expect(await waitFor(() => fs.existsSync(incumbentSignaled), 5_000)).toBe(true);

        // A non-cooperating fresh daemon replaces both shared artifacts during stop's real SIGTERM
        // grace window. The lock excludes every production start; the replacement proves cleanup
        // is ownership-checked, not cooperation-based.
        successor = spawn(process.execPath, ['-e', socketDaemonScript, browserSock, '', '__daemon-run'], { stdio: 'ignore' });
        expect(successor.pid).toBeTruthy();
        expect(await waitFor(() => {
          try { return fs.lstatSync(browserSock).ino !== incumbentSocket.ino; } catch { return false; }
        }, 5_000)).toBe(true);
        fs.writeFileSync(daemonPidFile(home), String(successor.pid));
        fs.writeFileSync(path.join(instancesDir, String(successor.pid)), '__daemon-run');

        const exitCode = await new Promise<number | null>((resolve) => stopper!.once('close', resolve));
        const result = parseStopResult(stdout);
        expect(result, `stop output was not JSON: ${stdout}\n${stderr}`).toBeTruthy();
        expect(exitCode === 0 || exitCode === 1).toBe(true); // successor may be reported as a survivor
        expect(readDaemonPidOf(home)).toBe(successor.pid);
        expect(fs.existsSync(browserSock)).toBe(true);
        expect(fs.lstatSync(browserSock).ino).not.toBe(incumbentSocket.ino);
        expect(alive(successor.pid!)).toBe(true);
      } finally {
        for (const child of [stopper, incumbent, successor]) {
          try { if (child?.pid) child.kill('SIGKILL'); } catch { /* already gone */ }
        }
        for (const child of [stopper, incumbent, successor]) {
          if (child?.pid) await waitFor(() => !alive(child.pid!), 5_000);
        }
        await rmHome(home);
      }
    },
    45_000,
  );

  // (The former "daemon died mid-stop reclaims the stale browser.sock" test was
  // removed with PHNX-4101: the browser IPC socket left with the standalone
  // browser CLI, so the daemon no longer binds or reclaims it.)

  it.skipIf(process.platform === 'win32')(
    'clean stop: releases the daemon, exits 0, and REPORTS an in-flight detached child rather than killing it',
    async () => {
      if (!fs.existsSync(DIST_ENTRY)) execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'ignore' });
      const home = mkHome();
      let daemonPid: number | null = null;
      // A real detached routine child in its OWN process group — survives the
      // daemon's death and must be reported, never killed (SING-11a).
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
      child.unref();
      try {
        expect(child.pid).toBeTruthy();
        daemonPid = startDetached({ agentsBin: DIST_ENTRY, logPath: path.join(home, 'd.log'), env: envFor(home) }).pid!;
        expect(await waitFor(() => readDaemonPidOf(home) === daemonPid, 20_000)).toBe(true);

        // Seed a `running` run record pointing at the live detached child, under
        // this HOME's runs dir, so the stop's postcondition enumerates it.
        const runDir = path.join(home, '.agents', '.history', 'runs', 'testjob', 'run-1');
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({
          status: 'running', pid: child.pid, agent: 'claude',
          startedAt: new Date().toISOString(), spawnedAt: Date.now(),
        }));

        const { status, result } = runStop(home);
        expect(result).toBeTruthy();
        expect(result.ok).toBe(true);            // every resource released
        expect(status).toBe(0);                  // clean stop exits 0
        expect(result.stoppedPid).toBe(daemonPid);
        expect(result.surviving).toEqual([]);
        expect(result.released).toContain('daemon process');
        expect(result.detachedChildren).toContain(child.pid);

        // The daemon is gone; the detached child was reported, NOT killed.
        expect(await waitFor(() => !alive(daemonPid!), 10_000)).toBe(true);
        expect(alive(child.pid!)).toBe(true);
      } finally {
        try { if (child.pid) process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ }
        try { if (daemonPid) process.kill(daemonPid, 'SIGKILL'); } catch { /* gone */ }
        for (const p of [child.pid, daemonPid]) { if (p) await waitFor(() => !alive(p), 5_000); }
        await rmHome(home);
      }
    },
    60_000,
  );

  it.skipIf(process.platform === 'win32')(
    'wedged daemon: escalates past the grace window to killTree, then still verifies nothing survives',
    async () => {
      const home = mkHome();
      // A real process that IGNORES SIGTERM and reads as a `__daemon-run` (its
      // argv carries the token, so isLiveDaemon matches it) — the wedge the
      // grace→killTree escalation exists for.
      const wedge = spawn(
        process.execPath,
        ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);", '__daemon-run'],
        { detached: true, stdio: 'ignore' },
      );
      wedge.unref();
      try {
        expect(wedge.pid).toBeTruthy();
        // Register the wedge as this state dir's daemon (pid file + instance
        // marker), the way a real daemon would, so stop targets it.
        const daemonDir = path.join(home, '.agents', '.cache', 'helpers', 'daemon');
        fs.mkdirSync(path.join(daemonDir, 'instances'), { recursive: true });
        fs.writeFileSync(daemonPidFile(home), String(wedge.pid));
        fs.writeFileSync(path.join(daemonDir, 'instances', String(wedge.pid)), 'node -e ... __daemon-run');

        const started = Date.now();
        const { status, result } = runStop(home);
        const elapsed = Date.now() - started;

        expect(result).toBeTruthy();
        expect(result.escalated).toBe(true);           // SIGTERM ignored → killTree
        expect(elapsed).toBeGreaterThan(4000);         // it waited out the grace window
        expect(result.ok).toBe(true);                  // killTree got it; nothing survives
        expect(result.surviving).toEqual([]);
        expect(status).toBe(0);
        expect(await waitFor(() => !alive(wedge.pid!), 5_000)).toBe(true);
      } finally {
        try { if (wedge.pid) process.kill(wedge.pid, 'SIGKILL'); } catch { /* gone */ }
        if (wedge.pid) await waitFor(() => !alive(wedge.pid!), 5_000);
        await rmHome(home);
      }
    },
    60_000,
  );

  // RUSH-2421: the postcondition missed the three state files a graceful handleShutdown removes
  // (lifetime marker, heartbeat, registry entry). On the ESCALATED path they outlived the daemon
  // while stop reported `ok: true`; a leftover heartbeat re-adopts a dead daemon.
  it.skipIf(process.platform === 'win32')(
    'killTree path: reclaims the lifetime marker, heartbeat and registry entry the dead daemon left',
    async () => {
      const home = mkHome();
      const wedge = spawn(
        process.execPath,
        ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);", '__daemon-run'],
        { detached: true, stdio: 'ignore' },
      );
      wedge.unref();
      try {
        expect(wedge.pid).toBeTruthy();
        const daemonDir = path.join(home, '.agents', '.cache', 'helpers', 'daemon');
        fs.mkdirSync(path.join(daemonDir, 'instances'), { recursive: true });
        fs.writeFileSync(daemonPidFile(home), String(wedge.pid));
        fs.writeFileSync(path.join(daemonDir, 'instances', String(wedge.pid)), 'node -e ... __daemon-run');
        // Exactly what a live daemon writes: `<pid>:<epochMs>` and a fresh
        // heartbeat naming the same pid.
        const lifetimePath = path.join(daemonDir, 'daemon.lifetime');
        const heartbeatPath = path.join(daemonDir, 'heartbeat.json');
        fs.writeFileSync(lifetimePath, `${wedge.pid}:${Date.now()}`);
        fs.writeFileSync(heartbeatPath, JSON.stringify({ lastTick: new Date().toISOString(), pid: wedge.pid }));

        const { result } = runStop(home);

        expect(result.escalated).toBe(true);   // SIGTERM ignored → killTree, no handleShutdown
        expect(result.ok).toBe(true);
        expect(result.surviving).toEqual([]);
        // Every one of the three is reported AND actually gone from disk.
        expect(result.released).toContain('daemon lifetime marker (reclaimed)');
        expect(result.released).toContain('daemon heartbeat (reclaimed)');
        expect(result.released).toContain('daemon instance registry entry (reclaimed)');
        expect(fs.existsSync(lifetimePath)).toBe(false);
        expect(fs.existsSync(heartbeatPath)).toBe(false);
        expect(fs.existsSync(path.join(daemonDir, 'instances', String(wedge.pid)))).toBe(false);
      } finally {
        try { if (wedge.pid) process.kill(wedge.pid, 'SIGKILL'); } catch { /* gone */ }
        if (wedge.pid) await waitFor(() => !alive(wedge.pid!), 5_000);
        await rmHome(home);
      }
    },
    60_000,
  );

  // Reclaim only what a provably DEAD owner left: a successor started during the stop owns a
  // marker and heartbeat naming its live pid, and deleting them would break it (same reasoning as
  // the broker-socket branch).
  it.skipIf(process.platform === 'win32')(
    'never reclaims a lifetime marker or heartbeat owned by a LIVE daemon',
    async () => {
      const home = mkHome();
      // The daemon being stopped: a wedge that ignores SIGTERM.
      const wedge = spawn(
        process.execPath,
        ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);", '__daemon-run'],
        { detached: true, stdio: 'ignore' },
      );
      wedge.unref();
      // A different, genuinely live process standing in for a successor. It is
      // NOT a __daemon-run, so it is not a "surviving daemon" — only the owner
      // recorded in the two state files.
      const successor = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
      successor.unref();
      try {
        const daemonDir = path.join(home, '.agents', '.cache', 'helpers', 'daemon');
        fs.mkdirSync(path.join(daemonDir, 'instances'), { recursive: true });
        fs.writeFileSync(daemonPidFile(home), String(wedge.pid));
        const lifetimePath = path.join(daemonDir, 'daemon.lifetime');
        const heartbeatPath = path.join(daemonDir, 'heartbeat.json');
        fs.writeFileSync(lifetimePath, `${successor.pid}:${Date.now()}`);
        fs.writeFileSync(heartbeatPath, JSON.stringify({ lastTick: new Date().toISOString(), pid: successor.pid }));

        const { result } = runStop(home);

        expect(result.released).toContain('daemon lifetime marker (owned by a live daemon)');
        expect(result.released).toContain('daemon heartbeat (owned by a live daemon)');
        // The live owner's state is untouched — reclaiming it would be the bug.
        expect(fs.existsSync(lifetimePath)).toBe(true);
        expect(fs.existsSync(heartbeatPath)).toBe(true);
      } finally {
        for (const p of [wedge.pid, successor.pid]) {
          try { if (p) process.kill(p, 'SIGKILL'); } catch { /* gone */ }
        }
        for (const p of [wedge.pid, successor.pid]) { if (p) await waitFor(() => !alive(p), 5_000); }
        await rmHome(home);
      }
    },
    60_000,
  );

  // The regression the awaited close introduced (RUSH-2421 review): a socket client holds its
  // connection open and `net.Server.close()` waits for it. With the close bounded at the same 5s
  // as the SIGTERM grace, `stopDaemon` escalated to killTree mid-`stop()`.
  it.skipIf(process.platform === 'win32')(
    'graceful stop STAYS graceful when a socket client is holding a warm hub connection',
    async () => {
      if (!fs.existsSync(DIST_ENTRY)) execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'ignore' });
      const home = mkHome();
      let daemonPid: number | null = null;
      let held: net.Socket | null = null;
      try {
        daemonPid = startDetached({ agentsBin: DIST_ENTRY, logPath: path.join(home, 'd.log'), env: envFor(home) }).pid!;
        expect(await waitFor(() => readDaemonPidOf(home) === daemonPid, 20_000)).toBe(true);

        // Wait for the feed-stream hub to be accepting, then hold a real
        // connection open exactly as a warm reader does: send the mandatory
        // scope handshake so the hub keeps the connection instead of rejecting it.
        const sock = path.join(home, '.agents', '.cache', 'helpers', 'feed', 'feed-stream.sock');
        expect(await waitFor(() => fs.existsSync(sock), 20_000)).toBe(true);
        held = net.createConnection(ipcEndpoint(sock));
        await new Promise<void>((resolve, reject) => {
          held!.on('connect', () => resolve());
          held!.on('error', reject);
        });
        held.write(JSON.stringify({ v: 1, scope: 'local' }) + '\n');

        const started = Date.now();
        const { status, result } = runStop(home);
        const elapsed = Date.now() - started;

        // The deterministic assertion: the daemon must release and exit well inside the 5s grace
        // window. Pre-fix the close waited out the same 5s, so escalation was a coin flip;
        // asserting the margin pins it.
        expect(elapsed).toBeLessThan(4000);
        expect(result.escalated).toBe(false);
        expect(result.ok).toBe(true);
        expect(result.surviving).toEqual([]);
        expect(status).toBe(0);
        // A graceful exit ran handleShutdown, so there is no residue to reclaim
        // — every resource is reported plainly, none "(reclaimed)".
        expect(result.released.filter((r: string) => r.includes('(reclaimed)'))).toEqual([]);
        expect(await waitFor(() => !alive(daemonPid!), 10_000)).toBe(true);
      } finally {
        try { held?.destroy(); } catch { /* already closed */ }
        try { if (daemonPid) process.kill(daemonPid, 'SIGKILL'); } catch { /* gone */ }
        if (daemonPid) await waitFor(() => !alive(daemonPid!), 5_000);
        await rmHome(home);
      }
    },
    60_000,
  );

});
