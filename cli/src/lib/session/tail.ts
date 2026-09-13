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
import { firstUserMessageFromEvents, cleanFirstUserMessage } from './prompt.js';

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
 * A single-pass, JSON-string-and-escape-aware elision scan: copies `input`
 * verbatim except inside a string literal whose content exceeds
 * {@link HEAD_ELISION_STRING_KEEP_UNITS}, where it keeps a short prefix and
 * splices in a `…[elided N chars]` marker for the rest — but still tracks
 * escape/quote state through to that string's real closing quote, so
 * surrounding JSON structure (a text block that follows an oversized image
 * block in the same content array) stays syntactically valid. This is a
 * generic JSON-string eliser, not an image-specific one: it does not care
 * WHAT is inside the oversized string, only that it is too large to keep.
 *
 * The threshold check and the flush point are both evaluated only at the END
 * of a complete ATOMIC escape unit — a lone ordinary char, a two-char escape
 * (`\\`, `\"`, `\n`, …), or a six-char `\uXXXX` escape — never in the middle
 * of one. Two real bugs this fixes: (1) checking a raw character INDEX for
 * exact equality against the threshold can be permanently skipped when a
 * `\`/escaped-char pair straddles that exact index, since both of those
 * characters `continue` past the check — after which the index never equals
 * the threshold again, so the whole string rides through unbounded; using
 * "unit end index `>=` threshold" instead of "raw index `===` threshold" is
 * immune to this regardless of how many escapes precede it. (2) flushing the
 * kept prefix mid-`\uXXXX` (e.g. right after the `\u`, before its 4 hex
 * digits) produces an invalid, truncated escape sequence in the OUTPUT, which
 * fails `JSON.parse` even though the scan itself "succeeded" — flushing only
 * at a unit boundary means the kept prefix is always valid on its own.
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
  let stringStart = 0;
  let skipping = false; // current string already crossed the keep threshold
  let inEscape = false; // previous char was an unconsumed '\' awaiting its escape-type char
  let hexRemaining = 0; // >0: consuming the N remaining hex digits of a \uXXXX escape
  const n = input.length;

  // Called once at the END of each atomic in-string unit (index `i` is the
  // unit's LAST character). Decides whether the elision threshold has just
  // been reached and, if so, flushes the kept prefix up to and including this
  // whole unit — never a partial one.
  const onUnitEnd = (i: number): void => {
    if (skipping) return;
    if (i + 1 - stringStart >= HEAD_ELISION_STRING_KEEP_UNITS) {
      outParts.push(input.slice(spanStart, i + 1));
      skipping = true;
    }
  };

  for (let i = 0; i < n; i++) {
    if ((i & HEAD_ELISION_TIME_CHECK_MASK) === 0 && Date.now() > deadlineMs) {
      if (!skipping) outParts.push(input.slice(spanStart, i));
      return { text: outParts.join(''), truncatedByBudget: true };
    }
    const ch = input.charCodeAt(i);

    if (!inString) {
      if (ch === 0x22 /* '"' */) {
        inString = true; stringStart = i + 1; skipping = false; inEscape = false; hexRemaining = 0;
      }
      continue;
    }

    if (hexRemaining > 0) {
      hexRemaining--;
      if (hexRemaining === 0) onUnitEnd(i);
      continue;
    }
    if (inEscape) {
      inEscape = false;
      if (ch === 0x75 /* 'u' */) { hexRemaining = 4; continue; }
      onUnitEnd(i); // two-char escape (\\, \", \/, \b, \f, \n, \r, \t) complete
      continue;
    }
    if (ch === 0x5c /* '\\' */) { inEscape = true; continue; }
    if (ch === 0x22 /* '"' */) {
      inString = false;
      if (skipping) {
        const elidedUnits = i - stringStart - HEAD_ELISION_STRING_KEEP_UNITS;
        outParts.push(`…[elided ${elidedUnits} chars]`);
        spanStart = i; // resume normal copying AT the closing quote
        skipping = false; // back to normal copying -- NOT still "skipping" past this string's own close
      }
      continue;
    }
    onUnitEnd(i); // ordinary content char, a one-char unit
  }
  if (!skipping) outParts.push(input.slice(spanStart, n));
  return { text: outParts.join(''), truncatedByBudget: false };
}

/**
 * Recover as many COMPLETE opening JSONL records as fit within budget, even
 * when the plain {@link DEFAULT_HEAD_MAX_BYTES} chunk doesn't reach a single
 * complete line — the case a first turn carrying a multi-megabyte inline
 * image produces, where that record's own closing newline sits past whatever
 * small chunk was read, so the old bare head reader dropped the WHOLE record
 * (and with it, the real original request) rather than just the oversized
 * value inside it.
 *
 * Returns every complete elided line the scan reached — NOT just the first —
 * because the oversized record is not always record #1: a Codex session
 * commonly opens with a small `session_meta`/header record before the
 * (possibly huge) real opening user turn, and the caller needs to see past
 * that header to reach it. Reads up to {@link HEAD_ELISION_MAX_READ_BYTES}
 * from byte 0, runs it through {@link elideOversizedJsonStrings} (bounded by
 * {@link HEAD_ELISION_MAX_MS}) — text before and after any oversized value is
 * preserved verbatim, UTF-8 decoding and escape handling both go through the
 * exact same path an unelided record would. Returns '' (a partial result, not
 * a guess) when the scan is cut off by either budget before even ONE complete
 * line was produced — never a followup/tail turn substituted for it.
 */
export function readSessionHeadContentBounded(filePath: string, maxReadBytes = HEAD_ELISION_MAX_READ_BYTES): string {
  const chunk = readSessionHeadChunk(filePath, maxReadBytes);
  if (!chunk || !chunk.content) return '';
  const { text, truncatedByBudget } = elideOversizedJsonStrings(chunk.content, Date.now() + HEAD_ELISION_MAX_MS);
  const lastNl = text.lastIndexOf('\n');
  if (lastNl >= 0) return text.slice(0, lastNl); // every complete elided line found, not just the first
  // No line terminator found anywhere in the elided text: either the record
  // (minus its oversized values) is STILL bigger than the read budget, or the
  // elision scan itself hit its time budget first, or we reached real EOF
  // with no trailing newline at all (a truncated/interrupted write).
  if (truncatedByBudget) return '';
  return chunk.sawEof ? text : '';
}

/** True when `events` contains at least one genuine (non-synthetic) user
 * turn — the signal that a head read has actually reached the session's real
 * opening request, as opposed to only metadata/header records that happen to
 * parse cleanly (a Codex `session_meta` line, for instance). Reuses the exact
 * same rejection rules `SessionMeta.firstUserMessage` itself is built with. */
function hasGenuineUserTurn(events: SessionEvent[]): boolean {
  return firstUserMessageFromEvents(events) !== undefined;
}

/** Index of the first genuine user event {@link firstUserMessageFromEvents}
 * would report, or -1 when there is none. Same rejection rules, exposed as a
 * position rather than a string, so a caller can guarantee that event
 * survives a length cap instead of just checking whether one exists. */
function genuineUserTurnIndex(events: SessionEvent[]): number {
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.type !== 'message' || event.role !== 'user' || event._synthetic) continue;
    if (cleanFirstUserMessage(event.content)) return i;
  }
  return -1;
}

/**
 * Read the FIRST `maxEvents` normalized events from a JSONL transcript's
 * head — the session's actual opening turns, bounded and cheap (one small
 * read from byte 0, the same shared Claude/Codex content parsers `readSessionTail`
 * uses, zero duplicated parse logic). Only Claude and Codex are supported,
 * matching {@link readSessionTailWithRaw}; other agents return no events.
 *
 * The plain bounded chunk is tried first and is enough for the overwhelming
 * majority of transcripts. It escalates to
 * {@link readSessionHeadContentBounded}'s JSON-aware elision scan whenever
 * that cheap chunk does NOT yield a genuine user turn — not merely when it's
 * empty. Two real cases need that distinction: an opening turn embedding a
 * multi-megabyte inline image (the cheap chunk holds no complete line at all,
 * so it's empty), AND a Codex transcript whose small `session_meta` header
 * record precedes a large opening user turn (the cheap chunk is non-empty and
 * parses fine, but has no user message in it yet, so checking for empty
 * content alone would never trigger the fallback and the real request would
 * never be recovered). Once escalated, the elided text carries every complete
 * record the scan reached, header included, so the SAME parsers see the
 * header AND the (now-shortened) user turn together.
 *
 * When this fallback fires, the parser's own image-handling path (e.g.
 * Claude's `normalizedAttachmentEvent`) still runs on the elided data — it
 * just sees a short placeholder `source.data` instead of the real payload, so
 * an attachment's derived byte size is not meaningful here, only the
 * surrounding TEXT is trustworthy.
 */
export function readSessionHead(
  filePath: string,
  agent: SessionAgentId,
  maxBytes = DEFAULT_HEAD_MAX_BYTES,
  maxEvents = DEFAULT_MAX_EVENTS,
): SessionEvent[] {
  if (agent !== 'claude' && agent !== 'codex') return [];

  const parse = (content: string): SessionEvent[] => {
    const events = agent === 'codex' ? parseCodexContent(content) : parseClaudeContent(content);
    sanitizeEvents(events);
    return events;
  };

  const cheapContent = readSessionHeadContent(filePath, maxBytes);
  if (cheapContent.trim()) {
    const cheapEvents = parse(cheapContent);
    if (hasGenuineUserTurn(cheapEvents)) return capToMaxEvents(cheapEvents, maxEvents);
  }

  const boundedContent = readSessionHeadContentBounded(filePath);
  if (!boundedContent.trim()) return [];

  // readSessionHeadContentBounded may carry many leading records within its
  // byte budget (a header plus everything the elision scan reached after it —
  // a big Codex/Claude session can front-load thousands of small metadata
  // lines before the real opening turn). This IS still a HEAD read, so a
  // later, unrelated turn must never leak into the result — but finding the
  // cutoff by re-parsing an ever-growing ACCUMULATED prefix string on every
  // line is O(lines²) in total bytes parsed (10k metadata lines over a 1 MiB
  // prefix reparsed each time is ~500 MB of cumulative parse work with no
  // deadline of its own). Two bounded, linear passes instead: first find the
  // cutoff line by parsing each line ALONE (cheap — a lone JSONL record is
  // self-contained, so a single-line parse correctly reports whether IT
  // carries a genuine user turn), then parse the needed prefix exactly once.
  const rawLines = boundedContent.split('\n').filter(l => l.trim());
  let cutoff = rawLines.length; // no genuine turn found in any single line -- use everything captured
  for (let i = 0; i < rawLines.length; i++) {
    if (hasGenuineUserTurn(parse(rawLines[i]))) {
      cutoff = i + 1;
      break;
    }
  }
  const events = parse(rawLines.slice(0, cutoff).join('\n'));
  return capToMaxEvents(events, maxEvents);
}

/**
 * Cap `events` at `maxEvents`, but never at the cost of dropping the genuine
 * opening request itself. A transcript that front-loads thousands of small
 * metadata/tool events ahead of its real first user turn would otherwise have
 * that turn sliced away by a plain `events.slice(0, maxEvents)` — the request
 * this whole reader exists to recover would silently vanish behind the cap
 * that was only ever meant to bound OUTPUT size, not to reject valid content.
 * When the genuine turn falls outside the first `maxEvents`, the cap widens
 * just enough to include it (index-inclusive), rather than dropping it.
 */
function capToMaxEvents(events: SessionEvent[], maxEvents: number): SessionEvent[] {
  if (events.length <= maxEvents) return events;
  const genuineIdx = genuineUserTurnIndex(events);
  const keep = genuineIdx >= maxEvents ? genuineIdx + 1 : maxEvents;
  return events.slice(0, keep);
}
