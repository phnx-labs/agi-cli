/**
 * agents daemon — doctor, logs, stop, reload.
 *
 * The diagnosis half: `doctor`'s verdicts (including the auto-start circuit
 * breaker), `logs` with nothing logged, and the no-op paths for stop/reload.
 *
 * Split out of a single 35-test `daemon.test.ts` that ran 159s — the slowest
 * file in the repo, and therefore the whole suite's floor: vitest parallelises
 * across FILES and runs one file's tests sequentially in a single worker. The
 * shared spawn harness lives in `daemon-test-harness.ts`.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  DAEMON_TESTS_SUPPORTED,
  makeHome,
  run,
} from './daemon-test-harness.js';

const describeDaemon = DAEMON_TESTS_SUPPORTED ? describe : describe.skip;

describeDaemon('agents daemon — doctor, logs, stop, reload', () => {
  it('status --json reports stopped with no pid when no daemon is running for THIS install', () => {
    const res = run(makeHome(), ['status', '--json']);
    expect(res.status).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.state).toBe('stopped');
    expect(payload.pid).toBeNull();
    // `duplicates` is scoped to THIS install's instance registry (RUSH-2368),
    // which lives inside the isolated AGENTS_DAEMON_DIR this test set. Nothing
    // has ever registered there, so it is always empty here — whatever else is
    // running on the dev machine (or on another test's isolated HOME) is a
    // different registry and never appears, by construction, not by luck.
    expect(payload.duplicates).toEqual([]);
    expect(payload.daemonEnabled).toBe(true);
    expect(payload.services.secretsBroker).toHaveProperty('reachable', false);
    // browserIpc left the daemon status with the standalone browser CLI (PHNX-4101).
    expect(payload.services.browserIpc).toBeUndefined();
    // Daemon housekeeping (watchdog, device-probe, ...) are plain daemon-core
    // timers, NOT routines (RUSH-2495), so a fresh install with nothing on disk
    // carries zero scheduled routines.
    expect(payload.scheduler).toEqual(
      expect.objectContaining({
        routineCount: 0,
        enabledCount: 0,
        failingCount: 0,
      }),
    );
  });
  it('logs reports no matching lines when no daemon has ever logged', () => {
    const res = run(makeHome(), ['logs']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('No matching log lines');
  });
  it('logs --json returns an empty array, not a crash, with no log file', () => {
    const res = run(makeHome(), ['logs', '--json']);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toEqual([]);
  });
  it('doctor exits non-zero and names the problem when the daemon should be running but is not', () => {
    const res = run(makeHome(), ['doctor']);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('Daemon is not running');
  });

  // RUSH-2418: the auto-start circuit breaker tells the operator to "Run
  // 'agents daemon doctor'", so doctor has to be able to answer them. Before
  // this, `runDoctor` read only the secrets-broker and browser-IPC health
  // records, so following that instruction produced "Daemon is not running.
  // Start it: agents daemon start" — the exact action the breaker had just
  // refused, with no mention of a breaker, a streak, or the cause.
  it('doctor reports an open auto-start circuit breaker, with the recorded cause', () => {
    const home = makeHome();
    const daemonDir = path.join(home, '.agents', '.cache', 'helpers', 'daemon');
    fs.mkdirSync(daemonDir, { recursive: true });
    // The record a run of failed starts leaves behind, written in the same shape
    // recordSubsystemError produces.
    fs.writeFileSync(path.join(daemonDir, 'health.json'), JSON.stringify({
      'daemon-start': {
        subsystem: 'daemon-start',
        lastError: 'start issued; no daemon has reported healthy since',
        lastErrorAt: new Date().toISOString(),
        consecutiveFailures: 5,
        lastOkAt: null,
      },
    }), 'utf-8');

    const res = run(home, ['doctor', '--json']);
    expect(res.status).toBe(1);
    const problems: string[] = JSON.parse(res.stdout).problems;
    const breaker = problems.find((p) => p.includes('auto-start is disabled'));
    expect(breaker).toBeDefined();
    expect(breaker).toContain('5 consecutive');
    expect(breaker).toContain('start issued; no daemon has reported healthy since');
  });

  // A start is marked failed the moment it is issued and cleared once the daemon
  // finishes booting, so a sub-threshold streak on a LIVE daemon is just the boot
  // window — reporting it would be a false alarm that clears itself a second
  // later. The open breaker is still reported unconditionally; only the
  // sub-threshold warning is scoped to a daemon that is actually down.
  it('doctor does not report a sub-threshold start streak while the daemon is running', () => {
    const home = makeHome();
    const daemonDir = path.join(home, '.agents', '.cache', 'helpers', 'daemon');
    fs.mkdirSync(daemonDir, { recursive: true });
    fs.writeFileSync(path.join(daemonDir, 'health.json'), JSON.stringify({
      'daemon-start': {
        subsystem: 'daemon-start',
        lastError: 'start issued; no daemon has reported healthy since',
        lastErrorAt: new Date().toISOString(),
        consecutiveFailures: 1,
        lastOkAt: null,
      },
    }), 'utf-8');
    const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)', '__daemon-run'], { stdio: 'ignore' });
    try {
      // A real daemon-shaped command identity, recorded as the pid-file owner.
      fs.writeFileSync(path.join(daemonDir, 'daemon.pid'), String(daemon.pid), 'utf-8');

      const res = run(home, ['doctor', '--json']);
      const problems: string[] = JSON.parse(res.stdout).problems;
      expect(problems.some((p) => p.includes('consecutive failure'))).toBe(false);
      expect(problems.some((p) => p.includes('Daemon is not running'))).toBe(false);
    } finally {
      daemon.kill('SIGKILL');
    }
  });
  it('doctor does not flag "not running" once the daemon is disabled for this device', () => {
    // Hosted-service problems can still fire here — the secrets broker/browser
    // IPC probes are real sockets, not scoped to this install. Duplicate-process
    // problems cannot: they are scoped to THIS install's instance registry
    // (RUSH-2368), which is always empty for a fresh isolated HOME. What
    // disabling controls is specifically the "should be running but isn't" check.
    const home = makeHome();
    run(home, ['disable']);
    const res = run(home, ['doctor']);
    expect(res.stdout).not.toContain('Daemon is not running');
  });
  it('stop on a device with no running daemon is a clean no-op', () => {
    const res = run(makeHome(), ['stop']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('not running');
  });
  it('reload with no running daemon reports nothing to reload rather than crashing', () => {
    const res = run(makeHome(), ['reload']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('not running');
  });
});
