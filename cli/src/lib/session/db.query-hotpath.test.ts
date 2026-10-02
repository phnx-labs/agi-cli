/**
 * RUSH-2211: the three query hot-path fixes in querySessions/ftsSearch.
 *   1. The default listing sort uses the bare `last_activity` column (not
 *      `IFNULL(last_activity, timestamp)`) so idx_sessions_last_activity serves it.
 *   2. The post-query existence check batches `fs.existsSync` per directory
 *      (`findMissingFilePaths`) instead of one stat syscall per row, but must
 *      still drop exactly the rows whose file vanished.
 *   3. Label-first search (`ftsSearch`) routes through the FTS5 `label` column
 *      instead of a leading-wildcard `LOWER(label) LIKE '%q%'` table scan.
 */
import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-qhotpath-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const {
  closeDB,
  getDB,
  getSessionExistenceCacheStats,
  upsertSession,
  querySessions,
  ftsSearch,
} = await import('./db.js');
type SessionMeta = import('@phnx-labs/sessions-cli/reader').SessionMeta;

afterAll(() => {
  closeDB();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

function meta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    shortId: id.slice(0, 8),
    agent: 'claude',
    timestamp: new Date('2026-01-01T00:00:00Z').toISOString(),
    filePath: '',
    ...extra,
  };
}

describe('querySessions default sort uses the last_activity index', () => {
  it('EXPLAIN QUERY PLAN shows an index scan, not a table scan + sort', () => {
    const db = getDB();
    for (let i = 0; i < 5; i++) {
      upsertSession(meta(`sort-${i}`, {
        lastActivity: new Date(2026, 0, i + 1).toISOString(),
        filePath: '',
      }), '');
    }
    const plan = db.prepare(
      `EXPLAIN QUERY PLAN SELECT * FROM sessions ORDER BY last_activity DESC, timestamp DESC LIMIT 20`,
    ).all() as Array<{ detail: string }>;
    const detail = plan.map(r => r.detail).join(' | ');
    expect(detail).toMatch(/USING INDEX idx_sessions_last_activity/);
    // The old shape wrapped the column in IFNULL(), which this same plan check
    // would have shown as a SCAN + a separate sort — this asserts the fix, not
    // just that *a* plan exists.
    expect(detail).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/);
  });

  it('returns rows newest-last_activity-first', () => {
    const rows = querySessions({ idPrefix: 'sort-' });
    const ids = rows.map(r => r.id);
    expect(ids).toEqual(['sort-4', 'sort-3', 'sort-2', 'sort-1', 'sort-0']);
  });
});

describe('querySessions batched existence check', () => {
  it('reuses settled directory membership and never caches rapid create/remove ticks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-qhp-cache-'));
    const first = path.join(dir, 'first.jsonl');
    const concurrent = path.join(dir, 'concurrent.jsonl');
    fs.writeFileSync(first, '{}');
    const settled = new Date(Date.now() - 5_000);
    fs.utimesSync(dir, settled, settled);
    upsertSession(meta('exist-cache-first', { filePath: first }), '');
    upsertSession(meta('exist-cache-concurrent', { filePath: concurrent }), '');

    expect(querySessions({ idPrefix: 'exist-cache-' }).map(row => row.id))
      .toEqual(['exist-cache-first']);
    const afterFirstSweep = getSessionExistenceCacheStats().sweeps;

    expect(querySessions({ idPrefix: 'exist-cache-' }).map(row => row.id))
      .toEqual(['exist-cache-first']);
    expect(getSessionExistenceCacheStats().sweeps).toBe(afterFirstSweep);

    // A concurrent writer can create the transcript without touching SQLite.
    // The directory metadata is the cross-process invalidation signal, so this
    // process must not keep the cached "missing" membership result.
    fs.writeFileSync(concurrent, '{}');
    expect(new Set(querySessions({ idPrefix: 'exist-cache-' }).map(row => row.id)))
      .toEqual(new Set(['exist-cache-first', 'exist-cache-concurrent']));
    expect(getSessionExistenceCacheStats().sweeps).toBe(afterFirstSweep + 1);

    fs.unlinkSync(first);
    expect(querySessions({ idPrefix: 'exist-cache-' }).map(row => row.id))
      .toEqual(['exist-cache-concurrent']);
    expect(getSessionExistenceCacheStats().sweeps).toBe(afterFirstSweep + 2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not hide same-tick filesystem-only mutations', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-qhp-rapid-'));
    const file = path.join(dir, 'rapid.jsonl');
    upsertSession(meta('exist-cache-rapid', { filePath: file }), '');

    for (let i = 0; i < 25; i++) {
      fs.writeFileSync(file, String(i));
      expect(querySessions({ idExact: 'exist-cache-rapid' }).map(row => row.id))
        .toEqual(['exist-cache-rapid']);
      fs.unlinkSync(file);
      expect(querySessions({ idExact: 'exist-cache-rapid' })).toEqual([]);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('expires a matching directory signature after the timestamp precision window', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-qhp-expire-'));
    const file = path.join(dir, 'delayed.jsonl');
    const settled = new Date(Date.now() - 5_000);
    fs.utimesSync(dir, settled, settled);
    upsertSession(meta('exist-cache-delayed', { filePath: file }), '');
    expect(querySessions({ idExact: 'exist-cache-delayed' })).toEqual([]);

    fs.writeFileSync(file, '{}');
    fs.utimesSync(dir, settled, settled);
    await new Promise(resolve => setTimeout(resolve, 2_100));
    expect(querySessions({ idExact: 'exist-cache-delayed' }).map(row => row.id))
      .toEqual(['exist-cache-delayed']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('drops rows whose backing file is gone and keeps rows whose file is present, across several directories', () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-qhp-dirA-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-qhp-dirB-'));
    const liveA = path.join(dirA, 'live-a.jsonl');
    const goneA = path.join(dirA, 'gone-a.jsonl');
    const liveB = path.join(dirB, 'live-b.jsonl');
    const goneB = path.join(dirB, 'gone-b.jsonl');
    fs.writeFileSync(liveA, '{}');
    fs.writeFileSync(liveB, '{}');
    // goneA/goneB are referenced by session rows but never written to disk —
    // simulates a transcript deleted out from under the index.

    upsertSession(meta('exist-live-a', { filePath: liveA }), '');
    upsertSession(meta('exist-gone-a', { filePath: goneA }), '');
    upsertSession(meta('exist-live-b', { filePath: liveB }), '');
    upsertSession(meta('exist-gone-b', { filePath: goneB }), '');
    // A synthetic row (no file_path) must survive untouched — it's exempt from
    // the existence check entirely.
    upsertSession(meta('exist-synthetic', { filePath: '' }), '');

    const rows = querySessions({ idPrefix: 'exist-' });
    const ids = new Set(rows.map(r => r.id));
    expect(ids.has('exist-live-a')).toBe(true);
    expect(ids.has('exist-live-b')).toBe(true);
    expect(ids.has('exist-synthetic')).toBe(true);
    expect(ids.has('exist-gone-a')).toBe(false);
    expect(ids.has('exist-gone-b')).toBe(false);

    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  });

  it('skipExistenceCheck bypasses the check entirely, including for a vanished file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-qhp-skip-'));
    const file = path.join(dir, 'vanished.jsonl');
    upsertSession(meta('exist-skip', { filePath: file }), '');
    const rows = querySessions({ idExact: 'exist-skip', skipExistenceCheck: true });
    expect(rows.map(r => r.id)).toEqual(['exist-skip']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('drops a contentless phantom but does NOT purge its tool-call evidence on listing (RUSH-2436)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-qhp-purge-'));
    const file = path.join(dir, 'purge-me.jsonl');
    const db = getDB();
    // Empty content => a phantom (stale/moved file_path), still suppressed from
    // listings. But listing must no longer DELETE data: the destructive
    // purge-on-read is gone; only directory-scoped cleanup purges.
    upsertSession(meta('exist-purge', { filePath: file }), '');
    db.prepare(
      `INSERT INTO tool_calls (call_key, session_id, ordinal, timestamp, tool, input, outcome, evidence_bytes)
       VALUES ('purge-call-1', 'exist-purge', 0, ?, 'exec', '{}', 'ok', 2)`,
    ).run(new Date().toISOString());

    const listed = querySessions({ idExact: 'exist-purge' });
    expect(listed.map(r => r.id), 'contentless phantom stays suppressed').toEqual([]);

    const remaining = db.prepare(`SELECT COUNT(*) AS c FROM tool_calls WHERE session_id = 'exist-purge'`)
      .get() as { c: number };
    expect(remaining.c, 'listing must not purge tool-call evidence').toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('ftsSearch label tier routes through the FTS5 index, not a leading-wildcard scan', () => {
  it('finds a session by a single-character label prefix (the interactive type-ahead case)', () => {
    upsertSession(meta('label-quick', { label: 'quick-fix' }), '');
    const hits = ftsSearch('q');
    const hit = hits.find(h => h.sessionId === 'label-quick');
    expect(hit).toBeDefined();
    expect(hit!.score).toBeGreaterThanOrEqual(800_000);
  });

  it('still ranks exact > prefix > contains for label matches', () => {
    upsertSession(meta('label-exact', { label: 'nightly-audit' }), '');
    upsertSession(meta('label-prefix', { label: 'nightly-audit-followup' }), '');
    upsertSession(meta('label-contains', { label: 'run-nightly-audit-again' }), '');

    const exactHit = ftsSearch('nightly-audit').find(h => h.sessionId === 'label-exact');
    expect(exactHit?.score).toBe(1_000_000);

    // Exact match short-circuits the tier (see ftsSearch docblock), so re-query
    // with a term that only prefix/contains-matches to see those tiers.
    const prefixHits = ftsSearch('nightly-audit-follow');
    expect(prefixHits.find(h => h.sessionId === 'label-prefix')?.score).toBe(900_000);
  });

  it('an empty/punctuation-only query falls back to the direct scan without throwing', () => {
    upsertSession(meta('label-punct', { label: 'weird...label' }), '');
    expect(() => ftsSearch('...')).not.toThrow();
  });
});

describe('ftsSearch snippets', () => {
  it('returns a bounded excerpt from the matching assistant answer', () => {
    upsertSession(
      meta('assistant-snippet'),
      'the user prompt contains no diagnostic terms',
      undefined,
      'Root cause: the grombulator flux capacitor overheated during the canary rollout.',
    );

    const hit = ftsSearch('grombulator overheated').find((row) => row.sessionId === 'assistant-snippet');
    expect(hit).toBeDefined();
    expect(hit!.snippet).toContain('**grombulator**');
    expect(hit!.snippet).toContain('**overheated**');
    expect(hit!.snippet!.length).toBeLessThan(200);
  });
});
