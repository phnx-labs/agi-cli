import { afterAll, beforeAll, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const savedHome = process.env.HOME;
const savedProfile = process.env.USERPROFILE;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-fork-'));
process.env.HOME = process.env.USERPROFILE = home;
let discover: typeof import('./discover.js');
let db: typeof import('./db.js');
const child = '22222222-2222-4222-8222-222222222222';
const parent = '11111111-1111-4111-8111-111111111111';
const fixture = fs.readFileSync(new URL('./testdata/codex-native-fork.jsonl', import.meta.url), 'utf8');
beforeAll(async () => { db = await import('./db.js'); discover = await import('./discover.js'); });
afterAll(() => {
  db.closeDB();
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
  fs.rmSync(home, { recursive: true, force: true });
});

it('keeps native child ownership through full and incremental inherited metadata', async () => {
  const file = path.join(home, 'fork.jsonl');
  const lines = fixture.trimEnd().split('\n');
  fs.writeFileSync(file, lines[0] + '\n');
  const before = fs.statSync(file);
  const first = await discover.scanCodexSessionResumable(file, null, before.mtimeMs, before.size);
  fs.appendFileSync(file, lines.slice(1).join('\n') + '\n');
  const after = fs.statSync(file);
  const resumed = await discover.scanCodexSessionResumable(file, first.newState, after.mtimeMs, after.size, before.mtimeMs);
  const full = await discover.scanCodexSessionResumable(file, null, after.mtimeMs, after.size);
  expect(resumed.mode).toBe('incremental');
  expect(resumed.scan).toEqual(full.scan);
  expect(resumed.scan).toMatchObject({ sessionId: child, cwd: '/workspace/child', timestamp: '2026-09-06T08:05:00.000Z', version: '0.153.4', model: 'child-model' });
  expect(resumed.scan.gitBranch).toBeUndefined();
});

it('repairs unchanged poisoned parent and child rows even in a cold backup directory', async () => {
  const dir = path.join(home, '.agents', '.history', 'backups', 'codex', '2026-09-06', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const childPath = path.join(dir, `rollout-${child}.jsonl`);
  const parentPath = path.join(dir, `rollout-${parent}.jsonl`);
  fs.writeFileSync(childPath, fixture);
  fs.writeFileSync(parentPath, fixture.split('\n')[1] + '\n');
  await discover.discoverSessions({ agent: 'codex', all: true });
  expect(db.getSessionById(child)?.filePath).toBe(childPath);
  const before = fs.statSync(childPath);
  // The old last-meta scanner indexed the child's bytes under its parent id.
  db.getDB().prepare('UPDATE sessions SET file_path = ?, cwd = ? WHERE id = ?').run(childPath, '/workspace/poisoned', parent);
  db.getDB().prepare('DELETE FROM sessions WHERE id = ?').run(child);
  db.getDB().prepare('UPDATE scan_ledger SET extractor_version = ?, scanned_at = ?').run(db.CONTENT_INDEX_VERSION - 1, 1);
  discover.__resetCodexScanBranchCountsForTest();
  await discover.discoverSessions({ agent: 'codex', all: true });
  expect(discover.__codexScanBranchCountsForTest().full).toBeGreaterThanOrEqual(2);
  expect(db.getSessionById(parent)).toMatchObject({ filePath: parentPath, cwd: '/workspace/parent' });
  expect(db.getSessionById(child)).toMatchObject({ filePath: childPath, cwd: '/workspace/child', version: '0.153.4' });
  expect(fs.statSync(childPath).mtimeMs).toBe(before.mtimeMs);
  expect(fs.statSync(childPath).size).toBe(before.size);
  expect(db.ftsSearch('independent child').map(row => row.sessionId)).toContain(child);
  const versions = db.getDB().prepare('SELECT extractor_version FROM scan_ledger').all() as { extractor_version: number }[];
  expect(versions.every(row => row.extractor_version === db.CONTENT_INDEX_VERSION)).toBe(true);
});

it('removes a poisoned parent binding and tool ledger when only the child rollout exists', async () => {
  const orphanChild = '44444444-4444-4444-8444-444444444444';
  const absentParent = '33333333-3333-4333-8333-333333333333';
  const dir = path.join(home, '.agents', '.history', 'backups', 'codex', '2026-09-07', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${orphanChild}.jsonl`);
  const content = fixture.replaceAll(child, orphanChild).replaceAll(parent, absentParent);
  fs.writeFileSync(file, content);
  const stat = fs.statSync(file);
  db.upsertSession({ id: absentParent, shortId: absentParent.slice(0, 8), agent: 'codex', filePath: file,
    timestamp: '2026-09-06T08:00:00.000Z', cwd: '/workspace/poisoned' }, 'poisoned parent evidence');
  db.getDB().prepare('INSERT INTO scan_ledger (file_path, file_mtime_ms, file_size, scanned_at, extractor_version) VALUES (?, ?, ?, ?, ?)')
    .run(file, stat.mtimeMs, stat.size, 1, db.CONTENT_INDEX_VERSION - 1);
  db.getDB().prepare('INSERT INTO tool_scan_ledger (session_id, file_path, file_mtime_ms, file_size, extractor_version, indexed_at, call_count, evidence_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(absentParent, file, stat.mtimeMs, stat.size, 1, 1, 0, 0);

  await discover.discoverSessions({ agent: 'codex', all: true });

  expect(db.getSessionById(absentParent)).toBeFalsy();
  expect(db.getSessionById(orphanChild)).toMatchObject({ filePath: file, cwd: '/workspace/child' });
  expect(db.ftsSearch('poisoned parent evidence').map(row => row.sessionId)).not.toContain(absentParent);
  expect(db.getDB().prepare('SELECT session_id FROM tool_scan_ledger WHERE file_path = ?').get(file)).toEqual({ session_id: orphanChild });
  expect(fs.readFileSync(file, 'utf8')).toBe(content);
});
