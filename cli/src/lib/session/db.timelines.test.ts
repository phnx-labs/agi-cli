import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Fresh HOME before importing state/db (db.ts captures DB_PATH at module load).
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-timelines-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { getSessionsDir } = await import('../state.js');
fs.mkdirSync(getSessionsDir(), { recursive: true });

const {
  getDB,
  pruneMirrorSessions,
  readSessionTimelineAny,
  readSessionTimelineEntry,
  upsertMirrorSession,
  writeSessionTimeline,
} = await import('./db.js');
const { emptyTimelineState, foldTimeline, projectSessionFiles, projectTimeline } = await import('@phnx-labs/sessions-cli/reader');
const { mergeSessionTimeline } = await import('./session-cache.js');
const { toPreviousSessionWatchRow, toSessionWatchRow } = await import('./remote/watch.js');
import type { ActiveSession } from './active.js';
import type { SessionEvent, SessionMeta } from '@phnx-labs/sessions-cli/reader';

const AT = (s: number): string => new Date(Date.UTC(2026, 8, 6, 0, 0, s)).toISOString();
const EVENTS: SessionEvent[] = [
  { type: 'message', agent: 'claude', timestamp: AT(0), role: 'user', content: 'Ship the timeline card.' },
  { type: 'message', agent: 'claude', timestamp: AT(1), role: 'assistant', content: 'Folding the transcript now.' },
  { type: 'tool_use', agent: 'claude', timestamp: AT(2), tool: 'Bash', callId: 'a', args: { command: 'bun run build' }, command: 'bun run build' },
  { type: 'file_change', agent: 'claude', timestamp: AT(3), changes: [{ path: '/repo/src/timeline.ts', op: 'created' }] },
];

function entry() {
  const state = foldTimeline(EVENTS, undefined, { offset: 4096 });
  const files = projectSessionFiles(state);
  return {
    timeline: projectTimeline(state, 'working'),
    request: state.request!,
    ...(files ? { files } : {}),
    state,
  };
}

describe('session_timelines cache', () => {
  it('stores the display projection and the resume state, and reads each back separately', () => {
    const stored = entry();
    writeSessionTimeline({ id: 'tl-1', fileMtimeMs: 100, fileSize: 4096, timeline: stored });

    // The display read returns the bounded projection and never the resume state.
    const projection = readSessionTimelineAny('tl-1');
    expect(projection?.timeline).toEqual(stored.timeline);
    expect(projection?.request?.headline).toBe('Ship the timeline card.');
    expect(projection?.files?.changes[0].path).toBe('/repo/src/timeline.ts');
    expect((projection as Record<string, unknown>).state).toBeUndefined();

    // The pass's read also carries the byte offset it must resume from.
    expect(readSessionTimelineEntry('tl-1')?.state.offset).toBe(4096);
  });

  it('overwrites in place — one row per session, newest fold wins', () => {
    writeSessionTimeline({ id: 'tl-2', fileMtimeMs: 1, fileSize: 10, timeline: entry() });
    const later = entry();
    later.timeline.tools = 99;
    writeSessionTimeline({ id: 'tl-2', fileMtimeMs: 2, fileSize: 20, timeline: later });
    expect(readSessionTimelineAny('tl-2')?.timeline.tools).toBe(99);
    expect(getDB().prepare(`SELECT COUNT(*) AS n FROM session_timelines WHERE session_id = ?`).get('tl-2'))
      .toEqual({ n: 1 });
  });

  it('returns undefined for an unknown session', () => {
    expect(readSessionTimelineAny('never-folded')).toBeUndefined();
    expect(readSessionTimelineEntry('never-folded')).toBeUndefined();
  });

  it('carries a peer mirror\'s projection with an EMPTY resume state', () => {
    const stored = entry();
    expect(upsertMirrorSession({
      id: 'peer-tl', shortId: 'peer-tl', agent: 'claude', machine: 'worker-1',
      timestamp: AT(0), lastActivity: AT(3), topic: 'peer topic',
      timeline: { timeline: stored.timeline, request: stored.request, files: stored.files },
    }, 'worker-1', Date.now())).toBe(true);
    expect(readSessionTimelineAny('peer-tl')?.timeline).toEqual(stored.timeline);
    // This box has no such transcript, so it must never hold a resume offset into one.
    expect(readSessionTimelineEntry('peer-tl')?.state).toEqual(emptyTimelineState());
  });

  it('is deleted with the session it belongs to', () => {
    const id = 'peer-pruned';
    upsertMirrorSession({
      id, shortId: id, agent: 'claude', machine: 'worker-1',
      timestamp: AT(0), lastActivity: AT(3), topic: 'peer topic',
      timeline: { timeline: entry().timeline },
    }, 'worker-1', 1_000);
    expect(readSessionTimelineAny(id)).toBeDefined();

    expect(pruneMirrorSessions(2_000)).toBeGreaterThan(0);
    expect(readSessionTimelineAny(id)).toBeUndefined();
  });
});


describe('the folded timeline reaches every row surface (PHNX-3939)', () => {
  const ID = 'row-1';

  it('merges onto a live row exactly where the summary merge runs', () => {
    writeSessionTimeline({ id: ID, fileMtimeMs: 5, fileSize: 4096, timeline: entry() });
    const row: ActiveSession = { context: 'terminal', kind: 'claude', sessionId: ID, status: 'running' };
    mergeSessionTimeline(row);
    expect(row.request?.headline).toBe('Ship the timeline card.');
    expect(row.timeline?.steps.length).toBeGreaterThan(0);
    expect(row.files?.changes[0].path).toBe('/repo/src/timeline.ts');
  });

  it('lets the daemon fold replace the recap\'s indexed guess, and re-derives the title with it', () => {
    // The recap tidies whatever turn the INDEX had, which lags a live session;
    // the fold read the transcript this tick. The fold wins, and the row's title
    // is re-derived so the two cannot disagree.
    writeSessionTimeline({ id: ID, fileMtimeMs: 5, fileSize: 4096, timeline: entry() });
    const stale = { text: 'an older turn', headline: 'an older turn', kind: 'text' as const, attachments: [], pastedLines: 0 };
    const row: ActiveSession = {
      context: 'terminal', kind: 'claude', sessionId: ID, status: 'running',
      request: stale, title: 'an older turn', userPromptClean: 'an older turn',
    };
    mergeSessionTimeline(row);
    expect(row.request?.headline).toBe('Ship the timeline card.');
    expect(row.title).toBe('Ship the timeline card.');
    expect(row.userPromptClean).toBe('Ship the timeline card.');
  });

  it('leaves a timeline or files the gather already computed alone', () => {
    writeSessionTimeline({ id: ID, fileMtimeMs: 5, fileSize: 4096, timeline: entry() });
    const own = { steps: [], earlier: { steps: 0, tools: 0, failed: 0 }, tools: 0, failed: 0, blocked: 0, spanMs: 0, state: 'ready' as const };
    const row: ActiveSession = { context: 'terminal', kind: 'claude', sessionId: ID, status: 'running', timeline: own };
    mergeSessionTimeline(row);
    expect(row.timeline).toBe(own);
  });

  it('rides the live watch row through the spread, with no re-read', () => {
    writeSessionTimeline({ id: ID, fileMtimeMs: 5, fileSize: 4096, timeline: entry() });
    const row: ActiveSession = { context: 'terminal', kind: 'claude', sessionId: ID, status: 'running' };
    mergeSessionTimeline(row);
    const watch = toSessionWatchRow('worker-1', row);
    expect(watch.request?.headline).toBe('Ship the timeline card.');
    expect(watch.timeline).toEqual(row.timeline);
    expect(watch.files).toEqual(row.files);
  });

  it('projects onto a history row and titles it from the request, not the raw topic', () => {
    const id = 'row-history';
    writeSessionTimeline({ id, fileMtimeMs: 6, fileSize: 4096, timeline: entry() });
    const meta: SessionMeta = {
      id, shortId: id, agent: 'claude', timestamp: AT(0), lastActivity: AT(3),
      filePath: '/sessions/row-history.jsonl', cwd: '/repo', machine: 'worker-1',
      topic: 'Set model to `Fable 5.1` and saved as your default',
    };
    const projected = toPreviousSessionWatchRow('worker-1', meta);
    expect(projected.title).toBe('Ship the timeline card.');
    expect(projected.request?.headline).toBe('Ship the timeline card.');
    expect(projected.timeline?.steps.length).toBeGreaterThan(0);
    expect(projected.files?.total).toBe(1);
  });

  it('leaves a history row with no folded timeline on its topic', () => {
    const meta: SessionMeta = {
      id: 'row-unfolded', shortId: 'row-unfo', agent: 'claude', timestamp: AT(0),
      filePath: '/sessions/row-unfolded.jsonl', cwd: '/repo', machine: 'worker-1', topic: 'plain topic',
    };
    const projected = toPreviousSessionWatchRow('worker-1', meta);
    expect(projected.title).toBe('plain topic');
    expect(projected.timeline).toBeUndefined();
  });
});
