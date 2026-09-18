/**
 * PHNX-2767: content search must return an FTS hit even when that session is
 * absent from the in-memory listing pool.
 *
 * The listing pool is cwd-scoped and default-capped (50), so intersecting FTS
 * hits with it dropped grep-visible transcripts — `agents sessions "tmux pane"`
 * returned 0 while the project JSONLs matched. No mocking: real SQLite FTS via
 * upsertSession, then searchContentIndex / filterSessionsByQuery against a
 * truncated pool.
 */

import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-search-content-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { upsertSession, closeDB, ftsSearch } = await import('./db.js');
const { searchContentIndex } = await import('./discover.js');
const { filterSessionsByQuery } = await import('../../commands/sessions.js');
type SessionMeta = import('@phnx-labs/sessions-cli/reader').SessionMeta;

afterAll(() => {
  closeDB();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

const IN_POOL_ID = 'aaaa2767-0000-4000-8000-000000000001';
const OUT_OF_POOL_ID = 'bbbb2767-0000-4000-8000-000000000002';
const OTHER_PROJECT_ID = 'cccc2767-0000-4000-8000-000000000003';
const OTHER_PROJECT_HIT_ID = 'dddd2767-0000-4000-8000-000000000004';
const OTHER_AGENT_HIT_ID = 'eeee2767-0000-4000-8000-000000000005';
const CONTENT = 'Pane is dead — tmux pane died while the agent was running';
const QUERY = 'tmux pane';

function meta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  const filePath = path.join(TEST_HOME, '.claude', 'projects', 'p', `${id}.jsonl`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{}\n');
  return {
    id,
    shortId: id.slice(0, 8),
    agent: 'claude',
    timestamp: '2026-08-12T10:00:00.000Z',
    project: 'agents-cli',
    cwd: path.join(TEST_HOME, 'src', 'agents-cli'),
    filePath,
    topic: extra.topic ?? 'unrelated listing row',
    ...extra,
  };
}

const inPool = meta(IN_POOL_ID, { topic: 'recent listing filler' });
const outOfPool = meta(OUT_OF_POOL_ID, {
  topic: 'recover the dead pane',
  timestamp: '2026-08-01T10:00:00.000Z',
});
const otherProject = meta(OTHER_PROJECT_ID, {
  topic: 'other repo work',
  project: 'other-repo',
  cwd: path.join(TEST_HOME, 'src', 'other-repo'),
});
const otherProjectHit = meta(OTHER_PROJECT_HIT_ID, {
  topic: 'tmux pane in another repo',
  project: 'other-repo',
  cwd: path.join(TEST_HOME, 'src', 'other-repo'),
});
const otherAgentHit = meta(OTHER_AGENT_HIT_ID, {
  topic: 'tmux pane on a different harness',
  agent: 'codex',
});

upsertSession(inPool, 'no matching body text here');
upsertSession(outOfPool, CONTENT);
upsertSession(otherProject, 'unrelated transcript body');
upsertSession(otherProjectHit, CONTENT);
upsertSession(otherAgentHit, CONTENT);

describe('searchContentIndex unions FTS hits missing from the listing pool (PHNX-2767)', () => {
  it('indexes the grep-visible transcript so FTS itself matches', () => {
    expect(ftsSearch(QUERY).some(h => h.sessionId === OUT_OF_POOL_ID)).toBe(true);
  });

  it('returns the FTS hit even when the caller passes an empty pool', () => {
    const hits = searchContentIndex([], QUERY);
    expect(hits.has(OUT_OF_POOL_ID)).toBe(true);
    expect(hits.has(OTHER_PROJECT_HIT_ID)).toBe(true);
    expect(hits.has(OTHER_PROJECT_ID)).toBe(false);
    const row = hits.get(OUT_OF_POOL_ID)!;
    expect(row.id).toBe(OUT_OF_POOL_ID);
    expect(row._matchedTerms).toEqual(expect.arrayContaining(['tmux', 'pane']));
    expect(row._bm25Score).toBeGreaterThan(0);
  });

  it('returns the FTS hit when the pool holds only an unrelated recent session', () => {
    const hits = searchContentIndex([inPool], QUERY);
    expect(hits.has(OUT_OF_POOL_ID)).toBe(true);
    expect(hits.has(IN_POOL_ID)).toBe(false);
  });

  it('still annotates an in-pool FTS hit rather than dropping it', () => {
    const hits = searchContentIndex([outOfPool], QUERY);
    expect(hits.has(OUT_OF_POOL_ID)).toBe(true);
    expect(hits.get(OUT_OF_POOL_ID)!._matchedTerms).toEqual(
      expect.arrayContaining(['tmux', 'pane']),
    );
  });
});

describe('filterSessionsByQuery surfaces out-of-pool content hits (PHNX-2767)', () => {
  it('unions the grep-visible transcript into the listing result', () => {
    const rows = filterSessionsByQuery([inPool], QUERY);
    expect(rows.map(s => s.id)).toContain(OUT_OF_POOL_ID);
    expect(rows.map(s => s.id)).not.toContain(IN_POOL_ID);
    // Unscoped content search is global — a matching transcript in another
    // project is a real FTS hit, not a pool-cap miss to ignore.
    expect(rows.map(s => s.id)).toContain(OTHER_PROJECT_HIT_ID);
  });

  it('does not reintroduce an FTS hit that fails --project', () => {
    const rows = filterSessionsByQuery([inPool], QUERY, { project: 'agents-cli' });
    expect(rows.map(s => s.id)).toContain(OUT_OF_POOL_ID);
    expect(rows.map(s => s.id)).not.toContain(OTHER_PROJECT_HIT_ID);
  });

  it('does not reintroduce an FTS hit that fails --agent', () => {
    const rows = filterSessionsByQuery([inPool], QUERY, { agent: 'claude' });
    expect(rows.map(s => s.id)).toContain(OUT_OF_POOL_ID);
    expect(rows.map(s => s.id)).not.toContain(OTHER_AGENT_HIT_ID);
  });
});
