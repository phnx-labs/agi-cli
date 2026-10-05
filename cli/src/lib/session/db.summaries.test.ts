import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-summaries-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { getSessionsDir } = await import('../state.js');
fs.mkdirSync(getSessionsDir(), { recursive: true });

const { readSessionSummary, readSessionSummaryAny, writeSessionSummary } = await import('./db.js');

const ENTRY = {
  goal: 'Ship the summarizer',
  checkpoints: [{ text: 'wrote the cache', at: '2026-09-05T00:00:00.000Z' }],
  summaryChecklist: [{ text: 'add table', done: true }],
  summaryState: 'ready' as const,
};

describe('session_summaries cache (mtime/size reuse)', () => {
  it('reads back a summary only for the exact transcript bytes it was written against', () => {
    const id = 'sum-1';
    writeSessionSummary({ id, fileMtimeMs: 100, fileSize: 200, summary: ENTRY });

    expect(readSessionSummary(id, { fileMtimeMs: 100, fileSize: 200 })).toEqual(ENTRY);
    expect(readSessionSummary(id, { fileMtimeMs: 101, fileSize: 200 })).toBeUndefined();
    expect(readSessionSummary(id, { fileMtimeMs: 100, fileSize: 201 })).toBeUndefined();
  });

  it('readSessionSummaryAny returns the latest row regardless of stamp (the display merge read)', () => {
    const id = 'sum-2';
    writeSessionSummary({ id, fileMtimeMs: 10, fileSize: 20, summary: ENTRY });
    expect(readSessionSummaryAny(id)).toEqual(ENTRY);

    const next = { ...ENTRY, goal: 'Ship it, refined' };
    writeSessionSummary({ id, fileMtimeMs: 11, fileSize: 25, summary: next });
    expect(readSessionSummaryAny(id)).toEqual(next);
    expect(readSessionSummary(id, { fileMtimeMs: 10, fileSize: 20 })).toBeUndefined();
    expect(readSessionSummary(id, { fileMtimeMs: 11, fileSize: 25 })).toEqual(next);
  });

  it('accepts a null stamp (a fleet-mirrored peer summary) and reads it by id', () => {
    const id = 'sum-3';
    writeSessionSummary({ id, fileMtimeMs: null, fileSize: null, summary: ENTRY });
    expect(readSessionSummaryAny(id)).toEqual(ENTRY);
    expect(readSessionSummary(id, { fileMtimeMs: null, fileSize: null })).toEqual(ENTRY);
  });

  it('returns undefined for an unknown session', () => {
    expect(readSessionSummaryAny('nope')).toBeUndefined();
  });
});
