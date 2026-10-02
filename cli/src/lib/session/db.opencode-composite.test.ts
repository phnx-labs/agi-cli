import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate the sessions DB under a temp HOME before db.js/state.js capture the
// path at import time.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-opencode-composite-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { upsertSession, querySessions, getSessionById } = await import('./db.js');
type SessionMeta = import('@phnx-labs/sessions-cli/reader').SessionMeta;

// A composite OpenCode-shaped file_path: one shared SQLite container, an in-DB id.
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
    // A real on-disk container file whose basename carries no fragment.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-db-'));
    const dbPath = path.join(dir, 'opencode.db');
    fs.writeFileSync(dbPath, 'not a real sqlite file, just a container marker');

    const id = 'ses_02410a2c3ffeRumGfUNRgtB1Xk';
    upsertSession(opencodeMeta(id, dbPath), 'demo topic');

    // The composite basename ('opencode.db#ses_…') is never a directory entry, so
    // the pre-fix dirname/basename membership check pruned every OpenCode row here.
    // With the container-aware gate the row survives a real existence check.
    const live = querySessions({ agent: 'opencode' });
    const liveRow = live.find(s => s.id === id);
    expect(liveRow, 'a live composite row must not be mis-classified as missing').toBeDefined();
    expect(liveRow!.archived).toBeUndefined();
    // getSessionById is the by-id path and must resolve too.
    expect(getSessionById(id)?.id).toBe(id);

    // Delete the container: the container-aware gate correctly detects the row as
    // gone. Its user turns still live in the DB, so it is now ARCHIVED (kept +
    // flagged), not dropped (RUSH-2436) — the detection fires, the action changed.
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

    // Removing the directory exercises the readdir-throws (catch) branch, which
    // falls back to a direct existsSync on the CONTAINER, not the composite string.
    // The row has durable content, so it is archived (kept + flagged), not dropped.
    fs.rmSync(dir, { recursive: true, force: true });
    const after = querySessions({ agent: 'opencode' }).find(s => s.id === id);
    expect(after, 'archived composite row survives directory removal').toBeDefined();
    expect(after!.archived).toBe(true);
  });
});
