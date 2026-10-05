/** Tests for {@link foldExecutionMachine}: which box a live session runs on (RUSH-2479). `agents
 * run --device <peer>` leaves a shim on the dispatching box with the remote session id, so the row
 * got the dispatcher's name. The session index records the truth; this folds it onto the live row. */

import { describe, it, expect } from 'vitest';
import { foldExecutionMachine, sessionProcessIsLocal, sessionProcessHost, type ActiveSession } from './active.js';

const self = 'zion';

function row(over: Partial<ActiveSession>): ActiveSession {
  return { context: 'terminal', kind: 'claude', status: 'running', ...over } as ActiveSession;
}

/** An index that reports `machine` for the ids it knows, nothing for the rest. */
const index = (m: Record<string, string>) => (id: string) => m[id];

describe('foldExecutionMachine', () => {
  it('re-attributes a dispatched run to the machine it executes on', () => {
    const rows = [row({ sessionId: 'off', machine: self, label: '[host/yosemite-s0]' })];
    foldExecutionMachine(rows, index({ off: 'yosemite-s0' }), self);
    expect(rows[0].machine).toBe('yosemite-s0');
    expect(rows[0].offloadedFrom).toBe(self);
  });

  it('re-attributes a row that carries no machine yet', () => {
    const rows = [row({ sessionId: 'off', machine: undefined })];
    foldExecutionMachine(rows, index({ off: 'yosemite-s0' }), self);
    expect(rows[0].machine).toBe('yosemite-s0');
  });

  it('leaves a genuinely local session alone', () => {
    const rows = [row({ sessionId: 'here', machine: self })];
    foldExecutionMachine(rows, index({ here: self }), self);
    expect(rows[0].machine).toBe(self);
    expect(rows[0].offloadedFrom).toBeUndefined();
  });

  it('leaves a row alone when the index has never seen it', () => {
    const rows = [row({ sessionId: 'unknown', machine: self })];
    foldExecutionMachine(rows, index({}), self);
    expect(rows[0].machine).toBe(self);
    expect(rows[0].offloadedFrom).toBeUndefined();
  });

  it("never overrides a peer's own self-report from the fan-out", () => {
    // The row already came back from yosemite-s1 saying it runs there. This
    // box's index copy is hearsay by comparison and must not win.
    const rows = [row({ sessionId: 'peer', machine: 'yosemite-s1' })];
    foldExecutionMachine(rows, index({ peer: 'yosemite-s0' }), self);
    expect(rows[0].machine).toBe('yosemite-s1');
    expect(rows[0].offloadedFrom).toBeUndefined();
  });

  it('skips a row with no session id (nothing to join on)', () => {
    const rows = [row({ sessionId: undefined, machine: self })];
    foldExecutionMachine(rows, index({}), self);
    expect(rows[0].machine).toBe(self);
  });

  it('attributes each row independently in a mixed set', () => {
    const rows = [
      row({ sessionId: 'a', machine: self }),
      row({ sessionId: 'b', machine: self }),
      row({ sessionId: 'c', machine: self }),
    ];
    foldExecutionMachine(rows, index({ a: 'yosemite-s0', b: self }), self);
    expect(rows.map((r) => r.machine)).toEqual(['yosemite-s0', self, self]);
    expect(rows.map((r) => r.offloadedFrom)).toEqual([self, undefined, undefined]);
  });
});

/** `machine` is where the agent executes; `sessionProcessIsLocal` is where the process is. For an
 * offloaded run they differ, and conflating them sent a local tmux pane id to a peer's server,
 * which can attach an unrelated session. */
describe('sessionProcessIsLocal', () => {
  it('calls an offloaded run LOCAL — its shim, pane and window are on this box', () => {
    expect(sessionProcessIsLocal({ machine: 'yosemite-s0', offloadedFrom: 'zion' }, 'zion')).toBe(true);
  });

  it('calls a genuine peer session REMOTE', () => {
    expect(sessionProcessIsLocal({ machine: 'yosemite-s0' }, 'zion')).toBe(false);
  });

  it('calls this machine, and an untagged row, LOCAL', () => {
    expect(sessionProcessIsLocal({ machine: 'zion' }, 'zion')).toBe(true);
    expect(sessionProcessIsLocal({}, 'zion')).toBe(true);
  });

  it('disagrees with a bare machine comparison exactly on the offloaded row', () => {
    const row = { machine: 'yosemite-s0', offloadedFrom: 'zion' };
    // The predicate every caller used before this fix, and the bug it caused.
    expect(row.machine !== 'zion').toBe(true);
    expect(sessionProcessIsLocal(row, 'zion')).toBe(true);
  });

  // Three-box case: rows travel via `--active --json` fan-out with their foreign `machine`, so a
  // box that is neither dispatcher nor executor sees them. Answering "local" there risks the same
  // unrelated-pane attach.
  it('calls A-dispatched-to-B REMOTE when asked on a third box C', () => {
    expect(sessionProcessIsLocal({ machine: 'B', offloadedFrom: 'A' }, 'C')).toBe(false);
  });
});

describe('sessionProcessHost', () => {
  it('is undefined when the process is here — the offloaded shim on its dispatcher', () => {
    expect(sessionProcessHost({ machine: 'yosemite-s0', offloadedFrom: 'zion' }, 'zion')).toBeUndefined();
    expect(sessionProcessHost({ machine: 'zion' }, 'zion')).toBeUndefined();
    expect(sessionProcessHost({}, 'zion')).toBeUndefined();
  });

  it('points at the DISPATCHER for an offloaded row seen from a third box, not the executor', () => {
    // Correcting only the predicate would send C to B carrying A's pane id —
    // the hazard relocated rather than fixed. The process is on A.
    expect(sessionProcessHost({ machine: 'B', offloadedFrom: 'A' }, 'C')).toBe('A');
  });

  it('points at the peer for an ordinary remote session', () => {
    expect(sessionProcessHost({ machine: 'yosemite-s0' }, 'zion')).toBe('yosemite-s0');
  });
});
