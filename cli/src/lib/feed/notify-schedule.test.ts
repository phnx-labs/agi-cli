import { describe, expect, it } from 'vitest';
import { DEFAULT_NOTIFY_SCHEDULES, NOTIFY_LEVELS, formatWaited, parseNotifySchedule } from './notify-schedule.js';

describe('parseNotifySchedule', () => {
  it('reads times from when the ask opened plus the stay and sound flags', () => {
    expect(parseNotifySchedule(['0m', '10m', 'stay'])).toEqual({ sidebar: false, atMs: [0, 600_000], stay: true, sound: false });
    expect(parseNotifySchedule(['5m', '1h', 'sound'])).toEqual({ sidebar: false, atMs: [300_000, 3_600_000], stay: false, sound: true });
    expect(parseNotifySchedule(['sidebar'])).toEqual({ sidebar: true });
  });

  it.each([
    [['soon'], '"soon" is not a time (5m, 1h), stay, sound or sidebar.'],
    [['sidebar', '5m'], '"sidebar" must be the only token.'],
    [['stay'], 'list at least one time (e.g. 0m), or sidebar for no banner.'],
    [['30m', '15m'], '"15m" is not later than the time before it; list the times in increasing order.'],
    [['0m', 'stay', 'stay'], '"stay" is listed twice.'],
    [['5s'], '"5s" is not a time (5m, 1h), stay, sound or sidebar.'],
  ])('rejects %j', (tokens, reason) => {
    expect(parseNotifySchedule(tokens)).toBe(reason);
  });

  it('every default parses', () => {
    for (const level of NOTIFY_LEVELS) expect(typeof parseNotifySchedule(DEFAULT_NOTIFY_SCHEDULES[level])).toBe('object');
  });
});

describe('formatWaited', () => {
  it('names minutes, then hours', () => {
    expect(formatWaited(15 * 60_000)).toBe('15 min');
    expect(formatWaited(60 * 60_000)).toBe('1 h');
    expect(formatWaited(90 * 60_000)).toBe('1 h 30 min');
  });
});
