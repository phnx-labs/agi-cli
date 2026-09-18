import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-db-actor-'));
process.env.HOME = TEST_HOME;

const { getDB, closeDB, upsertSession, getSessionById } = await import('../db.js');
type SessionMeta = import('@phnx-labs/sessions-cli/reader').SessionMeta;

const FILES = path.join(TEST_HOME, 'files');
fs.mkdirSync(FILES, { recursive: true });

function upsert(over: Partial<SessionMeta> & { id: string }): void {
  const filePath = path.join(FILES, `${over.id}.jsonl`);
  fs.writeFileSync(filePath, '');
  upsertSession(
    {
      id: over.id,
      shortId: over.id.slice(0, 8),
      agent: 'claude',
      timestamp: '2026-08-01T10:00:00.000Z',
      filePath,
      ...over,
    },
    '',
  );
}

/**
 * RUSH-2018: the sessions DB records who launched a session (`actor`) and the
 * actor's kind (`initiated_by`). The contract that matters is write-once
 * preservation: those columns are stamped at creation and a later content
 * rescan — which carries no actor — must NOT clobber them. That is enforced by
 * keeping both columns out of the upsert's ON CONFLICT update set.
 */
describe('sessions DB actor provenance (RUSH-2018)', () => {
  beforeAll(() => {
    getDB(); // migrate a fresh home to schema v19
  });
  afterAll(() => {
    closeDB();
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('persists actor + initiatedBy + phoenixId on insert and maps them back through rowToMeta', () => {
    upsert({ id: 'sess-actor-1', actor: 'ada@example.com', initiatedBy: 'human', phoenixId: 'phx_ada' });
    const meta = getSessionById('sess-actor-1');
    expect(meta?.actor).toBe('ada@example.com');
    expect(meta?.initiatedBy).toBe('human');
    expect(meta?.phoenixId).toBe('phx_ada');
  });

  it('stores the raw columns on the row', () => {
    const db = getDB();
    const row = db
      .prepare(`SELECT actor, initiated_by, phoenix_id FROM sessions WHERE id = ?`)
      .get('sess-actor-1') as { actor: string; initiated_by: string; phoenix_id: string };
    expect(row.actor).toBe('ada@example.com');
    expect(row.initiated_by).toBe('human');
    expect(row.phoenix_id).toBe('phx_ada');
  });

  it('preserves the original actor + phoenixId on a content rescan (ON CONFLICT excludes it)', () => {
    upsert({ id: 'sess-actor-2', actor: 'grace@example.com', initiatedBy: 'human', phoenixId: 'phx_grace' });
    // A rescan re-upserts the same id with NO actor (the scanner can't know it).
    upsert({ id: 'sess-actor-2', topic: 'rescanned' });
    const meta = getSessionById('sess-actor-2');
    // The rescan updated content but must NOT have wiped who launched it.
    expect(meta?.topic).toBe('rescanned');
    expect(meta?.actor).toBe('grace@example.com');
    expect(meta?.initiatedBy).toBe('human');
    expect(meta?.phoenixId).toBe('phx_grace');
  });

  it('leaves actor/initiatedBy/phoenixId undefined when never stamped (pre-actor rows)', () => {
    upsert({ id: 'sess-actor-3' });
    const meta = getSessionById('sess-actor-3');
    expect(meta?.actor).toBeUndefined();
    expect(meta?.initiatedBy).toBeUndefined();
    expect(meta?.phoenixId).toBeUndefined();
  });
});
