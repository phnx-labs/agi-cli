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

  it('recovers the opening record when the oversized image is the LAST string literal (no trailing text)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-head-elision-trailing-image-'));
    try {
      const filePath = path.join(dir, 'session.jsonl');
      const ask = 'Please debug this crash — screenshot attached:';
      // The image is the FINAL content block, so its base64 `data` is the last
      // string literal in the record: nothing after it resets the elision
      // scanner, so the record's own closing `"}]}}` + newline must still be
      // emitted by the final flush. Regression for the dropped-tail bug where
      // an image-only / image-last first turn produced zero events.
      const imageData = 'D'.repeat(1 * 1024 * 1024);
      const first = claudeUserRecord([
        { type: 'text', text: ask },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } },
      ]);
      // No record follows: a just-started session whose only turn is text+image.
      // Nothing after the image's `data` value resets the elision scanner, so
      // the record's own closing `"}]}}` + newline is what the final flush must
      // still emit. Any following record's opening quote would have masked the
      // bug (which is why the existing tests never caught it).
      fs.writeFileSync(filePath, first + '\n');

      // The plain bounded chunk alone cannot see this record.
      expect(readSessionHeadContent(filePath, 32 * 1024)).toBe('');

      const events = readSessionHead(filePath, 'claude');
      expect(events.length).toBeGreaterThan(0);
      expect(firstUserMessageFromEvents(events)).toBe(ask);
      // The oversized payload was elided, not read whole.
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
