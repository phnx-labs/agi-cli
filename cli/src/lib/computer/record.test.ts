/**
 * The consumer's recording half: an engine action event on fd 4 must land in
 * agents-cli's REAL event ledger with the same shape `agents computer sessions`
 * has always read (RUSH-2432). Written against the actual event log, not a stub.
 *
 * The engine's wire shape is what is fed in here — `command`, `invocationId`,
 * `host` — because a translation layer is exactly what would drift.
 */
import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { recordComputerAction, COMPUTER_INVOCATION_ID } from './record.js';
import { query, _resetForTest } from '../feed/events.js';
import { listComputerActions } from './sessions-list.js';
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
  it('writes the engine event into the computer.action ledger with its command, bundle, and host', () => {
    useFreshLedger();
    recordComputerAction({
      event: 'computer.action',
      command: 'click',
      invocationId: 'engine-run-1',
      targetPid: 4211,
      bundle: 'com.apple.notes',
      host: 'win-mini',
    });

    const recs = query({ eventTypes: ['computer.action'] });
    expect(recs).toHaveLength(1);
    expect(recs[0].command).toBe('click');
    expect(recs[0].targetPid).toBe(4211);
    expect(recs[0].bundle).toBe('com.apple.notes');
    expect(recs[0].host).toBe('win-mini');
  });

  it('preserves the ENGINE\'s invocation id, so the row groups the run that happened', () => {
    // Re-stamping our own id here would group by the CLI process instead of the
    // engine run, and for `--device` those are different machines' work.
    useFreshLedger();
    recordComputerAction({ command: 'raise', invocationId: 'engine-run-2' });
    recordComputerAction({ command: 'click', invocationId: 'engine-run-2' });

    const ids = new Set(query({ eventTypes: ['computer.action'] }).map((r) => r.invocationId));
    expect(ids).toEqual(new Set(['engine-run-2']));
  });

  it('falls back to this process\'s id when the engine stamped none', () => {
    useFreshLedger();
    recordComputerAction({ command: 'apps' });
    expect(query({ eventTypes: ['computer.action'] })[0].invocationId).toBe(COMPUTER_INVOCATION_ID);
  });

  it('falls back to the invocation\'s device when the engine did not name a host', () => {
    useFreshLedger();
    recordComputerAction({ command: 'apps' }, { device: 'win-mini' });
    expect(query({ eventTypes: ['computer.action'] })[0].host).toBe('win-mini');
  });

  it('lands in the shape the sessions reader parses, not merely in the log', () => {
    // `listComputerActions` drops any record without a string `command`, which
    // is exactly how a `verb`-shaped event would vanish from the history.
    useFreshLedger();
    recordComputerAction({ command: 'screenshot', invocationId: 'engine-run-3', host: 'win-mini' });
    const actions = listComputerActions();
    expect(actions).toHaveLength(1);
    expect(actions[0].verb).toBe('screenshot');
    expect(actions[0].invocationId).toBe('engine-run-3');
    expect(actions[0].host).toBe('win-mini');
  });

  it('bounds the task preview HERE, even when the engine reports an unbounded one', () => {
    // The retention rule belongs to the ledger's owner. An engine that streamed
    // a full --task string must not be able to write it into the session index.
    useFreshLedger();
    const longTask = 'describe every window in exhaustive detail '.repeat(20);
    expect(longTask.length).toBeGreaterThan(TASK_PREVIEW_MAX_CHARS);
    recordComputerAction({ command: 'run', task: longTask });

    const rec = query({ eventTypes: ['computer.action'] })[0];
    expect((rec.task as string).length).toBeLessThanOrEqual(TASK_PREVIEW_MAX_CHARS);
    expect(JSON.stringify(rec)).not.toContain(longTask);
  });

  it('passes through extra detail the engine attaches', () => {
    useFreshLedger();
    recordComputerAction({ command: 'screenshot', out: '/tmp/shot.png' });
    expect(query({ eventTypes: ['computer.action'] })[0].out).toBe('/tmp/shot.png');
  });

  it('carries no target pid for an action the engine resolved no window for', () => {
    useFreshLedger();
    recordComputerAction({ command: 'run', task: 'x' });
    expect(query({ eventTypes: ['computer.action'] })[0].targetPid).toBeUndefined();
  });
});
