import { describe, expect, it } from 'vitest';
import { masthead } from './comms-render.js';
import { stringWidth, stripAnsi } from './session/width.js';

describe('masthead', () => {
  it('aligns the right-hand value to the terminal edge', () => {
    const previous = process.env.COLUMNS;
    process.env.COLUMNS = '72';
    try {
      const rendered = masthead({
        title: 'agents talking',
        host: 'zion',
        accent: 'cyan',
        stats: ['3 live', '23 boxes'],
        right: '14:02:51',
      });
      const plain = stripAnsi(rendered);
      expect(plain).toContain('⌁ agents talking · zion   3 live · 23 boxes');
      expect(plain).toMatch(/14:02:51$/);
      expect(stringWidth(rendered)).toBe(72);
    } finally {
      if (previous === undefined) delete process.env.COLUMNS;
      else process.env.COLUMNS = previous;
    }
  });
});
