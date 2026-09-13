import { describe, it, expect, afterAll, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

// Sandbox the store under a temp HOME BEFORE importing the module (state.ts
// captures HOME at load). Dynamic import below evaluates it under the temp home.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'detach-store-'));
const savedHome = process.env.HOME;
process.env.HOME = TMP;

const {
  writeDetachRecord,
  readDetachRecord,
  clearDetachRecord,
  listDetachRecords,
  isHeadlessAlive,
  presenceFromStore,
} = await import('./detached.js');
const { captureProcessStartTime } = await import('../platform/process.js');

const children: ChildProcess[] = [];
function longRunningChild(): ChildProcess {
  // A real process we can check liveness against — no mocks.
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  children.push(child);
  return child;
}

afterEach(() => {
  for (const rec of listDetachRecords()) clearDetachRecord(rec.sessionId);
});
afterAll(() => {
  for (const c of children) {
    try {
      if (c.pid) process.kill(c.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('detach store', () => {
  it('write → read round-trips a record', () => {
    const rec = {
      sessionId: 'sess-aaa',
      agent: 'claude',
      cwd: '/tmp/work',
      headlessPid: 424242,
      headlessStartTime: 'fingerprint',
      detachedAtMs: 1000,
    };
    writeDetachRecord(rec);
    expect(readDetachRecord('sess-aaa')).toEqual(rec);
  });

  it('clear removes the record; read returns undefined', () => {
    writeDetachRecord({ sessionId: 'sess-bbb', agent: 'codex', headlessPid: 1, headlessStartTime: null, detachedAtMs: 0 });
    clearDetachRecord('sess-bbb');
    expect(readDetachRecord('sess-bbb')).toBeUndefined();
  });

  it('list returns every written record', () => {
    writeDetachRecord({ sessionId: 's1', agent: 'claude', headlessPid: 1, headlessStartTime: null, detachedAtMs: 0 });
    writeDetachRecord({ sessionId: 's2', agent: 'claude', headlessPid: 2, headlessStartTime: null, detachedAtMs: 0 });
    expect(listDetachRecords().map((r) => r.sessionId).sort()).toEqual(['s1', 's2']);
  });

  it('read on an unknown id is undefined, not a throw', () => {
    expect(readDetachRecord('never')).toBeUndefined();
  });
});

describe('isHeadlessAlive', () => {
  it('is true for a live pid whose start-time still matches', () => {
    const child = longRunningChild();
    const rec = {
      sessionId: 'live',
      agent: 'claude',
      headlessPid: child.pid!,
      headlessStartTime: captureProcessStartTime(child.pid!),
      detachedAtMs: Date.now(),
    };
    expect(isHeadlessAlive(rec)).toBe(true);
  });

  it('is false once the process has exited (awaits reap)', async () => {
    const child = longRunningChild();
    const pid = child.pid!;
    const start = captureProcessStartTime(pid);
    // Await 'exit' so the child is reaped — otherwise it lingers as a zombie
    // and kill(pid, 0) still succeeds.
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill('SIGKILL');
    });
    expect(isHeadlessAlive({ sessionId: 'dead', agent: 'claude', headlessPid: pid, headlessStartTime: start, detachedAtMs: 0 })).toBe(false);
  });

  it('is false when the start-time fingerprint no longer matches (PID reuse)', () => {
    const child = longRunningChild();
    // Live pid, but a stale fingerprint — this is not the process we launched.
    expect(
      isHeadlessAlive({ sessionId: 'reused', agent: 'claude', headlessPid: child.pid!, headlessStartTime: 'stale-fingerprint', detachedAtMs: 0 }),
    ).toBe(false);
  });

  it('is false for a bogus pid', () => {
    expect(isHeadlessAlive({ sessionId: 'x', agent: 'claude', headlessPid: 0, headlessStartTime: null, detachedAtMs: 0 })).toBe(false);
  });
});

describe('presenceFromStore', () => {
  it('undefined when there is no record', () => {
    expect(presenceFromStore('absent')).toBeUndefined();
  });

  it('background while the headless continuation is alive', () => {
    const child = longRunningChild();
    writeDetachRecord({
      sessionId: 'bg',
      agent: 'claude',
      headlessPid: child.pid!,
      headlessStartTime: captureProcessStartTime(child.pid!),
      detachedAtMs: Date.now(),
    });
    expect(presenceFromStore('bg')).toBe('background');
  });

  it('parked once the headless continuation has exited', () => {
    writeDetachRecord({ sessionId: 'pk', agent: 'claude', headlessPid: 0, headlessStartTime: null, detachedAtMs: 0 });
    expect(presenceFromStore('pk')).toBe('parked');
  });
});
