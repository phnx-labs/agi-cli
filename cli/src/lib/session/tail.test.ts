import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'path';
import { readSessionTail, readSessionTailWithRaw, readSessionTailContent, readSessionHead, readSessionHeadContent, readSessionHeadContentBounded } from './tail.js';
import { inferSessionState } from './state.js';
import { firstUserMessageFromEvents } from './prompt.js';

const FIXTURE = path.join(import.meta.dirname, 'testdata', 'tail-sample-claude.jsonl');

describe('readSessionTail', () => {
  it('parses the tail of a real JSONL into normalized events', () => {
    const events = readSessionTail(FIXTURE, 'claude');
    expect(events.length).toBeGreaterThan(0);
    const last = events[events.length - 1];
    expect(last.type).toBe('message');
    expect(last.role).toBe('assistant');
    expect(last.content).toContain('--tree the default');
  });

  it('drops a partial leading line when starting mid-file', () => {
    // A tiny byte budget forces the read to begin mid-file; the first (partial)
    // line must be discarded rather than producing a garbage event.
    const events = readSessionTail(FIXTURE, 'claude', 400);
    expect(events.length).toBeGreaterThan(0);
    // Every returned event still parsed cleanly (no malformed leftovers).
    for (const e of events) expect(typeof e.type).toBe('string');
  });

  it('returns [] for unsupported agents', () => {
    expect(readSessionTail(FIXTURE, 'gemini')).toEqual([]);
  });

  it('readSessionTailWithRaw returns both the events and the raw JSONL they came from', () => {
    const { events, content } = readSessionTailWithRaw(FIXTURE, 'claude');
    // Same events the events-only wrapper produces...
    expect(events).toEqual(readSessionTail(FIXTURE, 'claude'));
    // ...plus the raw text, so content-level readouts (token throughput) can walk
    // the lines the event model drops.
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain('"type"');
    // The raw content is the same cleaned chunk readSessionTailContent yields.
    expect(content).toBe(readSessionTailContent(FIXTURE));
  });

  it('readSessionTailWithRaw yields an empty tail for unsupported agents', () => {
    expect(readSessionTailWithRaw(FIXTURE, 'gemini')).toEqual({ events: [], content: '' });
  });

  it('feeds inferSessionState to a waiting verdict on a trailing question', () => {
    const events = readSessionTail(FIXTURE, 'claude');
    // The fixture's trailing question is stamped 2026-06-30T10:00:12Z; the file
    // was written just after it and the clock is 20 minutes on — inside the
    // 30-minute decay, measured from the message's own stamp (PHNX-3999).
    const askedMs = Date.parse('2026-06-30T10:00:12.000Z');
    const state = inferSessionState(events, {
      cwd: '/home/u/repo/.agents/worktrees/tree-view',
      gitBranch: 'agents/tree-view',
      pidAlive: true,
      mtimeMs: askedMs + 1_000,
      nowMs: askedMs + 20 * 60_000,
    });
    expect(state.activity).toBe('waiting_input');
    expect(state.awaitingReason).toBe('question');
    expect(state.worktree?.slug).toBe('tree-view');
  });
});

/**
 * PHNX-3999 follow-up: a session's opening user turn embedding a
 * multi-megabyte inline image is ONE JSONL record whose own closing newline
 * can sit well past the plain 32 KiB head chunk `readSessionHead` used to read
 * unconditionally — the old behavior dropped the WHOLE record (text before
 * and after the image included), leaving `firstUserMessageFromEvents` with
 * nothing and forcing a caller to guess (or wrongly fall back to a later
 * follow-up turn, the exact bug this exists to prevent). These tests build
 * real Claude-shaped JSONL fixtures with a genuine multi-megabyte base64
 * payload in the first record, on disk, and drive the real reader/parser
 * path end to end — no mocking.
 */
describe('readSessionHead recovers the original request past an oversized inline image (PHNX-3999)', () => {
  function claudeUserRecord(contentBlocks: unknown[], timestamp = '2026-08-01T14:00:00.000Z'): string {
    return JSON.stringify({
      type: 'user',
      timestamp,
      message: { role: 'user', content: contentBlocks },
    });
  }

  function assistantRecord(text: string, timestamp = '2026-08-01T14:00:05.000Z'): string {
    return JSON.stringify({
      type: 'assistant',
      timestamp,
      message: {
        role: 'assistant', model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'text', text }],
      },
    });
  }

  it('recovers text BEFORE and AFTER a >32 KiB embedded image in the opening record', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-head-elision-'));
    try {
      const filePath = path.join(dir, 'session.jsonl');
      const before = 'Please review this screenshot of the failing build:';
      const after = 'The error is highlighted in red near the bottom.';
      // ~1 MiB of base64-shaped filler -- comfortably over both the 32 KiB
      // plain-chunk fast-path threshold and the per-string 2 KiB keep
      // threshold, while staying well under the 4 MiB elision read cap so
      // the record's closing quote/newline is reachable within budget.
      const imageData = 'A'.repeat(1 * 1024 * 1024);
      const first = claudeUserRecord([
        { type: 'text', text: before },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } },
        { type: 'text', text: after },
      ]);
      const followUp = claudeUserRecord([{ type: 'text', text: 'A much later follow-up question, not the original request' }], '2026-08-01T15:00:00.000Z');
      fs.writeFileSync(filePath, [first, assistantRecord('Looking into it.'), followUp].join('\n') + '\n');

      // The plain bounded chunk alone genuinely cannot see this record.
      expect(readSessionHeadContent(filePath, 32 * 1024)).toBe('');

      const events = readSessionHead(filePath, 'claude');
      expect(events.length).toBeGreaterThan(0);

      const recovered = firstUserMessageFromEvents(events);
      expect(recovered).toBe(before); // firstUserMessageFromEvents stops at the first text block, which is correct: it IS the original request's leading sentence
      // Both surrounding text blocks parsed as real message events -- the
      // image did not swallow anything around it.
      const userTexts = events.filter(e => e.type === 'message' && e.role === 'user').map(e => e.content);
      expect(userTexts).toContain(before);
      expect(userTexts).toContain(after);
      // The later follow-up must NEVER appear here -- this is a HEAD read.
      expect(userTexts.some(t => t?.includes('much later follow-up'))).toBe(false);
      // The oversized image payload itself must not have been read into memory whole.
      expect(events.some(e => typeof e.content === 'string' && e.content.length > 100_000)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still returns the original request when the image sits at the START, before any text', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-head-elision-lead-image-'));
    try {
      const filePath = path.join(dir, 'session.jsonl');
      const ask = 'What does this diagram mean?';
      const imageData = 'B'.repeat(1 * 1024 * 1024);
      const first = claudeUserRecord([
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } },
        { type: 'text', text: ask },
      ]);
      fs.writeFileSync(filePath, first + '\n' + assistantRecord('It is a flowchart.') + '\n');

      const events = readSessionHead(filePath, 'claude');
      expect(firstUserMessageFromEvents(events)).toBe(ask);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns a real partial result (empty), never a guess, when the record exceeds the hard read budget', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-head-elision-exhausted-'));
    try {
      const filePath = path.join(dir, 'session.jsonl');
      // A single string bigger than HEAD_ELISION_MAX_READ_BYTES (4 MiB) that
      // never closes within the read window -- the record is genuinely
      // unrecoverable within budget.
      const hugeData = 'C'.repeat(6 * 1024 * 1024);
      const first = claudeUserRecord([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: hugeData } }]);
      const followUp = claudeUserRecord([{ type: 'text', text: 'later followup that must never be substituted' }], '2026-08-01T15:00:00.000Z');
      fs.writeFileSync(filePath, [first, followUp].join('\n') + '\n');

      expect(readSessionHeadContentBounded(filePath)).toBe('');
      const events = readSessionHead(filePath, 'claude');
      expect(events.length).toBe(0);
      // Explicitly not the tail followup either.
      expect(firstUserMessageFromEvents(events)).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the plain fast path is unaffected for an ordinary small opening record (no regression)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-head-plain-'));
    try {
      const filePath = path.join(dir, 'session.jsonl');
      const ask = 'Add a health check endpoint to the API';
      fs.writeFileSync(filePath, claudeUserRecord([{ type: 'text', text: ask }]) + '\n' + assistantRecord('On it.') + '\n');
      const events = readSessionHead(filePath, 'claude');
      expect(firstUserMessageFromEvents(events)).toBe(ask);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * PHNX-3999 review (58301aa3c) found two escape-boundary bugs in the elision
 * scanner's original strict-equality-on-raw-index threshold check, plus a
 * fallback trigger that missed Codex's session_meta-header-then-giant-user
 * shape. These fixtures reproduce each exactly, on real files through the
 * real reader, not a unit test of the (unexported) scanner in isolation.
 */
describe('readSessionHead escape-boundary and Codex-metadata-header fixes (PHNX-3999 review)', () => {
  it('elides correctly when a 2-char escape sits immediately at the keep threshold (reported: 1002079 bytes, unelided)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-head-escape-boundary-'));
    try {
      const filePath = path.join(dir, 'session.jsonl');
      const before = 'Please look at this:';
      const after = 'Thanks.';
      // 2048 ordinary 'a' units reach the keep threshold exactly, immediately
      // followed by a 2-char \n escape (one atomic unit) and then a run of
      // 'b' large enough to force real elision. A raw-index `=== 2048` check
      // can be permanently skipped by an escape landing right at the
      // boundary, letting the whole oversized run ride through unchanged.
      const rawJsonStringValue = `${'a'.repeat(2048)}\\n${'b'.repeat(1_000_000)}`;
      const record =
        '{"type":"user","timestamp":"2026-08-01T14:00:00.000Z","message":{"role":"user","content":[' +
        JSON.stringify({ type: 'text', text: before }) +
        ',{"type":"image","source":{"type":"base64","media_type":"image/png","data":"' +
        rawJsonStringValue +
        '"}},' +
        JSON.stringify({ type: 'text', text: after }) +
        ']}}';
      fs.writeFileSync(filePath, record + '\n');

      const bounded = readSessionHeadContentBounded(filePath);
      // Genuine elision happened -- nowhere near the ~1,000,050-byte
      // "unchanged" output the bug produced.
      expect(bounded.length).toBeLessThan(10_000);
      expect(() => JSON.parse(bounded)).not.toThrow();

      const events = readSessionHead(filePath, 'claude');
      const userTexts = events.filter(e => e.type === 'message' && e.role === 'user').map(e => e.content);
      expect(userTexts).toContain(before);
      expect(userTexts).toContain(after);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('elides correctly when an escaped quote sits immediately at the keep threshold', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-head-escaped-quote-boundary-'));
    try {
      const filePath = path.join(dir, 'session.jsonl');
      const before = 'See the quoted error below:';
      const after = 'That is the whole message.';
      // 2047 ordinary units, then a 2-char \" escape as the 2048th unit,
      // then a run of 'b' -- the escaped quote itself must never be read as
      // a real string terminator, and the threshold must still fire on it.
      const rawJsonStringValue = `${'a'.repeat(2047)}\\"${'b'.repeat(1_000_000)}`;
      const record =
        '{"type":"user","timestamp":"2026-08-01T14:00:00.000Z","message":{"role":"user","content":[' +
        JSON.stringify({ type: 'text', text: before }) +
        ',{"type":"image","source":{"type":"base64","media_type":"image/png","data":"' +
        rawJsonStringValue +
        '"}},' +
        JSON.stringify({ type: 'text', text: after }) +
        ']}}';
      fs.writeFileSync(filePath, record + '\n');

      const bounded = readSessionHeadContentBounded(filePath);
      expect(bounded.length).toBeLessThan(10_000);
      expect(() => JSON.parse(bounded)).not.toThrow();

      const events = readSessionHead(filePath, 'claude');
      const userTexts = events.filter(e => e.type === 'message' && e.role === 'user').map(e => e.content);
      expect(userTexts).toContain(before);
      expect(userTexts).toContain(after);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never truncates mid \\uXXXX escape when the escape straddles the keep threshold (reported: invalid JSON)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-head-unicode-boundary-'));
    try {
      const filePath = path.join(dir, 'session.jsonl');
      const before = 'Unicode payload follows:';
      const after = 'End of message.';
      // The exact review repro: 2046 'a', then a literal ሴ escape (6
      // raw chars, one atomic unit) straddling the 2048-unit threshold, then
      // a run of 'b'. Flushing mid-escape produces invalid JSON.
      const rawJsonStringValue = `${'a'.repeat(2046)}\\u1234${'b'.repeat(10_000)}`;
      const record =
        '{"type":"user","timestamp":"2026-08-01T14:00:00.000Z","message":{"role":"user","content":[' +
        JSON.stringify({ type: 'text', text: before }) +
        ',{"type":"image","source":{"type":"base64","media_type":"image/png","data":"' +
        rawJsonStringValue +
        '"}},' +
        JSON.stringify({ type: 'text', text: after }) +
        ']}}';
      fs.writeFileSync(filePath, record + '\n');

      const bounded = readSessionHeadContentBounded(filePath);
      expect(bounded.length).toBeLessThan(10_000);
      // The output must be valid, parseable JSON -- never a truncated escape.
      expect(() => JSON.parse(bounded)).not.toThrow();

      const events = readSessionHead(filePath, 'claude');
      const userTexts = events.filter(e => e.type === 'message' && e.role === 'user').map(e => e.content);
      expect(userTexts).toContain(before);
      expect(userTexts).toContain(after);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('escalates past a Codex session_meta header to recover the real opening user turn', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-head-codex-metadata-header-'));
    try {
      const filePath = path.join(dir, 'session.jsonl');
      const ask = 'Investigate the flaky auth test';
      // A small session_meta header record -- present, non-empty, and cleanly
      // parseable on its own (it yields an 'init' event, never a user
      // message) -- precedes a giant opening user record. Checking "cheap
      // content is non-empty" alone would never escalate here, since the
      // header alone already satisfies that check.
      const header = JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-08-01T14:00:00.000Z',
        payload: { cli_version: '1.0.0', cwd: '/home/u/repo' },
      });
      const hugeJunk = 'Z'.repeat(2 * 1024 * 1024);
      const userRecord =
        '{"type":"response_item","timestamp":"2026-08-01T14:00:01.000Z","payload":{"type":"message","role":"user","content":[' +
        JSON.stringify({ type: 'input_text', text: ask }) +
        ',{"type":"unused_attachment","data":"' +
        hugeJunk +
        '"}]}}';
      fs.writeFileSync(filePath, [header, userRecord].join('\n') + '\n');

      // The plain cheap chunk DOES see complete content (the header line) --
      // "non-empty" alone must not be mistaken for "found the real request".
      const cheap = readSessionHeadContent(filePath, 32 * 1024);
      expect(cheap.trim()).not.toBe('');
      expect(firstUserMessageFromEvents(readSessionHead(filePath, 'codex'))).toBe(ask);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recovers the request past a large metadata-only prefix without quadratic blowup, and past the 60-event cap', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-head-metadata-only-prefix-'));
    try {
      const filePath = path.join(dir, 'session.jsonl');
      const ask = 'Fix the flaky retry logic in the deploy pipeline';
      // 10,000 tiny session_meta records ahead of the real opening turn: each
      // parses cleanly to a non-user 'init' event, so genuinely reaching the
      // request requires walking past all of them, and each ALSO produces an
      // event, so the request's own event index (~10,000) sits far outside
      // the 60-event cap. Re-parsing a growing ACCUMULATED prefix on every one
      // of these lines is O(lines^2) in bytes parsed with no deadline of its
      // own; this fixture is exactly the shape that blows up.
      const metadataLines: string[] = [];
      for (let i = 0; i < 10_000; i++) {
        metadataLines.push(
          JSON.stringify({ type: 'session_meta', timestamp: '2026-08-01T14:00:00.000Z', payload: { cli_version: '1.0.0', cwd: `/home/u/repo-${i}` } }),
        );
      }
      const userRecord =
        '{"type":"response_item","timestamp":"2026-08-01T15:00:00.000Z","payload":{"type":"message","role":"user","content":[' +
        JSON.stringify({ type: 'input_text', text: ask }) +
        ']}}';
      fs.writeFileSync(filePath, [...metadataLines, userRecord].join('\n') + '\n');

      const startMs = Date.now();
      const events = readSessionHead(filePath, 'codex');
      const elapsedMs = Date.now() - startMs;

      expect(firstUserMessageFromEvents(events)).toBe(ask);
      // Well under a second on real hardware for ~10k small lines scanned
      // linearly; a quadratic re-parse of the same shape takes far longer.
      expect(elapsedMs).toBeLessThan(5_000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
