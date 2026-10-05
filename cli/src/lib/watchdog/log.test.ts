/** Tests for the canonical watchdog.log writer (watchdog-brain-v2). Cross-app imports are
 * forbidden, so these pin the shape the Fleet card's reader (apps/ext/src/core/watchdogLog.ts)
 * consumes, plus the line-cap trim. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { appendWatchdogEvents, boundTailLines, parseWatchdogEvents, trimToLast, formatEvent, WATCHDOG_TAIL_MAX_CHARS, type WatchdogEvent } from './log.js';

const KNOWN_KINDS = new Set(['tick', 'decision', 'nudge', 'undelivered', 'rotate', 'error']);

let dir: string;
let logPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-log-'));
  logPath = path.join(dir, 'watchdog.log');
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function readLines(): Record<string, unknown>[] {
  const raw = fs.readFileSync(logPath, 'utf8');
  return raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

describe('appendWatchdogEvents', () => {
  it('writes one Factory-shaped JSON object per line and appends across calls', () => {
    appendWatchdogEvents([
      { ts: 1, kind: 'decision', terminalId: 'CC-1', agentType: 'claude', message: 'parked on a question', reason: 'parked', stalledForMs: 360_000, nudgeText: 'Finish it.', tailLines: ['{"a":1}'] },
    ], { logPath });
    appendWatchdogEvents([
      { ts: 2, kind: 'nudge', terminalId: 'CC-1', message: 'nudged via inject (vscodium)', nudgeText: 'Finish it.' },
      { ts: 3, kind: 'tick', message: '1 live · 1 stalled · 1 nudged · 0 un-addressable' },
    ], { logPath });

    const lines = readLines();
    expect(lines).toHaveLength(3);
    for (const row of lines) {
      expect(typeof row.ts).toBe('number');
      expect(KNOWN_KINDS.has(row.kind as string)).toBe(true);
      expect(typeof row.message).toBe('string');
    }
    // Context fields survive the round-trip so the card can render them.
    expect(lines[0]).toMatchObject({ kind: 'decision', terminalId: 'CC-1', stalledForMs: 360_000, nudgeText: 'Finish it.' });
    expect((lines[0].tailLines as string[])[0]).toBe('{"a":1}');
    expect(lines[1]).toMatchObject({ kind: 'nudge', terminalId: 'CC-1' });
  });

  it('trims to the last maxLines so the file never grows unbounded', () => {
    const many: WatchdogEvent[] = Array.from({ length: 10 }, (_, i) => ({ ts: i, kind: 'tick', message: `t${i}` }));
    appendWatchdogEvents(many, { logPath, maxLines: 4 });
    const lines = readLines();
    expect(lines).toHaveLength(4);
    // The most-recent events are kept.
    expect(lines.map((l) => l.message)).toEqual(['t6', 't7', 't8', 't9']);
  });

  it('bounds transcript context while preserving its newest content', () => {
    const old = 'a'.repeat(WATCHDOG_TAIL_MAX_CHARS);
    const newest = 'NEWEST';
    appendWatchdogEvents([
      { ts: 1, kind: 'decision', message: 'bounded', tailLines: [old, newest] },
    ], { logPath });
    const tail = readLines()[0].tailLines as string[];
    expect(tail.join('').length).toBe(WATCHDOG_TAIL_MAX_CHARS);
    expect(tail.at(-1)).toBe(newest);
  });

  it('is a no-op for an empty event list', () => {
    appendWatchdogEvents([], { logPath });
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it('sanitizes malformed optional fields instead of leaking unsafe values', () => {
    const [event] = parseWatchdogEvents(JSON.stringify({
      ts: 1,
      kind: 'decision',
      message: 'valid',
      terminalId: 7,
      tailLines: ['safe', 8],
      inspections: [{ terminalId: 9, agentType: 'claude', message: 'skip', reason: 'working' }],
    }));
    expect(event.terminalId).toBeUndefined();
    expect(event.tailLines).toEqual(['safe']);
    expect(event.inspections).toEqual([{
      terminalId: undefined,
      agentType: 'claude',
      message: 'skip',
      reason: 'working',
      stalledForMs: undefined,
    }]);
  });

  it('rejects non-finite timestamps', () => {
    expect(parseWatchdogEvents('{"ts":1e400,"kind":"tick","message":"bad"}')).toEqual([]);
  });
});

describe('trimToLast / formatEvent', () => {
  it('boundTailLines retains all short tails unchanged', () => {
    expect(boundTailLines(['one', 'two'])).toEqual(['one', 'two']);
  });
  it('formatEvent emits compact single-line JSON', () => {
    const line = formatEvent({ ts: 1, kind: 'tick', message: 'hi' });
    expect(line).toBe('{"ts":1,"kind":"tick","message":"hi"}');
    expect(line).not.toContain('\n');
  });

  it('trimToLast keeps a trailing newline and caps the body', () => {
    const body = ['{"ts":1}', '{"ts":2}', '{"ts":3}'].join('\n') + '\n';
    expect(trimToLast(body, 2)).toBe('{"ts":2}\n{"ts":3}\n');
    expect(trimToLast(body, 10)).toBe('{"ts":1}\n{"ts":2}\n{"ts":3}\n');
  });
});
