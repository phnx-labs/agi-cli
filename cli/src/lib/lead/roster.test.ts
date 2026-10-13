import { describe, expect, it } from 'vitest';
import { FeedRoster, filterProject, rosterDelta } from './roster.js';

const agent = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  sessionId: id, title: `Title ${id}`, status, machine: 'box', confirmedProject: 'demo', previous: false, ...extra,
});

describe('FeedRoster', () => {
  it('replaces a scope on reset, applies upserts and removes, and drops history rows', () => {
    const r = new FeedRoster();
    expect(r.ready).toBe(false);
    r.apply({ type: 'reset', scope: 'a', agents: [agent('1', 'running', { rowKey: 'k1' }), agent('old', 'closed', { previous: true })] });
    r.apply({ type: 'reset', scope: 'b', agents: [agent('2', 'idle', { rowKey: 'k2' })] });
    r.apply({ type: 'agent.upsert', scope: 'a', rowKey: 'k3', agent: agent('3', 'running') });
    r.apply({ type: 'agent.upsert', scope: 'a', rowKey: 'k1', agent: agent('1', 'idle') });
    r.apply({ type: 'agent.remove', scope: 'b', rowKey: 'k2' });
    expect(r.ready).toBe(true);
    expect(Object.keys(r.snapshot()).sort()).toEqual(['1', '3']);
    expect(r.snapshot()['1'].status).toBe('idle');
    r.apply({ type: 'reset', scope: 'a', agents: [] });
    expect(r.snapshot()).toEqual({});
  });
});

describe('roster delta', () => {
  const row = (id: string, status: string) => ({ id: `${id}0000000-x`, title: `T${id}`, status, host: 'box' });
  it('lists starts, status changes and ends, and nothing when unchanged', () => {
    const snap = (...rows: ReturnType<typeof row>[]) => Object.fromEntries(rows.map((r) => [r.id, r]));
    const prev = snap(row('a', 'running'), row('b', 'idle'));
    const cur = snap(row('a', 'idle'), row('c', 'running'));
    expect(rosterDelta(prev, cur)).toEqual([
      '~ a0000000 “Ta” running → idle',
      '+ started c0000000 “Tc” running on box',
      '- ended b0000000 “Tb” (was idle on box)',
    ]);
    expect(rosterDelta(cur, cur)).toEqual([]);
  });

  it('filters to the project by cwd, then confirmedProject, excluding the Lead itself', () => {
    const snap = {
      x: { id: 'x', title: 'X', status: 'running', host: 'h', cwd: '/p/demo' },
      y: { id: 'y', title: 'Y', status: 'running', host: 'h', project: 'demo' },
      z: { id: 'z', title: 'Z', status: 'running', host: 'h', project: 'other' },
      lead: { id: 'lead', title: 'L', status: 'running', host: 'h', project: 'demo' },
    };
    const out = filterProject(snap, 'demo', (cwd) => (cwd?.startsWith('/p/demo') ? 'demo' : undefined), new Set(['lead']));
    expect(Object.keys(out).sort()).toEqual(['x', 'y']);
  });
});
