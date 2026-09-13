import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  listStandaloneComputerActions,
  mergeComputerActionSources,
  groupIntoComputerRuns,
  type ComputerAction,
} from './sessions-list.js';

const roots: string[] = [];
function ledgerDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-actions-'));
  roots.push(dir);
  return dir;
}
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

/** One line exactly as the standalone engine appends it. */
function line(record: Record<string, unknown>): string {
  return `${JSON.stringify({ event: 'computer.action', ...record })}\n`;
}

describe('the standalone computer action ledger', () => {
  it('reads the engine\'s own records, which never reach the feed ledger', () => {
    // The regression this covers: `computer` run directly by an operator writes
    // ONLY here, so reading the feed ledger alone showed no actions at all.
    const dir = ledgerDir();
    fs.writeFileSync(path.join(dir, '2026-09-13.jsonl'),
      line({ command: 'run', ts: '2026-09-13T10:00:00Z', pid: 11, invocationId: 'inv-a', task: 'fill the form' })
      + line({ command: 'click', ts: '2026-09-13T10:00:01Z', pid: 11, invocationId: 'inv-a', bundle: 'com.apple.Safari' })
      + line({ command: 'screenshot', ts: '2026-09-13T10:00:02Z', pid: 11, invocationId: 'inv-a', capture: { kind: 'screenshot', path: '/caps/window.jpg', name: 'window.jpg', bytes: 7082 } }));

    const actions = listStandaloneComputerActions({ dir });
    expect(actions.map((action) => action.verb)).toEqual(['screenshot', 'click', 'run']);
    expect(actions.every((action) => action.invocationId === 'inv-a')).toBe(true);
    const shot = actions.find((action) => action.verb === 'screenshot')!;
    expect(shot.capture).toEqual({ kind: 'screenshot', path: '/caps/window.jpg', name: 'window.jpg', bytes: 7082 });
  });

  it('reports no capture for an action the producer recorded none for', () => {
    const dir = ledgerDir();
    fs.writeFileSync(path.join(dir, '2026-09-13.jsonl'),
      // A failed write leaves the action with no capture — never a guessed path.
      line({ command: 'screenshot', ts: '2026-09-13T10:00:02Z', pid: 11, invocationId: 'inv-a' })
      + line({ command: 'screenshot', ts: '2026-09-13T10:00:03Z', pid: 11, invocationId: 'inv-a', capture: { kind: 'screenshot', name: 'x.jpg' } }));
    const actions = listStandaloneComputerActions({ dir });
    expect(actions.map((action) => action.capture)).toEqual([undefined, undefined]);
  });

  it('derives a capture name from its path when the producer omitted one', () => {
    const dir = ledgerDir();
    fs.writeFileSync(path.join(dir, '2026-09-13.jsonl'),
      line({ command: 'screenshot', ts: '2026-09-13T10:00:02Z', pid: 1, capture: { kind: 'screenshot', path: '/caps/deep/shot.jpg' } }));
    expect(listStandaloneComputerActions({ dir })[0]!.capture)
      .toEqual({ kind: 'screenshot', path: '/caps/deep/shot.jpg', name: 'shot.jpg' });
  });

  it('skips malformed and partial lines instead of throwing', () => {
    const dir = ledgerDir();
    fs.writeFileSync(path.join(dir, '2026-09-13.jsonl'),
      line({ command: 'click', ts: '2026-09-13T10:00:01Z', pid: 1, invocationId: 'ok' })
      + '{"command":"click"}\n'            // no timestamp
      + '{"ts":"2026-09-13T10:00:02Z"}\n'  // no verb
      + '{"command":"click","ts":"nope"}\n' // unparseable timestamp
      + 'not json at all\n'
      + '{"command":"type","ts":"2026-09-13T10:00:03Z"'); // a write in progress
    const actions = listStandaloneComputerActions({ dir });
    expect(actions.map((action) => action.verb)).toEqual(['click']);
  });

  it('reads newest days first and stops at the budget', () => {
    const dir = ledgerDir();
    fs.writeFileSync(path.join(dir, '2026-09-11.jsonl'), line({ command: 'old', ts: '2026-09-11T10:00:00Z', pid: 1 }));
    fs.writeFileSync(path.join(dir, '2026-09-13.jsonl'),
      Array.from({ length: 5 }, (_, i) => line({ command: `new${i}`, ts: `2026-09-13T10:00:0${i}Z`, pid: 1 })).join(''));
    const bounded = listStandaloneComputerActions({ dir, limit: 3 });
    expect(bounded).toHaveLength(3);
    // Newest-first within the budget: the old day is never reached.
    expect(bounded.map((action) => action.verb)).toEqual(['new4', 'new3', 'new2']);
  });

  it('returns nothing when the engine has never run here', () => {
    expect(listStandaloneComputerActions({ dir: path.join(ledgerDir(), 'absent') })).toEqual([]);
  });
});

describe('merging the two ledgers', () => {
  const action = (extra: Partial<ComputerAction>): ComputerAction => ({
    verb: 'click', ts: '2026-09-13T10:00:00Z', tsMs: 1_000, pid: 1, ...extra,
  });

  it('prefers the standalone record for a run present in both', () => {
    // A forwarded `agents computer` writes BOTH stores, and the forwarding
    // rewrites ts and pid — so the two copies disagree on exactly the fields a
    // timestamp/pid dedupe would key on. invocationId is echoed unchanged.
    const standalone = [action({ invocationId: 'inv-a', pid: 11, tsMs: 1_000, bundle: 'com.apple.Safari' })];
    const legacy = [action({ invocationId: 'inv-a', pid: 99, tsMs: 5_000, bundle: 'rewritten' })];
    const merged = mergeComputerActionSources(standalone, legacy);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.pid).toBe(11);
    expect(merged[0]!.bundle).toBe('com.apple.Safari');
  });

  it('keeps a legacy record whose run the standalone ledger never saw', () => {
    const merged = mergeComputerActionSources(
      [action({ invocationId: 'inv-a', tsMs: 1_000 })],
      [action({ invocationId: 'inv-b', tsMs: 2_000 })],
    );
    expect(merged.map((entry) => entry.invocationId)).toEqual(['inv-b', 'inv-a']);
  });

  it('keeps an invocationId-less legacy record rather than dropping history', () => {
    // It cannot be matched to anything, so dropping it would lose a row the
    // standalone ledger never had.
    const merged = mergeComputerActionSources([action({ invocationId: 'inv-a' })], [action({ invocationId: undefined, tsMs: 9_000 })]);
    expect(merged).toHaveLength(2);
  });

  it('produces ONE run row for a forwarded command, not two', () => {
    const standalone = [
      action({ invocationId: 'inv-a', verb: 'run', task: 'do it', tsMs: 1_000, pid: 11, hostname: 'm1' }),
      action({ invocationId: 'inv-a', verb: 'click', tsMs: 1_100, pid: 11, hostname: 'm1' }),
    ];
    const legacy = [
      action({ invocationId: 'inv-a', verb: 'run', task: 'do it', tsMs: 7_000, pid: 99, hostname: 'm1' }),
      action({ invocationId: 'inv-a', verb: 'click', tsMs: 7_100, pid: 99, hostname: 'm1' }),
    ];
    const rows = groupIntoComputerRuns(mergeComputerActionSources(standalone, legacy));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.counts).toEqual({ click: 1 });
    expect(rows[0]!.pid).toBe(11);
  });
});
