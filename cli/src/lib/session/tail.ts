/**
 * Fast tail read of a session transcript.
 *
 * The live `--active` view needs the *last* few events of a possibly-huge JSONL
 * to infer state — parsing the whole file per row would make the view crawl. We
 * read only the final chunk from an fd (mirroring the bounded head-read in
 * active.ts's `quickExtractTopic`), drop a partial leading line, and hand the
 * chunk to the existing content parsers so there's zero duplicated parse logic.
 */

import * as fs from 'fs';
import type { SessionAgentId, SessionEvent } from './types.js';
import { parseClaudeContent, parseCodexContent, sanitizeEvents } from './parse.js';

const DEFAULT_MAX_BYTES = 128 * 1024;
const DEFAULT_MAX_EVENTS = 60;

/** A tail read: the last few normalized events plus the raw text they came from. */
interface SessionTail {
  events: SessionEvent[];
  /** The raw JSONL chunk (leading partial line dropped), for content-level math. */
  content: string;
}

/**
 * Read the last `maxBytes` of a JSONL transcript as cleaned text. A tail that
 * begins mid-file yields one malformed leading line, which is dropped here so
 * downstream per-line parsers only see whole lines. Returns '' on any error or
 * empty file.
 */
export function readSessionTailContent(filePath: string, maxBytes = DEFAULT_MAX_BYTES): string {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return '';
  }

  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return '';
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    let content = buf.toString('utf8');

    // If we started mid-file, the first line is almost certainly partial — drop it.
    if (start > 0) {
      const nl = content.indexOf('\n');
      content = nl >= 0 ? content.slice(nl + 1) : '';
    }
    return content;
  } catch {
    return '';
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read the last `maxBytes` of a JSONL transcript and return its last
 * `maxEvents` normalized events *and* the raw text they were parsed from — the
 * raw text feeds content-level readouts (e.g. token throughput) that need the
 * lines the event model discards (Codex `token_count`). Only Claude and Codex
 * are supported (the prioritized harnesses for live state); other agents return
 * an empty tail.
 */
export function readSessionTailWithRaw(
  filePath: string,
  agent: SessionAgentId,
  maxBytes = DEFAULT_MAX_BYTES,
  maxEvents = DEFAULT_MAX_EVENTS,
): SessionTail {
  if (agent !== 'claude' && agent !== 'codex') return { events: [], content: '' };

  const content = readSessionTailContent(filePath, maxBytes);
  if (!content.trim()) return { events: [], content: '' };

  const events = agent === 'codex' ? parseCodexContent(content) : parseClaudeContent(content);
  sanitizeEvents(events);
  return { events: events.length > maxEvents ? events.slice(-maxEvents) : events, content };
}

/**
 * Read the last `maxEvents` normalized events from a JSONL transcript tail. Thin
 * wrapper over {@link readSessionTailWithRaw} for callers that only need events.
 */
export function readSessionTail(
  filePath: string,
  agent: SessionAgentId,
  maxBytes = DEFAULT_MAX_BYTES,
  maxEvents = DEFAULT_MAX_EVENTS,
): SessionEvent[] {
  return readSessionTailWithRaw(filePath, agent, maxBytes, maxEvents).events;
}

/** A session's original first turn is typically within the first few KiB —
 * far smaller than the tail window, since it's exactly one line near the
 * start of the file, not a rolling window of recent activity. */
const DEFAULT_HEAD_MAX_BYTES = 32 * 1024;

/**
 * Read exactly the first `maxBytes` of the file and, if that chunk doesn't
 * reach EOF, drop a trailing partial line so downstream per-line parsers only
 * see whole lines. This is the plain, cheap path — correct and unchanged for
 * the overwhelming majority of transcripts, where the opening JSONL record is
 * a few hundred bytes. Returns '' on any error, an empty file, or a chunk that
 * turned out to hold no complete line at all (the record is bigger than
 * `maxBytes`) — callers needing to recover from THAT case use
 * {@link readSessionHeadContentBounded}, not this.
 */
function readSessionHeadChunk(filePath: string, maxBytes: number): { content: string; sawEof: boolean } | undefined {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return undefined;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return { content: '', sawEof: true };
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return { content: buf.toString('utf8'), sawEof: len >= size };
  } catch {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read the FIRST `maxBytes` of a JSONL transcript as cleaned text — the mirror
 * of {@link readSessionTailContent}, for recovering the session's ACTUAL
 * original request boundedly when it isn't already indexed
 * (`SessionMeta.firstUserMessage`). Returns '' on any error, an empty file, or
 * a first record too large to fit `maxBytes` (bare — no elision fallback; see
 * {@link readSessionHeadContentBounded} for that).
 */
export function readSessionHeadContent(filePath: string, maxBytes = DEFAULT_HEAD_MAX_BYTES): string {
  const chunk = readSessionHeadChunk(filePath, maxBytes);
  if (!chunk) return '';
  let content = chunk.content;
  if (!chunk.sawEof) {
    // Didn't reach EOF: the last line in this chunk may be a partial write
    // of a longer record. Keep only whole lines.
    const lastNl = content.lastIndexOf('\n');
    content = lastNl >= 0 ? content.slice(0, lastNl) : '';
  }
  return content;
}

/**
 * Hard ceiling on how far {@link readSessionHeadContentBounded} will read
 * looking for the opening record's closing newline. A JSONL record is one
 * line, so a user turn that embeds a multi-megabyte image (base64, inline in
 * the same `"data": "..."` string) can push that line's own terminator
 * arbitrarily far past the plain {@link DEFAULT_HEAD_MAX_BYTES} chunk — this
 * is the point past which the record is treated as unrecoverable (`partial`),
 * never guessed at from a truncated fragment.
 */
const HEAD_ELISION_MAX_READ_BYTES = 4 * 1024 * 1024;
/** Keep at most this many UTF-16 units of any single JSON string value
 * verbatim; the remainder is replaced with a short marker. Bounds the ELIDED
 * OUTPUT size independent of how large the source string (an image's base64
 * payload can be tens of megabytes) actually is, while staying far larger
 * than any real first-turn text block ever needs to be. */
const HEAD_ELISION_STRING_KEEP_UNITS = 2048;
/** Wall-clock ceiling on the elision scan itself. The scan runs over data
 * already bounded by {@link HEAD_ELISION_MAX_READ_BYTES} and does O(1) work
 * per character, so this should never trip in practice — it exists as a
 * defense-in-depth budget, not the primary bound. */
const HEAD_ELISION_MAX_MS = 200;
/** How many characters the elision scan advances between wall-clock checks —
 * frequent enough that the time budget above is actually honored, infrequent
 * enough that `Date.now()` isn't on the hot path of every character. */
const HEAD_ELISION_TIME_CHECK_MASK = 0x3ffff; // every ~262k chars

/**
 * A single-pass, JSON-string-aware elision scan: copies `input` verbatim
 * except inside a string literal whose content exceeds
 * {@link HEAD_ELISION_STRING_KEEP_UNITS}, where it keeps a short prefix and
 * splices in a `…[elided N chars]` marker for the rest — but still tracks
 * escape/quote state through to that string's real closing quote, so
 * surrounding JSON structure (a text block that follows an oversized image
 * block in the same content array) stays syntactically valid. This is a
 * generic JSON-string eliser, not an image-specific one: it does not care
 * WHAT is inside the oversized string, only that it is too large to keep.
 *
 * `deadlineMs` is an absolute `Date.now()` value. `truncatedByBudget: true`
 * means the scan did not finish (ran out of time) — critically, the output
 * up to that point NEVER includes the unflushed tail of a string that had
 * already crossed the elision threshold (the flush happens once, the moment
 * the threshold is crossed, not at the closing quote), so a cutoff mid-scan
 * can never smuggle megabytes of un-elided content into the result.
 */
function elideOversizedJsonStrings(input: string, deadlineMs: number): { text: string; truncatedByBudget: boolean } {
  const outParts: string[] = [];
  let spanStart = 0;
  let inString = false;
  let escaped = false;
  let stringStart = 0;
  let skipping = false; // current string already crossed the keep threshold
  const n = input.length;
  for (let i = 0; i < n; i++) {
    if ((i & HEAD_ELISION_TIME_CHECK_MASK) === 0 && Date.now() > deadlineMs) {
      if (!skipping) outParts.push(input.slice(spanStart, i));
      return { text: outParts.join(''), truncatedByBudget: true };
    }
    const ch = input.charCodeAt(i);
    if (!inString) {
      if (ch === 0x22 /* '"' */) { inString = true; stringStart = i + 1; skipping = false; }
      continue;
    }
    if (escaped) { escaped = false; continue; }
    if (ch === 0x5c /* '\\' */) { escaped = true; continue; }
    if (ch === 0x22 /* '"' */) {
      inString = false;
      if (skipping) {
        const elidedUnits = i - stringStart - HEAD_ELISION_STRING_KEEP_UNITS;
        outParts.push(`…[elided ${elidedUnits} chars]`);
        spanStart = i; // resume normal copying AT the closing quote
      }
      continue;
    }
    if (!skipping && (i - stringStart) === HEAD_ELISION_STRING_KEEP_UNITS) {
      outParts.push(input.slice(spanStart, i)); // flush the kept prefix now
      skipping = true;
    }
  }
  if (!skipping) outParts.push(input.slice(spanStart, n));
  return { text: outParts.join(''), truncatedByBudget: false };
}

/**
 * Recover the transcript's opening JSONL record even when it doesn't fit the
 * plain {@link DEFAULT_HEAD_MAX_BYTES} chunk — the case a first turn carrying
 * a multi-megabyte inline image produces, where the record's own closing
 * newline sits past whatever small chunk was read, so the old bare head
 * reader dropped the WHOLE record (and with it, the real original request)
 * rather than the oversized value inside it.
 *
 * Only invoked when the cheap path already failed to find a complete line
 * (bounded — see {@link readSessionHeadChunk}'s `sawEof`), so an ordinary
 * transcript never pays this cost. Reads up to {@link HEAD_ELISION_MAX_READ_BYTES}
 * from byte 0, runs it through {@link elideOversizedJsonStrings} (bounded by
 * {@link HEAD_ELISION_MAX_MS}), and returns the first complete elided line —
 * text before and after the oversized value is preserved verbatim (only the
 * oversized value itself is shortened), UTF-8 decoding and escape handling
 * both go through the exact same path an unelided record would. Returns ''
 * (a partial result, not a guess) when the scan is cut off by either budget
 * before a complete line was ever produced — never a followup/tail turn
 * substituted for it.
 */
export function readSessionHeadContentBounded(filePath: string, maxReadBytes = HEAD_ELISION_MAX_READ_BYTES): string {
  const chunk = readSessionHeadChunk(filePath, maxReadBytes);
  if (!chunk || !chunk.content) return '';
  const { text, truncatedByBudget } = elideOversizedJsonStrings(chunk.content, Date.now() + HEAD_ELISION_MAX_MS);
  const firstNl = text.indexOf('\n');
  if (firstNl >= 0) return text.slice(0, firstNl);
  // No line terminator found anywhere in the elided text: either the record
  // (minus its oversized values) is STILL bigger than the read budget, or the
  // elision scan itself hit its time budget first, or we reached real EOF
  // with no trailing newline at all (a truncated/interrupted write).
  if (truncatedByBudget) return '';
  return chunk.sawEof ? text : '';
}

/**
 * Read the FIRST `maxEvents` normalized events from a JSONL transcript's
 * head — the session's actual opening turns, bounded and cheap (one small
 * read from byte 0, the same shared Claude/Codex content parsers `readSessionTail`
 * uses, zero duplicated parse logic). Only Claude and Codex are supported,
 * matching {@link readSessionTailWithRaw}; other agents return no events.
 *
 * When the plain bounded chunk holds no complete first line at all — an
 * opening user turn embedding a multi-megabyte inline image is the real case
 * this covers — falls back to {@link readSessionHeadContentBounded}'s
 * JSON-aware elision scan rather than returning nothing: the same content
 * parsers then see a syntactically valid record with the oversized value
 * shortened, so a text block before or after an elided image block is
 * recovered exactly as if the image had never been oversized (the parser's
 * own image-handling path, e.g. Claude's `normalizedAttachmentEvent`, still
 * runs — it just sees a short placeholder `source.data` instead of the real
 * payload, so an attachment's derived byte size is not meaningful when this
 * fallback fired, only the surrounding TEXT is trustworthy).
 */
export function readSessionHead(
  filePath: string,
  agent: SessionAgentId,
  maxBytes = DEFAULT_HEAD_MAX_BYTES,
  maxEvents = DEFAULT_MAX_EVENTS,
): SessionEvent[] {
  if (agent !== 'claude' && agent !== 'codex') return [];
  let content = readSessionHeadContent(filePath, maxBytes);
  if (!content.trim()) content = readSessionHeadContentBounded(filePath);
  if (!content.trim()) return [];
  const events = agent === 'codex' ? parseCodexContent(content) : parseClaudeContent(content);
  sanitizeEvents(events);
  return events.length > maxEvents ? events.slice(0, maxEvents) : events;
}
