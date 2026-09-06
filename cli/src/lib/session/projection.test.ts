import { describe, expect, it } from 'vitest';
import { SessionProjection } from './projection.js';
import { toSessionWatchRow, type SessionWatchEnvelope, type SessionWatchRow } from './watch.js';

const row = (scope: string, extra: Partial<SessionWatchRow> = {}) => ({ ...toSessionWatchRow(scope, { context: 'terminal', kind: 'codex', sessionId: 'exact-id', status: 'running', machine: 'worker' }), ...extra });
const reset = (scope: string, rows: SessionWatchRow[]): SessionWatchEnvelope => ({ version: 1, type: 'reset', streamId: scope, sequence: 1, capturedAt: 1, scope, rows });
const update = (scope: string, r: SessionWatchRow): SessionWatchEnvelope => ({ ...reset(scope, []), type: 'upsert', rowKey: r.rowKey, row: r });
function client() {
  const projection = new SessionProjection();
  const rows = new Map<string, SessionWatchRow>();
  return { rows, apply(event: SessionWatchEnvelope) {
    for (const e of projection.apply(event)) {
      if (e.type === 'reset') { for (const [key, r] of rows) if (r.sourceDevice === e.scope) rows.delete(key); for (const r of e.rows) rows.set(r.rowKey, r); }
      if (e.type === 'upsert') rows.set(e.rowKey, e.row);
      if (e.type === 'remove') rows.delete(e.rowKey);
    }
    return [...rows.values()];
  } };
}

describe('execution-owned session projection', () => {
  it.each([true, false])('converges regardless of launcher-first=%s without borrowing launcher state', launcherFirst => {
    const c = client();
    const launcher = reset('desktop', [row('desktop', { terminalId: 'tab', viewingIn: 'VSCodium', status: 'idle' })]);
    const owner = reset('worker', [row('worker', { attachments: [{ path: '/uploads/diagram.png', name: 'diagram.png', type: 'image' }] as SessionWatchRow['attachments'], preview: 'real progress', firstUserMessage: 'real request', status: 'running' })]);
    c.apply(launcherFirst ? launcher : owner);
    const rows = c.apply(launcherFirst ? owner : launcher);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sourceDevice: 'worker', machine: 'worker', status: 'running', preview: 'real progress', firstUserMessage: 'real request', observerTerminals: expect.arrayContaining([expect.objectContaining({ device: 'desktop', terminalId: 'tab' })]) });
    expect(rows[0].terminalId).toBeUndefined();
    expect(rows[0].attachments).toEqual([{ path: '/uploads/diagram.png', name: 'diagram.png', type: 'image' }]);
  });

  it('retains owner on disconnect, replaces on reconnect, and refuses stale launcher resurrection', () => {
    const c = client();
    c.apply(reset('desktop', [row('desktop')]));
    const owned = row('worker', { preview: 'owner', status: 'waiting' });
    c.apply(reset('worker', [owned]));
    expect(c.apply({ ...reset('worker', []), type: 'scope', status: 'unavailable' })[0].status).toBe('waiting');
    expect(c.apply(update('desktop', row('desktop', { preview: 'stale' })))[0].preview).toBe('owner');
    expect(c.apply(reset('worker', []))).toEqual([]);
    expect(c.apply(update('desktop', row('desktop', { preview: 'still stale' })))).toEqual([]);
    expect(c.apply(reset('worker', [owned]))).toHaveLength(1);
    expect(c.apply({ ...reset('worker', []), type: 'remove', rowKey: owned.rowKey })).toEqual([]);
  });

  it('lets genuine live owner beat history and stale richer launcher, then displays owner history', () => {
    const c = client();
    c.apply(reset('desktop', [row('desktop', { preview: 'stale', lastActivityMs: 999 })]));
    const history = row('worker', { previous: true, rowKey: 'history', preview: 'old', lastActivityMs: 99 });
    const live = row('worker', { preview: '', lastActivityMs: 1 });
    expect(c.apply(reset('worker', [history, live]))[0].preview).toBe('');
    expect(c.apply({ ...reset('worker', []), type: 'remove', rowKey: live.rowKey })[0]).toMatchObject({ previous: true, preview: 'old' });
  });

  it('retires an id-less placeholder only through unambiguous exact launch identity', () => {
    const c = client();
    c.apply(reset('desktop', [row('desktop', { sessionId: undefined, launchId: 'launch', terminalId: 'tab' })]));
    const rows = c.apply(reset('worker', [row('worker', { launchId: 'launch', preview: 'actual' })]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId: 'exact-id', preview: 'actual', observerTerminals: expect.arrayContaining([expect.objectContaining({ device: 'desktop', terminalId: 'tab' })]) });
  });

  it('does not join different exact ids, harnesses, or execution owners', () => {
    const c = client();
    expect(c.apply(reset('worker', [row('worker'), row('worker', { rowKey: 'two', sessionId: 'exact-id-2' }), row('worker', { rowKey: 'three', kind: 'claude' })]))).toHaveLength(3);
    expect(c.apply(reset('peer', [row('peer', { machine: 'peer' })]))).toHaveLength(4);
  });
});
