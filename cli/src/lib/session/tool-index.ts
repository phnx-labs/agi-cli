import * as fs from 'fs';
import { StringDecoder } from 'string_decoder';
import type Database from '../sqlite.js';
import { getDB, maintainSessionSearchIndex } from './db.js';
import { parseSession } from '@phnx-labs/sessions-cli/reader';
import {
  TOOL_INDEX_VERSION,
  TOOL_INDEX_LIMIT_ORDINAL,
  ToolCallCollector,
  type ToolCallCollectorSnapshot,
  collectClaudeToolCalls,
  collectCodexToolCalls,
  toolCallsFromEvents,
  type IndexedToolCall,
} from '@phnx-labs/sessions-cli/reader';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';
import {
  canonicalToolLedgerPath,
  persistToolCalls,
  purgeToolCalls,
  toolEvidenceSourcePath,
  type ToolScanResumePoint,
} from './tool-store.js';

const BACKFILL_MAX_FILES = 25;
const BACKFILL_MAX_BYTES = 16 * 1024 * 1024;
const BACKFILL_MAX_IN_MEMORY_SOURCE_BYTES = 16 * 1024 * 1024;
const BACKFILL_MAX_JSONL_RECORD_BYTES = 1024 * 1024;
export const BACKFILL_MAX_STREAM_SOURCE_BYTES = 64 * 1024 * 1024;

export interface ToolIndexCoverage {
  indexedFiles: number;
  indexedCalls: number;
  skippedFiles: number;
  limitedFiles: number;
  remainingFiles: number;
  complete: boolean;
}

interface ToolLedgerRow {
  file_path: string;
  file_mtime_ms: number;
  file_size: number;
  extractor_version: number;
  parsed_offset: number | null;
}

function readToolLedger(db: Database.Database, sessionId: string): ToolLedgerRow | undefined {
  return db.prepare(`
    SELECT file_path, file_mtime_ms, file_size, extractor_version, parsed_offset
    FROM tool_scan_ledger WHERE session_id = ?
  `).get(sessionId) as ToolLedgerRow | undefined;
}

function readToolParserState(db: Database.Database, sessionId: string): string | null {
  const row = db.prepare(`SELECT parser_state FROM tool_scan_ledger WHERE session_id = ?`)
    .get(sessionId) as { parser_state: string | null } | undefined;
  return row?.parser_state ?? null;
}

function needsIndex(
  row: ToolLedgerRow | undefined,
  stamp: { fileMtimeMs: number; fileSize: number },
): boolean {
  return !row
    || row.file_mtime_ms !== stamp.fileMtimeMs
    || row.file_size !== stamp.fileSize
    || row.extractor_version !== TOOL_INDEX_VERSION;
}

function planToolScan(
  db: Database.Database,
  sessionId: string,
  row: ToolLedgerRow | undefined,
  sourcePath: string,
  stamp: { fileMtimeMs: number; fileSize: number },
  resumable: boolean,
): { mode: 'replace' | 'append'; startOffset: number; snapshot?: ToolCallCollectorSnapshot } {
  const full = { mode: 'replace' as const, startOffset: 0 };
  if (!resumable || !row) return full;
  if (row.extractor_version !== TOOL_INDEX_VERSION) return full;
  if (row.parsed_offset === null) return full;
  if (row.file_path !== canonicalToolLedgerPath(sourcePath)) return full;
  if (stamp.fileSize < row.file_size || stamp.fileSize < row.parsed_offset) return full;
  const parserState = readToolParserState(db, sessionId);
  if (parserState === null) return full;
  let snapshot: ToolCallCollectorSnapshot;
  try {
    snapshot = JSON.parse(parserState) as ToolCallCollectorSnapshot;
  } catch {
    return full;
  }
  if (snapshot?.v !== 1 || !Number.isSafeInteger(snapshot.nextOrdinal)) return full;
  return { mode: 'append', startOffset: row.parsed_offset, snapshot };
}

export function readToolIndexCoverage(sessions: SessionMeta[]): ToolIndexCoverage {
  const db = getDB();
  const sessionIds = [...new Set(sessions
    .filter((session) => session.filePath)
    .map((session) => session.id))];
  const ledgerRows = sessionIds.length === 0 ? [] : db.prepare(`
    SELECT session_id, extractor_version, call_count
    FROM tool_scan_ledger
    WHERE session_id IN (SELECT value FROM json_each(?))
  `).all(JSON.stringify(sessionIds)) as Array<{
    session_id: string;
    extractor_version: number;
    call_count: number;
  }>;
  const currentRows = ledgerRows.filter((row) => row.extractor_version === TOOL_INDEX_VERSION);
  const limited = sessionIds.length === 0 ? { count: 0 } : db.prepare(`
    SELECT count(DISTINCT session_id) AS count
    FROM tool_calls
    WHERE tool = 'index_limit'
      AND session_id IN (SELECT value FROM json_each(?))
  `).get(JSON.stringify(sessionIds)) as { count: number };
  const remainingFiles = Math.max(0, sessionIds.length - currentRows.length);
  return {
    indexedFiles: currentRows.length,
    indexedCalls: currentRows.reduce((sum, row) => sum + row.call_count, 0),
    skippedFiles: 0,
    limitedFiles: limited.count,
    remainingFiles,
    complete: remainingFiles === 0 && limited.count === 0,
  };
}

function backfillLimitCall(session: SessionMeta, reason: string): IndexedToolCall {
  return {
    ordinal: TOOL_INDEX_LIMIT_ORDINAL,
    timestamp: session.timestamp,
    tool: 'index_limit',
    programs: [],
    programOccurrences: [],
    input: reason,
    outcome: 'unknown',
    parseError: 'Additional tool calls were not indexed for this session.',
  };
}

interface ToolParseResult {
  calls: IndexedToolCall[];
  resume: ToolScanResumePoint | null;
}

async function streamJsonlToolCalls(
  session: SessionMeta,
  from: { startOffset: number; snapshot?: ToolCallCollectorSnapshot } = { startOffset: 0 },
): Promise<ToolParseResult> {
  const collector = new ToolCallCollector(from.snapshot);
  const stream = fs.createReadStream(session.filePath, {
    highWaterMark: 64 * 1024,
    start: from.startOffset,
  });
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let pendingBytes = 0;
  let droppingOversizedLine = false;
  let skippedOversizedLine = false;
  let parsedOffset = from.startOffset;
  let lineBytes = 0;

  const applyLine = (line: string): void => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.endsWith('\r') ? line.slice(0, -1) : line);
    } catch {
      return;
    }
    if (session.agent === 'claude') collectClaudeToolCalls(collector, parsed);
    else collectCodexToolCalls(collector, parsed);
  };

  const consume = (text: string): void => {
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf('\n', start);
      const end = newline >= 0 ? newline : text.length;
      const segment = text.slice(start, end);
      const segmentBytes = Buffer.byteLength(segment);
      lineBytes += segmentBytes;
      if (!droppingOversizedLine) {
        if (pendingBytes + segmentBytes <= BACKFILL_MAX_JSONL_RECORD_BYTES) {
          pending += segment;
          pendingBytes += segmentBytes;
        } else {
          pending = '';
          pendingBytes = 0;
          droppingOversizedLine = true;
          skippedOversizedLine = true;
        }
      }
      if (newline < 0) break;
      if (!droppingOversizedLine) applyLine(pending);
      parsedOffset += lineBytes + 1;
      lineBytes = 0;
      pending = '';
      pendingBytes = 0;
      droppingOversizedLine = false;
      start = newline + 1;
    }
  };

  for await (const chunk of stream) consume(decoder.write(chunk as Buffer));
  consume(decoder.end());

  const resume = skippedOversizedLine
    ? null
    : { parserState: JSON.stringify(collector.snapshot()), parsedOffset };
  if (!droppingOversizedLine && pending.length > 0) applyLine(pending);

  const calls = collector.drainChanged();
  if (skippedOversizedLine && !calls.some((call) => call.ordinal === TOOL_INDEX_LIMIT_ORDINAL)) {
    calls.push(backfillLimitCall(
      session,
      'At least one JSONL record exceeded the 1 MiB tool-backfill parser limit.',
    ));
  }
  return { calls, resume };
}

function isResumableToolSource(agent: string): boolean {
  return agent === 'claude' || agent === 'codex';
}

async function toolCallsForBackfill(
  session: SessionMeta,
  sourceBytes: number,
  from: { startOffset: number; snapshot?: ToolCallCollectorSnapshot } = { startOffset: 0 },
): Promise<ToolParseResult> {
  if (isResumableToolSource(session.agent)) {
    if (sourceBytes > BACKFILL_MAX_STREAM_SOURCE_BYTES) {
      return {
        calls: [backfillLimitCall(
          session,
          'Transcript exceeds the 64 MiB safe streaming tool-backfill limit.',
        )],
        resume: null,
      };
    }
    return streamJsonlToolCalls(session, from);
  }
  if (sourceBytes > BACKFILL_MAX_IN_MEMORY_SOURCE_BYTES) {
    return {
      calls: [backfillLimitCall(
        session,
        'Transcript exceeds the 16 MiB safe in-memory tool-backfill parser limit.',
      )],
      resume: null,
    };
  }
  return { calls: toolCallsFromEvents(parseSession(session.filePath, session.agent)), resume: null };
}

export async function ensureToolIndex(
  sessions: SessionMeta[],
  limits: { maxFiles?: number; maxBytes?: number; verifySourceStamps?: boolean } = {},
): Promise<ToolIndexCoverage> {
  const maxFiles = limits.maxFiles ?? BACKFILL_MAX_FILES;
  const maxBytes = limits.maxBytes ?? BACKFILL_MAX_BYTES;
  const db = getDB();
  const pending: Array<{
    session: SessionMeta;
    stamp: { fileMtimeMs: number; fileSize: number };
    plan: ReturnType<typeof planToolScan>;
    readBytes: number;
  }> = [];
  let skippedFiles = 0;

  for (const session of sessions) {
    if (!session.filePath) continue;
    const sourcePath = toolEvidenceSourcePath(session.filePath, session.agent);
    const ledger = readToolLedger(db, session.id);
    const mustStatSource = limits.verifySourceStamps || sourcePath !== session.filePath;
    const indexed = !mustStatSource
      ? db.prepare(`
          SELECT file_mtime_ms, file_size FROM sessions WHERE id = ?
        `).get(session.id) as { file_mtime_ms: number | null; file_size: number | null } | undefined
      : undefined;
    let stamp = indexed?.file_mtime_ms != null && indexed.file_size != null
      ? { fileMtimeMs: indexed.file_mtime_ms, fileSize: indexed.file_size }
      : undefined;
    if (mustStatSource || !stamp) {
      try {
        const stat = fs.statSync(sourcePath);
        stamp = { fileMtimeMs: stat.mtimeMs, fileSize: stat.size };
      } catch {
        purgeToolCalls(db, session.id);
        skippedFiles++;
        continue;
      }
    }
    if (!needsIndex(ledger, stamp)) continue;
    const plan = planToolScan(db, session.id, ledger, sourcePath, stamp, isResumableToolSource(session.agent));
    pending.push({
      session,
      stamp,
      plan,
      readBytes: Math.max(0, stamp.fileSize - plan.startOffset),
    });
  }

  let indexedFiles = 0;
  let indexedCalls = 0;
  let consumedBytes = 0;
  let attemptedFiles = 0;
  for (const item of pending) {
    if (attemptedFiles >= maxFiles) break;
    if (attemptedFiles > 0 && consumedBytes + item.readBytes > maxBytes) break;
    attemptedFiles++;
    consumedBytes += item.readBytes;
    try {
      const { calls, resume } = await toolCallsForBackfill(item.session, item.stamp.fileSize, item.plan);
      persistToolCalls(db, item.session, calls, item.stamp, { mode: item.plan.mode, resume });
      indexedFiles++;
      indexedCalls += calls.length;
    } catch {
      skippedFiles++;
    }
  }
  if (indexedFiles > 0) maintainSessionSearchIndex(db);

  const remainingFiles = Math.max(0, pending.length - attemptedFiles);
  const limitedSessionIds = new Set<string>();
  const sessionIds = sessions.map((session) => session.id);
  for (let offset = 0; offset < sessionIds.length; offset += 500) {
    const ids = sessionIds.slice(offset, offset + 500);
    if (ids.length === 0) continue;
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT DISTINCT session_id FROM tool_calls
      WHERE tool = 'index_limit' AND session_id IN (${placeholders})
    `).all(...ids) as Array<{ session_id: string }>;
    for (const row of rows) limitedSessionIds.add(row.session_id);
  }
  const limitedFiles = limitedSessionIds.size;
  return {
    indexedFiles,
    indexedCalls,
    skippedFiles,
    limitedFiles,
    remainingFiles,
    complete: remainingFiles === 0 && skippedFiles === 0 && limitedFiles === 0,
  };
}
