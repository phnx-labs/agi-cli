import { describe, it, expect } from 'vitest';
import { computeTokPerSec } from './throughput.js';

/**
 * `computeTokPerSec` is the CLI's single source of truth for the live
 * output-token throughput the Fleet shows (issue #741 folded the
 * extension's parallel `computeOutputTokensPerSec` copy into here). These lock
 * the per-format token accounting and the rolling-window cutoff, since a drift
 * here silently mis-reports every running agent's speed.
 */

const NOW = Date.parse('2026-07-12T12:00:00.000Z');
const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();

describe('computeTokPerSec', () => {
  it('sums Claude assistant output_tokens inside the window and divides by it', () => {
    const content = [
      JSON.stringify({ type: 'assistant', timestamp: at(10), message: { usage: { output_tokens: 300 } } }),
      JSON.stringify({ type: 'assistant', timestamp: at(30), message: { usage: { output_tokens: 300 } } }),
    ].join('\n');
    // 600 tokens over a 60s window = 10 tok/s.
    expect(computeTokPerSec(content, 'claude', 60, NOW)).toBe(10);
  });

  it('drops Claude turns older than the window (walks back-to-front, breaks at cutoff)', () => {
    const content = [
      JSON.stringify({ type: 'assistant', timestamp: at(90), message: { usage: { output_tokens: 6000 } } }),
      JSON.stringify({ type: 'assistant', timestamp: at(10), message: { usage: { output_tokens: 600 } } }),
    ].join('\n');
    // Only the in-window 600 counts; the 90s-old turn is excluded → 10 tok/s.
    expect(computeTokPerSec(content, 'claude', 60, NOW)).toBe(10);
  });

  it('adds Codex reasoning_output_tokens to output_tokens from token_count events', () => {
    const content = JSON.stringify({
      type: 'event_msg',
      timestamp: at(20),
      payload: { type: 'token_count', info: { last_token_usage: { output_tokens: 300, reasoning_output_tokens: 300 } } },
    });
    // (300 + 300) / 60 = 10 tok/s.
    expect(computeTokPerSec(content, 'codex', 60, NOW)).toBe(10);
  });

  it('ignores non-usage Codex lines (function_call, plain messages)', () => {
    const content = [
      JSON.stringify({ type: 'response_item', timestamp: at(5), payload: { type: 'function_call', name: 'shell' } }),
      JSON.stringify({ type: 'event_msg', timestamp: at(5), payload: { type: 'token_count', info: { last_token_usage: { output_tokens: 120 } } } }),
    ].join('\n');
    expect(computeTokPerSec(content, 'codex', 60, NOW)).toBe(2);
  });

  it('returns 0 for empty or unparseable content', () => {
    expect(computeTokPerSec('', 'claude', 60, NOW)).toBe(0);
    expect(computeTokPerSec('not json\n{bad', 'codex', 60, NOW)).toBe(0);
    expect(computeTokPerSec('{', 'codex', 60, NOW)).toBe(0);
  });
});
