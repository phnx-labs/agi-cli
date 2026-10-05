import { describe, expect, it } from 'vitest';
import { unifiedDiff, colorizeUnifiedDiff } from '../diff-text.js';

describe('unifiedDiff', () => {
  it('returns empty string when contents match', () => {
    expect(unifiedDiff('alpha\nbeta\n', 'alpha\nbeta\n')).toBe('');
  });

  it('returns a unified-diff with header and hunk markers when contents differ', () => {
    const out = unifiedDiff('alpha\nbeta\n', 'alpha\ngamma\n', { fromLabel: 'a', toLabel: 'b' });
    expect(out).toContain('--- a');
    expect(out).toContain('+++ a');
    expect(out).toMatch(/^@@ /m);
    expect(out).toContain('-beta');
    expect(out).toContain('+gamma');
  });
});

describe('colorizeUnifiedDiff', () => {
  it('indents every output line with the given prefix', () => {
    const patch = unifiedDiff('a\n', 'b\n', { fromLabel: 'src' });
    const coloured = colorizeUnifiedDiff(patch, '>>>');
    for (const line of coloured.split('\n')) {
      expect(line.startsWith('>>>')).toBe(true);
    }
  });
});
