/**
 * Daemon self-heal: heartbeat, path guard, pid-reuse safety.
 * RUSH-1669 / RUSH-1670 / RUSH-1672 / RUSH-1673.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import {
  writeHeartbeat,
  readHeartbeat,
  removeHeartbeat,
  isDaemonRunning,
  claimDaemonInstance,
  writeDaemonPid,
  readDaemonPid,
  removeDaemonPid,
  getDaemonLaunch,
  validateDaemonBinary,
  getDaemonStatus,
} from '../daemon/daemon.js';
import { getDaemonDir } from '../state.js';
import { writeRunMeta, type RunMeta } from '../scheduling/routines.js';
import { getRunsDir } from '../state.js';
import { monitorRunningJobs, reapExitedRunningJobs } from '../daemon/runner.js';

// Redirect the daemon scratch dir (heartbeat.json / daemon.pid / the O_EXCL start
// lock) to a file-private temp so these IN-PROCESS writes never touch a live
// scheduler daemon's state on a dev machine. File-scoped, NOT global (see the
// note in tests/setup.ts): a global AGENTS_DAEMON_DIR is inherited by the real
// daemons that migrate.test.ts / daemon.test.ts spawn (env: {...process.env}) and
// forces them onto one shared dir, colliding on the single-instance guard.
let priorDaemonDir: string | undefined;
beforeAll(() => {
  priorDaemonDir = process.env.AGENTS_DAEMON_DIR;
  process.env.AGENTS_DAEMON_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-selfheal-'));
});
afterAll(() => {
  if (priorDaemonDir === undefined) delete process.env.AGENTS_DAEMON_DIR;
  else process.env.AGENTS_DAEMON_DIR = priorDaemonDir;
});

// A real process identity for daemon liveness tests. `isDaemonRunning` now
// validates the command boundary before trusting a pid, so using the vitest
// worker's own pid would encode the unsafe behavior PHNX-3607 removes.
const daemonStandIns: Array<ReturnType<typeof spawn>> = [];
async function spawnDaemonStandIn(): Promise<ReturnType<typeof spawn>> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)', '__daemon-run'], { stdio: 'ignore' });
  daemonStandIns.push(child);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(child.pid).toBeTruthy();
  return child;
}
afterEach(() => {
  for (const child of daemonStandIns.splice(0)) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

// ─── RUSH-1670: Heartbeat + wedged-daemon watchdog ──────────────────────────

describe('heartbeat read/write', () => {
  afterEach(() => { removeHeartbeat(); });

  it('round-trips a heartbeat to disk', () => {
    writeHeartbeat(12345);
    const hb = readHeartbeat();
    expect(hb).not.toBeNull();
    expect(hb!.pid).toBe(12345);
    expect(Date.parse(hb!.lastTick)).toBeGreaterThan(0);
  });

  it('returns null when no heartbeat file exists', () => {
    removeHeartbeat();
    expect(readHeartbeat()).toBeNull();
  });
});

describe('getDaemonStatus', () => {
  let priorPid: number | null;
  beforeEach(() => { priorPid = readDaemonPid(); });
  afterEach(() => {
    removeHeartbeat();
    if (priorPid === null) removeDaemonPid();
    else writeDaemonPid(priorPid);
  });

  it('reports stopped when no daemon is running', () => {
    removeDaemonPid();
    const s = getDaemonStatus();
    expect(s.state).toBe('stopped');
    expect(s.running).toBe(false);
  });

  it('reports running with binary path when daemon is alive and fresh', async () => {
    const daemon = await spawnDaemonStandIn();
    writeDaemonPid(daemon.pid!);
    writeHeartbeat(daemon.pid!);
    const s = getDaemonStatus();
    expect(s.state).toBe('running');
    expect(s.binaryPath).toBeTruthy();
  });

  // There is no `wedged` state (PHNX-4116): a stalled daemon exits for a
  // supervised systemd/launchd restart rather than sitting unresponsive, so a
  // stale heartbeat on a pid that no longer passes the liveness check reads as
  // `stopped`, not a distinct `wedged`.
  it('reports stopped, never a wedged state, when the heartbeat is stale and the pid is not a live daemon', async () => {
    const stale = new Date(Date.now() - 4 * 60_000).toISOString();
    const hbPath = path.join(getDaemonDir(), 'heartbeat.json');
    fs.mkdirSync(path.dirname(hbPath), { recursive: true });
    fs.writeFileSync(hbPath, JSON.stringify({ lastTick: stale, pid: 999_999 }));
    writeDaemonPid(999_999); // not a live process
    const s = getDaemonStatus();
    expect(s.state).toBe('stopped');
  });
});

// ─── pid-file / heartbeat desync: false "stopped" + double-start guard ──────

describe('isDaemonRunning — pid-file/heartbeat desync', () => {
  let priorPid: number | null;
  beforeEach(() => { priorPid = readDaemonPid(); });
  afterEach(() => {
    removeHeartbeat();
    if (priorPid === null) removeDaemonPid();
    else writeDaemonPid(priorPid);
  });

  it('reports running when the pid file is lost but a fresh heartbeat is alive, and re-adopts the pid file', async () => {
    // A live daemon keeps ticking, but its pid file went missing.
    const daemon = await spawnDaemonStandIn();
    removeDaemonPid();
    writeHeartbeat(daemon.pid!);

    expect(isDaemonRunning()).toBe(true);
    // Healed: the pid file now points back at the live pid.
    expect(readDaemonPid()).toBe(daemon.pid);
    // And the user-facing status is "running", not the false "stopped".
    expect(getDaemonStatus().state).toBe('running');
  });

  it('reports stopped when the pid file is lost and the heartbeat is stale', () => {
    removeDaemonPid();
    const stale = new Date(Date.now() - 4 * 60_000).toISOString();
    const hbPath = path.join(getDaemonDir(), 'heartbeat.json');
    fs.mkdirSync(path.dirname(hbPath), { recursive: true });
    fs.writeFileSync(hbPath, JSON.stringify({ lastTick: stale, pid: process.pid }));

    expect(isDaemonRunning()).toBe(false);
    expect(readDaemonPid()).toBeNull(); // stale pid file cleared, none re-adopted
  });

  it('evicts a live daemon that lost its pid file (heartbeat still proves it) — last-wins (RUSH-2352)', async () => {
    // A real, foreign, live process stands in for the running daemon.
    const child = await spawnDaemonStandIn();
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      expect(child.pid).toBeTruthy();
      // The live daemon's pid file is gone; only its fresh heartbeat remains.
      removeDaemonPid();
      writeHeartbeat(child.pid!);

      // resolveLiveDaemonPid() must still find it via the heartbeat (so a lost
      // pid file can't be used to dodge eviction), and claimDaemonInstance()
      // always wins now: it SIGTERMs the incumbent and claims the pid file for
      // itself, rather than deferring to it.
      expect(claimDaemonInstance()).toBe(true);
      expect(readDaemonPid()).toBe(process.pid);
      // The evicted incumbent is actually gone, not just out-claimed on paper —
      // Node's own 'exit' event is the unambiguous signal it is dead.
      await Promise.race([
        exited,
        new Promise((_, reject) => setTimeout(() => reject(new Error('incumbent never exited')), 5000)),
      ]);
    } finally {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  });

  it('adopts a fresh live heartbeat over a DEAD pid file, healing to the heartbeat pid', async () => {
    // The healing branch where the pid file is present but its pid is dead, and
    // a different, live, fresh heartbeat exists. (999999 is this repo's
    // established stand-in for a dead pid — see the orphan-reap tests below.)
    const child = await spawnDaemonStandIn();
    try {
      expect(child.pid).toBeTruthy();
      writeDaemonPid(999999);       // pid file present, but that pid is dead
      writeHeartbeat(child.pid!);   // a different, live, fresh daemon is ticking

      expect(isDaemonRunning()).toBe(true);
      // The dead pid file is re-adopted to the live heartbeat pid, not left stale.
      expect(readDaemonPid()).toBe(child.pid!);
    } finally {
      child.kill('SIGKILL');
    }
  });
});

// ─── RUSH-1672: pid-reuse-safe reaper + max wall-clock ──────────────────────

describe('monitorRunningJobs — pid-reuse + max wall-clock', () => {
  const cleanupDirs: string[] = [];
  afterEach(() => {
    for (const d of cleanupDirs.splice(0)) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });

  it('finalizes a run whose pid is dead (basic orphan reap)', () => {
    const meta: RunMeta = {
      jobName: '__selfheal-dead-pid__',
      runId: 'test-dead-1',
      agent: 'claude',
      pid: 999999,
      spawnedAt: Date.now() - 60_000,
      status: 'running',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      completedAt: null,
      exitCode: null,
    };
    writeRunMeta(meta);
    cleanupDirs.push(path.join(getRunsDir(), meta.jobName));

    monitorRunningJobs();

    const metaPath = path.join(getRunsDir(), meta.jobName, meta.runId, 'meta.json');
    const updated: RunMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    expect(updated.status).not.toBe('running');
    expect(updated.completedAt).not.toBeNull();
  });

  // The reaper must never SIGKILL the process doing the reaping. This case runs
  // monitorRunningJobs() against a record whose pid IS this process and whose
  // start time is past the 24h cap -- the exact shape that made the vitest
  // worker kill itself (rc=137, "Worker exited unexpectedly") before
  // terminateRoutineTree() guarded `pid === process.pid`. Reaching the
  // assertions at all is the proof: a self-kill never gets here.
  it('finalizes an over-cap run without killing the reaping process itself', () => {
    const meta: RunMeta = {
      jobName: '__selfheal-wallclock__',
      runId: 'test-wall-1',
      agent: 'claude',
      pid: process.pid,
      spawnedAt: Date.now(),
      status: 'running',
      startedAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
      completedAt: null,
      exitCode: null,
    };
    writeRunMeta(meta);
    cleanupDirs.push(path.join(getRunsDir(), meta.jobName));

    monitorRunningJobs();

    const metaPath = path.join(getRunsDir(), meta.jobName, meta.runId, 'meta.json');
    const updated: RunMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    expect(updated.status).toBe('timeout');
    expect(updated.completedAt).not.toBeNull();
  });
});

// The daemon heartbeat tick uses the ASYNC reaper (PHNX-3695) so the every-tick
// scan + ps identity probe never freeze the shared event loop. It must reconcile
// a run exactly as the synchronous monitorRunningJobs does (shared core:
// reconcileRunningRecord).
describe('reapExitedRunningJobs — async daemon-tick reaper', () => {
  const cleanupDirs: string[] = [];
  afterEach(() => {
    for (const d of cleanupDirs.splice(0)) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });

  it('finalizes a run whose pid is dead, same as the sync path', async () => {
    const meta: RunMeta = {
      jobName: '__reap-async-dead__',
      runId: 'reap-async-1',
      agent: 'claude',
      pid: 999999,
      spawnedAt: Date.now() - 60_000,
      status: 'running',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      completedAt: null,
      exitCode: null,
    };
    writeRunMeta(meta);
    cleanupDirs.push(path.join(getRunsDir(), meta.jobName));

    await reapExitedRunningJobs();

    const metaPath = path.join(getRunsDir(), meta.jobName, meta.runId, 'meta.json');
    const updated: RunMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    expect(updated.status).not.toBe('running');
    expect(updated.completedAt).not.toBeNull();
  });

  it('does not freeze the event loop while it reaps (a concurrent timer still fires)', async () => {
    const meta: RunMeta = {
      jobName: '__reap-async-live__',
      runId: 'reap-async-2',
      agent: 'claude',
      pid: process.pid, // alive → triggers the ps identity probe
      spawnedAt: Date.now(),
      status: 'running',
      startedAt: new Date().toISOString(),
      completedAt: null,
      exitCode: null,
    };
    writeRunMeta(meta);
    cleanupDirs.push(path.join(getRunsDir(), meta.jobName));

    let timerFired = false;
    const t = setTimeout(() => { timerFired = true; }, 0);
    const reap = reapExitedRunningJobs();
    // Yield: with an async reaper the loop keeps turning, so the 0ms timer runs
    // before the reap resolves rather than being blocked behind a sync ps scan.
    await new Promise((r) => setImmediate(r));
    await reap;
    clearTimeout(t);
    expect(timerFired).toBe(true);
  });
});

// ─── RUSH-1673: path guard (never supervise worktree/bunfs daemon) ──────────

describe('validateDaemonBinary — path guard', () => {
  it('throws for a /$bunfs/root/ virtual path', () => {
    expect(() => validateDaemonBinary('/$bunfs/root/agents')).toThrow(/bun virtual path/);
  });

  it('warns for a binary under .agents/worktrees/', () => {
    const { warnings } = validateDaemonBinary('/home/user/repo/.agents/worktrees/my-branch/cli/dist/index.js');
    expect(warnings.some((w) => /worktree/.test(w))).toBe(true);
  });

  it('warns for a nonexistent native binary', () => {
    const { warnings } = validateDaemonBinary('/nonexistent/agents-never-exists');
    expect(warnings.some((w) => /does not exist/.test(w))).toBe(true);
  });

  it('accepts process.execPath (a real binary) with no warnings', () => {
    const { warnings } = validateDaemonBinary(process.execPath);
    expect(warnings).toHaveLength(0);
  });
});

describe('getDaemonLaunch — path guard integration', () => {
  it('throws for a bunfs path', () => {
    expect(() => getDaemonLaunch('/$bunfs/root/agents')).toThrow(/bun virtual path/);
  });

  it('emits a warning (not a throw) for a worktree .js path', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-wt-'));
    const wtBin = path.join(tmpDir, '.agents', 'worktrees', 'fix', 'dist', 'index.js');
    fs.mkdirSync(path.dirname(wtBin), { recursive: true });
    fs.writeFileSync(wtBin, '');
    expect(() => getDaemonLaunch(wtBin)).not.toThrow();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
