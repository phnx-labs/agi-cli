import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ActiveSession } from '../active.js';
import { sessionAgentSupportsResume } from '../recovery.js';
import type { SessionMeta } from '../types.js';
import {
  SessionWatchState,
  sessionWatchRowKey,
  toPreviousSessionWatchRow,
  watchLocalSessions,
  toSessionWatchRow,
} from './watch.js';

const row = (sessionId: string, status: ActiveSession['status'] = 'running'): ActiveSession => ({
  context: 'terminal', kind: 'codex', sessionId, status, cwd: '/repo', lastActivityMs: 10,
});

const indexed = (id: string, over: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  shortId: id.slice(0, 8),
  agent: 'codex',
  timestamp: '2026-08-30T20:00:00.000Z',
  lastActivity: '2026-08-30T20:02:00.000Z',
  filePath: `/sessions/${id}.jsonl`,
  cwd: '/repo',
  machine: 'zion',
  ...over,
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
    expect(r.previous).toBe(true);
  });

  it('projects the indexed first user message on the streamed row', () => {
    const r = toSessionWatchRow('zion', {
      context: 'terminal', kind: 'codex', sessionId: 'x', status: 'idle',
      firstUserMessage: 'Implement the full request\nwith all acceptance criteria.',
    });
    expect(r.firstUserMessage).toBe('Implement the full request\nwith all acceptance criteria.');
  });
});

describe('SessionWatchRow carries the join keys the extension needs', () => {
  // Golden row: a dropped identity field breaks the extension's terminal->session
  // join (and re-strands remote/non-claude tabs on "tracking session"), so guard
  // that launchId + terminalId survive onto the streamed row alongside sessionId.
  it('projects launchId and terminalId from the ActiveSession onto the row', () => {
    const r = toSessionWatchRow('yosemite-s1', {
      context: 'terminal', kind: 'codex', status: 'running', pidAlive: true, cwd: '/repo',
      machine: 'yosemite-s1',
      sessionId: '01a05f06',
      launchId: '8b43e65e-1234-4c3d-9abc-000000000001',
      terminalId: 'cx-1787373814780-23',
    });
    expect(r.launchId).toBe('8b43e65e-1234-4c3d-9abc-000000000001');
    expect(r.terminalId).toBe('cx-1787373814780-23');
    expect(r.sessionId).toBe('01a05f06');
    expect(r.machine).toBe('yosemite-s1');
  });

  it('leaves the keys undefined when the source row has none (no invented values)', () => {
    const r = toSessionWatchRow('zion', {
      context: 'terminal', kind: 'codex', status: 'running', pidAlive: true, cwd: '/repo',
    });
    expect(r.launchId).toBeUndefined();
    expect(r.terminalId).toBeUndefined();
  });
});

describe('durable Previous rows on the canonical watch stream', () => {
  it('projects indexed history with the real request and recovery tuple', () => {
    const projected = toPreviousSessionWatchRow('zion', indexed('history-1', {
      firstUserMessage: 'Implement the full request\nwith every acceptance criterion.',
      topic: 'Implement the full request',
      gitBranch: 'agents/history',
      ticketId: 'PHNX-3621',
      prUrl: 'https://github.com/phnx-labs/agi-ext/pull/26',
      prNumber: 26,
    }));
    expect(projected).toMatchObject({
      context: 'recent', sessionId: 'history-1', previous: true, status: 'closed',
      sourceDevice: 'zion', resumable: true, viewingIn: null,
      firstUserMessage: 'Implement the full request\nwith every acceptance criterion.',
      branch: 'agents/history',
      ticket: { id: 'PHNX-3621' },
      pr: { url: 'https://github.com/phnx-labs/agi-ext/pull/26', number: 26 },
      recovery: { command: 'agents', args: ['sessions', 'resume', 'history-1', '--device', 'zion'], cwd: '/repo' },
    });
    expect(projected.lastActivityMs - projected.startedAtMs!).toBe(120_000);
  });

  it('headlines a history row on the same ladder as a live row (PHNX-3797)', () => {
    const generated = toPreviousSessionWatchRow('zion', indexed('history-2', {
      topic: 'the sessions list headline is wrong, fix it',
      generatedTitle: 'Session headline ladder fix',
    }));
    expect(generated.title).toBe('Session headline ladder fix');
    expect(generated.generatedTitle).toBe('Session headline ladder fix');

    const renamed = toPreviousSessionWatchRow('zion', indexed('history-3', {
      label: 'ship the auth fix',
      generatedTitle: 'Session headline ladder fix',
      topic: 'the sessions list headline is wrong, fix it',
    }));
    expect(renamed.title).toBe('ship the auth fix');

    const untitled = toPreviousSessionWatchRow('zion', indexed('history-4', {
      topic: 'the sessions list headline is wrong, fix it',
    }));
    expect(untitled.title).toBe('the sessions list headline is wrong, fix it');
  });

  it('a LIVE row carries its generated title verbatim onto the stream, for local and forwarded remote rows alike', () => {
    const live = toSessionWatchRow('mark-1', {
      context: 'terminal', kind: 'claude', sessionId: 'live-1', status: 'running', cwd: '/repo',
      generatedTitle: 'Fleet mirror preview sync', title: 'Fleet mirror preview sync', recapSource: 'generated',
      lastAgentLine: 'Both seams verified on the real shipped artifacts…',
    });
    expect(live.title).toBe('Fleet mirror preview sync');
    expect(live.generatedTitle).toBe('Fleet mirror preview sync');
    expect(live.lastAgentLine).toBe('Both seams verified on the real shipped artifacts…');
  });

  it('uses the same faithful-resume harness boundary as session recovery', () => {
    expect(sessionAgentSupportsResume('codex')).toBe(true);
    expect(sessionAgentSupportsResume('kimi')).toBe(false);
    expect(toPreviousSessionWatchRow('zion', indexed('kimi', { agent: 'kimi' })).recovery).toBeNull();
  });
});

describe('session watch protocol', () => {
  it('emits a versioned reset followed by stable-key deltas with monotonic sequence numbers', () => {
    const state = new SessionWatchState('stream-1');
    const reset = state.reset('zion', [row('a'), row('b')]);
    expect(reset).toMatchObject({ version: 1, type: 'reset', streamId: 'stream-1', sequence: 1, scope: 'zion' });
    const events = state.update('zion', [row('a', 'idle'), row('c')]);
    expect(events.map((event) => [event.type, event.sequence])).toEqual([
      ['upsert', 2], ['upsert', 3], ['remove', 4], ['upsert', 5],
    ]);
    expect(sessionWatchRowKey('zion', row('a'))).toBe(sessionWatchRowKey('zion', row('a')));
  });

  it('dedupes indexed/live identities and demotes new removals', () => {
    const state = new SessionWatchState('stream-history');
    const reset = state.reset('zion', [row('same'), row('new', 'closed')], [indexed('same'), indexed('old')]);
    expect(reset.type).toBe('reset');
    if (reset.type !== 'reset') throw new Error('expected reset');
    expect(reset.rows.filter((candidate) => candidate.sessionId === 'same')).toHaveLength(1);
    expect(reset.rows.find((candidate) => candidate.sessionId === 'old')?.previous).toBe(true);

    const events = state.update('zion', [row('same')]);
    expect(events.map((event) => event.type)).toEqual(['remove', 'upsert']);
    const demoted = events.find((event) => event.type === 'upsert');
    expect(demoted && demoted.type === 'upsert' ? demoted.row : null).toMatchObject({
      sessionId: 'new', previous: true, status: 'closed',
    });
  });

  it('evicts the oldest demotions so steady-state Previous history stays at 50', () => {
    const state = new SessionWatchState('stream-bounded');
    const history = Array.from({ length: 50 }, (_, index) => indexed(`history-${index}`, {
      timestamp: new Date(1_788_120_000_000 + index * 1_000).toISOString(),
      lastActivity: new Date(1_788_120_000_000 + index * 1_000).toISOString(),
    }));
    const reset = state.reset('zion', [], history);
    if (reset.type !== 'reset') throw new Error('expected reset');
    const projected = new Map(reset.rows.map((candidate) => [candidate.rowKey, candidate]));
    const apply = (events: ReturnType<SessionWatchState['update']>) => {
      for (const event of events) {
        if (event.type === 'upsert') projected.set(event.rowKey, event.row);
        else if (event.type === 'remove') projected.delete(event.rowKey);
      }
    };

    for (let index = 0; index < 5; index++) {
      const live = { ...row(`new-${index}`), lastActivityMs: 1_788_120_100_000 + index * 1_000 };
      apply(state.update('zion', [live]));
      apply(state.update('zion', []));
    }

    const previous = [...projected.values()].filter((candidate) => candidate.previous);
    expect(previous).toHaveLength(50);
    expect(previous.some((candidate) => candidate.sessionId === 'history-0')).toBe(false);
    expect(previous.some((candidate) => candidate.sessionId === 'new-4')).toBe(true);
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
      readCache: () => {
        snapshotReads++;
        return { version: 1, scope: 'local', capturedAt: 1, sessions: [row('a')] };
      },
      readPrevious: () => [],
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

  it('consumes a first publication written during the startup handoff', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-watch-handoff-'));
    const journalPath = path.join(dir, 'active.jsonl');
    const controller = new AbortController();
    const statuses: string[] = [];
    const watching = watchLocalSessions({
      scope: 'local', signal: controller.signal, journalPath, journalPollMs: 5,
      readCache: () => {
        fs.appendFileSync(journalPath, `${JSON.stringify({
          version: 1, scope: 'local', capturedAt: 2, upserts: [], removes: [],
        })}\n`);
        return undefined;
      },
      readPrevious: () => [],
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

  it('performs one bounded history read and includes it in the startup reset', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-watch-history-'));
    const journalPath = path.join(dir, 'active.jsonl');
    const controller = new AbortController();
    let historyReads = 0;
    let resetRows: ReturnType<typeof toSessionWatchRow>[] = [];
    const watching = watchLocalSessions({
      scope: 'zion', signal: controller.signal, journalPath, heartbeatMs: 1_000,
      readCache: () => ({ version: 1, scope: 'local', capturedAt: 1, sessions: [row('live')] }),
      readPrevious: () => {
        historyReads++;
        return [indexed('history')];
      },
      emit: (event) => {
        if (event.type !== 'reset') return;
        resetRows = event.rows;
        controller.abort();
      },
    });
    await watching;
    expect(historyReads).toBe(1);
    expect(resetRows.map((candidate) => [candidate.sessionId, candidate.previous])).toEqual([
      ['live', false],
      ['history', true],
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
