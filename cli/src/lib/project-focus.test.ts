import { describe, it, expect } from 'vitest';
import { FOCUS_LIMIT, focusBucket, rankFocusAreas, formatFocusCount, formatFocusAreas } from './project-focus.js';

describe('focusBucket', () => {
  it('buckets to three levels, which is where a monorepo becomes legible', () => {
    expect(focusBucket('apps/cli/src/lib/projects.ts')).toBe('apps/cli/src');
    expect(focusBucket('apps/ext/src/core/tasks.ts')).toBe('apps/ext/src');
    expect(focusBucket('apps/cli/docs/projects.md')).toBe('apps/cli/docs');
  });

  it('keeps shallow files visible instead of dropping them', () => {
    expect(focusBucket('README.md')).toBe('README.md');
    expect(focusBucket('apps/cli/package.json')).toBe('apps/cli');
  });

  it('drops process churn that would otherwise rank as engineering', () => {
    expect(focusBucket('apps/cli/.changelog/next/RUSH-1.md')).toBeUndefined();
    expect(focusBucket('apps/cli/CHANGELOG.md')).toBeUndefined();
    expect(focusBucket('bun.lock')).toBeUndefined();
    expect(focusBucket('apps/cli/bun.lock')).toBeUndefined();
  });

  it('ignores empty input', () => {
    expect(focusBucket('')).toBeUndefined();
    expect(focusBucket('/')).toBeUndefined();
  });
});

describe('rankFocusAreas', () => {
  it('ranks by touches, descending', () => {
    const files = [
      ...Array(5).fill('apps/cli/src/a.ts'),
      ...Array(2).fill('apps/ext/src/b.ts'),
      'apps/cli/docs/c.md',
    ];
    expect(rankFocusAreas(files)).toEqual([
      { path: 'apps/cli/src', touches: 5 },
      { path: 'apps/ext/src', touches: 2 },
      { path: 'apps/cli/docs', touches: 1 },
    ]);
  });

  it('breaks ties by path so two runs agree', () => {
    const out = rankFocusAreas(['b/x/1.ts', 'a/x/1.ts']);
    expect(out.map((a) => a.path)).toEqual(['a/x', 'b/x']);
  });

  it('caps the list', () => {
    const files = ['a/x/1', 'b/x/1', 'c/x/1', 'd/x/1', 'e/x/1', 'f/x/1'];
    expect(rankFocusAreas(files)).toHaveLength(FOCUS_LIMIT);
    expect(rankFocusAreas(files, 2)).toHaveLength(2);
  });

  it('excludes changelog churn from the ranking, not just the display', () => {
    const files = [...Array(10).fill('apps/cli/.changelog/next/x.md'), ...Array(3).fill('apps/cli/src/a.ts')];
    expect(rankFocusAreas(files)).toEqual([{ path: 'apps/cli/src', touches: 3 }]);
  });

  it('returns nothing for an empty window', () => {
    expect(rankFocusAreas([])).toEqual([]);
  });
});

describe('formatFocusCount', () => {
  it('keeps small counts exact and compactifies thousands', () => {
    expect(formatFocusCount(302)).toBe('302');
    expect(formatFocusCount(2329)).toBe('2.3k');
    expect(formatFocusCount(10000)).toBe('10k');
  });
});

describe('formatFocusAreas', () => {
  it('labels the unit once so the integer is not ambiguous', () => {
    const line = formatFocusAreas(
      [
        { path: 'apps/cli/src', touches: 2329 },
        { path: 'apps/cli/docs', touches: 302 },
      ],
      7,
    );
    expect(line).toBe('apps/cli/src 2.3k  ·  apps/cli/docs 302  file-touches (7d)');
  });
});
