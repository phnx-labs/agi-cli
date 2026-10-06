import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-migv52-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { getSessionsDir, getSessionsDbPath } = await import('../state.js');
fs.mkdirSync(getSessionsDir(), { recursive: true });

const db = await import('./db.js');
const Database = (await import('../sqlite.js')).default;

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';

{
  for (const id of [A, B]) {
    db.upsertSession({
      id,
      shortId: id.slice(0, 8),
      agent: 'claude',
      timestamp: '2026-09-18T00:00:00.000Z',
      filePath: path.join(TEST_HOME, `${id}.jsonl`),
    } as any, '');
  }
  db.closeDB();

  const raw = new Database(getSessionsDbPath());
  const ins = raw.prepare(`
    INSERT INTO session_resource_usage (session_id, kind, name, plugin, source, repo_root, snapshot_sha, count)
    VALUES (?, ?, ?, ?, 'agents-cli', NULL, NULL, ?)
  `);
  ins.run(A, 'skill', 'image', 'create', 2);
  ins.run(B, 'skill', 'image', 'create', 1);
  ins.run(B, 'skill', 'create:image', 'create', 1);
  ins.run(A, 'skill', 'browser', null, 3);
  raw.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '51')`).run();
  raw.close();
}

describe('schema migration v51 -> v52 (plugin resources keyed <plugin>:<name>)', () => {
  it('renames bare plugin rows to the inventory name and merges a same-session duplicate', () => {
    const rows = db.getDB().prepare(
      `SELECT session_id, kind, name, plugin, count FROM session_resource_usage ORDER BY session_id, name`,
    ).all();
    expect(rows).toEqual([
      { session_id: A, kind: 'skill', name: 'browser', plugin: null, count: 3 },
      { session_id: A, kind: 'skill', name: 'create:image', plugin: 'create', count: 2 },
      { session_id: B, kind: 'skill', name: 'create:image', plugin: 'create', count: 2 },
    ]);
    expect(db.queryResourceUsageStats({}).find(r => r.name === 'create:image'))
      .toMatchObject({ sessions: 2, invocations: 4 });
  });
});
