import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';

// RUSH-2436: the local DB is authoritative for content. A session whose
// transcript file is gone must still LIST and RENDER its user turns (served from
// session_text), flagged `archived`, instead of silently vanishing — and merely
// listing it must NOT purge its redacted tool-call evidence. A contentless
// phantom (a stale/moved file_path) stays suppressed.

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-db-archived-'));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

const db = await import('./db.js');
const toolStore = await import('./tool-store.js');

afterAll(() => {
  db.closeDB();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(testHome, { recursive: true, force: true });
});

beforeEach(() => {
  const handle = db.getDB();
  handle.exec('DELETE FROM sessions');
  handle.exec('DELETE FROM session_text');
  handle.exec('DELETE FROM tool_calls');
  handle.exec('DELETE FROM tool_scan_ledger');
  handle.exec('DELETE FROM session_preview_cache');
});

function makeMeta(id: string, agent: string, filePath: string): SessionMeta {
  return {
    id,
    shortId: id.slice(0, 8),
    agent: agent as SessionMeta['agent'],
    timestamp: '2026-08-08T00:00:00.000Z',
    cwd: '/tmp/project',
    filePath,
    messageCount: 2,
  };
}

/** Index a real transcript with durable user content, then delete its file. */
function indexThenDeleteFile(id: string, agent: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(testHome, `${agent}-`));
  const filePath = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(filePath, '{}\n');
  const stat = fs.statSync(filePath);
  db.upsertSessionsBatch([{
    meta: makeMeta(id, agent, filePath),
    content,
    scan: { fileMtimeMs: stat.mtimeMs, fileSize: stat.size },
  }]);
  fs.rmSync(filePath, { force: true });
  return filePath;
}

describe('RUSH-2436 archived session durability', () => {
  it('keeps a file-gone session in the listing, flagged archived, with content served from the DB', () => {
    indexThenDeleteFile('codex-archived-1', 'codex', 'refactor the retry loop please');

    const listed = db.querySessions();
    const row = listed.find(s => s.id === 'codex-archived-1');
    expect(row, 'file-gone session must still list, not vanish').toBeDefined();
    expect(row!.archived).toBe(true);
    expect(typeof row!.archivedAt).toBe('number');

    // The user turns are served from session_text, not the (deleted) file.
    expect(db.readSessionContent('codex-archived-1')).toBe('refactor the retry loop please');
  });

  it('resolves a file-gone session by id (agents sessions <id> path), not "No session found"', () => {
    indexThenDeleteFile('grok-archived-2', 'grok', 'why did the deploy stall?');

    // findSessionsById is exactly what `agents sessions <id>` resolves through.
    const byExact = db.findSessionsById('grok-archived-2');
    expect(byExact.map(s => s.id)).toContain('grok-archived-2');
    expect(byExact[0].archived).toBe(true);

    const byPrefix = db.findSessionsById('grok-arch');
    expect(byPrefix.map(s => s.id)).toContain('grok-archived-2');
  });

  it('does NOT purge tool-call evidence merely because the file is gone', () => {
    const id = 'claude-archived-3';
    const dir = fs.mkdtempSync(path.join(testHome, 'claude-'));
    const filePath = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(filePath, '{}\n');
    const stat = fs.statSync(filePath);
    const meta = makeMeta(id, 'claude', filePath);
    db.upsertSessionsBatch([{ meta, content: 'find the bug in parser.ts', scan: { fileMtimeMs: stat.mtimeMs, fileSize: stat.size } }]);
    toolStore.persistToolCalls(db.getDB(), meta, [{
      ordinal: 0, timestamp: meta.timestamp, tool: 'Bash', programs: ['git'],
      programOccurrences: [{ program: 'git', role: 'effective' }],
      input: 'git status', outcome: 'unknown',
    }], { fileMtimeMs: stat.mtimeMs, fileSize: stat.size }, { mode: 'replace' });

    const before = (db.getDB().prepare('SELECT count(*) AS n FROM tool_calls WHERE session_id = ?').get(id) as { n: number }).n;
    expect(before).toBe(1);

    fs.rmSync(filePath, { force: true });
    // Listing the file-gone session must not destroy its redacted evidence.
    db.querySessions();

    const after = (db.getDB().prepare('SELECT count(*) AS n FROM tool_calls WHERE session_id = ?').get(id) as { n: number }).n;
    expect(after, 'tool-call evidence must survive a listing of a file-gone session').toBe(1);
  });

  it('still suppresses a genuine phantom (stale file_path, no cached content)', () => {
    // A row whose file is missing AND whose session_text content is empty is a
    // phantom (a stale/moved pointer), not an archived session — stays dropped.
    const dir = fs.mkdtempSync(path.join(testHome, 'phantom-'));
    const filePath = path.join(dir, 'phantom.jsonl');
    fs.writeFileSync(filePath, '{}\n');
    const stat = fs.statSync(filePath);
    db.upsertSessionsBatch([{
      meta: makeMeta('phantom-4', 'codex', filePath),
      content: '',
      scan: { fileMtimeMs: stat.mtimeMs, fileSize: stat.size },
    }]);
    fs.rmSync(filePath, { force: true });

    const listed = db.querySessions();
    expect(listed.find(s => s.id === 'phantom-4'), 'contentless phantom must stay suppressed').toBeUndefined();
    // And it is never stamped archived.
    const rawArchived = (db.getDB().prepare('SELECT archived_at FROM sessions WHERE id = ?').get('phantom-4') as { archived_at: number | null }).archived_at;
    expect(rawArchived).toBeNull();
  });

  it('stamps archived_at only once (sticky)', () => {
    indexThenDeleteFile('codex-archived-5', 'codex', 'summarize the failing tests');

    const first = db.querySessions().find(s => s.id === 'codex-archived-5')!.archivedAt;
    expect(typeof first).toBe('number');
    // A second listing must not move the stamp.
    const second = db.querySessions().find(s => s.id === 'codex-archived-5')!.archivedAt;
    expect(second).toBe(first);
  });

  it('keeps an archived, content-bearing session in the cost rollup (topSessionsByCost)', () => {
    const id = 'codex-archived-cost';
    const dir = fs.mkdtempSync(path.join(testHome, 'codex-'));
    const filePath = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(filePath, '{}\n');
    const stat = fs.statSync(filePath);
    const meta = makeMeta(id, 'codex', filePath);
    meta.costUsd = 4.20; // topSessionsByCost filters cost_usd IS NOT NULL
    db.upsertSessionsBatch([{ meta, content: 'a pricey session', scan: { fileMtimeMs: stat.mtimeMs, fileSize: stat.size } }]);
    fs.rmSync(filePath, { force: true });

    const top = db.topSessionsByCost(10);
    expect(top.map(t => t.meta.id), 'archived expensive session must stay in the cost rollup').toContain(id);
    expect(top.find(t => t.meta.id === id)!.meta.archived).toBe(true);
  });

  it('un-archives a session whose file comes back (recoverable-trash restore)', () => {
    const id = 'codex-resurrect';
    const dir = fs.mkdtempSync(path.join(testHome, 'codex-'));
    const filePath = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(filePath, '{}\n');
    const stat = fs.statSync(filePath);
    db.upsertSessionsBatch([{ meta: makeMeta(id, 'codex', filePath), content: 'restore me', scan: { fileMtimeMs: stat.mtimeMs, fileSize: stat.size } }]);

    fs.rmSync(filePath, { force: true });
    expect(db.querySessions().find(s => s.id === id)!.archived).toBe(true);

    // The file returns; the next listing must clear the archived flag.
    fs.writeFileSync(filePath, '{}\n');
    const back = db.querySessions().find(s => s.id === id);
    expect(back, 'restored session still lists').toBeDefined();
    expect(back!.archived).toBeUndefined();
    const raw = (db.getDB().prepare('SELECT archived_at FROM sessions WHERE id = ?').get(id) as { archived_at: number | null }).archived_at;
    expect(raw).toBeNull();
  });
});
