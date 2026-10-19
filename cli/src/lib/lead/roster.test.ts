import { describe, expect, it } from 'vitest';
import { FeedRoster, filterProject, formatAttention, formatRosterRow, rosterDelta, rosterRowFromFeed } from './roster.js';

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

describe('FeedRoster attention', () => {
  const ask = (key: string, extra: Record<string, unknown> = {}) => ({
    key, sessionId: key.split('/')[1], host: key.split('/')[0], kind: 'question', state: 'open', openedAt: '2026-10-19T10:00:00.000Z',
    question: { text: 'Which database?', header: 'DB' }, choices: [{ id: '1', label: 'Staging' }, { id: '2', label: 'Prod' }], urgency: 'normal', ...extra,
  });

  it('tracks open asks fleet-wide per scope through reset, upsert and remove', () => {
    const r = new FeedRoster();
    r.apply({ type: 'reset', scope: 'a', agents: [], attention: [ask('a/s1/1'), ask('a/s2/1', { state: 'answered' })] });
    r.apply({ type: 'reset', scope: 'b', agents: [], attention: [ask('b/s3/1', { project: 'other' })] });
    r.apply({ type: 'attention.upsert', scope: 'a', rowKey: 'a/s4/2', attention: ask('a/s4/2', { openedAt: '2026-10-19T09:00:00.000Z' }) });
    expect(r.openAttention().map((x) => x.key)).toEqual(['a/s4/2', 'a/s1/1', 'b/s3/1']);
    r.apply({ type: 'attention.upsert', scope: 'a', rowKey: 'a/s1/1', attention: ask('a/s1/1', { state: 'resolved' }) });
    r.apply({ type: 'attention.remove', scope: 'b', rowKey: 'b/s3/1' });
    expect(r.openAttention().map((x) => x.key)).toEqual(['a/s4/2']);
    r.apply({ type: 'reset', scope: 'a', agents: [], attention: [] });
    expect(r.openAttention()).toEqual([]);
  });

  it('prints one line per ask: key, title, host, project, age, trimmed question and choices', () => {
    const r = new FeedRoster();
    r.apply({ type: 'reset', scope: 'a', agents: [], attention: [ask('box/abcd1234/3', { project: 'demo', question: { text: `Pick one ${'x'.repeat(300)}` } })] });
    const [item] = r.openAttention();
    const line = formatAttention(item, { id: 'abcd1234', title: 'Fix login', status: 'idle', host: 'box' }, Date.parse('2026-10-19T10:05:00.000Z'));
    expect(line.startsWith('- box/abcd1234/3 “Fix login” on box · demo · 5m ago: Pick one x')).toBe(true);
    expect(line).toContain('… Choices: 1=Staging, 2=Prod');
    expect(formatAttention({ ...item, choices: [], question: undefined }, undefined, Date.parse('2026-10-19T12:00:00.000Z')))
      .toBe('- box/abcd1234/3 “abcd1234” on box · demo · 2h ago: (question, no question text) Free-text answer.');
  });

  it('a session line says when it started and was last active, from the feed row', () => {
    const now = Date.parse('2026-10-19T12:00:00.000Z');
    const row = rosterRowFromFeed('box', { sessionId: 'abcd1234-ffff', title: 'Fix login', status: 'idle', machine: 'box', startedAtMs: now - 26 * 3_600_000, lastActivityMs: now - 7 * 60_000 })!;
    expect(formatRosterRow(row, now)).toBe('- abcd1234 “Fix login” idle on box · started 26h ago · last active 7m ago');
    expect(formatRosterRow(rosterRowFromFeed('box', { sessionId: 'abcd1234-ffff', title: 'T', startedAtMs: 'x' })!, now)).toBe('- abcd1234 “T” unknown on box');
  });
});
