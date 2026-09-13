import * as fs from 'fs';
import * as path from 'path';
import type Database from '../sqlite.js';
import {
  TOOL_INDEX_VERSION,
  TOOL_INDEX_LIMIT_ORDINAL,
  TOOL_SESSION_EVIDENCE_MAX_BYTES,
  toolCallEvidenceBytes,
  toolCallKey,
  type IndexedToolCall,
  type ToolCallCollectorSnapshot,
  type EventToolScanResumePoint,
} from './tool-calls.js';
import type { SessionMeta } from './types.js';

export function canonicalToolLedgerPath(filePath: string): string {
  let probe = path.resolve(filePath);
  const suffix: string[] = [];
  while (true) {
    try {
      return path.join(fs.realpathSync(probe), ...suffix.reverse());
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return path.resolve(filePath);
      suffix.push(path.basename(probe));
      probe = parent;
    }
  }
}

/** Resolve the transcript that actually carries tool events for split-file harnesses. */
export function toolEvidenceSourcePath(filePath: string, agent: string): string {
  if (agent === 'kimi' && path.basename(filePath) === 'state.json') {
    return path.join(path.dirname(filePath), 'agents', 'main', 'wire.jsonl');
  }
  if (agent === 'grok' && path.basename(filePath) === 'summary.json') {
    return path.join(path.dirname(filePath), 'chat_history.jsonl');
  }
  return filePath;
}

function deleteSessionCalls(db: Database.Database, sessionId: string): void {
  const rows = db.prepare(`SELECT rowid, call_key FROM tool_calls WHERE session_id = ?`)
    .all(sessionId) as Array<{ rowid: number; call_key: string }>;
  const deletePrograms = db.prepare(`DELETE FROM tool_call_programs WHERE call_key = ?`);
  const deleteOccurrences = db.prepare(`DELETE FROM tool_program_occurrences WHERE call_key = ?`);
  // Addressed by rowid, never by the UNINDEXED call_key — see the tool_call_text
  // schema comment in db.ts. A call_key predicate scans the whole FTS index.
  const deleteText = db.prepare(`DELETE FROM tool_call_text WHERE rowid = ?`);
  for (const { rowid, call_key } of rows) {
    deletePrograms.run(call_key);
    deleteOccurrences.run(call_key);
    deleteText.run(rowid);
  }
  db.prepare(`DELETE FROM tool_calls WHERE session_id = ?`).run(sessionId);
}

/** Remove cached tool evidence when its source transcript no longer exists. */
export function purgeToolCalls(
  db: Database.Database,
  sessionId: string,
): void {
  deleteSessionCalls(db, sessionId);
  db.prepare(`DELETE FROM tool_scan_ledger WHERE session_id = ?`).run(sessionId);
}

/** Purge deleted direct children when a transcript directory's stamp changes. */
export function purgeMissingToolCallsInDirectory(
  db: Database.Database,
  dirPath: string,
  currentFilePaths: string[],
): number {
  const normalizedDir = path.normalize(dirPath);
  const prefix = normalizedDir.endsWith(path.sep) ? normalizedDir : normalizedDir + path.sep;
  const present = new Set(currentFilePaths.map((filePath) => path.normalize(filePath)));
  const rows = db.prepare(`
    SELECT s.id, s.file_path, s.agent
    FROM sessions s
    WHERE substr(s.file_path, 1, ?) = ?
  `).all(prefix.length, prefix) as Array<{ id: string; file_path: string; agent: string }>;
  let purged = 0;
  for (const row of rows) {
    const filePath = path.normalize(row.file_path);
    if (path.dirname(filePath) !== normalizedDir || present.has(filePath)) continue;
    purgeToolCalls(db, row.id);
    purged++;
  }
  return purged;
}

/** The resume point a later incremental scan starts from. */
export interface ToolScanResumePoint {
  /** Serialized ToolCallCollector snapshot at `parsedOffset`. */
  parserState: string;
  /**
   * Where a later scan may resume. For the streaming (claude/codex) path this is
   * a BYTE offset just past the last complete record consumed. For the full-file
   * harness path (`planEventToolResume`) it is instead the COUNT of normalized
   * events already folded — the two never share a session (a session is one
   * agent, and the streaming path is claude/codex only), so the column carries
   * whichever meaning that agent's resumer wrote.
   */
  parsedOffset: number;
}

interface PersistToolCallsOptions {
  /**
   * `replace` drops the session's stored evidence first — correct for a parse
   * that started at byte 0. `append` merges the batch into what is already
   * stored and requires an existing ledger row; use it only for a parse that
   * resumed from that row's `parsedOffset`.
   */
  mode?: 'replace' | 'append';
  /**
   * Where a later scan may resume. Omitted (or null) clears any stored resume
   * point, which forces the next scan of this session to re-read from byte 0 —
   * the correct outcome whenever the parse could not cover the whole prefix
   * (an oversized record, a size-capped transcript, a non-streaming harness).
   */
  resume?: ToolScanResumePoint | null;
  maxSessionBytes?: number;
}

/** Persist one parser batch, its file stamp, and its resume point atomically. */
export function persistToolCalls(
  db: Database.Database,
  session: SessionMeta,
  calls: IndexedToolCall[],
  sourceStamp: { fileMtimeMs: number; fileSize: number },
  options: PersistToolCallsOptions = {},
): void {
  const mode = options.mode ?? 'replace';
  const maxSessionBytes = options.maxSessionBytes ?? TOOL_SESSION_EVIDENCE_MAX_BYTES;
  const resume = options.resume ?? null;
  const sourcePath = toolEvidenceSourcePath(session.filePath, session.agent);
  const insertCall = db.prepare(`
    INSERT INTO tool_calls (
      call_key, session_id, ordinal, source_call_id, timestamp, end_timestamp, tool, input,
      outcome, exit_code, status_code, error_code, output, error, parse_error
      , evidence_bytes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, ordinal) DO UPDATE SET
      source_call_id = excluded.source_call_id,
      timestamp = excluded.timestamp,
      end_timestamp = excluded.end_timestamp,
      tool = excluded.tool,
      input = excluded.input,
      outcome = excluded.outcome,
      exit_code = excluded.exit_code,
      status_code = excluded.status_code,
      error_code = excluded.error_code,
      output = excluded.output,
      error = excluded.error,
      parse_error = excluded.parse_error,
      evidence_bytes = excluded.evidence_bytes
  `);
  const insertProgram = db.prepare(`INSERT OR IGNORE INTO tool_call_programs (call_key, program) VALUES (?, ?)`);
  const insertOccurrence = db.prepare(`
    INSERT INTO tool_program_occurrences (call_key, occurrence_ordinal, program, role)
    VALUES (?, ?, ?, ?)
  `);
  // tool_call_text rows are addressed by the rowid of the tool_calls row they
  // describe (db.ts schema comment): its UNINDEXED call_key cannot be seeked.
  const insertText = db.prepare(`INSERT INTO tool_call_text (rowid, call_key, tool, input, output, error) VALUES (?, ?, ?, ?, ?, ?)`);
  const callRowid = db.prepare(`SELECT rowid FROM tool_calls WHERE call_key = ?`);
  const deletePrograms = db.prepare(`DELETE FROM tool_call_programs WHERE call_key = ?`);
  const deleteOccurrences = db.prepare(`DELETE FROM tool_program_occurrences WHERE call_key = ?`);
  const deleteText = db.prepare(`DELETE FROM tool_call_text WHERE rowid = ?`);
  const deleteCall = db.prepare(`DELETE FROM tool_calls WHERE call_key = ?`);
  const writeLedger = db.prepare(`
    INSERT INTO tool_scan_ledger (
      session_id, file_path, file_mtime_ms, file_size, extractor_version, indexed_at, call_count,
      evidence_bytes, parser_state, parsed_offset
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      file_path = excluded.file_path,
      file_mtime_ms = excluded.file_mtime_ms,
      file_size = excluded.file_size,
      extractor_version = excluded.extractor_version,
      indexed_at = excluded.indexed_at,
      call_count = excluded.call_count,
      evidence_bytes = excluded.evidence_bytes,
      parser_state = excluded.parser_state,
      parsed_offset = excluded.parsed_offset
  `);

  const txn = db.transaction(() => {
    if (mode === 'replace') deleteSessionCalls(db, session.id);
    const ledgerPath = canonicalToolLedgerPath(sourcePath);
    const priorLedger = mode === 'append'
      ? db.prepare(`SELECT call_count, evidence_bytes FROM tool_scan_ledger WHERE session_id = ?`).get(session.id) as {
          call_count: number;
          evidence_bytes: number;
        } | undefined
      : undefined;
    if (mode === 'append' && !priorLedger) {
      throw new Error('Append tool evidence requires an existing tool ledger row.');
    }
    if (mode === 'append' && calls.length === 0) {
      writeLedger.run(
        session.id, ledgerPath, sourceStamp.fileMtimeMs, sourceStamp.fileSize, TOOL_INDEX_VERSION, Date.now(),
        priorLedger!.call_count, priorLedger!.evidence_bytes,
        resume?.parserState ?? null, resume?.parsedOffset ?? null,
      );
      return;
    }

    const limitKey = toolCallKey(session.id, TOOL_INDEX_LIMIT_ORDINAL);
    const existingSize = db.prepare(`
      SELECT evidence_bytes FROM tool_calls WHERE session_id = ? AND ordinal = ?
    `);
    const priorLimit = mode === 'append'
      ? existingSize.get(session.id, TOOL_INDEX_LIMIT_ORDINAL) as { evidence_bytes: number } | undefined
      : undefined;
    const limitRow = callRowid.get(limitKey) as { rowid: number } | undefined;
    deletePrograms.run(limitKey);
    deleteOccurrences.run(limitKey);
    if (limitRow) deleteText.run(limitRow.rowid);
    deleteCall.run(limitKey);

    const existingRows = mode === 'append'
      ? calls.map((call) => ({
          ordinal: call.ordinal,
          bytes: (existingSize.get(session.id, call.ordinal) as { evidence_bytes: number } | undefined)?.evidence_bytes ?? 0,
        }))
      : [];
    const existingByOrdinal = new Map(existingRows.map((row) => [row.ordinal, row.bytes]));
    let storedBytes = priorLedger?.evidence_bytes ?? 0;
    let count = priorLedger?.call_count ?? 0;
    if (priorLimit) {
      storedBytes -= priorLimit.evidence_bytes;
      count--;
    }
    const limitCall: IndexedToolCall = {
      ordinal: TOOL_INDEX_LIMIT_ORDINAL,
      timestamp: session.timestamp,
      tool: 'index_limit',
      programs: [],
      programOccurrences: [],
      input: `Tool evidence stopped at the ${Math.floor(maxSessionBytes / 1024 / 1024)} MiB per-session payload limit.`,
      outcome: 'unknown',
      parseError: 'Additional tool calls were not indexed for this session.',
    };
    const limitBytes = toolCallEvidenceBytes(limitCall);
    const ordinaryLimit = Math.max(0, maxSessionBytes - limitBytes);
    const accepted: IndexedToolCall[] = [];
    let truncated = false;
    for (const call of [...calls].sort((a, b) => a.ordinal - b.ordinal)) {
      const replacingBytes = existingByOrdinal.get(call.ordinal) ?? 0;
      const nextBytes = storedBytes - replacingBytes + toolCallEvidenceBytes(call);
      if (nextBytes > ordinaryLimit) {
        truncated = true;
        break;
      }
      storedBytes = nextBytes;
      accepted.push(call);
      if (!existingByOrdinal.has(call.ordinal) || replacingBytes === 0) count++;
    }

    if (truncated) {
      if (storedBytes + limitBytes <= maxSessionBytes) {
        accepted.push(limitCall);
        storedBytes += limitBytes;
        count++;
      }
    }

    for (const call of accepted) {
      const key = toolCallKey(session.id, call.ordinal);
      insertCall.run(
        key, session.id, call.ordinal, call.sourceCallId ?? null, call.timestamp,
        call.endTimestamp ?? null, call.tool, call.input, call.outcome, call.exitCode ?? null,
        call.statusCode ?? null, call.errorCode ?? null, call.output ?? null,
        call.error ?? null, call.parseError ?? null, toolCallEvidenceBytes(call),
      );
      // The upsert above preserves the rowid of a call it updated, so this is
      // the same rowid the existing text row (if any) was written under.
      const { rowid } = callRowid.get(key) as { rowid: number };
      deletePrograms.run(key);
      deleteOccurrences.run(key);
      deleteText.run(rowid);
      for (const program of call.programs) insertProgram.run(key, program);
      call.programOccurrences.forEach((occurrence, occurrenceOrdinal) => {
        insertOccurrence.run(key, occurrenceOrdinal, occurrence.program, occurrence.role);
      });
      insertText.run(rowid, key, call.tool, call.input, call.output ?? '', call.error ?? '');
    }
    writeLedger.run(
      session.id, ledgerPath, sourceStamp.fileMtimeMs, sourceStamp.fileSize,
      TOOL_INDEX_VERSION, Date.now(), count, storedBytes,
      resume?.parserState ?? null, resume?.parsedOffset ?? null,
    );
  });
  txn();
}

/**
 * Decide whether a changed full-file-harness session can RESUME its tool index
 * from the last scan instead of re-deriving every call (PHNX-3411).
 *
 * The warm-tick indexer re-derives tool calls for a changed session on every
 * tick, and for an ACTIVE large session that means re-sanitizing tens of
 * thousands of calls each time — the synchronous work that wedged the daemon
 * event loop. Streaming harnesses (claude/codex) already resume from a byte
 * offset; every other harness re-parses the whole file, so this brings them the
 * same benefit at the EVENT level: the ledger stores how many events were folded
 * (`parsed_offset`) plus the collector snapshot (`parser_state`), and a later
 * scan folds only the newly appended events.
 *
 * Returns the prior resume point when it is safe to append, or `null` (full
 * re-scan) whenever the stored prefix may no longer describe the current file:
 * a different extractor, no recorded resume point, a source the ledger row does
 * not describe, a transcript that shrank below what was already parsed (a
 * truncation/rewrite, not an append), more events already folded than the file
 * now yields, or a snapshot that does not read back.
 */
export function planEventToolResume(
  db: Database.Database,
  sessionId: string,
  sourcePath: string,
  stamp: { fileMtimeMs: number; fileSize: number },
  currentEventCount: number,
): EventToolScanResumePoint | null {
  const row = db.prepare(`
    SELECT file_path, file_size, extractor_version, parsed_offset, parser_state
    FROM tool_scan_ledger WHERE session_id = ?
  `).get(sessionId) as {
    file_path: string;
    file_size: number;
    extractor_version: number;
    parsed_offset: number | null;
    parser_state: string | null;
  } | undefined;
  if (!row) return null;
  if (row.extractor_version !== TOOL_INDEX_VERSION) return null;
  if (row.parsed_offset === null || !Number.isSafeInteger(row.parsed_offset) || row.parsed_offset < 0) return null;
  if (row.file_path !== canonicalToolLedgerPath(sourcePath)) return null;
  if (stamp.fileSize < row.file_size) return null;
  // The file grew but reports fewer events than were already folded — the prefix
  // was rewritten, not appended to. Re-scan from scratch.
  if (row.parsed_offset > currentEventCount) return null;
  if (row.parser_state === null) return null;
  let snapshot: ToolCallCollectorSnapshot;
  try {
    snapshot = JSON.parse(row.parser_state) as ToolCallCollectorSnapshot;
  } catch {
    return null;
  }
  if (snapshot?.v !== 1 || !Number.isSafeInteger(snapshot.nextOrdinal)) return null;
  return { snapshot, eventCount: row.parsed_offset };
}
