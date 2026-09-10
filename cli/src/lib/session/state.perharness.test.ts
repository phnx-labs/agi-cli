import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { parseSession } from './parse.js';
import { inferSessionState, type SessionActivity } from './state.js';
import type { SessionAgentId, SessionEvent } from './types.js';

const TESTDATA = path.join(import.meta.dirname, 'testdata');

/**
 * Every non-claude/codex harness now flows through its own parser into the SAME
 * `inferSessionState`, so a live agent gets a real working / waiting / idle
 * instead of the blanket `unknown`. Each fixture is a real transcript in that
 * harness's on-disk format; we assert the inferred activity for a LIVE process
 * (pidAlive + a fresh mtime, the live-scan context).
 */
const CASES: Array<{ agent: SessionAgentId; fixture: string; expect: SessionActivity }> = [
  // Grok — all three states (the harness the brief names).
  { agent: 'grok', fixture: 'grok-working/chat_history.jsonl', expect: 'working' },
  { agent: 'grok', fixture: 'grok-waiting/chat_history.jsonl', expect: 'waiting_input' },
  { agent: 'grok', fixture: 'grok-idle/chat_history.jsonl', expect: 'idle' },
  // Other harnesses with a parser — one state each, for cross-harness coverage.
  { agent: 'droid', fixture: 'droid-working.jsonl', expect: 'working' },
  { agent: 'rush', fixture: 'rush-waiting.jsonl', expect: 'waiting_input' },
  { agent: 'gemini', fixture: 'gemini-idle.json', expect: 'idle' },
];

/**
 * The live-scan context for a fixture: the transcript was just written (mtime a
 * second after its last stamped event) and the clock sits a few seconds later.
 * The fixtures carry real, fixed stamps, and the engine measures a question's
 * age from the message's own stamp (PHNX-3999), so "fresh" has to be expressed
 * against that stamp rather than against `Date.now()`.
 */
function liveContext(events: SessionEvent[]) {
  const stamps = events.map((e) => Date.parse(e.timestamp)).filter(Number.isFinite);
  const lastMs = stamps.length ? Math.max(...stamps) : Date.now();
  return { pidAlive: true, mtimeMs: lastMs + 1_000, nowMs: lastMs + 5_000 };
}

describe('inferSessionState across harnesses (real transcript fixtures)', () => {
  for (const c of CASES) {
    it(`${c.agent} → ${c.expect}`, () => {
      const events = parseSession(path.join(TESTDATA, c.fixture), c.agent);
      expect(events.length).toBeGreaterThan(0);
      // Live process, freshly written — the state-engine context the active scan
      // passes. A trailing tool_use ⇒ working; a trailing prose question ⇒
      // waiting_input; a trailing plain assistant message ⇒ idle.
      const state = inferSessionState(events, liveContext(events));
      expect(state.activity).toBe(c.expect);
    });
  }

  it('the waiting states are the actionable "needs you" case, distinct from idle', () => {
    const waiting = parseSession(path.join(TESTDATA, 'grok-waiting/chat_history.jsonl'), 'grok');
    const idle = parseSession(path.join(TESTDATA, 'grok-idle/chat_history.jsonl'), 'grok');
    const w = inferSessionState(waiting, liveContext(waiting));
    const i = inferSessionState(idle, liveContext(idle));
    expect(w.activity).toBe('waiting_input');
    expect(w.awaitingReason).toBe('question');
    expect(i.activity).toBe('idle');
    expect(i.awaitingReason).toBeUndefined();
  });
});
