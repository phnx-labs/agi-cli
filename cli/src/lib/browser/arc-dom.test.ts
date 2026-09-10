import { describe, expect, test } from 'vitest';
import {
  arcClickExpression,
  arcFillExpression,
  arcRefsExpression,
  arcScrollExpression,
  parseArcRefsResult,
} from './arc-dom.js';

describe('native Arc DOM expressions', () => {
  test('parses stable selectors and preserves the displayed ref numbering', () => {
    const result = parseArcRefsResult(JSON.stringify([
      { role: 'textbox', name: 'Email', attrs: ['required'], selector: '#email' },
      { role: 'button', name: 'Continue', attrs: [], selector: 'form > button' },
    ]));
    expect(result.refs).toBe('- textbox "Email" [ref=1] [required]\n- button "Continue" [ref=2]');
    expect(result.nodeMap.get(1)?.selector).toBe('#email');
  });

  test('builds synchronous DOM operations with escaped caller values', () => {
    expect(arcRefsExpression({ limit: 2 })).toContain('rows.length >= 2');
    expect(arcClickExpression('button[data-name="x"]')).toContain('el.click()');
    const fill = arcFillExpression('#email', 'a"b', true);
    expect(fill).toContain("Object.getOwnPropertyDescriptor(proto, 'value').set");
    expect(fill).toContain("new InputEvent('input'");
    expect(fill).toContain("new Event('change'");
    expect(fill).toContain('a\\"b');
    expect(arcScrollExpression(4, -9)).toContain('window.scrollBy(4, -9)');
  });

  test('fails closed on malformed native results', () => {
    expect(() => parseArcRefsResult('[{"role":"button"}]')).toThrow('invalid DOM ref entry');
  });
});
