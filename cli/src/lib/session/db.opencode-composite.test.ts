import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-opencode-composite-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { upsertSession, querySessions, getSessionById } = await import('./db.js');
type SessionMeta = import('@phnx-labs/sessions-cli/reader').SessionMeta;

function opencodeMeta(id: string, containerDbPath: string): SessionMeta {
  return {
    id,
    shortId: id.slice(0, 8),
    agent: 'opencode',
    timestamp: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    filePath: `${containerDbPath}#${id}`,
  };
}

describe('composite OpenCode file_path survives the staleness gate (RUSH-2357)', () => {
  it('keeps a composite row while its container DB exists, and archives it once the DB is gone (RUSH-2436)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-db-'));
    const dbPath = path.join(dir, 'opencode.db');
    fs.writeFileSync(dbPath, 'not a real sqlite file, just a container marker');

    const id = 'ses_02410a2c3ffeRumGfUNRgtB1Xk';
    upsertSession(opencodeMeta(id, dbPath), 'demo topic');

    const live = querySessions({ agent: 'opencode' });
    const liveRow = live.find(s => s.id === id);
    expect(liveRow, 'a live composite row must not be mis-classified as missing').toBeDefined();
    expect(liveRow!.archived).toBeUndefined();
    expect(getSessionById(id)?.id).toBe(id);

    fs.rmSync(dbPath);
    const afterDelete = querySessions({ agent: 'opencode' });
    const archivedRow = afterDelete.find(s => s.id === id);
    expect(archivedRow, 'a content-bearing composite row is archived, not pruned, when its container is gone').toBeDefined();
    expect(archivedRow!.archived).toBe(true);
  });

  it('archives a composite row when the whole container directory is removed (RUSH-2436)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-db-dir-'));
    const dbPath = path.join(dir, 'opencode.db');
    fs.writeFileSync(dbPath, 'container');

    const id = 'ses_11111111ffffRumGfUNRgtB1Xk';
    upsertSession(opencodeMeta(id, dbPath), 'topic');
    expect(querySessions({ agent: 'opencode' }).map(s => s.id)).toContain(id);

    fs.rmSync(dir, { recursive: true, force: true });
    const after = querySessions({ agent: 'opencode' }).find(s => s.id === id);
    expect(after, 'archived composite row survives directory removal').toBeDefined();
    expect(after!.archived).toBe(true);
  });
});
