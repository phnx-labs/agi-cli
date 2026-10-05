
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

let priorDaemonDir: string | undefined;
beforeAll(() => {
  priorDaemonDir = process.env.AGENTS_DAEMON_DIR;
  process.env.AGENTS_DAEMON_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-selfheal-'));
});
afterAll(() => {
  if (priorDaemonDir === undefined) delete process.env.AGENTS_DAEMON_DIR;
  else process.env.AGENTS_DAEMON_DIR = priorDaemonDir;
});

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
    try { child.kill('SIGKILL'); } catch {  }
  }
});


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

  it('reports stopped, never a wedged state, when the heartbeat is stale and the pid is not a live daemon', async () => {
    const stale = new Date(Date.now() - 4 * 60_000).toISOString();
    const hbPath = path.join(getDaemonDir(), 'heartbeat.json');
    fs.mkdirSync(path.dirname(hbPath), { recursive: true });
    fs.writeFileSync(hbPath, JSON.stringify({ lastTick: stale, pid: 999_999 }));
    writeDaemonPid(999_999);
    const s = getDaemonStatus();
    expect(s.state).toBe('stopped');
  });
});


describe('isDaemonRunning — pid-file/heartbeat desync', () => {
  let priorPid: number | null;
  beforeEach(() => { priorPid = readDaemonPid(); });
  afterEach(() => {
    removeHeartbeat();
    if (priorPid === null) removeDaemonPid();
    else writeDaemonPid(priorPid);
  });

  it('reports running when the pid file is lost but a fresh heartbeat is alive, and re-adopts the pid file', async () => {
    const daemon = await spawnDaemonStandIn();
    removeDaemonPid();
    writeHeartbeat(daemon.pid!);

    expect(isDaemonRunning()).toBe(true);
    expect(readDaemonPid()).toBe(daemon.pid);
    expect(getDaemonStatus().state).toBe('running');
  });

  it('reports stopped when the pid file is lost and the heartbeat is stale', () => {
    removeDaemonPid();
    const stale = new Date(Date.now() - 4 * 60_000).toISOString();
    const hbPath = path.join(getDaemonDir(), 'heartbeat.json');
    fs.mkdirSync(path.dirname(hbPath), { recursive: true });
    fs.writeFileSync(hbPath, JSON.stringify({ lastTick: stale, pid: process.pid }));

    expect(isDaemonRunning()).toBe(false);
    expect(readDaemonPid()).toBeNull();
  });

  it('evicts a live daemon that lost its pid file (heartbeat still proves it) — last-wins (RUSH-2352)', async () => {
    const child = await spawnDaemonStandIn();
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      expect(child.pid).toBeTruthy();
      removeDaemonPid();
      writeHeartbeat(child.pid!);

      expect(claimDaemonInstance()).toBe(true);
      expect(readDaemonPid()).toBe(process.pid);
      await Promise.race([
        exited,
        new Promise((_, reject) => setTimeout(() => reject(new Error('incumbent never exited')), 5000)),
      ]);
    } finally {
      try { child.kill('SIGKILL'); } catch {  }
    }
  });

  it('adopts a fresh live heartbeat over a DEAD pid file, healing to the heartbeat pid', async () => {
    const child = await spawnDaemonStandIn();
    try {
      expect(child.pid).toBeTruthy();
      writeDaemonPid(999999);
      writeHeartbeat(child.pid!);

      expect(isDaemonRunning()).toBe(true);
      expect(readDaemonPid()).toBe(child.pid!);
    } finally {
      child.kill('SIGKILL');
    }
  });
});


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
      pid: process.pid,
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
    await new Promise((r) => setImmediate(r));
    await reap;
    clearTimeout(t);
    expect(timerFired).toBe(true);
  });
});


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
