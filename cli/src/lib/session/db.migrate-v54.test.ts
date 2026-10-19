import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-migv54-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { getSessionsDir, getSessionsDbPath } = await import('../state.js');
fs.mkdirSync(getSessionsDir(), { recursive: true });

const db = await import('./db.js');
const Database = (await import('../sqlite.js')).default;

const WITH_PR = 'aaaaaaaa-0000-4000-8000-000000000001';
const NO_PR = 'bbbbbbbb-0000-4000-8000-000000000002';
const MIRROR = 'cccccccc-0000-4000-8000-000000000003';
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
  raw.prepare(`INSERT INTO sessions (id, short_id, agent, timestamp, file_path, pr_url, pr_number, mirror_synced_at, machine) VALUES (?, ?, 'claude', '2026-10-18T00:00:00.000Z', '', 'https://github.com/acme/widget/pull/12', 12, 5, 'peer')`).run(MIRROR, MIRROR.slice(0, 8));
  raw.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '53')`).run();
  raw.close();
}

describe('schema migration v53 -> v54 (a PR only from a real gh pr create)', () => {
  it('re-parses only the transcripts of sessions that have a PR', () => {
    const ledger = db.getDB().prepare(`SELECT file_path FROM scan_ledger ORDER BY file_path`).all() as Array<{ file_path: string }>;
    expect(ledger.map(r => r.file_path)).toEqual([file(NO_PR)]);
  });

  it('clears a mirrored row\'s PR, which no local scan re-derives and a null sync would never clear', () => {
    const row = db.getDB().prepare(`SELECT pr_url, pr_number FROM sessions WHERE id = ?`).get(MIRROR) as { pr_url: string | null; pr_number: number | null };
    expect(row).toEqual({ pr_url: null, pr_number: null });
    const local = db.getDB().prepare(`SELECT pr_url FROM sessions WHERE id = ?`).get(WITH_PR) as { pr_url: string | null };
    expect(local.pr_url).toBe('https://github.com/acme/api/pull/41');
  });
});
