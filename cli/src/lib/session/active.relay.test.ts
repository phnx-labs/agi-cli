import { describe, expect, it } from 'vitest';
import { relayedTo } from './active.js';
import { SessionProjection } from './projection.js';
import { toSessionWatchRow, type SessionWatchEnvelope, type SessionWatchRow } from './watch.js';

const reset = (scope: string, rows: SessionWatchRow[]): SessionWatchEnvelope => ({ version: 1, type: 'reset', streamId: scope, sequence: 1, capturedAt: 1, scope, rows });

describe('a tab that relays its session to the owner device', () => {
  it('names the owner as the machine and this desktop as the origin', () => {
    expect(relayedTo({ machine: 'yosemite-m6' }, 'zion')).toEqual({ machine: 'yosemite-m6', offloadedFrom: 'zion' });
    expect(relayedTo({ machine: 'zion' }, 'zion')).toEqual({});
    expect(relayedTo({}, 'zion')).toEqual({});
    expect(relayedTo(undefined, 'zion')).toEqual({});
  });

  it('folds into the owner row as an observer instead of listing a second, unknown session', () => {
    const projection = new SessionProjection();
    const owner = toSessionWatchRow('yosemite-m6', { context: 'terminal', kind: 'claude', sessionId: 's1', status: 'idle', machine: 'yosemite-m6' });
    const tab = toSessionWatchRow('zion', { context: 'terminal', kind: 'claude', sessionId: 's1', status: 'unknown', terminalId: 'cl-1', workspaceDir: '/Users/me/src/agents', ...relayedTo({ machine: 'yosemite-m6' }, 'zion') });
    projection.apply(reset('yosemite-m6', [owner]));
    const out = projection.apply(reset('zion', [tab]));
    const rows = new Map<string, SessionWatchRow>();
    for (const e of out) {
      if (e.type === 'reset') for (const r of e.rows) rows.set(r.rowKey, r);
      if (e.type === 'upsert') rows.set(e.rowKey, e.row);
    }
    const s1 = [...rows.values()].filter((r) => r.sessionId === 's1');
    expect(s1).toHaveLength(1);
    expect(s1[0]).toMatchObject({ machine: 'yosemite-m6', status: 'idle' });
    expect(s1[0].observerTerminals).toEqual([expect.objectContaining({ device: 'zion', terminalId: 'cl-1', workspaceDir: '/Users/me/src/agents' })]);
  });

  it('a tab opened before the relay was recorded still folds into the device that has the transcript', () => {
    const projection = new SessionProjection();
    const owner = toSessionWatchRow('yosemite-m6', { context: 'terminal', kind: 'claude', sessionId: 's2', status: 'idle', machine: 'yosemite-m6', sessionFile: '/home/me/.claude/projects/x/s2.jsonl' });
    const tab = toSessionWatchRow('zion', { context: 'terminal', kind: 'claude', sessionId: 's2', status: 'unknown', terminalId: 'cl-2', machine: 'zion' });
    projection.apply(reset('zion', [tab]));
    const out = projection.apply(reset('yosemite-m6', [owner]));
    const rows = new Map<string, SessionWatchRow>();
    for (const e of out) {
      if (e.type === 'reset') for (const r of e.rows) rows.set(r.rowKey, r);
      if (e.type === 'upsert') rows.set(e.rowKey, e.row);
      if (e.type === 'remove') rows.delete(e.rowKey);
    }
    const s2 = [...rows.values()].filter((r) => r.sessionId === 's2');
    expect(s2).toHaveLength(1);
    expect(s2[0]).toMatchObject({ machine: 'yosemite-m6', status: 'idle' });
    expect(s2[0].observerTerminals?.map((o) => o.device)).toEqual(['zion']);
  });
});
