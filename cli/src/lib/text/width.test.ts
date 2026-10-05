import { describe, it, expect } from 'vitest';
import { stringWidth, stripAnsi, truncateToWidth, padToWidth, terminalWidth } from './width.js';

describe('stringWidth', () => {
  it('counts ASCII as one cell each', () => {
    expect(stringWidth('hello')).toBe(5);
  });

  it('ignores ANSI colour escapes', () => {
    const colored = '\x1b[32mok\x1b[39m';
    expect(stringWidth(colored)).toBe(2);
    expect(stripAnsi(colored)).toBe('ok');
  });

  it('counts CJK as two cells', () => {
    expect(stringWidth('日本語')).toBe(6);
  });

  it('counts emoji as two cells', () => {
    expect(stringWidth('🔧')).toBe(2);
  });

  it('treats combining marks as zero-width', () => {
    expect(stringWidth('é')).toBe(1);
  });
});

describe('OSC-8 hyperlinks (RUSH-2205)', () => {
  const link = '\x1b]8;;https://linear.app/x/issue/RUSH-2205\x1b\\RUSH-2205\x1b]8;;\x1b\\';

  it('measures only the visible label, not the URL', () => {
    expect(stringWidth(link)).toBe(9);
    expect(stripAnsi(link)).toBe('RUSH-2205');
  });

  it('handles the BEL-terminated variant', () => {
    const bel = '\x1b]8;;https://x\x07label\x1b]8;;\x07';
    expect(stringWidth(bel)).toBe(5);
    expect(stripAnsi(bel)).toBe('label');
  });

  it('truncates without leaving a corrupted (unterminated) escape', () => {
    const out = truncateToWidth(link + ' idle 3h', 6);
    expect(stringWidth(out)).toBeLessThanOrEqual(6);
    expect(stripAnsi(out)).not.toContain('\x1b');
  });
});

describe('truncateToWidth', () => {
  it('leaves short strings untouched', () => {
    expect(truncateToWidth('short', 10)).toBe('short');
  });

  it('truncates ASCII with an ellipsis at the target width', () => {
    const out = truncateToWidth('abcdefghij', 5);
    expect(stringWidth(out)).toBeLessThanOrEqual(5);
    expect(out.endsWith('…')).toBe(true);
  });

  it('never splits a wide glyph across the boundary', () => {
    const out = truncateToWidth('日本', 3);
    expect(stringWidth(out)).toBeLessThanOrEqual(3);
    expect(out).toBe('日…');
  });

  it('measures the coloured input by visible width, not escape length', () => {
    const colored = '\x1b[32mhello world\x1b[39m';
    const out = truncateToWidth(colored, 5);
    expect(stringWidth(out)).toBeLessThanOrEqual(5);
  });
});

describe('padToWidth', () => {
  it('pads to the visible target width', () => {
    expect(padToWidth('ab', 5)).toBe('ab   ');
  });
  it('pads accounting for wide chars', () => {
    expect(padToWidth('日', 5)).toBe('日   ');
  });
  it('does not truncate when already wider', () => {
    expect(padToWidth('abcdef', 3)).toBe('abcdef');
  });
});

describe('terminalWidth', () => {
  it('prefers $COLUMNS and clamps to the sane band', () => {
    const prev = process.env.COLUMNS;
    process.env.COLUMNS = '120';
    expect(terminalWidth()).toBe(120);
    process.env.COLUMNS = '5000';
    expect(terminalWidth()).toBe(200);
    process.env.COLUMNS = '10';
    expect(terminalWidth()).toBe(60);
    if (prev === undefined) delete process.env.COLUMNS;
    else process.env.COLUMNS = prev;
  });
});
