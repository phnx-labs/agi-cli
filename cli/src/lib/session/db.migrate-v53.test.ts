import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-migv53-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { getSessionsDir, getSessionsDbPath } = await import('../state.js');
fs.mkdirSync(getSessionsDir(), { recursive: true });

const db = await import('./db.js');
const Database = (await import('../sqlite.js')).default;

const WITH_PR = 'aaaaaaaa-0000-4000-8000-000000000001';
const NO_PR = 'bbbbbbbb-0000-4000-8000-000000000002';
const file = (id: string) => {
  const p = path.join(TEST_HOME, `${id}.jsonl`);
  fs.writeFileSync(p, '{}\n');
  return fs.realpathSync(p);
};

{
  for (const id of [WITH_PR, NO_PR]) {
    db.upsertSession({
      id, shortId: id.slice(0, 8), agent: 'claude', timestamp: '2026-10-18T00:00:00.000Z', filePath: file(id),
      ...(id === WITH_PR ? { prUrl: 'https://github.com/acme/api/pull/41', prNumber: 41 } : {}),
    } as any, '');
  }
  db.closeDB();
  const raw = new Database(getSessionsDbPath());
  for (const id of [WITH_PR, NO_PR]) {
    raw.prepare(`INSERT OR REPLACE INTO scan_ledger (file_path, file_mtime_ms, file_size, scanned_at) VALUES (?, 1, 2, 3)`).run(file(id));
  }
  raw.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '52')`).run();
  raw.close();
}

describe('schema migration v52 -> v53 (every PR a session created)', () => {
  it('re-parses only the transcripts of sessions that already have a PR, and round-trips prUrls', () => {
    const ledger = db.getDB().prepare(`SELECT file_path FROM scan_ledger ORDER BY file_path`).all() as Array<{ file_path: string }>;
    expect(ledger.map(r => r.file_path)).toEqual([file(NO_PR)]);
    const prUrls = ['https://github.com/acme/api/pull/41', 'https://github.com/acme/web/pull/7'];
    db.upsertSession({ ...db.getSessionById(WITH_PR)!, prUrls }, '');
    expect(db.getSessionById(WITH_PR)!.prUrls).toEqual(prUrls);
    expect(db.getSessionById(NO_PR)!.prUrls).toBeUndefined();
  });
});
