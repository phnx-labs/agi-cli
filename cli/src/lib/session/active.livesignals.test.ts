import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { clearLiveSignalsCacheForTest, computeLiveSignals } from './active.js';

const TESTDATA = path.join(import.meta.dirname, 'testdata');
const tmp: string[] = [];

/** Copy a fixture to a fresh temp path and stamp its mtime to now (a live-scan
 * needs a fresh transcript to read a trailing tool_use as `working`). */
function freshCopy(fixtureRelative: string, basename: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-livesignals-'));
  const dst = path.join(dir, basename);
  fs.copyFileSync(path.join(TESTDATA, fixtureRelative), dst);
  const now = new Date();
  fs.utimesSync(dst, now, now);
  tmp.push(dir);
  return dst;
}

describe('computeLiveSignals wires every tracked harness into real state', () => {
  beforeEach(() => {
    clearLiveSignalsCacheForTest();
  });

  it('a live grok transcript yields working (not an empty signal set)', () => {
    const file = freshCopy('grok-working/chat_history.jsonl', 'chat_history.jsonl');
    const { state } = computeLiveSignals('grok', file, path.dirname(file), true);
    expect(state).toBeDefined();
    expect(state!.activity).toBe('working');
  });

  it('a live grok transcript that ended on a question yields waiting_input', () => {
    const file = freshCopy('grok-waiting/chat_history.jsonl', 'chat_history.jsonl');
    const { state } = computeLiveSignals('grok', file, path.dirname(file), true);
    expect(state!.activity).toBe('waiting_input');
    expect(state!.awaitingReason).toBe('question');
  });

  it('a live droid transcript yields working', () => {
    const file = freshCopy('droid-working.jsonl', 'droid-working.jsonl');
    const { state } = computeLiveSignals('droid', file, path.dirname(file), true);
    expect(state!.activity).toBe('working');
  });

  it('an untracked/opaque kind yields no state (falls back to the live floor upstream)', () => {
    const file = freshCopy('grok-idle/chat_history.jsonl', 'chat_history.jsonl');
    // `amp` is not session-tracked — computeLiveSignals returns {} and the caller's
    // resolveFallbackStatus reports `running` for the live process.
    expect(computeLiveSignals('amp', file, path.dirname(file), true)).toEqual({});
  });

  it('no transcript file yields no state', () => {
    expect(computeLiveSignals('grok', undefined, '/tmp', true)).toEqual({});
  });

  it('re-classifies from the cached parse when the transcript mtime is unchanged (#2047, PHNX-3999)', () => {
    const file = freshCopy('grok-working/chat_history.jsonl', 'chat_history.jsonl');
    const cwd = path.dirname(file);
    const first = computeLiveSignals('grok', file, cwd, true);
    expect(first.state?.activity).toBe('working');
    // Same path + mtime: the parsed tail is reused and the classification is
    // recomputed. Replacing the bytes with an unparseable line while pinning the
    // mtime back proves the second call never re-read the file — only the
    // memoized events could have produced this state.
    const { mtime, atime } = fs.statSync(file);
    fs.writeFileSync(file, 'not json\n');
    fs.utimesSync(file, atime, mtime);
    const second = computeLiveSignals('grok', file, cwd, true);
    expect(second.state?.activity).toBe('working');
    expect(second.state?.preview).toEqual(first.state?.preview);
  });

  it('a time-based classification expires without an mtime change: the cache holds the parse, not the verdict (PHNX-3999)', () => {
    const file = freshCopy('../../feed/testdata/claude-prose-question.jsonl', 'prose.jsonl');
    const cwd = path.dirname(file);
    // The fixture's turn ended on a free-text question stamped 10:00:06Z; pin the
    // mtime just after it so the stamp is transcript evidence.
    const askedMs = Date.parse('2026-09-10T10:00:06.000Z');
    fs.utimesSync(file, new Date(askedMs + 2_000), new Date(askedMs + 2_000));
    const live = computeLiveSignals('claude', file, cwd, true, askedMs + 10 * 60_000);
    expect(live.state?.activity).toBe('waiting_input');
    expect(live.state?.awaitingReason).toBe('question');
    expect(live.state?.lastEventMs).toBe(askedMs);
    // Nothing on disk changes; 31 minutes pass. The mtime-keyed memo used to hand
    // back the frozen "waiting" verdict here for as long as nobody typed.
    const later = computeLiveSignals('claude', file, cwd, true, askedMs + 31 * 60_000);
    expect(later.state?.activity).toBe('idle');
    expect(later.state?.question).toBeUndefined();
  });

  it('recomputes when the transcript mtime advances', () => {
    const file = freshCopy('grok-working/chat_history.jsonl', 'chat_history.jsonl');
    const cwd = path.dirname(file);
    const first = computeLiveSignals('grok', file, cwd, true);
    // Bump mtime without rewriting content — the cache key includes mtime, so
    // this must re-enter the parse path and return a fresh object.
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(file, later, later);
    const second = computeLiveSignals('grok', file, cwd, true);
    expect(second).not.toBe(first);
    expect(second.state?.activity).toBe('working');
  });

  it('recomputes when pidAlive flips (lifecycle context)', () => {
    const file = freshCopy('grok-working/chat_history.jsonl', 'chat_history.jsonl');
    const cwd = path.dirname(file);
    const alive = computeLiveSignals('grok', file, cwd, true);
    const dead = computeLiveSignals('grok', file, cwd, false);
    expect(dead).not.toBe(alive);
    expect(dead.state).toBeDefined();
  });

  afterAll(() => {
    for (const d of tmp) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
  });
});
