import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as state from '../state.js';
import { sshReachable } from '../ssh-exec.js';

// Redirect the cache dir to a temp tree (real fs) so reconcile reads and writes real task sidecars;
// initialized eagerly so the module-load reachability probe sees a valid dir for ssh's control
// socket.
let CACHE_ROOT: string = mkdtempSync(join(tmpdir(), 'agents-cli-reconcile-boot-'));
vi.spyOn(state, 'getCacheDir').mockImplementation(() => CACHE_ROOT);

import { classifyExit, reconcileTask, reconcileRunningTasks, reachabilityProbeCommand } from './reconcile.js';

it('uses a valid reachability command for each remote shell', () => {
  expect(reachabilityProbeCommand('powershell')).toBe('powershell -NoProfile -Command "exit 0"');
  expect(reachabilityProbeCommand('posix')).toBe('true');
});
import { saveTask, loadTask, terminalPatch, type HostTask } from './tasks.js';

// The heal path needs a real ssh round-trip (no mocking); gate on localhost being ssh-reachable so
// it runs on dev machines and skips on hosted CI.
const LOCALHOST_SSH = sshReachable('localhost', 5000);

function makeTask(overrides: Partial<HostTask> = {}): HostTask {
  return {
    id: 'abc12345',
    host: 'box',
    target: 'user@box',
    agent: 'claude',
    prompt: 'do a thing',
    remoteLog: '$HOME/.agents/.cache/hosts/abc12345.log',
    remoteExit: '$HOME/.agents/.cache/hosts/abc12345.exit',
    status: 'running',
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  CACHE_ROOT = mkdtempSync(join(tmpdir(), 'agents-cli-reconcile-'));
  mkdirSync(join(CACHE_ROOT, 'hosts'), { recursive: true });
  // ssh's control-socket dir lives under getCacheDir(); ssh-exec only ensures it
  // once (module-level flag), so with a fresh cache dir per test we must create
  // it ourselves or multiplexed ssh can't open its socket and reports 255.
  mkdirSync(join(CACHE_ROOT, 'ssh'), { recursive: true, mode: 0o700 });
});

afterEach(() => {
  rmSync(CACHE_ROOT, { recursive: true, force: true });
});

// The classifier is where every bug-prone branch lives; readRemoteExit is just a
// thin ssh wrapper around it, so exercising it with plain SshExecResult-shaped
// data (NOT a mocked ssh layer) covers the real decision logic.
describe('classifyExit', () => {
  it('ssh connection failure (code 255) → unreachable, never a guessed status', () => {
    expect(classifyExit({ code: 255, stdout: '', timedOut: false })).toEqual({ state: 'unreachable' });
  });

  it('spawn error / null code → unreachable', () => {
    expect(classifyExit({ code: null, stdout: '', timedOut: false })).toEqual({ state: 'unreachable' });
  });

  it('timeout → unreachable even if a code came back', () => {
    expect(classifyExit({ code: 0, stdout: '', timedOut: true })).toEqual({ state: 'unreachable' });
  });

  it('reachable but empty .exit (absent or mid-write) → running', () => {
    expect(classifyExit({ code: 0, stdout: '', timedOut: false })).toEqual({ state: 'running' });
    expect(classifyExit({ code: 0, stdout: '   \n', timedOut: false })).toEqual({ state: 'running' });
  });

  it('.exit holds 0 → done with code 0', () => {
    expect(classifyExit({ code: 0, stdout: '0\n', timedOut: false })).toEqual({ state: 'done', code: 0 });
  });

  it('.exit holds a non-zero code → done with that code', () => {
    expect(classifyExit({ code: 0, stdout: '137\n', timedOut: false })).toEqual({ state: 'done', code: 137 });
  });

  it('garbage in .exit coerces to 0 (matches the follow-loop parse)', () => {
    expect(classifyExit({ code: 0, stdout: 'not-a-number\n', timedOut: false })).toEqual({ state: 'done', code: 0 });
  });
});

describe('terminalPatch', () => {
  it('code 0 → completed', () => {
    const p = terminalPatch(0);
    expect(p.status).toBe('completed');
    expect(p.exitCode).toBe(0);
    expect(typeof p.finishedAt).toBe('string');
  });

  it('non-zero code → failed, code preserved', () => {
    const p = terminalPatch(2);
    expect(p.status).toBe('failed');
    expect(p.exitCode).toBe(2);
  });
});

describe('reconcileTask — terminal records are immutable (no ssh)', () => {
  // A non-'running' status short-circuits before any ssh, so these run offline.
  it('leaves a completed record untouched', () => {
    const task = makeTask({ status: 'completed', exitCode: 0 });
    saveTask(task);
    const out = reconcileTask(task);
    expect(out.status).toBe('completed');
    expect(loadTask(task.id)?.status).toBe('completed');
  });

  it('leaves a failed record untouched', () => {
    const task = makeTask({ id: 'fail0001', status: 'failed', exitCode: 1 });
    saveTask(task);
    const out = reconcileTask(task);
    expect(out.status).toBe('failed');
    expect(out.exitCode).toBe(1);
  });
});

describe('reconcileRunningTasks — no running tasks means no ssh', () => {
  it('returns the input unchanged when nothing is running', () => {
    const tasks = [
      makeTask({ id: 'done0001', status: 'completed', exitCode: 0 }),
      makeTask({ id: 'fail0002', status: 'failed', exitCode: 3 }),
    ];
    const out = reconcileRunningTasks(tasks);
    expect(out).toEqual(tasks);
  });

  it('returns an empty list unchanged', () => {
    expect(reconcileRunningTasks([])).toEqual([]);
  });
});

// The literal bug the PR fixes: a 'running' record whose remote `.exit` now
// holds a code must be healed to a terminal status AND persisted to disk. Driven
// over a real `ssh localhost` cat of a real `.exit` file — no mocking.
describe.skipIf(!LOCALHOST_SSH)('reconcile over real ssh (localhost)', () => {
  let exitFile: string;

  beforeEach(() => {
    exitFile = join(CACHE_ROOT, 'run.exit');
  });

  it('heals a running record from a code-0 .exit and persists it', () => {
    writeFileSync(exitFile, '0\n');
    const task = makeTask({ id: 'heal0000', target: 'localhost', remoteExit: exitFile });
    saveTask(task);

    const out = reconcileTask(task);

    expect(out.status).toBe('completed');
    expect(out.exitCode).toBe(0);
    expect(loadTask('heal0000')?.status).toBe('completed'); // written through to disk
  });

  it('heals a non-zero .exit to failed with the code preserved', () => {
    writeFileSync(exitFile, '137\n');
    const task = makeTask({ id: 'heal0137', target: 'localhost', remoteExit: exitFile });
    saveTask(task);

    reconcileTask(task);

    const disk = loadTask('heal0137');
    expect(disk?.status).toBe('failed');
    expect(disk?.exitCode).toBe(137);
  });

  it('leaves a running record running when the .exit is absent (still going)', () => {
    const task = makeTask({ id: 'still001', target: 'localhost', remoteExit: join(CACHE_ROOT, 'nope.exit') });
    saveTask(task);

    expect(reconcileTask(task).status).toBe('running');
    expect(loadTask('still001')?.status).toBe('running');
  });

  it('reconcileRunningTasks: unreachable host stays running, never failed', () => {
    const down = makeTask({ id: 'downhost', target: 'no-such-host-xyzzy-12345', remoteExit: exitFile });
    saveTask(down);

    const [out] = reconcileRunningTasks([down]);

    expect(out.status).toBe('running');
    expect(loadTask('downhost')?.status).toBe('running');
  });
});
