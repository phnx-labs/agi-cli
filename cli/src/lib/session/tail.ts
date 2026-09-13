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
