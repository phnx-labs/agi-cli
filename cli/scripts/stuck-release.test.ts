
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as path from 'path';

const SCRIPT = path.resolve(__dirname, 'stuck-release.sh');

function stuck(
  registryLatest: string,
  tags: Array<[string, 'yes' | 'no']>,
  bump?: { kind: string; mainVersion: string },
) {
  const input = tags.map(([v, published]) => `${v} ${published}`).join('\n') + '\n';
  const args = bump ? [registryLatest, bump.kind, bump.mainVersion] : [registryLatest];
  const r = spawnSync('bash', [SCRIPT, ...args], { input, encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

describe('stuck-release: the 2026-08-02 jam', () => {
  it('finds the oldest unpublished tag ahead of the registry', () => {
    expect(
      stuck('1.20.78', [
        ['1.20.77', 'yes'],
        ['1.20.78', 'yes'],
        ['1.20.80', 'no'],
        ['1.20.81', 'no'],
      ]),
    ).toBe('1.20.80');
  });

  it('is order-independent — tags come back from git unsorted', () => {
    expect(
      stuck('1.20.78', [
        ['1.20.81', 'no'],
        ['1.20.80', 'no'],
      ]),
    ).toBe('1.20.80');
  });
});

describe('stuck-release: nothing stuck', () => {
  it('reports nothing when every tag is published', () => {
    expect(
      stuck('1.20.81', [
        ['1.20.79', 'yes'],
        ['1.20.80', 'yes'],
        ['1.20.81', 'yes'],
      ]),
    ).toBeNull();
  });

  it('ignores tags at or behind the registry', () => {
    expect(
      stuck('1.20.81', [
        ['1.20.50', 'no'],
        ['1.20.81', 'no'],
      ]),
    ).toBeNull();
  });

  it('reports nothing for an empty tag list', () => {
    expect(stuck('1.20.81', [])).toBeNull();
  });
});

describe('stuck-release: version ordering', () => {
  it('sorts numerically, not lexically', () => {
    expect(
      stuck('1.20.8', [
        ['1.20.10', 'no'],
        ['1.20.9', 'no'],
      ]),
    ).toBe('1.20.9');
  });

  it('crosses a minor boundary correctly', () => {
    expect(
      stuck('1.20.81', [
        ['1.21.0', 'no'],
        ['1.20.81', 'yes'],
      ]),
    ).toBe('1.21.0');
  });

  it('skips malformed tag names rather than choking on them', () => {
    expect(
      stuck('1.20.78', [
        ['1.20.80-rc1' as string, 'no'],
        ['not-a-version' as string, 'no'],
        ['1.20.80', 'no'],
      ]),
    ).toBe('1.20.80');
  });
});


describe('stuck-release: the 2026-08-10 deadlock', () => {
  const TAGS: Array<[string, 'yes' | 'no']> = [
    ['1.22.35', 'yes'],
    ['1.22.36', 'no'],
  ];

  it('still blocks a plain patch bump past the stuck tag', () => {
    expect(stuck('1.22.35', TAGS, { kind: 'patch', mainVersion: '1.22.36' })).toBe('1.22.36');
  });

  it('lets patch-from-main step over main own unpublishable version', () => {
    expect(stuck('1.22.35', TAGS, { kind: 'patch-from-main', mainVersion: '1.22.36' })).toBeNull();
  });

  it('does not exempt a stuck tag that is NOT main own version', () => {
    expect(
      stuck(
        '1.22.35',
        [
          ['1.22.36', 'no'],
          ['1.22.37', 'no'],
        ],
        { kind: 'patch-from-main', mainVersion: '1.22.37' },
      ),
    ).toBe('1.22.36');
  });

  it('keeps blocking when no bump kind is supplied (unchanged default)', () => {
    expect(stuck('1.22.35', TAGS)).toBe('1.22.36');
  });

  it('still reports a genuine jam sitting BEHIND main own version', () => {
    expect(
      stuck(
        '1.22.35',
        [
          ['1.22.36', 'no'],
          ['1.22.38', 'no'],
        ],
        { kind: 'patch-from-main', mainVersion: '1.22.36' },
      ),
    ).toBe('1.22.38');
  });
});
