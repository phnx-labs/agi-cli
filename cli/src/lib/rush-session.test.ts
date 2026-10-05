import { describe, it, expect } from 'vitest';
import { isRushSessionExpired } from './rush-session.js';

describe('isRushSessionExpired', () => {
  it('treats expires_at: 0 as non-expiring (Phoenix pid_ bearer, PHNX-3645)', () => {
    expect(isRushSessionExpired(0)).toBe(false);
  });

  it('treats a missing expires_at as non-expiring', () => {
    expect(isRushSessionExpired(undefined)).toBe(false);
  });

  it('is expired when expires_at (ms) is in the past', () => {
    const oneHourAgo = Date.now() - 3600_000;
    expect(isRushSessionExpired(oneHourAgo)).toBe(true);
  });

  it('is not expired when expires_at (ms) is in the future', () => {
    const oneHourAhead = Date.now() + 3600_000;
    expect(isRushSessionExpired(oneHourAhead)).toBe(false);
  });

  it('is expired for a real ms-scale timestamp already in the past (PHNX-3805)', () => {
    const realPastMs = 1788157222000;
    expect(realPastMs).toBeLessThan(Date.now());
    expect(isRushSessionExpired(realPastMs)).toBe(true);
  });

  it('does not misread a valid future ms timestamp as expired (PHNX-3805)', () => {
    const farFutureMs = Date.now() + 30 * 24 * 3600_000;
    expect(isRushSessionExpired(farFutureMs)).toBe(false);
  });
});
