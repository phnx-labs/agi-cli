import { describe, expect, it } from 'vitest';
import { parseTimeFilter } from '../discover.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function agoMs(input: string): number {
  return Date.now() - parseTimeFilter(input);
}

describe('parseTimeFilter', () => {
  it('supports minute/hour/day/week units', () => {
    expect(agoMs('1m')).toBeCloseTo(MIN, -3);
    expect(agoMs('1h')).toBeCloseTo(HOUR, -4);
    expect(agoMs('24h')).toBeCloseTo(24 * HOUR, -5);
    expect(agoMs('7d')).toBeCloseTo(7 * DAY, -6);
    expect(agoMs('4w')).toBeCloseTo(28 * DAY, -6);
  });

  it('supports month (mo) and year (y) units', () => {
    expect(agoMs('1mo')).toBeCloseTo(30 * DAY, -7);
    expect(agoMs('3mo')).toBeCloseTo(90 * DAY, -7);
    expect(agoMs('1y')).toBeCloseTo(365 * DAY, -8);
  });

  it('does not read "1mo" as "1m" + stray text', () => {
    expect(agoMs('1mo')).toBeGreaterThan(agoMs('1m') * 1000);
  });

  it('parses ISO dates as absolute timestamps', () => {
    expect(parseTimeFilter('2026-01-01')).toBe(new Date('2026-01-01').getTime());
  });

  it('returns 0 for unparseable input', () => {
    expect(parseTimeFilter('garbage')).toBe(0);
    expect(parseTimeFilter('5x')).toBe(0);
  });
});
