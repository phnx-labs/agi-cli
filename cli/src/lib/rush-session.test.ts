import { describe, it, expect } from 'vitest';
import { isRushSessionExpired } from './rush-session.js';

describe('isRushSessionExpired', () => {
  it('treats expires_at: 0 as non-expiring (Phoenix pid_ bearer, PHNX-3645)', () => {
    // 0 is the sentinel `rush login` writes for a non-expiring opaque bearer; reading it as an
    // absolute timestamp was the 1970-01-01 bug that rejected every valid Phoenix session across
    // cloud dispatch, secrets sync and the cloud session source.
    expect(isRushSessionExpired(0)).toBe(false);
  });

  it('treats a missing expires_at as non-expiring', () => {
    expect(isRushSessionExpired(undefined)).toBe(false);
  });

  it('is expired when expires_at (ms) is in the past', () => {
    // expires_at is stored in Unix MILLISECONDS.
    const oneHourAgo = Date.now() - 3600_000;
    expect(isRushSessionExpired(oneHourAgo)).toBe(true);
  });

  it('is not expired when expires_at (ms) is in the future', () => {
    const oneHourAhead = Date.now() + 3600_000;
    expect(isRushSessionExpired(oneHourAhead)).toBe(false);
  });

  // PHNX-3805 regression: expires_at is in MILLISECONDS but was compared to `Date.now() / 1000`, so
  // a long-past value never read as expired and `agents cloud providers` reported Rush `available:
  // true` on a dead session. A real past ms timestamp MUST read as expired.
  it('is expired for a real ms-scale timestamp already in the past (PHNX-3805)', () => {
    // A concrete stored value observed on disk: 2026-08-31, already past.
    const realPastMs = 1788157222000;
    expect(realPastMs).toBeLessThan(Date.now()); // guard: this fixture is truly past
    expect(isRushSessionExpired(realPastMs)).toBe(true);
  });

  it('does not misread a valid future ms timestamp as expired (PHNX-3805)', () => {
    // A future ms timestamp — the pre-fix seconds comparison would have read
    // this correctly by luck, but a seconds-scale check breaks in the other
    // direction; pin the ms contract here too.
    const farFutureMs = Date.now() + 30 * 24 * 3600_000; // 30 days out
    expect(isRushSessionExpired(farFutureMs)).toBe(false);
  });
});
