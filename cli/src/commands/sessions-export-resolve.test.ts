/**
 * `selectSessions` (behind `agents sessions export <id>`) must resolve an
 * id-shaped selector by id ONLY — never fall back to fuzzy content search.
 *
 * The flagged bug: the id/content gate keyed on `isCompleteSessionId`, so a bare
 * hex SHORT id ("eeee5555") skipped the index lookup and — worse — fell through
 * to the text query, bundling every transcript that merely MENTIONS the string
 * (a resume prompt echoes the parent id into many later session bodies). Gating
 * on `looksLikeSessionId` treats a short id as an id: exact -> prefix -> index,
 * and a miss reports "no session with that id" instead of shipping the mentioner.
 *
 * Real DB under a temp HOME, no mocks. Synthetic ids (dddd/eeee/ffff) that no
 * sibling test's fixtures use, so a shared index can't cross-contaminate.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate the sessions DB under a temp HOME before db.js/state.js capture the
// path at import time.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-export-resolve-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { upsertSession, closeDB } = await import('../lib/session/db.js');
const { selectSessions } = await import('./sessions-export.js');
type SessionMeta = import('@phnx-labs/sessions-cli/reader').SessionMeta;

// findSessionsById (and the content search) drop rows whose transcript is gone,
// so the fixture writes a real file rather than a dangling path.
function meta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  const filePath = path.join(TEST_HOME, `${id}.jsonl`);
  fs.writeFileSync(filePath, '');
  return {
    id,
    shortId: id.slice(0, 8),
    agent: 'claude',
    timestamp: new Date().toISOString(),
    filePath,
    ...extra,
  };
}

afterAll(() => {
  closeDB();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('selectSessions resolves an id-shaped selector by id only', () => {
  it('a short id present only in another session\'s CONTENT is NOT selected', () => {
    // The reproduction: the mentioner is in the pool AND indexed with content
    // that mentions the query. A content fallback would surface it; id-only must
    // report a miss and select nothing.
    const mentioner = 'dddd4444-1111-2222-3333-444455556666';
    const mentionerMeta = meta(mentioner, { topic: 'resume previous work eeee5555' });
    upsertSession(mentionerMeta, 'resume previous work eeee5555 earlier in the thread');

    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const selected = selectSessions([mentionerMeta], ['eeee5555']);
    errSpy.mockRestore();

    // Never the mentioner: a short id must not fuzzy-match content.
    expect(selected).toEqual([]);
  });

  it('a short id that IS a real session prefix resolves to that session via the index', () => {
    const full = 'ffff6666-1111-2222-3333-444455556666';
    upsertSession(meta(full, { topic: 'the real one' }), '');
    // Empty pool: the id is absent from the discovered pool but present in the
    // index, exactly the pool-minority case selectSessions widens through.
    const selected = selectSessions([], ['ffff6666']);
    expect(selected.map(s => s.id)).toEqual([full]);
  });

  it('a complete id absent from the pool still resolves through the index', () => {
    const indexed = 'dddd4444-9999-8888-7777-666655554444';
    upsertSession(meta(indexed, { topic: 'indexed but not discovered' }), '');
    expect(selectSessions([], [indexed]).map(s => s.id)).toEqual([indexed]);
  });

  it('a genuine search phrase keeps the ranked content path', () => {
    const hit = 'ffff6666-aaaa-bbbb-cccc-ddddeeeeffff';
    const hitMeta = meta(hit, { topic: 'refactor the auth middleware' });
    upsertSession(hitMeta, 'refactor the auth middleware for clarity');
    // A non-id selector must still content-match (this is NOT an id-shaped query).
    const selected = selectSessions([hitMeta], ['auth middleware']);
    expect(selected.map(s => s.id)).toContain(hit);
  });
});
