import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseKimiWireMetricsIncremental,
  type KimiParserState,
} from '../discover.js';

// Differential parity harness (B-4, Kimi): wire.jsonl is pure additive counters, so resuming from
// a persisted offset plus counter bases equals a full parse. A complete-but-unterminated last
// record is deferred, never double-counted. Real temp files, no mocks.

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-kimi-inc-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Create a session dir with an agents/main/ layout and return the session dir. */
function makeSessionDir(): string {
  const sessionDir = path.join(dir, 'session_x');
  fs.mkdirSync(path.join(sessionDir, 'agents', 'main'), { recursive: true });
  return sessionDir;
}

function wirePath(sessionDir: string): string {
  return path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
}

/** A full parse = incremental from a null prior (fresh counters at offset 0). */
function fullMetrics(sessionDir: string) {
  return parseKimiWireMetricsIncremental(sessionDir, null);
}

/** Serialize wire events into JSONL lines (no trailing newline). */
function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n');
}

function richEvents(): object[] {
  return [
    { type: 'context.append_message', role: 'user' },
    { type: 'usage.record', usage: { inputOther: 100, output: 20, inputCacheRead: 5, inputCacheCreation: 3 } },
    { type: 'context.append_message', role: 'assistant' },
    { type: 'something.else', ignored: true },
    { type: 'context.append_message', role: 'user' },
    { type: 'usage.record', usage: { inputOther: 200, output: 40, inputCacheRead: 10, inputCacheCreation: 1 } },
  ];
}

describe('kimi incremental parity — boundary sweep', () => {
  it('replaying across a split at EVERY line index equals a full parse', async () => {
    const events = richEvents();
    const serialized = events.map((e) => JSON.stringify(e));
    for (let k = 1; k < serialized.length; k++) {
      const sessionDir = path.join(dir, `s-${k}`);
      fs.mkdirSync(path.join(sessionDir, 'agents', 'main'), { recursive: true });
      const wp = wirePath(sessionDir);

      // Seed with chunk A, parse (bootstrap continuation).
      fs.writeFileSync(wp, serialized.slice(0, k).join('\n') + '\n');
      let step = parseKimiWireMetricsIncremental(sessionDir, null);
      let prior: KimiParserState = step.newState;

      // Append chunk B, resume.
      fs.appendFileSync(wp, serialized.slice(k).join('\n') + '\n');
      step = parseKimiWireMetricsIncremental(sessionDir, prior);

      const full = fullMetrics(sessionDir);
      expect(step.messageCount, `split@${k} messageCount`).toBe(full.messageCount);
      expect(step.tokenCount, `split@${k} tokenCount`).toBe(full.tokenCount);
      expect(step.outputTokens, `split@${k} outputTokens`).toBe(full.outputTokens);
      // Concrete counts: 3 messages, tokens = (100+20+5+3)+(200+40+10+1)=379, output=60.
      expect(full.messageCount).toBe(3);
      expect(full.tokenCount).toBe(379);
      expect(full.outputTokens).toBe(60);
    }
  });
});

describe('kimi incremental parity — no wire.jsonl yet', () => {
  it('a session with no wire.jsonl yields zero counters and an offset-0 continuation', () => {
    const sessionDir = path.join(dir, 'no-wire');
    fs.mkdirSync(sessionDir, { recursive: true });
    const r = parseKimiWireMetricsIncremental(sessionDir, null);
    expect(r.messageCount).toBe(0);
    expect(r.tokenCount).toBe(0);
    expect(r.outputTokens).toBe(0);
    expect(r.newState.offset).toBe(0);
  });
});

describe('kimi incremental parity — truncation → full reparse', () => {
  it('when wire.jsonl shrinks below the stored offset, a fresh full parse (prior=null) matches', () => {
    const sessionDir = makeSessionDir();
    const wp = wirePath(sessionDir);
    const original = jsonl(richEvents()) + '\n';
    fs.writeFileSync(wp, original);
    const first = parseKimiWireMetricsIncremental(sessionDir, null);
    expect(first.newState.offset).toBe(Buffer.byteLength(original, 'utf-8'));

    // Rewrite SMALLER (a fresh, shorter session reusing the same path).
    const rewritten = jsonl([
      { type: 'context.append_message', role: 'user' },
      { type: 'usage.record', usage: { inputOther: 7, output: 3 } },
    ]) + '\n';
    fs.writeFileSync(wp, rewritten);
    const newSize = Buffer.byteLength(rewritten, 'utf-8');
    expect(newSize).toBeLessThan(first.newState.offset);

    // The incremental fn detects the shrink (size <= offset) and full-parses.
    const reparse = parseKimiWireMetricsIncremental(sessionDir, first.newState);
    const full = fullMetrics(sessionDir);
    expect(reparse.messageCount).toBe(full.messageCount);
    expect(reparse.tokenCount).toBe(full.tokenCount);
    expect(reparse.outputTokens).toBe(full.outputTokens);
    expect(reparse.messageCount).toBe(1);
    expect(reparse.tokenCount).toBe(10);
    expect(reparse.outputTokens).toBe(3);
  });
});

describe('kimi incremental parity — partial / complete-unterminated trailing line', () => {
  it('a chunk ending mid-JSON (no trailing newline) is re-consumed on the next append', () => {
    const sessionDir = makeSessionDir();
    const wp = wirePath(sessionDir);
    const l1 = JSON.stringify({ type: 'context.append_message', role: 'user' });
    fs.writeFileSync(wp, l1 + '\n');
    const step1 = parseKimiWireMetricsIncremental(sessionDir, null);
    expect(step1.messageCount).toBe(1);
    expect(step1.newState.offset).toBe(Buffer.byteLength(l1 + '\n', 'utf-8'));

    const l2full = JSON.stringify({ type: 'usage.record', usage: { inputOther: 50, output: 12 } });
    const l2partial = l2full.slice(0, Math.floor(l2full.length / 2));
    fs.appendFileSync(wp, l2partial);
    const step2 = parseKimiWireMetricsIncremental(sessionDir, step1.newState);
    // No new '\n' → offset must NOT advance; the half-line is not parsed.
    expect(step2.newState.offset).toBe(step1.newState.offset);
    expect(step2.tokenCount).toBe(0);

    fs.appendFileSync(wp, l2full.slice(l2partial.length) + '\n');
    const step3 = parseKimiWireMetricsIncremental(sessionDir, step2.newState);
    expect(step3.newState.offset).toBe(fs.statSync(wp).size);

    const full = fullMetrics(sessionDir);
    expect(step3.tokenCount).toBe(full.tokenCount);
    expect(step3.tokenCount).toBe(62);
  });

  it('a COMPLETE record missing only its trailing newline is deferred, then counted EXACTLY once', () => {
    // The non-atomic-append bug class: a writer appends a full, valid record and
    // only later appends its '\n'. Kimi counters are additive with NO dedup, so a
    // double-apply would show up as messageCount 1→2.
    const sessionDir = makeSessionDir();
    const wp = wirePath(sessionDir);
    const l1 = JSON.stringify({ type: 'context.append_message', role: 'user' });
    fs.writeFileSync(wp, l1 + '\n');
    const step1 = parseKimiWireMetricsIncremental(sessionDir, null);
    expect(step1.messageCount).toBe(1);
    expect(step1.newState.offset).toBe(Buffer.byteLength(l1 + '\n', 'utf-8'));

    // Append a COMPLETE, valid second record — WITHOUT its trailing '\n' yet.
    const l2 = JSON.stringify({ type: 'context.append_message', role: 'assistant' });
    fs.appendFileSync(wp, l2);
    const step2 = parseKimiWireMetricsIncremental(sessionDir, step1.newState);
    // Deferred: offset does NOT advance, line2 NOT yet counted.
    expect(step2.newState.offset).toBe(step1.newState.offset);
    expect(step2.messageCount).toBe(1);

    // Writer flushes the terminating '\n'.
    fs.appendFileSync(wp, '\n');
    const step3 = parseKimiWireMetricsIncremental(sessionDir, step2.newState);
    // Counted EXACTLY once — not twice.
    expect(step3.messageCount).toBe(2);
    expect(step3.newState.offset).toBe(fs.statSync(wp).size);

    const full = fullMetrics(sessionDir);
    expect(step3.messageCount).toBe(full.messageCount);
  });
});
