/**
 * The consumer's recording half: an engine action event on fd 4 must land in
 * agents-cli's REAL event ledger with the same shape `agents computer sessions`
 * has always read (RUSH-2432). Written against the actual event log, not a stub.
 */
import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { recordComputerAction, COMPUTER_INVOCATION_ID } from './record.js';
import { query, _resetForTest } from '../feed/events.js';
import { TASK_PREVIEW_MAX_CHARS } from './sessions-list.js';

const tempDirs: string[] = [];

afterEach(() => {
  _resetForTest();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function useFreshLedger(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-computer-record-'));
  tempDirs.push(dir);
  _resetForTest(path.join(dir, 'events.jsonl'));
}

describe('recordComputerAction', () => {
  it('writes the engine event into the computer.action ledger with its verb, bundle, and device', () => {
    useFreshLedger();
    recordComputerAction({ verb: 'click', targetPid: 4211, bundle: 'com.apple.notes', device: 'win-mini' });

    const recs = query({ eventTypes: ['computer.action'] });
    expect(recs).toHaveLength(1);
    expect(recs[0].command).toBe('click');
    expect(recs[0].targetPid).toBe(4211);
    expect(recs[0].bundle).toBe('com.apple.notes');
    expect(recs[0].device).toBe('win-mini');
  });

  it('falls back to the invocation\'s device when the engine did not stamp one', () => {
    useFreshLedger();
    recordComputerAction({ verb: 'apps' }, { device: 'win-mini' });
    expect(query({ eventTypes: ['computer.action'] })[0].device).toBe('win-mini');
  });

  it('groups every action of one invocation under a single invocationId', () => {
    // This is what makes `agents computer sessions` show one row per run rather
    // than one row per click.
    useFreshLedger();
    recordComputerAction({ verb: 'raise' });
    recordComputerAction({ verb: 'click' });
    recordComputerAction({ verb: 'type' });

    const ids = new Set(query({ eventTypes: ['computer.action'] }).map((r) => r.invocationId));
    expect(ids).toEqual(new Set([COMPUTER_INVOCATION_ID]));
  });

  it('bounds the task preview HERE, even when the engine reports an unbounded one', () => {
    // The retention rule belongs to the ledger's owner. An engine that streamed
    // a full --task string must not be able to write it into the session index.
    useFreshLedger();
    const longTask = 'describe every window in exhaustive detail '.repeat(20);
    expect(longTask.length).toBeGreaterThan(TASK_PREVIEW_MAX_CHARS);
    recordComputerAction({ verb: 'run', task: longTask });

    const rec = query({ eventTypes: ['computer.action'] })[0];
    expect((rec.task as string).length).toBeLessThanOrEqual(TASK_PREVIEW_MAX_CHARS);
    expect(JSON.stringify(rec)).not.toContain(longTask);
  });

  it('passes through extra detail the engine attaches', () => {
    useFreshLedger();
    recordComputerAction({ verb: 'screenshot', out: '/tmp/shot.png' });
    expect(query({ eventTypes: ['computer.action'] })[0].out).toBe('/tmp/shot.png');
  });

  it('carries no target pid for an action the engine resolved no window for', () => {
    useFreshLedger();
    recordComputerAction({ verb: 'run', task: 'x' });
    expect(query({ eventTypes: ['computer.action'] })[0].targetPid).toBeUndefined();
  });
});
