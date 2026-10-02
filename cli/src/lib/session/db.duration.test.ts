/**
 * The persisted `duration_ms` (PHNX-3457) against a REAL SQLite index. Harness
 * scan extractors that never derived a span (rush/grok/kimi/cursor/muse/
 * antigravity) left `duration_ms` NULL — 52% of the corpus, 100% of rush — so the
 * console median was computed over only the ~48% that carried it. The fix computes
 * it at the single upsert boundary from the timestamps the row already stores, so
 * every harness gets a span. This exercises that write path end to end.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-duration-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { upsertSession, getSessionById } = await import('./db.js');
type SessionMeta = import('@phnx-labs/sessions-cli/reader').SessionMeta;
type ScanStamp = import('./db.js').ScanStamp;

function rushMeta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  // Exactly the shape discover.ts's readRushMeta builds: a start timestamp, no
  // durationMs, no lastActivity.
  return {
    id,
    shortId: id.slice(0, 8),
    agent: 'rush',
    timestamp: '2026-08-28T20:00:08.000Z',
    filePath: `/s/${id}.jsonl`,
    ...extra,
  };
}

function durationOf(id: string): number | null {
  return getSessionById(id)?.durationMs ?? null;
}

describe('duration_ms is populated for a harness whose extractor never derived it (PHNX-3457)', () => {
  it('derives a span from the last-message time (meta.lastActivity) when present', () => {
    upsertSession(rushMeta('rush-lastact', { lastActivity: '2026-08-28T20:12:08.000Z' }), '');
    expect(durationOf('rush-lastact')).toBe(12 * 60_000);
  });

  it('falls back to the file mtime as last-activity when the extractor set none', () => {
    const scan: ScanStamp = { fileMtimeMs: Date.parse('2026-08-28T20:05:08.000Z'), fileSize: 100 };
    upsertSession(rushMeta('rush-mtime'), '', scan);
    expect(durationOf('rush-mtime')).toBe(5 * 60_000);
  });

  it('stays NULL (never a fabricated 0) when no positive span can be established', () => {
    // No lastActivity, no scan → resolveLastActivity returns timestamp → span 0 → NULL.
    upsertSession(rushMeta('rush-null'), '');
    expect(durationOf('rush-null')).toBeNull();
  });

  it('never overrides a precise span the extractor already computed', () => {
    upsertSession(
      rushMeta('rush-precise', { durationMs: 7777, lastActivity: '2026-08-28T21:00:08.000Z' }),
      '',
    );
    expect(durationOf('rush-precise')).toBe(7777);
  });
});
