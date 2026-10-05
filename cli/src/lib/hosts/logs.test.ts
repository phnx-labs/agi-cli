import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, mkdtempSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as state from '../state.js';
import { sshReachable } from '../ssh-exec.js';

// Redirect the cache dir to a temp tree (real fs) to stage real task sidecars and logs; initialized
// eagerly so the module-load LOCALHOST_SSH probe sees a valid dir for ssh's control socket.
let CACHE_ROOT: string = mkdtempSync(join(tmpdir(), 'agents-cli-hostlogs-boot-'));
vi.spyOn(state, 'getCacheDir').mockImplementation(() => CACHE_ROOT);

import { showHostTaskLog, hostTaskLogJson, tailLines } from './logs.js';
import { saveTask, localLogPath, type HostTask } from './tasks.js';

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
    status: 'completed',
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

let out: string;
let writeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  CACHE_ROOT = mkdtempSync(join(tmpdir(), 'agents-cli-hostlogs-'));
  mkdirSync(join(CACHE_ROOT, 'hosts'), { recursive: true });
  mkdirSync(join(CACHE_ROOT, 'ssh'), { recursive: true, mode: 0o700 });
  out = '';
  writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
});

afterEach(() => {
  writeSpy.mockRestore();
  rmSync(CACHE_ROOT, { recursive: true, force: true });
});

describe('showHostTaskLog', () => {
  it('returns found:false for an unknown id (so callers can fall through to sessions)', async () => {
    const res = await showHostTaskLog('nope-not-a-task', false);
    expect(res.found).toBe(false);
    expect(res.exitCode).toBeUndefined();
    expect(out).toBe('');
  });

  it('prints the captured local log for a finished task and reports exit 0', async () => {
    const task = makeTask();
    saveTask(task);
    writeFileSync(localLogPath(task.id), 'PONG\n');

    const res = await showHostTaskLog(task.id, false);

    expect(res.found).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(out).toBe('PONG\n');
  });

  it('found:true with a friendly note when the task exists but no log was captured', async () => {
    const task = makeTask({ id: 'nolog001' });
    saveTask(task);

    const res = await showHostTaskLog(task.id, false);

    expect(res.found).toBe(true);
    expect(res.exitCode).toBe(0);
  });

  it('does NOT follow (no SSH) a finished task even when follow is requested', async () => {
    const task = makeTask({ id: 'done0001', status: 'completed' });
    saveTask(task);
    writeFileSync(localLogPath(task.id), 'final output\n');

    const res = await showHostTaskLog(task.id, true);

    expect(res.found).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(out).toBe('final output\n');
  });
});

describe('hostTaskLogJson', () => {
  it('returns found:false for an unknown id (so callers fall through to sessions)', () => {
    const res = hostTaskLogJson('nope-not-a-task');
    expect(res.found).toBe(false);
    expect(res.task).toBeUndefined();
    expect(res.log).toBeUndefined();
    expect(out).toBe('');
  });

  it('returns the task record and its captured log for a finished task', () => {
    const task = makeTask({ id: 'json0001' });
    saveTask(task);
    writeFileSync(localLogPath(task.id), 'PONG\n');

    const res = hostTaskLogJson(task.id);

    expect(res.found).toBe(true);
    expect(res.task?.id).toBe('json0001');
    expect(res.task?.agent).toBe('claude');
    expect(res.log).toBe('PONG\n');
    expect(() => JSON.stringify({ kind: 'task', task: res.task, log: res.log })).not.toThrow();
  });

  it('returns log:null when the task exists but no log was captured', () => {
    const task = makeTask({ id: 'json0002' });
    saveTask(task);

    const res = hostTaskLogJson(task.id);

    expect(res.found).toBe(true);
    expect(res.task?.id).toBe('json0002');
    expect(res.log).toBeNull();
  });
});

// Detached-dispatch log retrieval over real ssh (localhost). Guards the bug where a --no-follow
// dispatch captured no local log, so `agents logs <id>` always printed "(no local log captured for
// this task)".
describe.skipIf(!LOCALHOST_SSH)('detached-run log fetch over real ssh (localhost)', () => {
  it('fetches and prints the remote log when no local log exists (detached dispatch)', async () => {
    const remoteLogFile = join(CACHE_ROOT, 'remote-abc00001.log');
    writeFileSync(remoteLogFile, 'detached run output\n');

    const task = makeTask({ id: 'abc00001', target: 'localhost', remoteLog: remoteLogFile });
    saveTask(task);

    const res = await showHostTaskLog(task.id, false);

    expect(res.found).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(out).toBe('detached run output\n');
  });

  it('caches the fetched log locally so subsequent calls read it from disk (no SSH)', async () => {
    const remoteLogFile = join(CACHE_ROOT, 'remote-abc00002.log');
    writeFileSync(remoteLogFile, 'cached output\n');

    const task = makeTask({ id: 'abc00002', target: 'localhost', remoteLog: remoteLogFile });
    saveTask(task);

    await showHostTaskLog(task.id, false);

    expect(existsSync(localLogPath(task.id))).toBe(true);
  });

  it('still shows the no-log note when the remote log is also absent', async () => {
    const task = makeTask({
      id: 'abc00003',
      target: 'localhost',
      remoteLog: join(CACHE_ROOT, 'nonexistent.log'),
    });
    saveTask(task);

    const res = await showHostTaskLog(task.id, false);

    expect(res.found).toBe(true);
    expect(out).toContain('no local log');
  });
});

// hostTaskLogJson must emit the reconciled record: a task that finished remotely must show its
// terminal status/exitCode, not a stale 'running'. Uses a real `ssh localhost cat <.exit>`, so
// gated on localhost SSH.
describe.skipIf(!LOCALHOST_SSH)('hostTaskLogJson reconciles a finished run before emitting (real ssh)', () => {
  it('surfaces terminal status + exitCode for a running record whose remote .exit is now set', () => {
    const remoteExitFile = join(CACHE_ROOT, 'remote-recon01.exit');
    writeFileSync(remoteExitFile, '0\n');

    const task = makeTask({
      id: 'recon001',
      status: 'running',
      target: 'localhost',
      remoteExit: remoteExitFile,
    });
    saveTask(task);
    writeFileSync(localLogPath(task.id), 'done output\n');

    const res = hostTaskLogJson(task.id);

    expect(res.found).toBe(true);
    expect(res.task?.status).toBe('completed');
    expect(res.task?.exitCode).toBe(0);
    expect(res.task?.finishedAt).toBeTruthy();
    expect(res.log).toBe('done output\n');
  });

  it('leaves a still-running record running when its remote .exit is empty', () => {
    const remoteExitFile = join(CACHE_ROOT, 'remote-recon02.exit');
    writeFileSync(remoteExitFile, '');

    const task = makeTask({
      id: 'recon002',
      status: 'running',
      target: 'localhost',
      remoteExit: remoteExitFile,
    });
    saveTask(task);

    const res = hostTaskLogJson(task.id);

    expect(res.found).toBe(true);
    expect(res.task?.status).toBe('running');
    expect(res.task?.exitCode).toBeUndefined();
  });
});

describe('tailLines', () => {
  const strip = (s: string): string => s.replace(/\[[0-9;]*m/g, '');

  it('returns the whole text (with a trailing newline) when under the limit', () => {
    const out = strip(tailLines('a\nb\nc', 40));
    expect(out).toBe('a\nb\nc\n');
    expect(out).not.toContain('hidden');
  });

  it('does not count a trailing newline as an extra hidden line', () => {
    const text = Array.from({ length: 40 }, (_, i) => `L${i}`).join('\n') + '\n';
    const out = strip(tailLines(text, 40));
    expect(out).not.toContain('hidden');
    expect(out.split('\n').filter(Boolean)).toHaveLength(40);
  });

  it('keeps only the last n lines and reports how many were hidden', () => {
    const text = Array.from({ length: 100 }, (_, i) => `L${i}`).join('\n');
    const out = strip(tailLines(text, 40));
    expect(out).toContain('60 earlier lines hidden');
    expect(out).toContain('--full');
    expect(out).toContain('L99');
    expect(out).toContain('L60');
    expect(out).not.toContain('L59');
  });

  it('uses the singular "line" when exactly one is hidden', () => {
    const text = Array.from({ length: 41 }, (_, i) => `L${i}`).join('\n');
    const out = strip(tailLines(text, 40));
    expect(out).toContain('1 earlier line hidden');
    expect(out).not.toContain('1 earlier lines');
  });
});
