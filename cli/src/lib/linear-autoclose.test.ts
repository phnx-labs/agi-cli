import { describe, it, expect } from 'vitest';
import { shouldCloseIssue, type PrInfo } from './linear-autoclose.js';

describe('shouldCloseIssue', () => {
  it('returns true for a merged PR with a mergedAt timestamp', () => {
    const pr: PrInfo = { state: 'MERGED', mergedAt: '2024-06-01T12:00:00Z' };
    expect(shouldCloseIssue(pr)).toBe(true);
  });

  it('returns false for an open PR', () => {
    expect(shouldCloseIssue({ state: 'OPEN', mergedAt: null })).toBe(false);
  });

  it('returns false for a closed-without-merge PR', () => {
    // gh reports state CLOSED when a PR is closed without merging
    expect(shouldCloseIssue({ state: 'CLOSED', mergedAt: null })).toBe(false);
  });

  it('returns false when state is MERGED but mergedAt is null (defensive)', () => {
    // Belt-and-suspenders: a merged PR should always carry a timestamp,
    // but guard against malformed API responses.
    expect(shouldCloseIssue({ state: 'MERGED', mergedAt: null })).toBe(false);
  });

  it('returns false for an unknown state', () => {
    expect(shouldCloseIssue({ state: 'UNKNOWN', mergedAt: '2024-06-01T12:00:00Z' })).toBe(false);
  });

  it('returns true for MERGED with empty-string mergedAt (shell uses -z which also catches this)', () => {
    // gh never returns '' for mergedAt, but the shell routine converts null to "" and the
    // TypeScript only checks `!== null`. The divergence is intentional: the shell check is more
    // defensive.
    expect(shouldCloseIssue({ state: 'MERGED', mergedAt: '' })).toBe(true);
  });
});
