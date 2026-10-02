import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-tool-store-'));
process.env.HOME = TEST_HOME;

const { closeDB, getDB, querySessions, upsertSession } = await import('./db.js');
const { canonicalToolLedgerPath, persistToolCalls, purgeMissingToolCallsInDirectory } = await import('./tool-store.js');
type SessionMeta = import('@phnx-labs/sessions-cli/reader').SessionMeta;

afterAll(() => {
  closeDB();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('persistToolCalls', () => {
  it('replaces then incrementally updates calls and their program rows', () => {
    const db = getDB();
    const filePath = path.join(TEST_HOME, 'session.jsonl');
    fs.writeFileSync(filePath, '{}\n');
    const session = {
      id: 'store-session', shortId: 'store-se', agent: 'codex',
      timestamp: '2026-08-03T00:00:00Z', filePath,
    } as SessionMeta;
    const stamp = { fileMtimeMs: fs.statSync(filePath).mtimeMs, fileSize: fs.statSync(filePath).size };
    persistToolCalls(db, session, [{
      ordinal: 0, timestamp: session.timestamp, tool: 'exec_command', programs: ['git'],
      programOccurrences: [
        { program: 'git', role: 'effective' },
        { program: 'git', role: 'effective' },
      ],
      input: 'git status', outcome: 'unknown',
    }], stamp, { mode: 'replace' });
    persistToolCalls(db, session, [{
      ordinal: 0, timestamp: session.timestamp, tool: 'exec_command', programs: ['git'],
      programOccurrences: [{ program: 'git', role: 'effective' }],
      input: 'git status', outcome: 'error', error: 'failed',
    }], stamp, { mode: 'append' });

    expect(db.prepare(`SELECT outcome, error FROM tool_calls WHERE session_id = ?`).get(session.id))
      .toEqual({ outcome: 'error', error: 'failed' });
    expect(db.prepare(`SELECT program FROM tool_call_programs`).all()).toEqual([{ program: 'git' }]);
    expect(db.prepare(`
      SELECT occurrence_ordinal, program, role FROM tool_program_occurrences
      ORDER BY occurrence_ordinal
    `).all()).toEqual([
      { occurrence_ordinal: 0, program: 'git', role: 'effective' },
    ]);
    expect((db.prepare(`SELECT call_count FROM tool_scan_ledger`).get() as { call_count: number }).call_count).toBe(1);
  });

  it('keeps prior evidence on append and drops it on replace', () => {
    const db = getDB();
    const filePath = path.join(TEST_HOME, 'append-vs-replace.jsonl');
    fs.writeFileSync(filePath, '{}\n');
    const session = {
      id: 'append-vs-replace', shortId: 'append-v', agent: 'claude',
      timestamp: '2026-08-03T00:00:00Z', filePath,
    } as SessionMeta;
    const call = (ordinal: number, input: string) => ({
      ordinal, timestamp: session.timestamp, tool: 'Bash', programs: ['git'],
      programOccurrences: [{ program: 'git', role: 'effective' as const }],
      input, outcome: 'unknown' as const,
    });
    const stamp = () => {
      const stat = fs.statSync(filePath);
      return { fileMtimeMs: stat.mtimeMs, fileSize: stat.size };
    };
    const rowids = () => db.prepare(`SELECT rowid FROM tool_calls WHERE session_id = ? ORDER BY ordinal`)
      .all(session.id) as Array<{ rowid: number }>;
    const inputs = () => (db.prepare(`SELECT input FROM tool_calls WHERE session_id = ? ORDER BY ordinal`)
      .all(session.id) as Array<{ input: string }>).map((row) => row.input);

    persistToolCalls(db, session, [call(0, 'git status'), call(1, 'git diff')], stamp(), {
      mode: 'replace',
      resume: { parserState: '{"v":1,"nextOrdinal":2,"pending":[]}', parsedOffset: 3 },
    });
    const beforeRowids = rowids();
    fs.appendFileSync(filePath, '{}\n');

    // The transcript grew, so the scan indexes only the new call. The two calls
    // already stored keep their rows -- this is the delete-everything-and-reparse
    // that RUSH-2208 is about, and the rowids prove they were never rewritten.
    persistToolCalls(db, session, [call(2, 'git log')], stamp(), {
      mode: 'append',
      resume: { parserState: '{"v":1,"nextOrdinal":3,"pending":[]}', parsedOffset: 6 },
    });

    expect(inputs()).toEqual(['git status', 'git diff', 'git log']);
    expect(rowids().slice(0, 2)).toEqual(beforeRowids);
    expect(db.prepare(`SELECT call_count, parsed_offset FROM tool_scan_ledger WHERE session_id = ?`).get(session.id))
      .toEqual({ call_count: 3, parsed_offset: 6 });
    // Every stored call is still searchable through the rowid-addressed FTS rows.
    expect(db.prepare(`
      SELECT count(*) AS n FROM tool_call_text
      WHERE rowid IN (SELECT rowid FROM tool_calls WHERE session_id = ?)
    `).get(session.id)).toEqual({ n: 3 });

    // A replace with no resume point clears the session's evidence and the
    // resume point with it, so the next scan starts from byte 0.
    persistToolCalls(db, session, [call(0, 'git fetch')], stamp(), { mode: 'replace' });

    expect(inputs()).toEqual(['git fetch']);
    expect(db.prepare(`SELECT call_count, parser_state, parsed_offset FROM tool_scan_ledger WHERE session_id = ?`)
      .get(session.id)).toEqual({ call_count: 1, parser_state: null, parsed_offset: null });
    expect(db.prepare(`
      SELECT count(*) AS n FROM tool_call_text
      WHERE rowid IN (SELECT rowid FROM tool_calls WHERE session_id = ?)
    `).get(session.id)).toEqual({ n: 1 });
  });

  it('leaves no orphaned search rows when a session is replaced', () => {
    const db = getDB();
    const filePath = path.join(TEST_HOME, 'fts-orphans.jsonl');
    fs.writeFileSync(filePath, '{}\n');
    const session = {
      id: 'fts-orphans', shortId: 'fts-orph', agent: 'claude',
      timestamp: '2026-08-03T00:00:00Z', filePath,
    } as SessionMeta;
    const stat = fs.statSync(filePath);
    const stamp = { fileMtimeMs: stat.mtimeMs, fileSize: stat.size };
    const before = (db.prepare(`SELECT count(*) AS n FROM tool_call_text`).get() as { n: number }).n;
    persistToolCalls(db, session, [0, 1, 2].map((ordinal) => ({
      ordinal, timestamp: session.timestamp, tool: 'Bash', programs: ['rg'],
      programOccurrences: [{ program: 'rg', role: 'effective' as const }],
      input: `rg orphan-probe-${ordinal}`, outcome: 'unknown' as const,
    })), stamp, { mode: 'replace' });

    persistToolCalls(db, session, [], stamp, { mode: 'replace' });

    expect(db.prepare(`SELECT count(*) AS n FROM tool_call_text`).get()).toEqual({ n: before });
    expect(db.prepare(`SELECT count(*) AS n FROM tool_call_text WHERE tool_call_text MATCH '"orphan-probe"'`).get())
      .toEqual({ n: 0 });
  });

  it('stores an explicit terminal record when a session reaches its evidence budget', () => {
    const db = getDB();
    const filePath = path.join(TEST_HOME, 'large-session.jsonl');
    fs.writeFileSync(filePath, '{}\n');
    const session = {
      id: 'large-store-session', shortId: 'large-st', agent: 'codex',
      timestamp: '2026-08-03T00:00:00Z', filePath,
    } as SessionMeta;
    const stat = fs.statSync(filePath);
    persistToolCalls(db, session, [{
      ordinal: 0, timestamp: session.timestamp, tool: 'exec_command', programs: ['git'],
      programOccurrences: [{ program: 'git', role: 'effective' }],
      input: `git status ${'x'.repeat(200)}`, outcome: 'unknown',
    }], { fileMtimeMs: stat.mtimeMs, fileSize: stat.size }, { mode: 'replace', maxSessionBytes: 256 });

    expect(db.prepare(`SELECT tool, parse_error FROM tool_calls WHERE session_id = ?`).all(session.id))
      .toEqual([{ tool: 'index_limit', parse_error: 'Additional tool calls were not indexed for this session.' }]);
    const ledger = db.prepare(`SELECT evidence_bytes FROM tool_scan_ledger WHERE file_path = ?`)
      .get(canonicalToolLedgerPath(filePath)) as { evidence_bytes: number };
    expect(ledger.evidence_bytes)
      .toBeLessThanOrEqual(256);
  });

  it('advances an empty append from ledger totals without changing stored evidence', () => {
    const db = getDB();
    const filePath = path.join(TEST_HOME, 'empty-append-session.jsonl');
    fs.writeFileSync(filePath, '{}\n');
    const session = {
      id: 'empty-append-session', shortId: 'empty-ap', agent: 'codex',
      timestamp: '2026-08-03T00:00:00Z', filePath,
    } as SessionMeta;
    const first = fs.statSync(filePath);
    persistToolCalls(db, session, [{
      ordinal: 0, timestamp: session.timestamp, tool: 'exec_command', programs: ['git'],
      programOccurrences: [{ program: 'git', role: 'effective' }],
      input: 'git status', outcome: 'unknown',
    }], { fileMtimeMs: first.mtimeMs, fileSize: first.size });
    const before = db.prepare(`SELECT call_count, evidence_bytes FROM tool_scan_ledger WHERE file_path = ?`).get(filePath);
    fs.appendFileSync(filePath, '{}\n');
    const second = fs.statSync(filePath);

    persistToolCalls(db, session, [], { fileMtimeMs: second.mtimeMs, fileSize: second.size }, { mode: 'append' });

    expect(db.prepare(`SELECT call_count, evidence_bytes FROM tool_scan_ledger WHERE file_path = ?`).get(filePath)).toEqual(before);
    expect(db.prepare(`SELECT count(*) AS n FROM tool_calls WHERE session_id = ?`).get(session.id)).toEqual({ n: 1 });
  });

  it('keeps the pre-parse source stamp when a split transcript appends during indexing', () => {
    const db = getDB();
    const sessionDir = path.join(TEST_HOME, 'kimi-concurrent-append');
    const filePath = path.join(sessionDir, 'state.json');
    const sourcePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(filePath, '{}\n');
    fs.writeFileSync(sourcePath, '{"first":true}\n');
    const session = {
      id: 'kimi-concurrent-append', shortId: 'kimi-con', agent: 'kimi',
      timestamp: '2026-08-03T00:00:00Z', filePath,
    } as SessionMeta;
    const parsedStamp = fs.statSync(sourcePath);

    fs.appendFileSync(sourcePath, '{"appended":true}\n');
    persistToolCalls(db, session, [], {
      fileMtimeMs: parsedStamp.mtimeMs,
      fileSize: parsedStamp.size,
    });

    expect(db.prepare(`SELECT file_mtime_ms, file_size FROM tool_scan_ledger WHERE file_path = ?`)
      .get(canonicalToolLedgerPath(sourcePath)))
      .toEqual({ file_mtime_ms: parsedStamp.mtimeMs, file_size: parsedStamp.size });
    expect(fs.statSync(sourcePath).size).toBeGreaterThan(parsedStamp.size);
  });

  it('archives (does NOT purge) a content-bearing session when its transcript disappears (RUSH-2436)', () => {
    const db = getDB();
    const filePath = path.join(TEST_HOME, 'deleted-session.jsonl');
    fs.writeFileSync(filePath, '{}\n');
    const session = {
      id: 'deleted-store-session', shortId: 'deleted-', agent: 'codex',
      timestamp: '2026-08-03T00:00:00Z', filePath,
    } as SessionMeta;
    upsertSession(session, 'deleted');
    const stat = fs.statSync(filePath);
    persistToolCalls(db, session, [{
      ordinal: 0, timestamp: session.timestamp, tool: 'exec_command', programs: ['git'],
      programOccurrences: [{ program: 'git', role: 'effective' }],
      input: 'git status', outcome: 'unknown',
    }], { fileMtimeMs: stat.mtimeMs, fileSize: stat.size });
    fs.unlinkSync(filePath);

    // The session has durable content ('deleted'), so it is now SERVED (flagged
    // archived) instead of dropped, and merely listing it must NOT destroy its
    // redacted tool-call evidence — that destructive purge-on-read is gone.
    const listed = querySessions({ idExact: session.id });
    expect(listed.map(s => s.id)).toEqual([session.id]);
    expect(listed[0].archived).toBe(true);
    expect(db.prepare(`SELECT count(*) AS n FROM tool_calls WHERE session_id = ?`).get(session.id)).toEqual({ n: 1 });
    expect(db.prepare(`SELECT count(*) AS n FROM tool_scan_ledger WHERE session_id = ?`).get(session.id)).toEqual({ n: 1 });
  });

  it('purges a deleted child from a changed transcript directory without statting every session', () => {
    const db = getDB();
    const dirPath = path.join(TEST_HOME, 'changed-dir');
    fs.mkdirSync(dirPath, { recursive: true });
    const keptPath = path.join(dirPath, 'kept.jsonl');
    const deletedPath = path.join(dirPath, 'deleted.jsonl');
    fs.writeFileSync(keptPath, '{}\n');
    fs.writeFileSync(deletedPath, '{}\n');
    for (const [id, filePath] of [['kept-dir-session', keptPath], ['deleted-dir-session', deletedPath]]) {
      const session = { id, shortId: id.slice(0, 8), agent: 'codex', timestamp: '2026-08-03T00:00:00Z', filePath } as SessionMeta;
      upsertSession(session, id);
      const stat = fs.statSync(filePath);
      persistToolCalls(db, session, [{
        ordinal: 0, timestamp: session.timestamp, tool: 'exec_command', programs: ['git'],
        programOccurrences: [{ program: 'git', role: 'effective' }],
        input: 'git status', outcome: 'unknown',
      }], { fileMtimeMs: stat.mtimeMs, fileSize: stat.size });
    }

    expect(purgeMissingToolCallsInDirectory(db, dirPath, [keptPath])).toBe(1);
    expect(db.prepare(`SELECT session_id FROM tool_calls ORDER BY session_id`).all())
      .toContainEqual({ session_id: 'kept-dir-session' });
    expect(db.prepare(`SELECT session_id FROM tool_calls WHERE session_id = ?`).all('deleted-dir-session')).toEqual([]);
  });

  it('purges the ledger for a deleted transcript that contained no calls', () => {
    const db = getDB();
    const dirPath = path.join(TEST_HOME, 'empty-deleted-dir');
    const filePath = path.join(dirPath, 'empty.jsonl');
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(filePath, '{}\n');
    const session = {
      id: 'empty-deleted-session', shortId: 'empty-de', agent: 'codex',
      timestamp: '2026-08-03T00:00:00Z', filePath,
    } as SessionMeta;
    upsertSession(session, 'empty');
    const stat = fs.statSync(filePath);
    persistToolCalls(db, session, [], { fileMtimeMs: stat.mtimeMs, fileSize: stat.size });
    fs.unlinkSync(filePath);

    expect(purgeMissingToolCallsInDirectory(db, dirPath, [])).toBe(1);
    expect(db.prepare(`SELECT count(*) AS n FROM tool_scan_ledger WHERE file_path = ?`).get(filePath)).toEqual({ n: 0 });
  });

  it.skipIf(process.platform === 'win32')('resolves the same ledger key after deleting a symlinked transcript', () => {
    const db = getDB();
    const realDir = path.join(TEST_HOME, 'real-managed-home');
    const linkedDir = path.join(TEST_HOME, 'linked-managed-home');
    fs.mkdirSync(realDir, { recursive: true });
    fs.symlinkSync(realDir, linkedDir, 'dir');
    const realPath = path.join(realDir, 'linked.jsonl');
    const linkedPath = path.join(linkedDir, 'linked.jsonl');
    fs.writeFileSync(realPath, '{}\n');
    const session = {
      id: 'symlink-deleted-session', shortId: 'symlink-', agent: 'codex',
      timestamp: '2026-08-03T00:00:00Z', filePath: linkedPath,
    } as SessionMeta;
    upsertSession(session, 'symlink');
    const stat = fs.statSync(linkedPath);
    persistToolCalls(db, session, [], { fileMtimeMs: stat.mtimeMs, fileSize: stat.size });
    const canonicalRealPath = canonicalToolLedgerPath(realPath);
    expect(db.prepare(`SELECT file_path FROM tool_scan_ledger WHERE file_path = ?`).get(canonicalRealPath))
      .toEqual({ file_path: canonicalRealPath });
    fs.unlinkSync(realPath);

    expect(purgeMissingToolCallsInDirectory(db, linkedDir, [])).toBe(1);
    expect(db.prepare(`SELECT count(*) AS n FROM tool_scan_ledger WHERE file_path = ?`).get(canonicalRealPath))
      .toEqual({ n: 0 });
  });
});
