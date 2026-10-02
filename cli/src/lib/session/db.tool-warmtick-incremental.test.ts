/**
 * The daemon warm-tick tool index is incremental for NON-streaming harnesses
 * (PHNX-3411).
 *
 * A live session's transcript grows every turn, so the warm-tick indexer sees a
 * changed session on every tick. It used to re-derive — parse AND re-sanitize —
 * every tool call in the whole history each time, `toolIndexMode: 'replace'`.
 * For an active large session on the interactive hub that was seconds of
 * synchronous work per tick, blocking the daemon event loop and browser IPC.
 * claude/codex were carved out into a resumable path; the other 11 harnesses
 * were not.
 *
 * These tests drive the real `upsertSessionsBatch` warm-tick path for a Grok
 * session (a non-streaming, full-file harness) across many ticks and pin:
 *   - the tool index resumes (append), not re-derives (replace), after tick 1;
 *   - a growing session's already-stored calls are never deleted+reinserted;
 *   - the incrementally-built index is byte-for-byte the same as one full
 *     re-parse of the final transcript (NO regression);
 *   - a first scan, a truncation/rewrite, and an extractor bump all still
 *     full-scan correctly.
 *
 * Real files, a real SQLite index, the real parser — no mocks.
 */
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

/** One completed Grok tool call: the assistant tool_call and its tool_result. */
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

/** Drive one warm tick: exactly what the Grok scanner + batch indexer do. */
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
  // Grok's tool source IS chat_history.jsonl (see toolEvidenceSourcePath); name
  // the file so parseGrok reads it directly and the tool stamp matches.
  fs.writeFileSync(filePath, grokCall('git status', 'clean'));
});

describe('warm-tick tool index — Grok (non-streaming harness) stays incremental', () => {
  it('resumes after the first tick and never re-derives stored calls', () => {
    // Tick 1: a first, cold scan MUST be a full parse — nothing to resume from.
    expect(planEventToolResume(getDB(), session, filePath, stat(filePath), parseSession(filePath, 'grok').length)).toBeNull();
    warmTick(session, filePath);

    const afterFirst = ledger(session);
    expect(afterFirst?.call_count).toBe(1);
    expect(afterFirst?.extractor_version).toBe(TOOL_INDEX_VERSION);
    // The resume point was recorded: the whole event stream folded to its end
    // (each Grok call is an assistant message + a tool_use + a tool_result).
    const firstEventCount = parseSession(filePath, 'grok').length;
    expect(afterFirst?.parsed_offset).toBe(firstEventCount);
    expect(afterFirst?.parser_state).not.toBeNull();

    const firstCallRowid = storedCalls(session)[0].rowid;

    // Five more ticks, one appended completed call each. Every tick after the
    // first MUST be an incremental resume, and the first call's row MUST keep its
    // rowid — a full 'replace' deletes+reinserts it (new rowid), an 'append'
    // upsert does not, so a stable rowid is observable proof of incrementality.
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
    // Build the same session incrementally across many ticks.
    warmTick(session, filePath);
    for (let tick = 2; tick <= 8; tick++) {
      fs.appendFileSync(filePath, grokCall(`cmd ${tick}`, tick % 3 === 0 ? `Error: boom ${tick}` : `done ${tick}`));
      warmTick(session, filePath);
    }
    const incremental = storedCalls(session);
    const incrementalPrograms = programsFor(session);

    // Full re-parse of the SAME final content into a fresh session id, from
    // event 0. A distinct file path — the tool ledger keys file_path uniquely, so
    // two sessions cannot share one transcript there.
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
    // Byte-for-byte identical evidence: same ordinals, tools, redacted inputs,
    // and outcomes (incl. the `Error:`-prefixed rows that become error outcomes).
    expect(incrementalNoRowid).toEqual(full);
    expect(incrementalPrograms).toEqual(programsFor(fresh));
    expect(incremental).toHaveLength(8);
  });

  it('full-scans again when the transcript is truncated/rewritten', () => {
    warmTick(session, filePath);
    fs.appendFileSync(filePath, grokCall('more', 'ok'));
    warmTick(session, filePath);
    expect(ledger(session)?.call_count).toBe(2);

    // Rewrite the file smaller than what was already folded — a truncation, not
    // an append. The next scan MUST NOT resume from the stale offset.
    fs.writeFileSync(filePath, grokCall('reset', 'fresh'));
    const events = parseSession(filePath, 'grok');
    expect(planEventToolResume(getDB(), session, filePath, stat(filePath), events.length)).toBeNull();
    warmTick(session, filePath);
    // The index reflects the rewritten file, not the stale longer history.
    expect(ledger(session)?.call_count).toBe(1);
    expect(storedCalls(session)).toHaveLength(1);
  });

  it('a stale extractor version forces a full re-scan', () => {
    warmTick(session, filePath);
    // Simulate an extractor bump: the stored row predates the current version.
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
