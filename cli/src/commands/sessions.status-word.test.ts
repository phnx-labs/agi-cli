import { describe, it, expect } from 'vitest';
import { formatLiveStatusHeadline, liveStatusWord } from '../lib/session/presentation.js';
import type { ActiveSession } from '../lib/session/active.js';

function row(partial: Partial<ActiveSession>): ActiveSession {
  return { context: 'headless', kind: 'grok', status: 'running', ...partial } as ActiveSession;
}

describe('liveStatusWord (status text for the default list, not just a glyph)', () => {
  it('rich activity drives the word: working / waiting / idle', () => {
    expect(liveStatusWord(row({ activity: 'working', status: 'running' }))).toBe('working');
    expect(liveStatusWord(row({ activity: 'waiting_input', status: 'input_required' }))).toBe('waiting');
    expect(liveStatusWord(row({ activity: 'idle', status: 'idle' }))).toBe('idle');
  });

  it('a coarse-status row (no rich activity, e.g. an opaque live harness) still reads working', () => {
    expect(liveStatusWord(row({ status: 'running' }))).toBe('working');
  });

  it('input_required is the actionable "waiting" case even without rich activity', () => {
    expect(liveStatusWord(row({ status: 'input_required' }))).toBe('waiting');
  });

  it('a queued cloud row reads queued; a not-live row is empty', () => {
    expect(liveStatusWord(row({ status: 'queued' }))).toBe('queued');
    expect(liveStatusWord(undefined)).toBe('');
  });

  it('lifecycle status (closed/abandoned) wins over any residual parsed activity', () => {
    expect(liveStatusWord(row({ status: 'closed', activity: 'idle' }))).toBe('closed');
    expect(liveStatusWord(row({ status: 'abandoned', activity: 'working' }))).toBe('abandoned');
  });
});

describe('formatLiveStatusHeadline (PHNX-4387)', () => {
  it('a working turn Claude reports busy says how long the transcript has been quiet', () => {
    const headline = formatLiveStatusHeadline(row({ kind: 'claude', activity: 'working', status: 'running', quietSinceMs: Date.now() - 132_422 }));
    expect(headline).toContain('working');
    expect(headline).toContain('quiet 2m');
    expect(formatLiveStatusHeadline(row({ kind: 'claude', activity: 'working', status: 'running' }))).not.toContain('quiet');
  });
});
