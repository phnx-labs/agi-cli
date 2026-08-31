import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ActiveSession } from '../active.js';
import { SessionWatchState, sessionWatchRowKey, watchLocalSessions, toSessionWatchRow, type SessionWatchRow } from './watch.js';

const row = (sessionId: string, status: ActiveSession['status'] = 'running'): ActiveSession => ({
  context: 'terminal', kind: 'codex', sessionId, status, cwd: '/repo', lastActivityMs: 10,
});

describe('toSessionWatchRow resumable gating (reap dead crash-orphans)', () => {
  it('marks a dead, days-stale orphan non-resumable with no recovery command', () => {
    const r = toSessionWatchRow('zion', { context: 'terminal', kind: 'codex', sessionId: 'x', status: 'abandoned', pidAlive: false, cwd: '/repo' });
    expect(r.resumable).toBe(false);
    expect(r.recovery).toBeNull();
  });

  it('keeps a live/idle-unfinished session resumable', () => {
    const r = toSessionWatchRow('zion', { context: 'terminal', kind: 'codex', sessionId: 'x', status: 'idle', pidAlive: true, cwd: '/repo' });
    expect(r.resumable).toBe(true);
    expect(r.recovery).toMatchObject({ command: 'agents', args: ['sessions', 'resume', 'x', '--device', 'zion'] });
  });

  it('keeps a recently-closed session resumable (not yet stale)', () => {
    const r = toSessionWatchRow('zion', { context: 'terminal', kind: 'codex', sessionId: 'x', status: 'closed', pidAlive: false, cwd: '/repo' });
    expect(r.resumable).toBe(true);
  });
});

describe('session watch protocol', () => {
  it('emits a versioned reset followed by stable-key deltas with monotonic sequence numbers', () => {
    const state = new SessionWatchState('stream-1');
    const reset = state.reset('zion', [row('a'), row('b')]);
    expect(reset).toMatchObject({ version: 1, type: 'reset', streamId: 'stream-1', sequence: 1, scope: 'zion' });
    const events = state.update('zion', [row('a', 'idle'), row('c')]);
    expect(events.map((event) => [event.type, event.sequence])).toEqual([['upsert', 2], ['upsert', 3], ['remove', 4]]);
    expect(sessionWatchRowKey('zion', row('a'))).toBe(sessionWatchRowKey('zion', row('a')));
  });

  it('marks a scope unavailable without removing its retained rows', () => {
    const state = new SessionWatchState('stream-2');
    state.reset('box', [row('retained', 'crashed')]);
    expect(state.scope('box', 'unavailable', 'ssh closed')).toMatchObject({ type: 'scope', status: 'unavailable', sequence: 2 });
    expect(state.update('box', [row('retained', 'crashed')])).toEqual([]);
  });

  it('reads one reset then consumes multiple writer ticks with zero repeated gathers', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-watch-'));
    const journalPath = path.join(dir, 'active.jsonl');
    const controller = new AbortController();
    let snapshotReads = 0;
    const events: Array<{ type: string }> = [];
    const watching = watchLocalSessions({
      scope: 'local', signal: controller.signal, journalPath, journalPollMs: 5, heartbeatMs: 1_000,
      readPrevious: () => [],
      readCache: () => {
        snapshotReads++;
        return { version: 1, scope: 'local', capturedAt: 1, sessions: [row('a')] };
      },
      emit: (event) => {
        events.push(event);
        if (events.filter((candidate) => candidate.type === 'upsert').length === 2) controller.abort();
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.appendFileSync(journalPath, `${JSON.stringify({ version: 1, scope: 'local', capturedAt: 2, upserts: [row('a', 'idle')], removes: [] })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.appendFileSync(journalPath, `${JSON.stringify({ version: 1, scope: 'local', capturedAt: 3, upserts: [row('a', 'running'), row('b')], removes: [] })}\n`);
    await watching;
    expect(snapshotReads).toBe(1);
    expect(events.filter((event) => event.type === 'upsert')).toHaveLength(3);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const previousRow = (sessionId: string, firstUserMessage: string): ActiveSession => ({
    context: 'headless', kind: 'claude', sessionId, status: 'closed', cwd: '/repo',
    firstUserMessage, version: '2.1.200', account: 'a@b.com', harness: 'claude',
    lastActivityMs: 5, previous: true,
  });

  it('initial reset folds durable Previous rows in beside the live set (PHNX-3621)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-watch-prev-'));
    const journalPath = path.join(dir, 'active.jsonl');
    const controller = new AbortController();
    let reset: { type: string; rows: SessionWatchRow[] } | undefined;
    const watching = watchLocalSessions({
      scope: 'zion', signal: controller.signal, journalPath, journalPollMs: 5, heartbeatMs: 1_000,
      readCache: () => ({ version: 1, scope: 'local', capturedAt: 1, sessions: [row('live-1')] }),
      readPrevious: () => [previousRow('prev-1', 'the original ask, verbatim')],
      emit: (event) => {
        if (event.type === 'reset') { reset = event as unknown as { type: string; rows: SessionWatchRow[] }; controller.abort(); }
      },
    });
    await watching;
    fs.rmSync(dir, { recursive: true, force: true });

    const byId = new Map(reset!.rows.map((r) => [r.sessionId, r]));
    expect(byId.has('live-1')).toBe(true);
    expect(byId.has('prev-1')).toBe(true);
    // The live row is not a Previous row; the durable row is.
    expect(byId.get('live-1')!.previous).toBe(false);
    const prev = byId.get('prev-1')!;
    expect(prev.previous).toBe(true);
    // firstUserMessage and a resume recovery command survive the projection.
    expect(prev.firstUserMessage).toBe('the original ask, verbatim');
    expect(prev.resumable).toBe(true);
    expect(prev.recovery).toMatchObject({ command: 'agents', args: ['sessions', 'resume', 'prev-1', '--device', 'zion'] });
    expect(prev.sourceDevice).toBe('zion');
  });

  it('a live row wins by session id over a Previous row for the same session', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-watch-prevwin-'));
    const journalPath = path.join(dir, 'active.jsonl');
    const controller = new AbortController();
    let reset: { rows: SessionWatchRow[] } | undefined;
    const watching = watchLocalSessions({
      scope: 'zion', signal: controller.signal, journalPath, journalPollMs: 5, heartbeatMs: 1_000,
      readCache: () => ({ version: 1, scope: 'local', capturedAt: 1, sessions: [row('dup', 'running')] }),
      // The index still lists 'dup' as a durable row — the live process must win.
      readPrevious: () => [previousRow('dup', 'stale ask'), previousRow('prev-only', 'other ask')],
      emit: (event) => { if (event.type === 'reset') { reset = event as unknown as { rows: SessionWatchRow[] }; controller.abort(); } },
    });
    await watching;
    fs.rmSync(dir, { recursive: true, force: true });

    const dupRows = reset!.rows.filter((r) => r.sessionId === 'dup');
    expect(dupRows).toHaveLength(1);
    expect(dupRows[0].previous).toBe(false);
    expect(dupRows[0].status).toBe('running');
    // The non-colliding durable row still comes through.
    expect(reset!.rows.some((r) => r.sessionId === 'prev-only' && r.previous)).toBe(true);
  });

  it('a newly-ended session reappears as its durable Previous row on the journal seam', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-watch-ended-'));
    const journalPath = path.join(dir, 'active.jsonl');
    const controller = new AbortController();
    const upserts: SessionWatchRow[] = [];
    // 'a' starts live; once its live process is gone the index lists it as Previous.
    let ended = false;
    const watching = watchLocalSessions({
      scope: 'zion', signal: controller.signal, journalPath, journalPollMs: 5, heartbeatMs: 10_000,
      readCache: () => ({ version: 1, scope: 'local', capturedAt: 1, sessions: [row('a', 'running')] }),
      readPrevious: () => (ended ? [previousRow('a', 'the ask for a')] : []),
      emit: (event) => {
        if (event.type === 'upsert') {
          upserts.push(event.row);
          if (event.row.sessionId === 'a' && event.row.previous) controller.abort();
        }
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The live 'a' exits: the gather removes it from the live snapshot journal.
    ended = true;
    fs.appendFileSync(journalPath, `${JSON.stringify({ version: 1, scope: 'local', capturedAt: 2, upserts: [], removes: ['a'] })}\n`);
    await watching;
    fs.rmSync(dir, { recursive: true, force: true });

    const durableA = upserts.find((r) => r.sessionId === 'a' && r.previous);
    expect(durableA).toBeDefined();
    expect(durableA!.firstUserMessage).toBe('the ask for a');
    expect(durableA!.resumable).toBe(true);
  });

  it('consumes a first publication written during the startup handoff', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-watch-handoff-'));
    const journalPath = path.join(dir, 'active.jsonl');
    const controller = new AbortController();
    const statuses: string[] = [];
    const watching = watchLocalSessions({
      scope: 'local', signal: controller.signal, journalPath, journalPollMs: 5,
      readPrevious: () => [],
      readCache: () => {
        fs.appendFileSync(journalPath, `${JSON.stringify({
          version: 1, scope: 'local', capturedAt: 2, upserts: [], removes: [],
        })}\n`);
        return undefined;
      },
      emit: (event) => {
        if (event.type === 'scope') {
          statuses.push(event.status);
          if (event.status === 'available') controller.abort();
        }
      },
    });
    await watching;
    expect(statuses).toEqual(['unavailable', 'available']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
