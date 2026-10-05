import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatRelativeTime, formatCompactAge, sessionAgeParts } from './relative-time.js';

describe('formatRelativeTime', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps relative buckets for recent times', () => {
    vi.setSystemTime(new Date('2026-07-04T12:00:00.000Z'));
    expect(formatRelativeTime('2026-07-04T11:59:10.000Z')).toBe('just now');
    expect(formatRelativeTime('2026-07-04T11:30:00.000Z')).toBe('30 min ago');
    expect(formatRelativeTime('2026-07-04T09:00:00.000Z')).toBe('3 hours ago');
    expect(formatRelativeTime('2026-07-02T12:00:00.000Z')).toBe('2 days ago');
  });

  it('shows a bare month/day for an older date in the current year', () => {
    vi.setSystemTime(new Date('2026-07-04T12:00:00.000Z'));
    expect(formatRelativeTime('2026-06-01T12:00:00.000Z')).toBe('Jun 1');
  });

  it("appends a 2-digit year for a date outside the current year", () => {
    vi.setSystemTime(new Date('2026-07-04T12:00:00.000Z'));
    expect(formatRelativeTime('2025-06-28T12:00:00.000Z')).toBe("Jun 28 '25");
  });
});

describe('formatCompactAge', () => {
  afterEach(() => vi.useRealTimers());

  it('drops the "ago" and the unit word so it can ride beside the long form', () => {
    vi.setSystemTime(new Date('2026-07-04T12:00:00.000Z'));
    expect(formatCompactAge('2026-07-04T11:59:10.000Z')).toBe('now');
    expect(formatCompactAge('2026-07-04T11:30:00.000Z')).toBe('30m');
    expect(formatCompactAge('2026-07-04T09:00:00.000Z')).toBe('3h');
    expect(formatCompactAge('2026-07-02T12:00:00.000Z')).toBe('2d');
  });

  it('falls back to the same calendar label as the long form past a week', () => {
    vi.setSystemTime(new Date('2026-07-04T12:00:00.000Z'));
    expect(formatCompactAge('2026-06-01T12:00:00.000Z')).toBe('Jun 1');
    expect(formatCompactAge('2025-06-28T12:00:00.000Z')).toBe("Jun 28 '25");
  });
});

describe('sessionAgeParts', () => {
  afterEach(() => vi.useRealTimers());

  it('reports creation and last activity as two fields for a session that ran', () => {
    vi.setSystemTime(new Date('2026-07-04T12:00:00.000Z'));
    expect(sessionAgeParts('2026-07-01T12:00:00.000Z', '2026-07-04T11:00:00.000Z')).toEqual({
      created: '3d',
      last: '1 hour ago',
    });
  });

  it('drops the creation field when the session lived under a minute', () => {
    vi.setSystemTime(new Date('2026-07-04T12:00:00.000Z'));
    expect(sessionAgeParts('2026-07-04T09:00:00.000Z', '2026-07-04T09:00:30.000Z')).toEqual({
      last: '2 hours ago',
    });
  });

  it('labels a session with no recorded last activity by its creation time', () => {
    vi.setSystemTime(new Date('2026-07-04T12:00:00.000Z'));
    expect(sessionAgeParts('2026-07-04T09:00:00.000Z')).toEqual({ last: '3 hours ago' });
  });

  it('degrades to the last-activity label alone on an unparseable timestamp', () => {
    vi.setSystemTime(new Date('2026-07-04T12:00:00.000Z'));
    expect(sessionAgeParts('not-a-date', '2026-07-04T09:00:00.000Z')).toEqual({
      last: '3 hours ago',
    });
  });
});
