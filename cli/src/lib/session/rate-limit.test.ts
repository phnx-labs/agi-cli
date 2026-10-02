import { describe, expect, it } from 'vitest';
import { detectRateLimited, inferSessionState } from '@phnx-labs/sessions-cli/reader';
import type { SessionEvent } from '@phnx-labs/sessions-cli/reader';

describe('detectRateLimited (RUSH-1523)', () => {
  it('matches common rate-limit shapes', () => {
    expect(detectRateLimited('Rate limit exceeded')).toBe(true);
    expect(detectRateLimited('Too many requests, please try again later')).toBe(true);
    expect(detectRateLimited('HTTP 429 from API')).toBe(true);
    expect(detectRateLimited('You have hit your usage limit')).toBe(true);
    expect(detectRateLimited('out of credits')).toBe(true);
    expect(detectRateLimited('quota exceeded for this org')).toBe(true);
    expect(detectRateLimited('Editing src/foo.ts')).toBe(false);
  });

  it('inferSessionState sets rateLimited from a recent assistant message', () => {
    const events: SessionEvent[] = [
      { type: 'message', role: 'user', content: 'keep going', ts: 1 },
      { type: 'message', role: 'assistant', content: 'Rate limit exceeded — try again later', ts: 2 },
    ];
    const state = inferSessionState(events);
    expect(state.rateLimited).toBe(true);
  });
});
