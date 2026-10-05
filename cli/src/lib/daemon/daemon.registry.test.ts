
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawn, spawnSync } from 'child_process';
import {
  startDaemon,
  ensureDaemonStarted,
  isDaemonRunning,
  readDaemonPid,
  writeDaemonPid,
  removeDaemonPid,
  isDaemonAutostartCircuitOpen,
  DAEMON_AUTOSTART_FAILURE_LIMIT,
  schedulerGateTransition,
  anchorDaemonCwd,
  describeEphemeralDaemonRoot,
  warnEphemeralDaemonRoot,
  validateDaemonBinary,
  registerDaemonInstance,
  unregisterDaemonInstance,
  reapStrayDaemons,
  stopResidueArtifacts,
} from './daemon.js';
import { getDaemonDir } from '../state.js';
import { readSubsystemHealth, recordSubsystemOk, SUBSYSTEM_DAEMON_START } from '../daemon-health.js';
import { DIST_ENTRY, REPO_ROOT, installKeychainHermeticity } from './daemon.test-fixture.js';

installKeychainHermeticity();

async function spawnDaemonStandIn(): Promise<ReturnType<typeof spawn>> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)', '__daemon-run'], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(child.pid).toBeTruthy();
  return child;
}

describe('stopResidueArtifacts (RUSH-2421: reclaim only what a DEAD owner left)', () => {
  let dir = '';
  let prev: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'agd-res-'));
    prev = process.env.AGENTS_DAEMON_DIR;
    process.env.AGENTS_DAEMON_DIR = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.AGENTS_DAEMON_DIR;
    else process.env.AGENTS_DAEMON_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const artifact = (pid: number | null, label: string, survivors: number[] = []) =>
    stopResidueArtifacts(pid, survivors).find((a) => a.label === label)!;

  const seedMarker = (pid: number) => {
    const markerPath = path.join(dir, 'instances', String(pid));
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, 'node ... __daemon-run');
    return markerPath;
  };

  it.skipIf(process.platform === 'win32')('keeps the entry of a daemon the survivor scan still sees', () => {
    const markerPath = seedMarker(4242);
    const entry = artifact(4242, 'daemon instance registry entry', [4242]);
    expect(entry.present).toBe(true);
    expect(entry.ownedByLiveOther).toBe(true);
    expect(fs.existsSync(markerPath)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('reclaims the entry of a daemon that did not survive', () => {
    const markerPath = seedMarker(4242);
    const entry = artifact(4242, 'daemon instance registry entry', []);
    expect(entry.present).toBe(true);
    expect(entry.ownedByLiveOther).toBe(false);
    entry.reclaim();
    expect(entry.stillPresent()).toBe(false);
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it('keeps lifetime and heartbeat state when the stopped daemon still survives', () => {
    const pid = 4242;
    const lifetimePath = path.join(dir, 'daemon.lifetime');
    const heartbeatPath = path.join(dir, 'heartbeat.json');
    fs.writeFileSync(lifetimePath, `${pid}:${Date.now()}`);
    fs.writeFileSync(heartbeatPath, JSON.stringify({ lastTick: new Date().toISOString(), pid }));

    const lifetime = artifact(pid, 'daemon lifetime marker', [pid]);
    const heartbeat = artifact(pid, 'daemon heartbeat', [pid]);
    expect(lifetime.ownedByLiveOther).toBe(true);
    expect(heartbeat.ownedByLiveOther).toBe(true);
    expect(fs.existsSync(lifetimePath)).toBe(true);
    expect(fs.existsSync(heartbeatPath)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('treats a ZOMBIE stopped daemon as dead, not alive', () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    const pid = child.pid!;
    child.kill('SIGKILL');
    const deadline = Date.now() + 5_000;
    let zombie = false;
    while (Date.now() < deadline && !zombie) {
      try {
        process.kill(pid, 0);
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
        zombie = / Z /.test(stat) || stat.includes(') Z ');
      } catch { break; }
    }
    if (!zombie) return;
    expect(() => process.kill(pid, 0)).not.toThrow();

    const markerPath = seedMarker(pid);
    const entry = artifact(pid, 'daemon instance registry entry', []);
    expect(entry.ownedByLiveOther).toBe(false);
    entry.reclaim();
    expect(fs.existsSync(markerPath)).toBe(false);
  });
});

describe('ensureDaemonStarted (#415: always-on beyond routines)', () => {
  let priorPid: number | null = null;

  beforeEach(() => { priorPid = readDaemonPid(); });
  afterEach(() => {
    if (priorPid === null) removeDaemonPid();
    else writeDaemonPid(priorPid);
  });

  it('is an idempotent no-op when a daemon is already running', async () => {
    const daemon = await spawnDaemonStandIn();
    writeDaemonPid(daemon.pid!);
    expect(isDaemonRunning()).toBe(true);

    try {
      const first = ensureDaemonStarted();
      expect(first).not.toBeNull();
      expect(first!.method).toBe('already-running');
      expect(first!.pid).toBe(daemon.pid);

      const second = ensureDaemonStarted();
      expect(second!.method).toBe('already-running');
      expect(second!.pid).toBe(daemon.pid);

      expect(readDaemonPid()).toBe(daemon.pid);
    } finally {
      daemon.kill('SIGKILL');
    }
  });

  it('refuses to LAUNCH under a redirected HOME (no seam), while reporting stays allowed', async () => {
    const savedSeam = process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME;
    const daemon = await spawnDaemonStandIn();
    delete process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME;
    try {
      removeDaemonPid();
      expect(isDaemonRunning()).toBe(false);
      expect(ensureDaemonStarted()).toBeNull();
      expect(readDaemonPid()).toBeNull();

      writeDaemonPid(daemon.pid!);
      expect(ensureDaemonStarted()?.method).toBe('already-running');
    } finally {
      daemon.kill('SIGKILL');
      if (savedSeam === undefined) delete process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME;
      else process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME = savedSeam;
    }
  });
});

describe('redirected-HOME launch guard (W4, PHNX-3736)', () => {
  const BAD_BIN = '/nonexistent/agents-cli-does-not-exist';
  let saved: string | undefined;

  beforeEach(() => { saved = process.env.AGENTS_ALLOW_TEST_DAEMON; });
  afterEach(() => {
    if (saved === undefined) delete process.env.AGENTS_ALLOW_TEST_DAEMON;
    else process.env.AGENTS_ALLOW_TEST_DAEMON = saved;
  });

  it('startDaemon refuses under a redirected HOME without AGENTS_ALLOW_TEST_DAEMON', () => {
    delete process.env.AGENTS_ALLOW_TEST_DAEMON;
    removeDaemonPid();
    let caught: any = null;
    try {
      startDaemon();
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught.name).toBe('RedirectedHomeDaemonError');
    expect(caught.message).toMatch(/redirected HOME/);
    expect(caught.message).toMatch(/AGENTS_ALLOW_TEST_DAEMON/);
    expect(readDaemonPid()).toBeNull();
  });

  it('AGENTS_ALLOW_TEST_DAEMON=1 lets the launch through to the real outcome', () => {
    process.env.AGENTS_ALLOW_TEST_DAEMON = '1';
    removeDaemonPid();
    expect(() => startDaemon(BAD_BIN)).toThrow(/no PID/i);
  });

  it('an already-running daemon is still reported under a redirected HOME (stop stays possible)', async () => {
    delete process.env.AGENTS_ALLOW_TEST_DAEMON;
    const daemon = await spawnDaemonStandIn();
    try {
      writeDaemonPid(daemon.pid!);
      expect(startDaemon().method).toBe('already-running');
    } finally {
      daemon.kill('SIGKILL');
      removeDaemonPid();
    }
  });
});

describe('daemon auto-start circuit breaker (RUSH-2418)', () => {
  let tmpHome = '';
  const saved: Record<string, string | undefined> = {};
  const BAD_BIN = '/nonexistent/agents-cli-does-not-exist';

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'agd-2418-'));
    for (const k of ['HOME', 'PATH', 'AGENTS_DAEMON_DIR', 'AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME', 'AGENTS_ALLOW_TEST_DAEMON']) saved[k] = process.env[k];
    process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME = '1';
    process.env.AGENTS_ALLOW_TEST_DAEMON = '1';

    const shimDir = path.join(tmpHome, 'bin');
    fs.mkdirSync(shimDir, { recursive: true });
    for (const name of ['systemctl', 'launchctl']) {
      const p = path.join(shimDir, name);
      fs.writeFileSync(p, '#!/bin/sh\nexit 1\n', 'utf-8');
      fs.chmodSync(p, 0o755);
    }

    process.env.HOME = tmpHome;
    process.env.AGENTS_DAEMON_DIR = path.join(tmpHome, 'daemon');
    process.env.PATH = `${shimDir}${path.delimiter}${saved.PATH ?? ''}`;
    fs.mkdirSync(process.env.AGENTS_DAEMON_DIR, { recursive: true });
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')(
    'counts a daemon that spawns successfully and then dies — not just an unspawnable binary',
    () => {
      const dyingBin = path.join(tmpHome, 'dying-daemon.js');
      fs.writeFileSync(dyingBin, 'process.exit(0);\n', 'utf-8');

      for (let i = 1; i <= DAEMON_AUTOSTART_FAILURE_LIMIT; i++) {
        const res = startDaemon(dyingBin);
        expect(res.pid).toBeTruthy();
        expect(readSubsystemHealth(SUBSYSTEM_DAEMON_START)?.consecutiveFailures).toBe(i);
      }
      expect(isDaemonAutostartCircuitOpen()).toBe(true);
      expect(ensureDaemonStarted()).toBeNull();
    },
    30_000,
  );

  it.skipIf(process.platform === 'win32')(
    'opens after N consecutive failed starts, and the explicit override is still allowed',
    async () => {
      expect(isDaemonAutostartCircuitOpen()).toBe(false);

      for (let i = 1; i <= DAEMON_AUTOSTART_FAILURE_LIMIT; i++) {
        expect(() => startDaemon(BAD_BIN)).toThrow(/no PID/i);
        expect(readSubsystemHealth(SUBSYSTEM_DAEMON_START)?.consecutiveFailures).toBe(i);
      }
      expect(isDaemonAutostartCircuitOpen()).toBe(true);

      const warnings: string[] = [];
      const realWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: any, ...rest: any[]) => {
        warnings.push(String(chunk));
        return (realWrite as any)(chunk, ...rest);
      }) as typeof process.stderr.write;
      try {
        expect(ensureDaemonStarted()).toBeNull();
      } finally {
        process.stderr.write = realWrite;
      }
      expect(warnings.join('')).toMatch(/agents daemon doctor/);

      expect(() => startDaemon(BAD_BIN)).toThrow(/no PID/i);

      const daemon = await spawnDaemonStandIn();
      try {
        writeDaemonPid(daemon.pid!);
        expect(ensureDaemonStarted()?.method).toBe('already-running');
        removeDaemonPid();
      } finally {
        daemon.kill('SIGKILL');
      }

      recordSubsystemOk(SUBSYSTEM_DAEMON_START);
      expect(isDaemonAutostartCircuitOpen()).toBe(false);
    },
    30_000,
  );

  it.skipIf(process.platform === 'win32')(
    'a startup failure exits non-zero with a named reason instead of a raw stack',
    async () => {
      if (!fs.existsSync(DIST_ENTRY)) {
        execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'ignore' });
      }
      const notADir = path.join(tmpHome, 'daemon-dir-is-a-file');
      fs.writeFileSync(notADir, 'not a directory', 'utf-8');

      const env = { ...process.env, HOME: tmpHome, AGENTS_DAEMON_DIR: notADir };
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
      const run = spawnSync(process.execPath, [DIST_ENTRY, '__daemon-run'], {
        env, encoding: 'utf-8', timeout: 30_000,
      });

      expect(run.status).toBe(1);
      expect(`${run.stderr}${run.stdout}`).toMatch(/daemon (startup failure|uncaughtException)/);
    },
    45_000,
  );
});

describe('anchorDaemonCwd', () => {
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
  });

  afterEach(() => {
    try {
      process.chdir(originalCwd);
    } catch {
      process.chdir(os.homedir());
    }
  });

  it.skipIf(process.platform === 'win32')('recovers a deleted working directory by anchoring to home', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-cwd-'));
    const realTmp = fs.realpathSync(tmp);
    process.chdir(realTmp);
    fs.rmSync(realTmp, { recursive: true, force: true });

    let cwdBroken = false;
    try {
      process.cwd();
    } catch {
      cwdBroken = true;
    }
    expect(cwdBroken).toBe(true);

    const resolved = anchorDaemonCwd();
    expect(resolved).toBe(os.homedir());
    expect(fs.realpathSync(process.cwd())).toBe(fs.realpathSync(os.homedir()));
  });

  it('anchors to home even when launched from an unrelated valid directory', () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-cwd-')));
    try {
      process.chdir(tmp);
      const resolved = anchorDaemonCwd();
      expect(resolved).toBe(os.homedir());
      expect(fs.realpathSync(process.cwd())).toBe(fs.realpathSync(os.homedir()));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('describeEphemeralDaemonRoot', () => {
  it('flags a git worktree entry', () => {
    expect(describeEphemeralDaemonRoot('/home/u/.agents/worktrees/rv/cli/src/index.ts')).toBe('a git worktree');
  });

  it('flags /tmp and /private/tmp entries (the /tmp/rv-head case)', () => {
    expect(describeEphemeralDaemonRoot('/tmp/rv-head/cli/src/index.ts')).toBe('a temporary directory');
    expect(describeEphemeralDaemonRoot('/private/tmp/rv-head/cli/src/index.ts')).toBe('a temporary directory');
  });

  it('flags macOS /var/folders and linux /dev/shm entries', () => {
    expect(describeEphemeralDaemonRoot('/var/folders/xy/abc/T/build/index.js')).toBe('a temporary directory');
    expect(describeEphemeralDaemonRoot('/private/var/folders/xy/abc/T/build/index.js')).toBe('a temporary directory');
    expect(describeEphemeralDaemonRoot('/dev/shm/build/index.js')).toBe('a temporary directory');
  });

  it('returns null for stable install roots and normal checkouts', () => {
    expect(describeEphemeralDaemonRoot('/home/u/.agents/.history/versions/agents/1.20.88/node_modules/@phnx-labs/agents-cli/dist/index.js')).toBeNull();
    expect(describeEphemeralDaemonRoot('/opt/homebrew/lib/node_modules/@phnx-labs/agents-cli/dist/index.js')).toBeNull();
    expect(describeEphemeralDaemonRoot('/home/u/src/github.com/x/agents-cli/cli/src/index.ts')).toBeNull();
    expect(describeEphemeralDaemonRoot('/home/u/tmp/agents-cli/dist/index.js')).toBeNull();
  });
});

describe('warnEphemeralDaemonRoot', () => {
  it('warns for an ephemeral launch root (the /tmp/rv-head case)', () => {
    const msg = warnEphemeralDaemonRoot(() => '/tmp/rv-head/cli/src/index.ts');
    expect(msg).not.toBeNull();
    expect(msg).toContain('a temporary directory');
    expect(msg).toContain('/tmp/rv-head/cli/src/index.ts');
  });

  it('stays silent for a stable version-home launch root', () => {
    expect(
      warnEphemeralDaemonRoot(() => '/home/u/.agents/.history/versions/agents/1.20.88/dist/index.js'),
    ).toBeNull();
  });

  it('is non-fatal when the bin resolver throws', () => {
    let result: string | null = 'sentinel';
    expect(() => {
      result = warnEphemeralDaemonRoot(() => {
        throw new Error('no main CLI entry');
      });
    }).not.toThrow();
    expect(result).toBeNull();
  });

  it('does not throw when resolving the real launch binary', () => {
    expect(() => warnEphemeralDaemonRoot()).not.toThrow();
  });
});

describe('validateDaemonBinary (ephemeral-root warning)', () => {
  it('warns when the daemon binary is under /tmp', () => {
    const { warnings } = validateDaemonBinary('/tmp/rv-head/cli/src/index.ts');
    expect(warnings.some((w) => w.includes('a temporary directory'))).toBe(true);
  });

  it('warns when the daemon binary is inside a git worktree', () => {
    const { warnings } = validateDaemonBinary('/home/u/.agents/worktrees/rv/cli/src/index.ts');
    expect(warnings.some((w) => w.includes('a git worktree'))).toBe(true);
  });

  it('does not emit a wedge warning for a version-home install', () => {
    const { warnings } = validateDaemonBinary('/home/u/.agents/.history/versions/agents/1.20.88/dist/index.js');
    expect(warnings.some((w) => /worktree|temporary directory/.test(w))).toBe(false);
  });
});

describe('schedulerGateTransition (scheduler.enabled re-evaluated on SIGHUP)', () => {
  it('boots the scheduler when the gate flipped on while the daemon ran scheduler-less', () => {
    expect(schedulerGateTransition(false, true)).toBe('boot');
  });

  it('stops a running scheduler when the gate flipped off', () => {
    expect(schedulerGateTransition(true, false)).toBe('stop');
  });

  it('reloads a running scheduler when the gate is unchanged', () => {
    expect(schedulerGateTransition(true, true)).toBe('reload');
  });

  it('stays dark when the gate is off and nothing runs', () => {
    expect(schedulerGateTransition(false, false)).toBe('none');
  });
});

describe.skipIf(process.platform === 'win32')(
  'daemon instance registry — one daemon per device, whatever the launch entry',
  () => {
    const instancesDir = (): string => path.join(getDaemonDir(), 'instances');
    const isChildAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const spawned: Array<ReturnType<typeof spawn>> = [];

    afterEach(() => {
      for (const c of spawned) {
        try {
          c.kill('SIGKILL');
        } catch {
        }
      }
      spawned.length = 0;
      try {
        fs.rmSync(instancesDir(), { recursive: true, force: true });
      } catch {
      }
    });

    it('registerDaemonInstance writes a pid marker; unregister removes it', () => {
      registerDaemonInstance(4242);
      expect(fs.existsSync(path.join(instancesDir(), '4242'))).toBe(true);
      unregisterDaemonInstance(4242);
      expect(fs.existsSync(path.join(instancesDir(), '4242'))).toBe(false);
    });

    it('reaps a live __daemon-run registrant that is neither self nor the pid-file owner', async () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)', '__daemon-run'], {
        stdio: 'ignore',
      });
      spawned.push(child);
      await new Promise((r) => setTimeout(r, 150));
      expect(child.pid).toBeDefined();
      registerDaemonInstance(child.pid!);

      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      const result = reapStrayDaemons();
      expect(result.reaped).toBe(1);
      expect(fs.existsSync(path.join(instancesDir(), String(child.pid)))).toBe(false);
      await Promise.race([
        exited,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('reaper returned before daemon death')), 2_000)),
      ]);
      expect(isChildAlive(child.pid!)).toBe(false);
    });

    it('waits for a wedged stray to die, escalates, then removes its marker', async () => {
      const child = spawn(
        process.execPath,
        ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1e9);", '__daemon-run'],
        { stdio: 'ignore' },
      );
      spawned.push(child);
      await new Promise((r) => setTimeout(r, 150));
      expect(child.pid).toBeDefined();
      registerDaemonInstance(child.pid!);
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));

      const started = Date.now();
      const result = reapStrayDaemons();
      const elapsed = Date.now() - started;

      expect(elapsed).toBeGreaterThan(4_000);
      expect(result.reaped).toBe(1);
      expect(result.details).toContain(`reaped stray daemon pid ${child.pid} (escalated)`);
      expect(fs.existsSync(path.join(instancesDir(), String(child.pid)))).toBe(false);
      await Promise.race([
        exited,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('escalated reaper returned before daemon death')), 2_000)),
      ]);
      expect(isChildAlive(child.pid!)).toBe(false);
    }, 15_000);

    it('never kills a live pid that is NOT a daemon (pid-reuse guard); only drops the stale marker', async () => {
      const child = spawn('sleep', ['30'], { stdio: 'ignore' });
      spawned.push(child);
      await new Promise((r) => setTimeout(r, 150));
      registerDaemonInstance(child.pid!);

      const result = reapStrayDaemons();
      expect(result.reaped).toBe(0);
      expect(fs.existsSync(path.join(instancesDir(), String(child.pid)))).toBe(false);
      expect(isChildAlive(child.pid!)).toBe(true);
    });

    it('garbage-collects a marker whose pid is dead, reaping nothing', () => {
      const deadPid = 2147483000 + (process.pid % 1000);
      registerDaemonInstance(deadPid);
      const result = reapStrayDaemons();
      expect(result.reaped).toBe(0);
      expect(fs.existsSync(path.join(instancesDir(), String(deadPid)))).toBe(false);
    });

    it('never reaps this process, even when it is registered', () => {
      registerDaemonInstance(process.pid);
      const result = reapStrayDaemons();
      expect(result.details.some((d) => d.includes(String(process.pid)))).toBe(false);
      expect(isChildAlive(process.pid)).toBe(true);
      unregisterDaemonInstance(process.pid);
    });
  },
);
