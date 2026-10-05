import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-optimize-'));
process.env.HOME = TEST_HOME;

const { closeDB, getDB, maintainSessionSearchIndex, optimizeSessionSearchIndex } = await import('./db.js');

afterAll(() => {
  closeDB();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('optimizeSessionSearchIndex', () => {
  it('merges accumulated FTS5 segments and purges tombstones without losing content', () => {
    const db = getDB();
    const insert = db.prepare(
      `INSERT INTO tool_call_text(call_key, tool, input, output, error) VALUES (?, 'exec', ?, ?, '')`,
    );
    const del = db.prepare(`DELETE FROM tool_call_text WHERE call_key = ?`);

    for (let i = 0; i < 200; i++) {
      insert.run(`k${i}`, `input ${i}`, `searchable body number ${i}`);
    }
    for (let i = 0; i < 100; i++) {
      del.run(`k${i}`);
    }

    const before = (db.prepare(`SELECT count(*) AS n FROM tool_call_text_data`).get() as { n: number }).n;
    const results = optimizeSessionSearchIndex();
    const tool = results.find((r) => r.table === 'tool_call_text');

    expect(tool).toBeDefined();
    expect(tool!.segmentsBefore).toBe(before);
    expect(tool!.segmentsAfter).toBeLessThan(tool!.segmentsBefore);

    const hit = db.prepare(
      `SELECT count(*) AS n FROM tool_call_text WHERE tool_call_text MATCH 'searchable'`,
    ).get() as { n: number };
    expect(hit.n).toBeGreaterThan(0);

    expect(results.some((r) => r.table === 'session_text')).toBe(true);
  });
});

describe('maintainSessionSearchIndex', () => {
  it('leaves a small index alone and merges one past the threshold', () => {
    const db = getDB();
    const segments = (): number =>
      (db.prepare(`SELECT count(*) AS n FROM tool_call_text_data`).get() as { n: number }).n;
    const insert = db.prepare(
      `INSERT INTO tool_call_text(call_key, tool, input, output, error) VALUES (?, 'exec', ?, ?, '')`,
    );

    expect(maintainSessionSearchIndex(db, { segmentThreshold: segments() + 1 })).toEqual([]);

    for (let i = 0; i < 200; i++) insert.run(`m${i}`, `input ${i}`, `maintained body ${i}`);
    const doomed = db.prepare(
      `SELECT rowid FROM tool_call_text WHERE call_key LIKE 'm%' ORDER BY rowid LIMIT 100`,
    ).all() as Array<{ rowid: number }>;
    const del = db.prepare(`DELETE FROM tool_call_text WHERE rowid = ?`);
    for (const { rowid } of doomed) del.run(rowid);

    const before = segments();
    const merged = maintainSessionSearchIndex(db, { segmentThreshold: before, mergePages: 1000 });
    const tool = merged.find((result) => result.table === 'tool_call_text');
    expect(tool).toBeDefined();
    expect(tool!.segmentsAfter).toBeLessThan(tool!.segmentsBefore);

    expect(db.prepare(
      `SELECT count(*) AS n FROM tool_call_text WHERE tool_call_text MATCH 'maintained'`,
    ).get()).toEqual({ n: 100 });
  });
});
