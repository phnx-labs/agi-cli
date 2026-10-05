import { describe, it, expect } from 'vitest';
import { wrapToWidth } from './wrap';
import { stringWidth } from './session/width';

describe('wrapToWidth', () => {
  it('wraps on word boundaries at the given width', () => {
    const out = wrapToWidth('the quick brown fox jumps over', 12);
    expect(out).toEqual(['the quick', 'brown fox', 'jumps over']);
    for (const l of out) expect(l.length).toBeLessThanOrEqual(12);
  });

  it('hanging-indents continuation lines under the value, never the first', () => {
    const out = wrapToWidth('alpha beta gamma delta', 12, 4);
    expect(out[0].startsWith(' ')).toBe(false);
    for (const l of out.slice(1)) expect(l.startsWith('    ')).toBe(true);
  });

  it('never splits a single word longer than the width mid-word', () => {
    const out = wrapToWidth('short verylongunbreakabletoken end', 10);
    expect(out).toContain('verylongunbreakabletoken');
  });

  it('preserves existing newlines as paragraph breaks', () => {
    const out = wrapToWidth('one two\nthree four', 20);
    expect(out).toEqual(['one two', 'three four']);
  });

  it('returns [""] for empty input, not []', () => {
    expect(wrapToWidth('', 40)).toEqual(['']);
  });

  it('measures VISIBLE width, not raw .length — ANSI-coloured text is not over-counted', () => {
    const green = (s: string) => `\x1b[32m${s}\x1b[39m`;
    const coloured = `${green('hello')} ${green('world')}`;
    expect(coloured.length).toBeGreaterThan(11);
    const out = wrapToWidth(coloured, 11);
    expect(out).toEqual([coloured]);
    for (const l of out) expect(stringWidth(l)).toBeLessThanOrEqual(11);
  });

  it('respects a legitimately small cols with no indent (floor is 1, not 8)', () => {
    const out = wrapToWidth('ab cd ef gh', 3);
    expect(out).toEqual(['ab', 'cd', 'ef', 'gh']);
    for (const l of out) expect(l.length).toBeLessThanOrEqual(3);
  });

  it('an indent larger than cols still makes progress (floors at 8, does not crash)', () => {
    const out = wrapToWidth('aaaa bbbb cccc dddd eeee', 10, 40);
    expect(out.length).toBeGreaterThan(1);
    expect(out[0]).toBe('aaaa');
    for (const l of out.slice(1)) expect(l.startsWith(' '.repeat(40))).toBe(true);
  });

  it('degrades a non-finite cols to the floor instead of joining everything on one line', () => {
    const out = wrapToWidth('a b c', Number.NaN);
    expect(out).toEqual(['a', 'b', 'c']);
  });
});
