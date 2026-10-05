
import { describe, it, expect } from 'vitest';
import { foldExecutionMachine, sessionProcessIsLocal, sessionProcessHost, type ActiveSession } from './active.js';

const self = 'zion';

function row(over: Partial<ActiveSession>): ActiveSession {
  return { context: 'terminal', kind: 'claude', status: 'running', ...over } as ActiveSession;
}

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
    expect(row.machine !== 'zion').toBe(true);
    expect(sessionProcessIsLocal(row, 'zion')).toBe(true);
  });

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
    expect(sessionProcessHost({ machine: 'B', offloadedFrom: 'A' }, 'C')).toBe('A');
  });

  it('points at the peer for an ordinary remote session', () => {
    expect(sessionProcessHost({ machine: 'yosemite-s0' }, 'zion')).toBe('yosemite-s0');
  });
});
