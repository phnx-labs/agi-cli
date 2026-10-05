import { describe, it, expect } from 'vitest';
import { capacityWeight, UNVERIFIED_WEIGHT, PROJECTION_HORIZON_MIN } from './capacity.js';

describe('capacityWeight — a missing usage signal fails CLOSED (PHNX-3392, GWT-E5c)', () => {
  it('an unverifiable account (null snapshot) never outdraws a verified-healthy one', () => {
    expect(capacityWeight(null, null)).toBeLessThan(capacityWeight(41, null));
  });

  it('an unverifiable account is still pickable — an all-blind pool is never stranded', () => {
    expect(capacityWeight(null, null)).toBeGreaterThan(0);
    expect(capacityWeight(null, null)).toBe(UNVERIFIED_WEIGHT);
    expect(UNVERIFIED_WEIGHT).toBeGreaterThanOrEqual(1);
  });

  it('a null snapshot with a burn projection still floors at the unverified weight, never 0', () => {
    expect(capacityWeight(null, PROJECTION_HORIZON_MIN)).toBe(UNVERIFIED_WEIGHT);
    expect(capacityWeight(null, 0)).toBe(1);
  });

  it('verified headroom weighting is unchanged by the fail-closed null arm', () => {
    expect(capacityWeight(50, null)).toBe(50);
    expect(capacityWeight(90, null)).toBe(10);
    expect(capacityWeight(50, PROJECTION_HORIZON_MIN / 2)).toBeCloseTo(25, 5);
  });
});
