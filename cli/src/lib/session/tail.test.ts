import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { readSessionTail, readSessionTailWithRaw, readSessionTailContent } from './tail.js';
import { inferSessionState } from './state.js';

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
