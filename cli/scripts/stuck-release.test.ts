
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
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

describe('stuck-release: release.sh must consume the tag list fail-closed', () => {
  const RELEASE_SH = fs.readFileSync(path.resolve(__dirname, 'release.sh'), 'utf-8');

  it('demonstrates why: die inside a process substitution does NOT abort the script', () => {
    const script = `
      set -euo pipefail
      die() { echo "DIED" >&2; exit 1; }
      gather() { false || die "cannot read"; }
      while read -r a; do :; done < <(gather)
      echo "CONTINUED"
    `;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf-8' });
    expect(r.stdout).toContain('CONTINUED');
    expect(r.status).toBe(0);
  });

  it('demonstrates the safe form: a command substitution does abort it', () => {
    const script = `
      set -euo pipefail
      die() { echo "DIED" >&2; exit 1; }
      gather() { false || die "cannot read"; }
      RAW="$(gather)"
      while read -r a; do :; done <<< "$RAW"
      echo "CONTINUED"
    `;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf-8' });
    expect(r.stdout).not.toContain('CONTINUED');
    expect(r.status).toBe(1);
  });

  it('release.sh uses the safe form', () => {
    expect(RELEASE_SH).toMatch(/REMOTE_TAG_LINES="\$\(remote_version_tags\)"/);
    const unsafe = RELEASE_SH.split('\n').filter(
      (l) => !l.trimStart().startsWith('#') && l.includes('< <(remote_version_tags)'),
    );
    expect(unsafe).toEqual([]);
  });
});

describe('release.sh: every irreversible act is gated by the lease', () => {
  const LINES = fs
    .readFileSync(path.resolve(__dirname, 'release.sh'), 'utf-8')
    .split(/\r?\n/);

  function precededByLeaseGate(idx: number, window = 6) {
    for (let i = idx - 1; i >= 0 && i >= idx - window; i--) {
      const l = LINES[i].trim();
      if (l === '' || l.startsWith('#')) continue;
      if (l.startsWith('require_lease')) return true;
    }
    return false;
  }

  it('every `git push origin "v$TARGET"` is preceded by require_lease', () => {
    const pushes = LINES.map((l, i) => ({ l, i })).filter(({ l }) =>
      /^\s*git push origin "v\$TARGET"/.test(l),
    );
    expect(pushes.length).toBeGreaterThan(0);
    const ungated = pushes.filter(({ i }) => !precededByLeaseGate(i));
    expect(ungated.map(({ i, l }) => `line ${i + 1}: ${l.trim()}`)).toEqual([]);
  });

  it('any PRE-publish PR merge is lease-gated; the async bump-merge runs after publish', () => {
    const publishIdx = LINES.findIndex((l) =>
      /^\s*route_home_base_phase\s*\\?$/.test(l),
    );
    expect(publishIdx).toBeGreaterThan(-1);
    const merges = LINES.map((l, i) => ({ l, i })).filter(({ l }) =>
      /gh pr merge "\$PR_NUMBER"/.test(l),
    );
    expect(merges.length).toBeGreaterThan(0);
    const ungatedPrePublish = merges
      .filter(({ i }) => i < publishIdx)
      .filter(({ i }) => !precededByLeaseGate(i, 8));
    expect(
      ungatedPrePublish.map(({ i, l }) => `line ${i + 1}: ${l.trim()}`),
    ).toEqual([]);
    expect(merges.some(({ i }) => i > publishIdx)).toBe(true);
  });

  it('the publish routing is preceded by require_lease', () => {
    const idx = LINES.findIndex((l) => /^\s*route_home_base_phase\s*\\?$/.test(l));
    expect(idx).toBeGreaterThan(-1);
    expect(precededByLeaseGate(idx)).toBe(true);
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
