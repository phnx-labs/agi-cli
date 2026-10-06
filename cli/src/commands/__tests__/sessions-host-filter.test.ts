
import { describe, it, expect } from 'vitest';
import { hasNoBrowserDisqualifyingFlags } from '../sessions.js';
import { filterActiveSessionsByHostScope } from '../ps-roster.js';
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

describe('hasNoBrowserDisqualifyingFlags (bare interactive --host routing)', () => {
  it('allows a bare --host listing (no query, no flags) into the browser', () => {
    expect(hasNoBrowserDisqualifyingFlags({ host: ['yosemite-s0'] } as any, undefined)).toBe(true);
  });

  it('keeps the raw stream for a --host search (a query the picker path owns)', () => {
    expect(hasNoBrowserDisqualifyingFlags({ host: ['yosemite-s0'] } as any, 'auth bug')).toBe(false);
  });

  it('keeps the raw stream when a render/filter flag is set', () => {
    for (const flags of [{ flat: true }, { tree: true }, { markdown: true }, { until: '2d' }, { project: 'x' }, { sort: 'cost' }, { artifacts: true }, { skill: 'design' }, { plugin: 'rush' }]) {
      expect(hasNoBrowserDisqualifyingFlags({ host: ['yosemite-s0'], ...flags } as any, undefined)).toBe(false);
    }
  });

  it('#12: --skill/--plugin must not silently fall through to the unfiltered browser', () => {
    expect(hasNoBrowserDisqualifyingFlags({ skill: 'design' } as any, undefined)).toBe(false);
    expect(hasNoBrowserDisqualifyingFlags({ plugin: 'rush' } as any, undefined)).toBe(false);
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
