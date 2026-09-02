import * as fs from 'fs';
import { StringDecoder } from 'string_decoder';
import type Database from '../sqlite.js';
import { getDB, maintainSessionSearchIndex } from './db.js';
import { parseSession } from './parse.js';
import {
  TOOL_INDEX_VERSION,
  TOOL_INDEX_LIMIT_ORDINAL,
  ToolCallCollector,
  type ToolCallCollectorSnapshot,
  collectClaudeToolCalls,
  collectCodexToolCalls,
  toolCallEvidenceBytes,
  toolCallsFromEvents,
  type IndexedToolCall,
} from './tool-calls.js';
import type { SessionMeta } from './types.js';
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

export const TOOL_SEARCH_SCHEMA_VERSION = 1;
export const TOOL_PROGRAM_COUNT_SCHEMA_VERSION = 1;
export const TOOL_QUERY_MAX_CLAUSES = 32;
export const TOOL_QUERY_MAX_CLAUSE_BYTES = 4096;
export const TOOL_QUERY_MAX_CALL_ROWS = 50_000;
export const TOOL_QUERY_MAX_RESULT_BYTES = 8 * 1024 * 1024;
export const TOOL_QUERY_MAX_RESULT_SESSIONS = 1_000;
export const TOOL_QUERY_MAX_SERIALIZED_BYTES = 15 * 1024 * 1024;
export const TOOL_QUERY_MERGE_OVERHEAD_BYTES = 64 * 1024;

export interface ToolIndexCoverage {
  indexedFiles: number;
  indexedCalls: number;
  skippedFiles: number;
  limitedFiles: number;
  remainingFiles: number;
  complete: boolean;
}

export interface ToolCallEvidence extends IndexedToolCall {
  id: string;
}

export interface ToolSessionEvidence {
  id: string;
  shortId: string;
  agent: string;
  machine?: string;
  timestamp: string;
  project?: string;
  cwd?: string;
  topic?: string;
  label?: string;
  /** The daemon-generated headline (PHNX-3797). Carried so a consumer of this
   * envelope names a session the same way every other surface does; a
   * projection that drops it silently degrades `sessionHeadline` to
   * `label || topic`. */
  generatedTitle?: string;
  filePath?: string;
  calls: ToolCallEvidence[];
}

export interface ToolSearchEnvelope {
  schemaVersion: typeof TOOL_SEARCH_SCHEMA_VERSION;
  generatedAt: string;
  query: { clauses: string[] };
  coverage: ToolIndexCoverage;
  sessions: ToolSessionEvidence[];
}

export interface ToolProgramCountTotals {
  occurrences: number;
  toolCalls: number;
  sessions: number;
}

export interface ToolProgramCountEnvelope {
  schemaVersion: typeof TOOL_PROGRAM_COUNT_SCHEMA_VERSION;
  kind: 'tool-program-count';
  generatedAt: string;
  query: {
    program: string;
    semantics: 'static-program-occurrences-v1';
  };
  coverage: ToolIndexCoverage;
  totals: ToolProgramCountTotals;
  machines: Array<{
    machine: string;
    coverage: ToolIndexCoverage;
    totals: ToolProgramCountTotals;
  }>;
}

/** Serialize once and enforce headroom below the fleet transport's 16 MiB cap. */
export function serializeToolSearchEnvelope(envelope: ToolSearchEnvelope): string {
  const rendered = JSON.stringify(envelope, null, 2) + '\n';
  if (Buffer.byteLength(rendered) > TOOL_QUERY_MAX_SERIALIZED_BYTES) {
    throw new Error(`Tool result exceeds ${TOOL_QUERY_MAX_SERIALIZED_BYTES / 1024 / 1024} MiB after JSON encoding; reduce --limit or add a more specific term.`);
  }
  return rendered;
}

/** Exact UTF-8 size of the public pretty-JSON envelope. */
export function serializedToolSearchEnvelopeBytes(envelope: ToolSearchEnvelope): number {
  return Buffer.byteLength(JSON.stringify(envelope, null, 2) + '\n');
}

/**
 * Reserve the exact local JSON plus coordinator headroom before retaining peer
 * stdout. Peer envelopes repeat metadata that disappears during merge, so
 * charging their full wire bytes against the remainder is conservative.
 */
export function toolSearchRemoteReceiveBudget(envelope: ToolSearchEnvelope): number {
  const localBytes = serializedToolSearchEnvelopeBytes(envelope);
  return Math.max(
    0,
    TOOL_QUERY_MAX_SERIALIZED_BYTES - TOOL_QUERY_MERGE_OVERHEAD_BYTES - localBytes,
  );
}

interface StoredCallRow {
  call_key: string;
  session_id: string;
  ordinal: number;
  source_call_id: string | null;
  timestamp: string;
  tool: string;
  input: string;
  outcome: IndexedToolCall['outcome'];
  exit_code: number | null;
  status_code: number | null;
  error_code: string | null;
  output: string | null;
  error: string | null;
  parse_error: string | null;
}

interface ToolLedgerRow {
  file_path: string;
  file_mtime_ms: number;
  file_size: number;
  extractor_version: number;
  parsed_offset: number | null;
}

/**
 * The ledger columns every candidate session is judged on. Deliberately NOT
 * `parser_state`: this runs once per session in the scan's warm path, and that
 * column holds a serialized collector snapshot that can reach a megabyte. It is
 * read separately, only for the sessions that turn out to need indexing.
 */
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

/**
 * Where to start reading a session whose transcript changed.
 *
 * A live session's transcript is append-only, so re-reading it from byte 0 on
 * every scan re-parses the entire history to discover the handful of records
 * that are new — the cost that makes a large session's tool index quadratic in
 * the number of scans. When the ledger carries a resume point that the current
 * file still agrees with, the scan reads only the appended bytes and merges the
 * result (`append`); anything else re-reads the whole file (`replace`).
 *
 * Each check below rejects a case where the stored prefix may no longer describe
 * the file: a harness the streaming parser cannot resume, a different extractor,
 * no recorded resume point, a source path the ledger row does not describe, a
 * file that shrank below what was already parsed (a rewrite or truncation, not
 * an append), or a snapshot that does not read back.
 */
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

/** Read index completeness from SQLite only; never stat or parse transcripts. */
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

/**
 * One parse of a transcript: the calls to persist, plus where a later scan may
 * resume. `resume` is null when the parse could not be trusted to have covered
 * its whole prefix — the next scan then re-reads from byte 0.
 */
interface ToolParseResult {
  calls: IndexedToolCall[];
  resume: ToolScanResumePoint | null;
}

/** Stream Claude/Codex JSONL without ever retaining an oversized record. */
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
  // Byte offset just past the last complete record applied. Only a complete,
  // newline-terminated record advances it, so resuming here can never re-apply a
  // record (which would mint a second ordinal for it) nor skip a partial tail.
  let parsedOffset = from.startOffset;
  /** Bytes of the record currently being assembled, across chunk boundaries. */
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
      // Counted outside the drop guard and across chunk boundaries: this is the
      // record's true size on disk, which is what the resume offset is measured
      // in. `pendingBytes` cannot stand in for it — that one resets when an
      // oversized record is dropped, and a record split over two 64 KiB reads
      // would lose the part carried in from the previous chunk.
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
      parsedOffset += lineBytes + 1; // + the newline itself
      lineBytes = 0;
      pending = '';
      pendingBytes = 0;
      droppingOversizedLine = false;
      start = newline + 1;
    }
  };

  for await (const chunk of stream) consume(decoder.write(chunk as Buffer));
  consume(decoder.end());

  // Snapshot BEFORE the unterminated trailing record, and pair it with an offset
  // that stops short of that record. The writer may be mid-append, so the record
  // is indexed now (its evidence is real) but is re-read by the next scan — which
  // resumes with the same next-ordinal and so re-derives the same ordinals,
  // making the re-read an idempotent upsert rather than a duplicate.
  const resume = skippedOversizedLine
    // A dropped oversized record left the ordinals and the pending map out of
    // step with the file; nothing here can be resumed from.
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

/** True for the harnesses whose transcript the streaming parser can resume. */
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
  // Every other harness is parsed whole into memory by parseSession, which
  // exposes no byte offset to resume from — so these stay full replaces and
  // record no resume point, rather than storing one this path cannot honour.
  return { calls: toolCallsFromEvents(parseSession(session.filePath, session.agent)), resume: null };
}

/**
 * Fill one bounded chunk of the independent tool index. A warm call performs
 * only stat + ledger checks; it never opens or parses unchanged transcripts.
 */
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
    /** Bytes this scan will actually read — the whole file, or just the tail. */
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
    // The byte budget is a batch boundary, not a correctness boundary. Admit
    // one oversized transcript by itself so it can never wedge the ledger or
    // silently disappear from results; the next invocation resumes afterward.
    // Budgeted on the bytes this scan reads, not the file's size: a resumed
    // session costs only its appended tail, so a batch can cover far more
    // growing sessions than it could when every one was re-read whole.
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
  // The scan just wrote a batch of FTS segments; pay a bounded slice of the
  // merge they need so the index converges here instead of degrading until
  // someone runs `agents sessions optimize` by hand (RUSH-2208).
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

interface QueryTerm {
  field?: 'tool' | 'program' | 'input' | 'output' | 'status' | 'exit' | 'error';
  value: string;
}

function tokenizeClause(source: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (const char of source.trim()) {
    if (escaped) {
      token += char;
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = undefined;
      else token += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (token) tokens.push(token);
      token = '';
    } else {
      token += char;
    }
  }
  if (escaped) token += '\\';
  if (token) tokens.push(token);
  return tokens;
}

/** Parse one same-call clause. Unprefixed terms search every evidence field. */
export function parseToolQueryClause(source: string): QueryTerm[] {
  const fields = new Set(['tool', 'program', 'input', 'output', 'status', 'exit', 'error']);
  return tokenizeClause(source).map((token) => {
    const colon = token.indexOf(':');
    if (colon > 0) {
      const candidate = token.slice(0, colon).toLowerCase();
      if (fields.has(candidate)) {
        return { field: candidate as QueryTerm['field'], value: token.slice(colon + 1) };
      }
    }
    return { value: token };
  }).filter((term) => term.value.length > 0);
}

/** A count has one unambiguous subject: one exact `program:<name>` term. */
export function parseToolProgramCountClause(source: string): string {
  const terms = parseToolQueryClause(source);
  if (terms.length !== 1 || terms[0].field !== 'program') {
    throw new Error('--count requires exactly one --query program:<name> clause.');
  }
  return terms[0].value;
}

function includes(haystack: string | undefined, needle: string): boolean {
  return (haystack ?? '').toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}

function matchesTerm(call: ToolCallEvidence, term: QueryTerm): boolean {
  const value = term.value.toLocaleLowerCase();
  switch (term.field) {
    case 'tool': return includes(call.tool, value);
    case 'program': return call.programs.some((program) => program.toLocaleLowerCase() === value);
    case 'input': return includes(call.input, value);
    // A harness can mark the returned bytes as an error while they are still
    // the command's output. Keep `error:` available for explicit diagnostics,
    // but let `output:` match either bounded result channel.
    case 'output': return includes(call.output, value) || includes(call.error, value);
    case 'status': return call.outcome === value || String(call.statusCode ?? '') === value;
    case 'exit': return String(call.exitCode ?? '') === value;
    case 'error': return includes(call.error, value) || includes(call.errorCode, value);
    default:
      return [call.tool, call.input, call.output, call.error, call.errorCode, call.outcome]
        .some((field) => includes(field, value))
        || call.programs.some((program) => includes(program, value))
        || String(call.exitCode ?? '') === value
        || String(call.statusCode ?? '') === value;
  }
}

function distinctClauseAssignment(calls: ToolCallEvidence[], clauses: QueryTerm[][]): ToolCallEvidence[] | null {
  if (clauses.length === 0) return calls;
  const candidates = clauses.map((clause) => calls.filter((call) => clause.every((term) => matchesTerm(call, term))));
  if (candidates.some((matches) => matches.length === 0)) return null;
  const order = candidates.map((_, index) => index).sort((a, b) => candidates[a].length - candidates[b].length);
  const selected = new Map<number, ToolCallEvidence>();
  const ownerByCall = new Map<string, number>();
  const assign = (clauseIndex: number, seenCalls: Set<string>): boolean => {
    for (const call of candidates[clauseIndex]) {
      if (seenCalls.has(call.id)) continue;
      seenCalls.add(call.id);
      const owner = ownerByCall.get(call.id);
      if (owner === undefined || assign(owner, seenCalls)) {
        ownerByCall.set(call.id, clauseIndex);
        selected.set(clauseIndex, call);
        return true;
      }
    }
    return false;
  };
  for (const clauseIndex of order) {
    if (!assign(clauseIndex, new Set())) return null;
  }
  return clauses.map((_, index) => selected.get(index)!);
}

function intersect(left: Set<string> | undefined, right: Set<string>): Set<string> {
  if (!left) return right;
  return new Set([...left].filter((key) => right.has(key)));
}

function ftsPhrase(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function canUseTrigram(value: string): boolean {
  return Array.from(value).length >= 3;
}

function ftsCandidateRows(
  db: Database.Database,
  sessionIds: string[],
  expression: string,
): Array<{ call_key: string }> {
  return db.prepare(`
    SELECT t.call_key FROM tool_call_text t
    JOIN tool_calls c ON c.call_key = t.call_key
    WHERE c.session_id IN (SELECT value FROM json_each(?)) AND tool_call_text MATCH ?
    LIMIT ?
  `).all(JSON.stringify(sessionIds), expression, TOOL_QUERY_MAX_CALL_ROWS + 1) as Array<{ call_key: string }>;
}

/** Use indexed typed columns and trigram FTS; final matching remains exact in JS. */
function candidateKeysForClause(
  db: Database.Database,
  sessionIds: string[],
  clause: QueryTerm[],
): Set<string> {
  let candidates: Set<string> | undefined;
  const scope = JSON.stringify(sessionIds);
  for (const term of clause) {
    const matches = new Set<string>();
    let rows: Array<{ call_key: string }> = [];
    switch (term.field) {
      case 'program':
        rows = db.prepare(`
          SELECT p.call_key FROM tool_call_programs p
          JOIN tool_calls c ON c.call_key = p.call_key
          WHERE c.session_id IN (SELECT value FROM json_each(?)) AND p.program = ? COLLATE NOCASE
          LIMIT ?
        `).all(scope, term.value, TOOL_QUERY_MAX_CALL_ROWS + 1) as Array<{ call_key: string }>;
        break;
      case 'status':
        rows = db.prepare(`
          SELECT call_key FROM tool_calls
          WHERE session_id IN (SELECT value FROM json_each(?))
            AND (outcome = ? COLLATE NOCASE OR CAST(status_code AS TEXT) = ?)
          LIMIT ?
        `).all(scope, term.value, term.value, TOOL_QUERY_MAX_CALL_ROWS + 1) as Array<{ call_key: string }>;
        break;
      case 'exit':
        rows = db.prepare(`
          SELECT call_key FROM tool_calls
          WHERE session_id IN (SELECT value FROM json_each(?)) AND CAST(exit_code AS TEXT) = ?
          LIMIT ?
        `).all(scope, term.value, TOOL_QUERY_MAX_CALL_ROWS + 1) as Array<{ call_key: string }>;
        break;
      case 'tool':
      case 'input': {
        const field = term.field;
        rows = canUseTrigram(term.value)
          ? ftsCandidateRows(db, sessionIds, `${field}:${ftsPhrase(term.value)}`)
          : db.prepare(`
              SELECT call_key FROM tool_calls
              WHERE session_id IN (SELECT value FROM json_each(?))
                AND instr(lower(${field}), lower(?)) > 0
              LIMIT ?
            `).all(scope, term.value, TOOL_QUERY_MAX_CALL_ROWS + 1) as Array<{ call_key: string }>;
        break;
      }
      case 'output':
        rows = canUseTrigram(term.value)
          ? ftsCandidateRows(db, sessionIds, `(output:${ftsPhrase(term.value)} OR error:${ftsPhrase(term.value)})`)
          : db.prepare(`
              SELECT call_key FROM tool_calls
              WHERE session_id IN (SELECT value FROM json_each(?))
                AND (instr(lower(coalesce(output, '')), lower(?)) > 0
                  OR instr(lower(coalesce(error, '')), lower(?)) > 0)
              LIMIT ?
            `).all(scope, term.value, term.value, TOOL_QUERY_MAX_CALL_ROWS + 1) as Array<{ call_key: string }>;
        break;
      case 'error':
        if (canUseTrigram(term.value)) {
          rows = ftsCandidateRows(db, sessionIds, `error:${ftsPhrase(term.value)}`);
          rows.push(...db.prepare(`
            SELECT call_key FROM tool_calls
            WHERE session_id IN (SELECT value FROM json_each(?))
              AND instr(lower(coalesce(error_code, '')), lower(?)) > 0
            LIMIT ?
          `).all(scope, term.value, TOOL_QUERY_MAX_CALL_ROWS + 1) as Array<{ call_key: string }>);
        } else {
          rows = db.prepare(`
            SELECT call_key FROM tool_calls
            WHERE session_id IN (SELECT value FROM json_each(?))
              AND (instr(lower(coalesce(error, '')), lower(?)) > 0
                OR instr(lower(coalesce(error_code, '')), lower(?)) > 0)
            LIMIT ?
          `).all(scope, term.value, term.value, TOOL_QUERY_MAX_CALL_ROWS + 1) as Array<{ call_key: string }>;
        }
        break;
      default:
        if (canUseTrigram(term.value)) {
          rows = ftsCandidateRows(db, sessionIds, ftsPhrase(term.value));
          rows.push(...db.prepare(`
            SELECT c.call_key FROM tool_calls c
            WHERE c.session_id IN (SELECT value FROM json_each(?)) AND (
              instr(lower(coalesce(c.error_code, '')), lower(?)) > 0
              OR instr(lower(c.outcome), lower(?)) > 0
              OR CAST(c.exit_code AS TEXT) = ?
              OR CAST(c.status_code AS TEXT) = ?
              OR EXISTS (
                SELECT 1 FROM tool_call_programs p
                WHERE p.call_key = c.call_key AND instr(lower(p.program), lower(?)) > 0
              )
            ) LIMIT ?
          `).all(
            scope, term.value, term.value, term.value, term.value, term.value,
            TOOL_QUERY_MAX_CALL_ROWS + 1,
          ) as Array<{ call_key: string }>);
        } else {
          rows = db.prepare(`
            SELECT c.call_key FROM tool_calls c
            WHERE c.session_id IN (SELECT value FROM json_each(?)) AND (
              instr(lower(c.tool), lower(?)) > 0
              OR instr(lower(c.input), lower(?)) > 0
              OR instr(lower(coalesce(c.output, '')), lower(?)) > 0
              OR instr(lower(coalesce(c.error, '')), lower(?)) > 0
              OR instr(lower(coalesce(c.error_code, '')), lower(?)) > 0
              OR instr(lower(c.outcome), lower(?)) > 0
              OR CAST(c.exit_code AS TEXT) = ?
              OR CAST(c.status_code AS TEXT) = ?
              OR EXISTS (
                SELECT 1 FROM tool_call_programs p
                WHERE p.call_key = c.call_key AND instr(lower(p.program), lower(?)) > 0
              )
            ) LIMIT ?
          `).all(
            scope,
            term.value, term.value, term.value, term.value, term.value,
            term.value, term.value, term.value, term.value,
            TOOL_QUERY_MAX_CALL_ROWS + 1,
          ) as Array<{ call_key: string }>;
        }
        break;
    }
    for (const row of rows) matches.add(row.call_key);
    if (matches.size > TOOL_QUERY_MAX_CALL_ROWS) {
      throw new Error(`Tool query matched more than ${TOOL_QUERY_MAX_CALL_ROWS.toLocaleString()} call rows; add a more specific term.`);
    }
    candidates = intersect(candidates, matches);
    if (candidates.size === 0) break;
  }
  return candidates ?? new Set<string>();
}

function programsForRows(db: Database.Database, rows: StoredCallRow[]): Map<string, string[]> {
  const programs = new Map<string, string[]>();
  const keys = rows.map((row) => row.call_key);
  if (keys.length === 0) return programs;
  const programRows = db.prepare(`
    SELECT call_key, program FROM tool_call_programs
    WHERE call_key IN (SELECT value FROM json_each(?)) ORDER BY program
  `).all(JSON.stringify(keys)) as Array<{ call_key: string; program: string }>;
  for (const row of programRows) {
    const list = programs.get(row.call_key) ?? [];
    list.push(row.program);
    programs.set(row.call_key, list);
  }
  return programs;
}

function occurrencesForRows(
  db: Database.Database,
  rows: StoredCallRow[],
): Map<string, IndexedToolCall['programOccurrences']> {
  const occurrences = new Map<string, IndexedToolCall['programOccurrences']>();
  const keys = rows.map((row) => row.call_key);
  if (keys.length === 0) return occurrences;
  const occurrenceRows = db.prepare(`
    SELECT call_key, program, role FROM tool_program_occurrences
    WHERE call_key IN (SELECT value FROM json_each(?))
    ORDER BY call_key, occurrence_ordinal
  `).all(JSON.stringify(keys)) as Array<{
    call_key: string;
    program: string;
    role: 'wrapper' | 'effective';
  }>;
  for (const row of occurrenceRows) {
    const list = occurrences.get(row.call_key) ?? [];
    list.push({ program: row.program, role: row.role });
    occurrences.set(row.call_key, list);
  }
  return occurrences;
}

function appendStoredRows(
  out: Map<string, ToolCallEvidence[]>,
  rows: StoredCallRow[],
  programs: Map<string, string[]>,
  occurrences: Map<string, IndexedToolCall['programOccurrences']>,
  loadedBytes: number,
): number {
  for (const row of rows) {
    const call: ToolCallEvidence = {
      id: row.call_key,
      ordinal: row.ordinal,
      sourceCallId: row.source_call_id ?? undefined,
      timestamp: row.timestamp,
      tool: row.tool,
      programs: programs.get(row.call_key) ?? [],
      programOccurrences: occurrences.get(row.call_key) ?? [],
      input: row.input,
      outcome: row.outcome,
      exitCode: row.exit_code ?? undefined,
      statusCode: row.status_code ?? undefined,
      errorCode: row.error_code ?? undefined,
      output: row.output ?? undefined,
      error: row.error ?? undefined,
      parseError: row.parse_error ?? undefined,
    };
    loadedBytes += toolCallEvidenceBytes(call);
    if (loadedBytes > TOOL_QUERY_MAX_RESULT_BYTES) {
      throw new Error(`Tool result exceeds ${TOOL_QUERY_MAX_RESULT_BYTES / 1024 / 1024} MiB; reduce --limit or add a more specific term.`);
    }
    const list = out.get(row.session_id) ?? [];
    list.push(call);
    out.set(row.session_id, list);
  }
  return loadedBytes;
}

function readCalls(db: Database.Database, sessionIds: string[]): Map<string, ToolCallEvidence[]> {
  const out = new Map<string, ToolCallEvidence[]>();
  const PAGE = 250;
  let totalRows = 0;
  let loadedBytes = 0;
  for (const sessionId of sessionIds) {
    let afterOrdinal = -1;
    for (;;) {
      const rows = db.prepare(`
        SELECT * FROM tool_calls
        WHERE session_id = ? AND ordinal > ?
        ORDER BY ordinal LIMIT ?
      `).all(sessionId, afterOrdinal, PAGE) as StoredCallRow[];
      if (rows.length === 0) break;
      totalRows += rows.length;
      if (totalRows > TOOL_QUERY_MAX_CALL_ROWS) {
        throw new Error(`Tool listing exceeds ${TOOL_QUERY_MAX_CALL_ROWS.toLocaleString()} call rows; reduce --limit or add --query.`);
      }
      loadedBytes = appendStoredRows(
        out,
        rows,
        programsForRows(db, rows),
        occurrencesForRows(db, rows),
        loadedBytes,
      );
      afterOrdinal = rows.at(-1)!.ordinal;
      if (rows.length < PAGE) break;
    }
  }
  return out;
}

function readCallsByKeys(db: Database.Database, keys: Set<string>): Map<string, ToolCallEvidence[]> {
  if (keys.size === 0) return new Map();
  const out = new Map<string, ToolCallEvidence[]>();
  const allKeys = [...keys];
  let loadedBytes = 0;
  const rows = db.prepare(`
    SELECT * FROM tool_calls
    WHERE call_key IN (SELECT value FROM json_each(?))
    ORDER BY session_id, ordinal
  `).all(JSON.stringify(allKeys)) as StoredCallRow[];
  loadedBytes = appendStoredRows(
    out,
    rows,
    programsForRows(db, rows),
    occurrencesForRows(db, rows),
    loadedBytes,
  );
  return out;
}

/** Count exact, pre-indexed static program sites without reading transcripts. */
export function countToolProgramOccurrences(
  sessions: SessionMeta[],
  program: string,
  coverage: ToolIndexCoverage,
  machine: string,
): ToolProgramCountEnvelope {
  const normalized = program.trim();
  if (!normalized || Buffer.byteLength(normalized) > 512) {
    throw new Error('Tool program count requires one program name from 1 to 512 bytes.');
  }
  const db = getDB();
  const ids = sessions.map((session) => session.id);
  const rows = ids.length === 0 ? [] : db.prepare(`
    SELECT coalesce(nullif(s.machine, ''), ?) AS machine,
      count(*) AS occurrences,
      count(DISTINCT o.call_key) AS toolCalls,
      count(DISTINCT c.session_id) AS sessions
    FROM tool_program_occurrences o
    JOIN tool_calls c ON c.call_key = o.call_key
    JOIN sessions s ON s.id = c.session_id
    WHERE c.session_id IN (SELECT value FROM json_each(?))
      AND o.program = ? COLLATE NOCASE
    GROUP BY coalesce(nullif(s.machine, ''), ?)
  `).all(machine, JSON.stringify(ids), normalized, machine) as Array<{
    machine: string;
    occurrences: number;
    toolCalls: number;
    sessions: number;
  }>;
  const totals = rows.reduce<ToolProgramCountTotals>((sum, row) => ({
    occurrences: sum.occurrences + row.occurrences,
    toolCalls: sum.toolCalls + row.toolCalls,
    sessions: sum.sessions + row.sessions,
  }), { occurrences: 0, toolCalls: 0, sessions: 0 });
  const sessionsByMachine = new Map<string, SessionMeta[]>();
  for (const session of sessions) {
    const origin = session.machine ?? machine;
    const group = sessionsByMachine.get(origin) ?? [];
    group.push(session);
    sessionsByMachine.set(origin, group);
  }
  const coverageRows = ids.length === 0 ? [] : db.prepare(`
    WITH scoped AS (
      SELECT id, coalesce(nullif(machine, ''), ?) AS machine
      FROM sessions
      WHERE file_path <> ''
        AND id IN (SELECT value FROM json_each(?))
    )
    SELECT
      scoped.machine,
      count(*) AS scope_files,
      count(ledger.session_id) AS indexed_files,
      coalesce(sum(ledger.call_count), 0) AS indexed_calls,
      count(limited.call_key) AS limited_files
    FROM scoped
    LEFT JOIN tool_scan_ledger ledger
      ON ledger.session_id = scoped.id
      AND ledger.extractor_version = ?
    LEFT JOIN tool_calls limited
      ON limited.session_id = scoped.id
      AND limited.tool = 'index_limit'
    GROUP BY scoped.machine
  `).all(machine, JSON.stringify(ids), TOOL_INDEX_VERSION) as Array<{
    machine: string;
    scope_files: number;
    indexed_files: number;
    indexed_calls: number;
    limited_files: number;
  }>;
  const coverageByMachine = new Map(coverageRows.map((row) => {
    const remainingFiles = Math.max(0, row.scope_files - row.indexed_files);
    return [row.machine, {
      indexedFiles: row.indexed_files,
      indexedCalls: row.indexed_calls,
      skippedFiles: 0,
      limitedFiles: row.limited_files,
      remainingFiles,
      complete: remainingFiles === 0 && row.limited_files === 0,
    } satisfies ToolIndexCoverage];
  }));
  const machineTotals = new Map(rows.map((row) => [row.machine, {
    occurrences: row.occurrences,
    toolCalls: row.toolCalls,
    sessions: row.sessions,
  }]));
  const machines = [...sessionsByMachine.keys()].map((origin) => ({
    machine: origin,
    coverage: coverageByMachine.get(origin) ?? {
      indexedFiles: 0,
      indexedCalls: 0,
      skippedFiles: 0,
      limitedFiles: 0,
      remainingFiles: 0,
      complete: true,
    },
    totals: machineTotals.get(origin) ?? { occurrences: 0, toolCalls: 0, sessions: 0 },
  }));
  if (machines.length === 0) machines.push({ machine, coverage, totals });
  return {
    schemaVersion: TOOL_PROGRAM_COUNT_SCHEMA_VERSION,
    kind: 'tool-program-count',
    generatedAt: new Date().toISOString(),
    query: { program: normalized, semantics: 'static-program-occurrences-v1' },
    coverage,
    totals,
    machines,
  };
}

/** Query cached evidence; every repeated clause must select a distinct call. */
export function searchToolCalls(
  sessions: SessionMeta[],
  clauseSources: string[],
  coverage: ToolIndexCoverage,
  resultLimit = sessions.length,
): ToolSearchEnvelope {
  if (!Number.isSafeInteger(resultLimit) || resultLimit < 1 || resultLimit > TOOL_QUERY_MAX_RESULT_SESSIONS) {
    throw new Error(`Tool search --limit must be from 1 to ${TOOL_QUERY_MAX_RESULT_SESSIONS}.`);
  }
  if (clauseSources.length > TOOL_QUERY_MAX_CLAUSES) {
    throw new Error(`Tool search accepts at most ${TOOL_QUERY_MAX_CLAUSES} --query clauses.`);
  }
  if (clauseSources.some((clause) => Buffer.byteLength(clause) > TOOL_QUERY_MAX_CLAUSE_BYTES)) {
    throw new Error(`Each tool --query clause is limited to ${TOOL_QUERY_MAX_CLAUSE_BYTES} bytes.`);
  }
  const db = getDB();
  const clauses = clauseSources.map(parseToolQueryClause);
  const searchedSessions = clauses.length === 0 ? sessions.slice(0, resultLimit) : sessions;
  const sessionIds = searchedSessions.map((session) => session.id);
  let candidateKeys: Set<string> | undefined;
  if (clauses.length > 0) {
    candidateKeys = new Set<string>();
    for (const clause of clauses) {
      for (const key of candidateKeysForClause(db, sessionIds, clause)) {
        candidateKeys.add(key);
        if (candidateKeys.size > TOOL_QUERY_MAX_CALL_ROWS) {
          throw new Error(`Tool query requires more than ${TOOL_QUERY_MAX_CALL_ROWS.toLocaleString()} candidate calls; add a more specific term.`);
        }
      }
    }
  }
  const callsBySession = clauses.length === 0
    ? readCalls(db, sessionIds)
    : readCallsByKeys(db, candidateKeys!);
  const matched: ToolSessionEvidence[] = [];
  let resultBytes = 0;
  for (const session of searchedSessions) {
    const calls = callsBySession.get(session.id) ?? [];
    const selected = distinctClauseAssignment(calls, clauses);
    if (!selected || selected.length === 0) continue;
    resultBytes += Buffer.byteLength([
      session.id, session.shortId, session.agent, session.machine, session.timestamp,
      session.project, session.cwd, session.topic, session.label,
    ].filter((value): value is string => typeof value === 'string').join('\0'));
    resultBytes += selected.reduce((total, call) => total + toolCallEvidenceBytes(call), 0);
    if (resultBytes > TOOL_QUERY_MAX_RESULT_BYTES) {
      throw new Error(`Tool result exceeds ${TOOL_QUERY_MAX_RESULT_BYTES / 1024 / 1024} MiB; reduce --limit or add a more specific term.`);
    }
    matched.push({
      id: session.id,
      shortId: session.shortId,
      agent: session.agent,
      machine: session.machine,
      timestamp: session.timestamp,
      project: session.project,
      cwd: session.cwd,
      topic: session.topic,
      label: session.label,
      generatedTitle: session.generatedTitle,
      calls: selected,
    });
    if (matched.length >= resultLimit) break;
  }
  return {
    schemaVersion: TOOL_SEARCH_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    query: { clauses: clauseSources },
    coverage,
    sessions: matched,
  };
}
