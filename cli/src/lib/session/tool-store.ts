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
} from '@phnx-labs/sessions-cli/reader';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';

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
  const deleteText = db.prepare(`DELETE FROM tool_call_text WHERE rowid = ?`);
  for (const { rowid, call_key } of rows) {
    deletePrograms.run(call_key);
    deleteOccurrences.run(call_key);
    deleteText.run(rowid);
  }
  db.prepare(`DELETE FROM tool_calls WHERE session_id = ?`).run(sessionId);
}

export function purgeToolCalls(
  db: Database.Database,
  sessionId: string,
): void {
  deleteSessionCalls(db, sessionId);
  db.prepare(`DELETE FROM tool_scan_ledger WHERE session_id = ?`).run(sessionId);
}

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

export interface ToolScanResumePoint {
  parserState: string;
  parsedOffset: number;
}

interface PersistToolCallsOptions {
  mode?: 'replace' | 'append';
  resume?: ToolScanResumePoint | null;
  maxSessionBytes?: number;
}

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
