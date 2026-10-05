import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-warmtick-incr-'));
process.env.HOME = TEST_HOME;

const { closeDB, getDB, upsertSessionsBatch } = await import('./db.js');
const { parseSession } = await import('@phnx-labs/sessions-cli/reader');
const { scanEventToolCalls } = await import('@phnx-labs/sessions-cli/reader');
const { planEventToolResume, persistToolCalls } = await import('./tool-store.js');
const { TOOL_INDEX_VERSION } = await import('@phnx-labs/sessions-cli/reader');
type SessionMeta = import('@phnx-labs/sessions-cli/reader').SessionMeta;

afterAll(() => {
  closeDB();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

let seq = 0;

function grokCall(command: string, result: string): string {
  const id = `call-${seq++}`;
  return [
    { type: 'assistant', content: `running ${command}`, tool_calls: [
      { id, name: 'shell', arguments: { command } },
    ] },
    { type: 'tool_result', tool_call_id: id, content: result, is_error: false },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n';
}

function stat(filePath: string) {
  const s = fs.statSync(filePath);
  return { fileMtimeMs: s.mtimeMs, fileSize: s.size };
}

function warmTick(sessionId: string, filePath: string): void {
  const scan = stat(filePath);
  const events = parseSession(filePath, 'grok');
  const meta = {
    id: sessionId,
    shortId: sessionId.slice(0, 8),
    agent: 'grok',
    timestamp: '2026-08-28T00:00:00Z',
    filePath,
    machine: 'test-box',
  } as SessionMeta;
  upsertSessionsBatch([{ meta, content: '', scan, events }]);
}

function ledger(sessionId: string) {
  return getDB().prepare(`
    SELECT call_count, file_size, extractor_version, parsed_offset, parser_state
    FROM tool_scan_ledger WHERE session_id = ?
  `).get(sessionId) as {
    call_count: number;
    file_size: number;
    extractor_version: number;
    parsed_offset: number | null;
    parser_state: string | null;
  } | undefined;
}

function storedCalls(sessionId: string) {
  return getDB().prepare(`
    SELECT ordinal, source_call_id, tool, input, outcome, rowid FROM tool_calls
    WHERE session_id = ? ORDER BY ordinal
  `).all(sessionId) as Array<{
    ordinal: number; source_call_id: string | null; tool: string;
    input: string; outcome: string; rowid: number;
  }>;
}

function programsFor(sessionId: string) {
  return getDB().prepare(`
    SELECT p.program FROM tool_call_programs p
    JOIN tool_calls c ON c.call_key = p.call_key
    WHERE c.session_id = ? ORDER BY c.ordinal, p.program
  `).all(sessionId) as Array<{ program: string }>;
}

let session: string;
let filePath: string;

beforeEach(() => {
  session = `grok-${seq}-warm`;
  filePath = path.join(TEST_HOME, `${session}-chat_history.jsonl`);
  fs.writeFileSync(filePath, grokCall('git status', 'clean'));
});

describe('warm-tick tool index — Grok (non-streaming harness) stays incremental', () => {
  it('resumes after the first tick and never re-derives stored calls', () => {
    expect(planEventToolResume(getDB(), session, filePath, stat(filePath), parseSession(filePath, 'grok').length)).toBeNull();
    warmTick(session, filePath);

    const afterFirst = ledger(session);
    expect(afterFirst?.call_count).toBe(1);
    expect(afterFirst?.extractor_version).toBe(TOOL_INDEX_VERSION);
    const firstEventCount = parseSession(filePath, 'grok').length;
    expect(afterFirst?.parsed_offset).toBe(firstEventCount);
    expect(afterFirst?.parser_state).not.toBeNull();

    const firstCallRowid = storedCalls(session)[0].rowid;

    let priorEventCount = firstEventCount;
    for (let tick = 2; tick <= 6; tick++) {
      fs.appendFileSync(filePath, grokCall(`step ${tick}`, `ok ${tick}`));
      const events = parseSession(filePath, 'grok');
      const prior = planEventToolResume(getDB(), session, filePath, stat(filePath), events.length);
      expect(prior, `tick ${tick} must resume, not re-derive`).not.toBeNull();
      expect(prior!.eventCount).toBe(priorEventCount);

      warmTick(session, filePath);

      const l = ledger(session);
      expect(l?.call_count, `tick ${tick} call count`).toBe(tick);
      expect(l?.parsed_offset, `tick ${tick} resume offset`).toBe(events.length);
      expect(storedCalls(session)[0].rowid, `tick ${tick} keeps first row`).toBe(firstCallRowid);
      priorEventCount = events.length;
    }

    expect(storedCalls(session)).toHaveLength(6);
  });

  it('the incremental index equals a full re-parse of the final transcript', () => {
    warmTick(session, filePath);
    for (let tick = 2; tick <= 8; tick++) {
      fs.appendFileSync(filePath, grokCall(`cmd ${tick}`, tick % 3 === 0 ? `Error: boom ${tick}` : `done ${tick}`));
      warmTick(session, filePath);
    }
    const incremental = storedCalls(session);
    const incrementalPrograms = programsFor(session);

    const fresh = `${session}-fullreparse`;
    const freshPath = path.join(TEST_HOME, `${fresh}-chat_history.jsonl`);
    fs.copyFileSync(filePath, freshPath);
    const events = parseSession(freshPath, 'grok');
    const meta = {
      id: fresh, shortId: fresh.slice(0, 8), agent: 'grok',
      timestamp: '2026-08-28T00:00:00Z', filePath: freshPath, machine: 'test-box',
    } as SessionMeta;
    const scanned = scanEventToolCalls(events);
    persistToolCalls(getDB(), meta, scanned.calls, stat(freshPath), { mode: 'replace' });

    const full = storedCalls(fresh).map((c) => ({ ...c, rowid: 0 }));
    const incrementalNoRowid = incremental.map((c) => ({ ...c, rowid: 0 }));
    expect(incrementalNoRowid).toEqual(full);
    expect(incrementalPrograms).toEqual(programsFor(fresh));
    expect(incremental).toHaveLength(8);
  });

  it('full-scans again when the transcript is truncated/rewritten', () => {
    warmTick(session, filePath);
    fs.appendFileSync(filePath, grokCall('more', 'ok'));
    warmTick(session, filePath);
    expect(ledger(session)?.call_count).toBe(2);

    fs.writeFileSync(filePath, grokCall('reset', 'fresh'));
    const events = parseSession(filePath, 'grok');
    expect(planEventToolResume(getDB(), session, filePath, stat(filePath), events.length)).toBeNull();
    warmTick(session, filePath);
    expect(ledger(session)?.call_count).toBe(1);
    expect(storedCalls(session)).toHaveLength(1);
  });

  it('a stale extractor version forces a full re-scan', () => {
    warmTick(session, filePath);
    getDB().prepare(`UPDATE tool_scan_ledger SET extractor_version = ? WHERE session_id = ?`)
      .run(TOOL_INDEX_VERSION - 1, session);
    const events = parseSession(filePath, 'grok');
    expect(planEventToolResume(getDB(), session, filePath, stat(filePath), events.length)).toBeNull();
  });

  it('a corrupt snapshot falls back to a full re-scan', () => {
    warmTick(session, filePath);
    getDB().prepare(`UPDATE tool_scan_ledger SET parser_state = 'not json' WHERE session_id = ?`).run(session);
    const events = parseSession(filePath, 'grok');
    expect(planEventToolResume(getDB(), session, filePath, stat(filePath), events.length)).toBeNull();
  });
});
