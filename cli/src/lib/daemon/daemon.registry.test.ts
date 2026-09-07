/**
 * Daemon registry, auto-start circuit breaker, and misc daemon utilities:
 * stopResidueArtifacts, ensureDaemonStarted, the RUSH-2418 auto-start circuit
 * breaker, anchorDaemonCwd, the ephemeral-root detectors,
 * schedulerGateTransition, and the instance registry + reaper.
 *
 * RUSH-2819: split out of daemon.test.ts (2201 lines / 88 tests / ~112s in CI)
 * so vitest can parallelize this suite across worker forks. Shared helpers
 * live in daemon.test-fixture.ts; the manifest/plist/systemd tests live in
 * daemon.test.ts; spawn/single-instance/self-terminate tests live in
 * daemon.lifecycle.test.ts; shutdown semantics live in daemon.stop.test.ts.
 */

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

// The other half of the registry rule (RUSH-2421 review). The marker is named by
// pid, so it is unambiguously the stopped daemon's — but it is only RESIDUE once
// that daemon is DEAD. Deleting it while the process still lives erases the very
// record `findSurvivingStateDirDaemons` enumerates, so the NEXT `agents daemon
// stop` finds an empty registry and a cleared pid file and reports `ok: true`
// with the daemon still running.
//
// Tested against the enumerator directly rather than through `agents daemon
// stop`: driving the whole command would require a pid that survives SIGKILL,
// which nothing does, and pointing it at a live pid we control would SIGTERM the
// test runner itself.
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
    // The caller's own postcondition scan says this daemon survived the kill.
    const entry = artifact(4242, 'daemon instance registry entry', [4242]);
    expect(entry.present).toBe(true);
    // The fix: a survivor is not residue. Reclaiming here erased the record the
    // NEXT stop reads, so it reported ok:true with the daemon still running.
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
    // A SIGKILLed child stays in the process table until its parent reaps it,
    // and kill(pid, 0) SUCCEEDS on a zombie — so an isAlive-keyed rule kept the
    // entry of a daemon that was already gone. The survivor scan, which matches
    // a live `__daemon-run`, does not include a zombie.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    const pid = child.pid!;
    child.kill('SIGKILL');
    // Do NOT await 'exit' — that reaps it. Poll until it is a zombie: still
    // signalable, but no longer a running process.
    const deadline = Date.now() + 5_000;
    let zombie = false;
    while (Date.now() < deadline && !zombie) {
      try {
        process.kill(pid, 0);
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
        zombie = / Z /.test(stat) || stat.includes(') Z ');
      } catch { break; }
    }
    if (!zombie) return; // /proc unavailable (macOS) — the assertion below is Linux-specific
    expect(() => process.kill(pid, 0)).not.toThrow(); // isAlive() would say "alive"

    const markerPath = seedMarker(pid);
    const entry = artifact(pid, 'daemon instance registry entry', []); // survivor scan: empty
    expect(entry.ownedByLiveOther).toBe(false);
    entry.reclaim();
    expect(fs.existsSync(markerPath)).toBe(false);
  });
});

/**
 * #415: the daemon must be always-on for any background need, not only after
 * `routines add`. `ensureDaemonStarted` is the shared side-effect entrypoint any
 * such background-need path calls. It must reuse the single `startDaemon`
 * entrypoint, so the #414 single-instance guard makes a second call a no-op
 * rather than a relaunch. The pid file names a real daemon-shaped process so
 * the production command-identity check is exercised rather than bypassed
 * with the test pid.
 */
describe('ensureDaemonStarted (#415: always-on beyond routines)', () => {
  let priorPid: number | null = null;

  beforeEach(() => { priorPid = readDaemonPid(); });
  afterEach(() => {
    // Leave any real daemon on this machine exactly as we found it.
    if (priorPid === null) removeDaemonPid();
    else writeDaemonPid(priorPid);
  });

  it('is an idempotent no-op when a daemon is already running', async () => {
    const daemon = await spawnDaemonStandIn();
    writeDaemonPid(daemon.pid!);
    expect(isDaemonRunning()).toBe(true);

    try {
      // First unlock brings the daemon "up" — but it's already running, so this
      // reports the existing owner without spawning a second process.
      const first = ensureDaemonStarted();
      expect(first).not.toBeNull();
      expect(first!.method).toBe('already-running');
      expect(first!.pid).toBe(daemon.pid);

      // A second unlock (or any later background trigger) is a steady-state
      // no-op, never a relaunch — the always-on guarantee, not a restart loop.
      const second = ensureDaemonStarted();
      expect(second!.method).toBe('already-running');
      expect(second!.pid).toBe(daemon.pid);

      // The pid file still points at the single owning process throughout.
      expect(readDaemonPid()).toBe(daemon.pid);
    } finally {
      daemon.kill('SIGKILL');
    }
  });

  // RUSH-3021: the vitest suite itself runs under a redirected HOME
  // (tests/setup.ts), which is exactly the state this gate keys on. Without
  // the gate, this call would attempt a real detached launch into the
  // sandbox HOME — the leaked child that outlives its test and races the
  // temp-home teardown rm (ENOTEMPTY; #2860's reviewer flagged the gap).
  // Fails on ungated code: startDaemon() would return a spawn attempt
  // (non-null) and write a pid file.
  it('refuses to LAUNCH under a redirected HOME (no seam), while reporting stays allowed', async () => {
    const savedSeam = process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME;
    const daemon = await spawnDaemonStandIn();
    delete process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME;
    try {
      removeDaemonPid();
      expect(isDaemonRunning()).toBe(false);
      expect(ensureDaemonStarted()).toBeNull();
      expect(readDaemonPid()).toBeNull();

      // Reporting an already-live daemon is untouched by the gate (the
      // already-running branch sits above it).
      writeDaemonPid(daemon.pid!);
      expect(ensureDaemonStarted()?.method).toBe('already-running');
    } finally {
      daemon.kill('SIGKILL');
      if (savedSeam === undefined) delete process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME;
      else process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME = savedSeam;
    }
  });
});

// RUSH-2418: `daemon-health.ts`'s `consecutiveFailures` was write-only telemetry
// — recorded, surfaced by `agents daemon status`, and consulted by nothing. So a
// daemon that died on boot was relaunched by EVERY foreground command that
// wanted one (secrets unlock, browser start, watchdog, ...): an application-level
// crash loop the OS supervisor's throttle cannot even see, because each attempt
// is a fresh service start rather than a respawn.
//
// This drives the REAL failure path — an unspawnable daemon binary, five times —
// and asserts the sixth AUTO-start refuses while the explicit override still
// runs.
describe('daemon auto-start circuit breaker (RUSH-2418)', () => {
  let tmpHome = '';
  const saved: Record<string, string | undefined> = {};
  const BAD_BIN = '/nonexistent/agents-cli-does-not-exist';

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'agd-2418-'));
    for (const k of ['HOME', 'PATH', 'AGENTS_DAEMON_DIR', 'AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME']) saved[k] = process.env[k];
    process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME = '1';

    // A service-manager shim that always fails, so every start deterministically
    // falls through to the detached spawn — which then fails on the missing
    // binary. No real launchd/systemd unit is ever touched.
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

  // THE case this breaker exists for, and the one an outcome-shaped check
  // cannot see: a daemon binary that SPAWNS FINE and then dies. `startDetached`
  // returns a real `child.pid`, so the launcher has no error to observe — the
  // first version of this fix counted only unspawnable binaries and let ten
  // consecutive crash-loop starts through with the breaker still closed.
  it.skipIf(process.platform === 'win32')(
    'counts a daemon that spawns successfully and then dies — not just an unspawnable binary',
    () => {
      // Exits 0 immediately: a perfectly spawnable binary that never becomes a
      // daemon, i.e. exactly a startup crash loop.
      const dyingBin = path.join(tmpHome, 'dying-daemon.js');
      fs.writeFileSync(dyingBin, 'process.exit(0);\n', 'utf-8');

      for (let i = 1; i <= DAEMON_AUTOSTART_FAILURE_LIMIT; i++) {
        const res = startDaemon(dyingBin);
        expect(res.pid).toBeTruthy(); // the spawn SUCCEEDS — nothing to catch
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
      // Nothing recorded yet — the breaker must start closed, or a healthy box
      // would never auto-start at all. (Asserted on the predicate rather than by
      // calling ensureDaemonStarted, which would spawn a real daemon here.)
      expect(isDaemonAutostartCircuitOpen()).toBe(false);

      // Each failed start bumps the streak. Loop from 1 so the assertion below
      // proves the counter tracks attempts rather than merely being non-zero.
      for (let i = 1; i <= DAEMON_AUTOSTART_FAILURE_LIMIT; i++) {
        expect(() => startDaemon(BAD_BIN)).toThrow(/no PID/i);
        expect(readSubsystemHealth(SUBSYSTEM_DAEMON_START)?.consecutiveFailures).toBe(i);
      }
      expect(isDaemonAutostartCircuitOpen()).toBe(true);

      // The point of the ticket: the next AUTO-start refuses instead of
      // re-entering the loop, and says where to look.
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

      // ...while `agents daemon start` — the operator's deliberate override —
      // is NOT gated: it still attempts, and still fails loudly on the real
      // cause rather than on the breaker.
      expect(() => startDaemon(BAD_BIN)).toThrow(/no PID/i);

      // An already-live daemon is still reported while the breaker is open — it
      // gates launching one, not answering "is one up?". Without this ordering a
      // stale streak would make a healthy daemon read as absent to every caller
      // that branches on the return value.
      const daemon = await spawnDaemonStandIn();
      try {
        writeDaemonPid(daemon.pid!);
        expect(ensureDaemonStarted()?.method).toBe('already-running');
        removeDaemonPid();
      } finally {
        daemon.kill('SIGKILL');
      }

      // A daemon that actually comes up clears the streak — runDaemon records
      // the success side only once it has claimed — so the breaker closes again.
      recordSubsystemOk(SUBSYSTEM_DAEMON_START);
      expect(isDaemonAutostartCircuitOpen()).toBe(false);
    },
    30_000,
  );

  // The third layer (RUSH-2418): `src/index.ts` awaited runDaemon() with no
  // try/catch and there was no `uncaughtException`/`unhandledRejection` handler
  // anywhere in cli/src, so a startup throw died on Node's default handler
  // — a raw stack to whatever the service manager had on stdout, nothing in
  // logs.jsonl, and an exit code that depended on how it died. Drive the real
  // `__daemon-run` entrypoint into a startup failure and assert it now exits
  // non-zero deterministically with a named reason.
  it.skipIf(process.platform === 'win32')(
    'a startup failure exits non-zero with a named reason instead of a raw stack',
    async () => {
      if (!fs.existsSync(DIST_ENTRY)) {
        execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'ignore' });
      }
      // A daemon dir that is a FILE: getDaemonDir()'s mkdirSync throws on the
      // first thing runDaemon does (claimDaemonInstance -> getLockPath).
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
    // The tests below chdir into temp dirs (some deleted); restore a valid cwd so
    // later tests and vitest teardown aren't left standing in a dead directory.
    try {
      process.chdir(originalCwd);
    } catch {
      process.chdir(os.homedir());
    }
  });

  // Windows refuses to remove a directory that is a live process's cwd, so the
  // rmSync below throws EBUSY and the test fails on its own setup. That is not a
  // gap in coverage: the state being reproduced — a process standing in a
  // directory that no longer exists — cannot arise on Windows for the same
  // reason. The recovery this asserts is POSIX-only by construction.
  it.skipIf(process.platform === 'win32')('recovers a deleted working directory by anchoring to home', () => {
    // Reproduce the exact routine-outage failure: the daemon is running with its
    // cwd inside a directory (a git worktree, in the real incident) that then gets
    // removed out from under it. A process cannot chdir out of a deleted directory
    // on its own, so every job it spawns inherits the dead cwd and Bun crashes with
    // `ENOENT: Bun could not find a file` at startup. anchorDaemonCwd must recover.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-cwd-'));
    const realTmp = fs.realpathSync(tmp);
    process.chdir(realTmp);
    fs.rmSync(realTmp, { recursive: true, force: true });

    // Sanity: we are genuinely standing in a deleted directory now. On Linux,
    // process.cwd() throws ENOENT here — the precondition of the outage.
    let cwdBroken = false;
    try {
      process.cwd();
    } catch {
      cwdBroken = true;
    }
    expect(cwdBroken).toBe(true);

    const resolved = anchorDaemonCwd();
    expect(resolved).toBe(os.homedir());
    // cwd() must now succeed and point at home — spawns will inherit a live dir.
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
  // A daemon launched from an ephemeral path wedges on every dynamic import once
  // that path is removed — the /tmp/rv-head incident. This predicate is what
  // both the launch-time check (validateDaemonBinary) and the runtime startup
  // self-check (warnEphemeralDaemonRoot) share, so it must classify precisely.
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
    // Version home (the real install location), a global npm prefix, and an
    // ordinary source checkout under $HOME must NOT be flagged — else every
    // dev run and every install would emit a spurious wedge warning.
    expect(describeEphemeralDaemonRoot('/home/u/.agents/.history/versions/agents/1.20.88/node_modules/@phnx-labs/agents-cli/dist/index.js')).toBeNull();
    expect(describeEphemeralDaemonRoot('/opt/homebrew/lib/node_modules/@phnx-labs/agents-cli/dist/index.js')).toBeNull();
    expect(describeEphemeralDaemonRoot('/home/u/src/github.com/x/agents-cli/cli/src/index.ts')).toBeNull();
    // A directory merely named "tmp" under $HOME is not a temp root (anchored match).
    expect(describeEphemeralDaemonRoot('/home/u/tmp/agents-cli/dist/index.js')).toBeNull();
  });
});

describe('warnEphemeralDaemonRoot', () => {
  // The runtime startup self-check: it must warn (return the message) for an
  // ephemeral launch root, stay silent (null) for a stable one, and never throw
  // — including when the bin resolver itself throws (getAgentsBinPath can, when a
  // shim's main entry is missing). resolveBin is injected so all three branches
  // hit the real code path without mocking the module.
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
    // Default resolver (getAgentsBinPath against the live argv[1]) must run
    // through the try without throwing — this is what runDaemon calls at startup.
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

// The instance registry + reaper are POSIX-only (a no-op on Windows), and these
// tests spawn real child processes — so the whole block is macOS/Linux.
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
          /* already gone */
        }
      }
      spawned.length = 0;
      try {
        fs.rmSync(instancesDir(), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it('registerDaemonInstance writes a pid marker; unregister removes it', () => {
      registerDaemonInstance(4242);
      expect(fs.existsSync(path.join(instancesDir(), '4242'))).toBe(true);
      unregisterDaemonInstance(4242);
      expect(fs.existsSync(path.join(instancesDir(), '4242'))).toBe(false);
    });

    it('reaps a live __daemon-run registrant that is neither self nor the pid-file owner', async () => {
      // A daemon spawned from a DIFFERENT launch entry (here: a bare `node`,
      // not the argv[1] path the old reaper matched on) still registers under
      // the shared device daemon dir, so the reaper finds and kills it.
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
      expect(isChildAlive(child.pid!)).toBe(true); // the innocent process is untouched
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
