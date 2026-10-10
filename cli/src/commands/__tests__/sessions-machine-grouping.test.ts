
import { describe, it, expect } from 'vitest';
import { pickerColumnsFor } from '../sessions.js';
import { mergeLocalFirst } from '../../lib/session/selection.js';
import { groupSessionsByMachine, dedupeByMachineSession } from '../ps-roster.js';
import type { ActiveSession } from '../../lib/session/active.js';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';

function mk(overrides: Partial<ActiveSession>): ActiveSession {
  return {
    context: 'terminal',
    kind: 'claude',
    status: 'running',
    ...overrides,
  };
}

function mkMeta(overrides: Partial<SessionMeta>): SessionMeta {
  return {
    id: overrides.id ?? 's',
    shortId: overrides.shortId ?? overrides.id ?? 's',
    agent: 'claude',
    timestamp: '2026-07-01T00:00:00Z',
    filePath: '/x.jsonl',
    ...overrides,
  };
}

describe('groupSessionsByMachine', () => {
  it('pins the local machine first even when it has fewer sessions', () => {
    const layout = groupSessionsByMachine(
      [
        mk({ machine: 'zion', sessionId: 'z1' }),
        mk({ machine: 'zion', sessionId: 'z2' }),
        mk({ machine: 'yosemite-s0', sessionId: 'l1' }),
      ],
      'yosemite-s0',
    );
    expect(layout.machines.map((m) => m.machine)).toEqual(['yosemite-s0', 'zion']);
    expect(layout.machines[0].isLocal).toBe(true);
    expect(layout.machines[1].isLocal).toBe(false);
  });

  it('sorts non-local machines by session count desc, then name', () => {
    const layout = groupSessionsByMachine(
      [
        mk({ machine: 'alpha', sessionId: 'a1' }),
        mk({ machine: 'beta', sessionId: 'b1' }),
        mk({ machine: 'beta', sessionId: 'b2' }),
        mk({ machine: 'gamma', sessionId: 'g1' }),
      ],
      'local-box',
    );
    expect(layout.machines.map((m) => m.machine)).toEqual(['beta', 'alpha', 'gamma']);
  });

  it('prefers the explicit machine tag over the provenance host', () => {
    const layout = groupSessionsByMachine(
      [mk({ machine: 'tagged', provenance: { host: 'provhost' } as any, sessionId: 's1' })],
      'local-box',
    );
    expect(layout.machines[0].machine).toBe('tagged');
  });

  it('falls back to the normalized provenance host when there is no tag', () => {
    const layout = groupSessionsByMachine(
      [mk({ provenance: { host: 'ZION.tail1a85a1.ts.net' } as any, sessionId: 's1' })],
      'local-box',
    );
    expect(layout.machines[0].machine).toBe('zion');
  });

  it('falls back to the local machine for an untagged, provenance-less session', () => {
    const layout = groupSessionsByMachine([mk({ sessionId: 's1' })], 'local-box');
    expect(layout.machines).toHaveLength(1);
    expect(layout.machines[0].machine).toBe('local-box');
    expect(layout.machines[0].isLocal).toBe(true);
  });

  it('still splits a machine into its workspace layout', () => {
    const layout = groupSessionsByMachine(
      [
        mk({ machine: 'zion', cwd: '/repo/a', sessionId: 's1' }),
        mk({ machine: 'zion', cwd: '/repo/b', sessionId: 's2' }),
      ],
      'local-box',
    );
    expect(layout.machines[0].total).toBe(2);
    expect(layout.machines[0].layout.workspaces).toHaveLength(2);
  });

  it('lifts cloud tasks into their own top-level "cloud" group, off the querier machine, sorted last', () => {
    const layout = groupSessionsByMachine(
      [
        mk({ context: 'cloud', machine: 'zion', sessionId: 'task_e', kind: 'codex', status: 'queued' }),
        mk({ context: 'cloud', machine: 'zion', sessionId: 'vclfel94', status: 'waiting' }),
        mk({ machine: 'zion', cwd: '/repo/a', sessionId: 'local1' }),
      ],
      'zion',
    );
    expect(layout.machines.map((m) => m.machine)).toEqual(['zion', 'cloud']);
    const zion = layout.machines.find((m) => m.machine === 'zion')!;
    const cloud = layout.machines.find((m) => m.machine === 'cloud')!;
    expect(zion.total).toBe(1);
    expect(cloud.total).toBe(2);
    expect(cloud.isLocal).toBe(false);
  });
});

describe('dedupeByMachineSession', () => {
  it('collapses the same session seen twice on one machine', () => {
    const out = dedupeByMachineSession([
      mk({ machine: 'zion', sessionId: 'dup' }),
      mk({ machine: 'zion', sessionId: 'dup' }),
    ]);
    expect(out).toHaveLength(1);
  });

  it('keeps identically-numbered sessions on different machines', () => {
    const out = dedupeByMachineSession([
      mk({ machine: 'zion', sessionId: 'same' }),
      mk({ machine: 'yosemite-s1', sessionId: 'same' }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('keeps every session that has no sessionId (uncorrelatable)', () => {
    const out = dedupeByMachineSession([
      mk({ machine: 'zion', sessionId: undefined }),
      mk({ machine: 'zion', sessionId: undefined }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('prefers the executing machine\'s row over the dispatcher\'s offload shim', () => {
    const out = dedupeByMachineSession([
      mk({ machine: 'yosemite-s0', sessionId: 'off', offloadedFrom: 'zion', label: '[host/yosemite-s0]' }),
      mk({ machine: 'yosemite-s0', sessionId: 'off', sessionFile: '/t.jsonl', topic: 'real work' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].offloadedFrom).toBeUndefined();
    expect(out[0].topic).toBe('real work');
  });

  it('keeps the shim when it is the only row for that session (peer unreachable)', () => {
    const out = dedupeByMachineSession([
      mk({ machine: 'yosemite-s0', sessionId: 'off', offloadedFrom: 'zion' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].offloadedFrom).toBe('zion');
  });

  it('does not reorder when the first row is already the executing machine\'s', () => {
    const out = dedupeByMachineSession([
      mk({ machine: 'yosemite-s0', sessionId: 'off', topic: 'real work' }),
      mk({ machine: 'yosemite-s0', sessionId: 'off', offloadedFrom: 'zion' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].topic).toBe('real work');
  });
});

describe('mergeLocalFirst', () => {
  it('puts the local machine block first, then remotes by count desc then name', () => {
    const merged = mergeLocalFirst(
      [
        mkMeta({ id: 'a1', machine: 'alpha' }),
        mkMeta({ id: 'l1', machine: 'yosemite-s0' }),
        mkMeta({ id: 'b1', machine: 'beta' }),
        mkMeta({ id: 'b2', machine: 'beta' }),
      ],
      'yosemite-s0',
    );
    expect(merged.map((s) => s.machine)).toEqual(['yosemite-s0', 'beta', 'beta', 'alpha']);
  });

  it('treats an untagged session as local (discover leaves local rows implicit)', () => {
    const merged = mergeLocalFirst(
      [mkMeta({ id: 'r1', machine: 'zion' }), mkMeta({ id: 'x1', machine: undefined })],
      'yosemite-s0',
    );
    expect(merged[0].machine).toBeUndefined();
    expect(merged[1].machine).toBe('zion');
  });

  it('preserves incoming (timestamp) order within a machine block', () => {
    const merged = mergeLocalFirst(
      [
        mkMeta({ id: 'l-new', machine: 'local' }),
        mkMeta({ id: 'l-old', machine: 'local' }),
      ],
      'local',
    );
    expect(merged.map((s) => s.id)).toEqual(['l-new', 'l-old']);
  });

  it('collapses a session present both locally and via fan-out (same machine + id)', () => {
    const merged = mergeLocalFirst(
      [
        mkMeta({ id: 'dup', machine: 'zion' }),
        mkMeta({ id: 'dup', machine: 'zion' }),
      ],
      'local',
    );
    expect(merged).toHaveLength(1);
  });

  it('keeps identically-numbered sessions that live on different machines', () => {
    const merged = mergeLocalFirst(
      [
        mkMeta({ id: 'same', machine: 'local' }),
        mkMeta({ id: 'same', machine: 'zion' }),
      ],
      'local',
    );
    expect(merged).toHaveLength(2);
  });
});

describe('pickerColumnsFor machine column width', () => {
  it('sizes the column to fit the widest hostname whole (no ellipsis truncation)', () => {
    const cols = pickerColumnsFor([
      mkMeta({ id: 'a', machine: 'yosemite-s0' }),
      mkMeta({ id: 'b', machine: 'zion' }),
    ]);
    expect(cols.showMachine).toBe(true);
    expect(cols.machineWidth).toBe(12);
  });

  it('uses the COMPACTED label width when a shared prefix is stripped', () => {
    const cols = pickerColumnsFor([
      mkMeta({ id: 'a', machine: 'yosemite-s0' }),
      mkMeta({ id: 'b', machine: 'yosemite-s1' }),
    ]);
    expect(cols.machineWidth).toBe(8);
  });

  it('caps the column so a pathological hostname cannot devour the row', () => {
    const cols = pickerColumnsFor([
      mkMeta({ id: 'a', machine: 'a-really-absurdly-long-hostname-that-goes-on' }),
      mkMeta({ id: 'b', machine: 'zion' }),
    ]);
    expect(cols.machineWidth).toBe(18);
  });
});
