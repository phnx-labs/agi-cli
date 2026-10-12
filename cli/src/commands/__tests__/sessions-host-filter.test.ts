
import { describe, it, expect } from 'vitest';
import { filterActiveSessionsByHostScope } from '../../lib/session/active.js';
import { shouldIncludeLocal, remoteHostsToDial } from '../../lib/session/remote-list.js';
import type { ActiveSession } from '../../lib/session/active.js';

describe('shouldIncludeLocal', () => {
  const self = 'zion';

  it('includes local when no --host is given (full fleet view)', () => {
    expect(shouldIncludeLocal(undefined, self)).toBe(true);
    expect(shouldIncludeLocal([], self)).toBe(true);
  });

  it('drops local when --host names only other machines (the fix: filter, not add)', () => {
    expect(shouldIncludeLocal(['yosemite-s0'], self)).toBe(false);
    expect(shouldIncludeLocal(['yosemite-s0', 'yosemite-s1'], self)).toBe(false);
  });

  it('includes local when it is itself named among the hosts', () => {
    expect(shouldIncludeLocal(['zion'], self)).toBe(true);
    expect(shouldIncludeLocal(['yosemite-s0', 'zion'], self)).toBe(true);
  });

  it('matches self by normalized id — case, domain suffix, and user@host', () => {
    expect(shouldIncludeLocal(['ZION'], self)).toBe(true);
    expect(shouldIncludeLocal(['zion.tail1a85a1.ts.net'], self)).toBe(true);
    expect(shouldIncludeLocal(['muqsit@zion'], self)).toBe(true);
  });

  it('does not treat a different machine as self', () => {
    expect(shouldIncludeLocal(['muqsit@yosemite-s0'], self)).toBe(false);
  });
});

describe('remoteHostsToDial', () => {
  const self = 'zion';

  it('returns undefined with no --host (auto-discovery sweep)', () => {
    expect(remoteHostsToDial(undefined, self)).toBeUndefined();
    expect(remoteHostsToDial([], self)).toBeUndefined();
  });

  it('dials exactly the named non-self hosts', () => {
    expect(remoteHostsToDial(['yosemite-s0', 'yosemite-s1'], self)).toEqual(['yosemite-s0', 'yosemite-s1']);
  });

  it('drops self from the dial list (local seed covers it — no self-SSH, no spurious "unreachable")', () => {
    expect(remoteHostsToDial(['zion', 'yosemite-s0'], self)).toEqual(['yosemite-s0']);
  });

  it('returns [] when the only named host is self (caller then skips the fan-out)', () => {
    expect(remoteHostsToDial(['zion'], self)).toEqual([]);
    expect(remoteHostsToDial(['zion.tail1a85a1.ts.net'], self)).toEqual([]);
  });
});

describe('filterActiveSessionsByHostScope', () => {
  const self = 'zion';
  const row = (over: Partial<ActiveSession>): ActiveSession =>
    ({ context: 'terminal', kind: 'claude', status: 'running', ...over }) as ActiveSession;

  it('passes everything through when no host is scoped (full fleet view)', () => {
    const rows = [row({ machine: 'zion' }), row({ machine: 'yosemite-s0' })];
    expect(filterActiveSessionsByHostScope(rows, undefined, self)).toHaveLength(2);
    expect(filterActiveSessionsByHostScope(rows, [], self)).toHaveLength(2);
  });

  it('drops a session that zion dispatched but yosemite-s0 is executing', () => {
    const rows = [
      row({ machine: 'zion', sessionId: 'here' }),
      row({ machine: 'yosemite-s0', sessionId: 'offloaded', offloadedFrom: 'zion' }),
    ];
    const out = filterActiveSessionsByHostScope(rows, ['zion'], self);
    expect(out.map((s) => s.sessionId)).toEqual(['here']);
  });

  it('keeps that same session under the machine it actually runs on', () => {
    const rows = [row({ machine: 'yosemite-s0', sessionId: 'offloaded', offloadedFrom: 'zion' })];
    expect(filterActiveSessionsByHostScope(rows, ['yosemite-s0'], self)).toHaveLength(1);
  });

  it('treats an untagged row as this machine', () => {
    const rows = [row({ machine: undefined, sessionId: 'local' })];
    expect(filterActiveSessionsByHostScope(rows, ['zion'], self)).toHaveLength(1);
    expect(filterActiveSessionsByHostScope(rows, ['yosemite-s0'], self)).toHaveLength(0);
  });

  it('matches a host the same way the seed does — case, domain suffix, user@host', () => {
    const rows = [row({ machine: 'yosemite-s0' })];
    for (const h of ['YOSEMITE-S0', 'yosemite-s0.tail.ts.net', 'muqsit@yosemite-s0']) {
      expect(filterActiveSessionsByHostScope(rows, [h], self)).toHaveLength(1);
    }
  });

  it('unions a multi-host scope', () => {
    const rows = [row({ machine: 'zion' }), row({ machine: 'yosemite-s0' }), row({ machine: 'mac-mini' })];
    const out = filterActiveSessionsByHostScope(rows, ['zion', 'mac-mini'], self);
    expect(out.map((s) => s.machine)).toEqual(['zion', 'mac-mini']);
  });
});
