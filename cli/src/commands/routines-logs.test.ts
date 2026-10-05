import { describe, it, expect } from 'vitest';
import { formatRunDuration } from './routines.js';

describe('formatRunDuration', () => {
  const start = '2026-07-01T15:00:00.000Z';
  const plus = (ms: number): string => new Date(Date.parse(start) + ms).toISOString();

  it('returns "" when the run has not completed', () => {
    expect(formatRunDuration(start, null)).toBe('');
  });

  it('returns "" for a negative or unparseable span', () => {
    expect(formatRunDuration(start, '2026-06-01T00:00:00.000Z')).toBe('');
    expect(formatRunDuration('not-a-date', plus(5000))).toBe('');
  });

  it('renders sub-minute spans in seconds', () => {
    expect(formatRunDuration(start, plus(12_000))).toBe('  · 12 sec');
    expect(formatRunDuration(start, plus(59_000))).toBe('  · 59 sec');
  });

  it('renders minute spans in whole minutes', () => {
    expect(formatRunDuration(start, plus(4 * 60_000))).toBe('  · 4 min');
    expect(formatRunDuration(start, plus(59 * 60_000))).toBe('  · 59 min');
  });

  it('renders multi-hour spans as hours + minutes, dropping a zero-minute remainder', () => {
    expect(formatRunDuration(start, plus(2 * 3_600_000))).toBe('  · 2 hr');
    expect(formatRunDuration(start, plus(2 * 3_600_000 + 15 * 60_000))).toBe('  · 2 hr 15 min');
  });
});
