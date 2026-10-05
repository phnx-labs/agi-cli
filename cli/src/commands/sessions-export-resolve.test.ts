import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-export-resolve-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { upsertSession, closeDB } = await import('../lib/session/db.js');
const { selectSessions } = await import('./sessions-export.js');
type SessionMeta = import('@phnx-labs/sessions-cli/reader').SessionMeta;

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
    const mentioner = 'dddd4444-1111-2222-3333-444455556666';
    const mentionerMeta = meta(mentioner, { topic: 'resume previous work eeee5555' });
    upsertSession(mentionerMeta, 'resume previous work eeee5555 earlier in the thread');

    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const selected = selectSessions([mentionerMeta], ['eeee5555']);
    errSpy.mockRestore();

    expect(selected).toEqual([]);
  });

  it('a short id that IS a real session prefix resolves to that session via the index', () => {
    const full = 'ffff6666-1111-2222-3333-444455556666';
    upsertSession(meta(full, { topic: 'the real one' }), '');
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
    const selected = selectSessions([hitMeta], ['auth middleware']);
    expect(selected.map(s => s.id)).toContain(hit);
  });
});
