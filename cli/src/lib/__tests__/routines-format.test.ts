import { describe, it, expect } from 'vitest';
import { humanizeCron, humanizeNextRun, formatRepoLink } from '../routines-format.js';


describe('humanizeCron', () => {
  it('every minute', () => {
    expect(humanizeCron('* * * * *')).toBe('every minute');
  });

  it('every 5 minutes', () => {
    expect(humanizeCron('*/5 * * * *')).toBe('every 5 minutes');
  });

  it('every 2 hours', () => {
    expect(humanizeCron('0 */2 * * *')).toBe('every 2 hours');
  });

  it('daily at 7 AM', () => {
    expect(humanizeCron('0 7 * * *')).toBe('daily at 7:00 AM');
  });

  it('daily at 7 PM', () => {
    expect(humanizeCron('0 19 * * *')).toBe('daily at 7:00 PM');
  });

  it('weekdays at 9 AM', () => {
    expect(humanizeCron('0 9 * * 1-5')).toBe('weekdays at 9:00 AM');
  });

  it('Sundays at 9 AM', () => {
    expect(humanizeCron('0 9 * * 0')).toBe('Sundays at 9:00 AM');
  });

  it('Fridays at 6 PM', () => {
    expect(humanizeCron('0 18 * * 5')).toBe('Fridays at 6:00 PM');
  });

  it('unrecognized expression falls back to raw string', () => {
    const raw = '5 4 */3 * 2';
    expect(humanizeCron(raw)).toBe(raw);
  });

  it('midnight daily', () => {
    expect(humanizeCron('0 0 * * *')).toBe('daily at 12:00 AM');
  });
});


const NOW = new Date('2026-05-29T17:00:00Z');

describe('humanizeNextRun', () => {
  it('returns dash for null', () => {
    expect(humanizeNextRun(null, NOW)).toBe('-');
  });

  it('same calendar day', () => {
    const date = new Date('2026-05-29T20:00:00Z');
    const result = humanizeNextRun(date, NOW);
    expect(result).toMatch(/^today /);
  });

  it('next calendar day', () => {
    const date = new Date('2026-05-30T09:00:00Z');
    const result = humanizeNextRun(date, NOW);
    expect(result).toMatch(/^tomorrow /);
  });

  it('+3 days shows weekday name', () => {
    const date = new Date('2026-06-01T09:00:00Z');
    const result = humanizeNextRun(date, NOW);
    expect(result).toMatch(/^Mon /);
  });

  it('+30 days shows month and day', () => {
    const date = new Date('2026-06-28T09:00:00Z');
    const result = humanizeNextRun(date, NOW);
    expect(result).toMatch(/^Jun 28,/);
  });

  it('+6 days (boundary) shows weekday name', () => {
    const date = new Date('2026-06-04T09:00:00Z');
    const result = humanizeNextRun(date, NOW);
    expect(result).toMatch(/^Thu /);
  });

  it('+7 days (boundary) shows full date', () => {
    const date = new Date('2026-06-05T09:00:00Z');
    const result = humanizeNextRun(date, NOW);
    expect(result).toMatch(/^Jun 5,/);
  });
});


describe('formatRepoLink', () => {
  it('undefined → dash, no href', () => {
    const r = formatRepoLink(undefined);
    expect(r.display).toBe('-');
    expect(r.href).toBeNull();
  });

  it('non-string number → dash, no href (never throws)', () => {
    const r = formatRepoLink(12345 as any);
    expect(r.display).toBe('-');
    expect(r.href).toBeNull();
  });

  it('empty string → dash, no href', () => {
    const r = formatRepoLink('');
    expect(r.display).toBe('-');
    expect(r.href).toBeNull();
  });

  it('owner/name → github pulls URL', () => {
    const r = formatRepoLink('muqsitnawaz/agents');
    expect(r.display).toBe('muqsitnawaz/agents');
    expect(r.href).toBe('https://github.com/muqsitnawaz/agents/pulls');
  });

  it('https URL → display hostname+path, href verbatim', () => {
    const r = formatRepoLink('https://github.com/foo/bar');
    expect(r.display).toBe('github.com/foo/bar');
    expect(r.href).toBe('https://github.com/foo/bar');
  });

  it('http URL → display without scheme, href verbatim', () => {
    const r = formatRepoLink('http://example.com/foo/bar');
    expect(r.display).toBe('example.com/foo/bar');
    expect(r.href).toBe('http://example.com/foo/bar');
  });

  it('plain string with no slash → display verbatim, no href', () => {
    const r = formatRepoLink('just-a-name');
    expect(r.display).toBe('just-a-name');
    expect(r.href).toBeNull();
  });

  it('path with multiple slashes → display verbatim, no href', () => {
    const r = formatRepoLink('org/team/repo');
    expect(r.display).toBe('org/team/repo');
    expect(r.href).toBeNull();
  });

  it('long URL display is truncated to REPO_DISPLAY_MAX chars with ellipsis, href untruncated', () => {
    const longUrl = 'https://gitlab.example.com/path/to/project';
    const r = formatRepoLink(longUrl);
    expect(r.display.length).toBe(24);
    expect(r.display.endsWith('…')).toBe(true);
    expect(r.href).toBe(longUrl);
  });
});
