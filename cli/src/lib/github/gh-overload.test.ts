/** Tests for the `gh` overload delegate: argument parsing, target resolution, the empty/pending
 * "not green yet" trap, and render fidelity. */

import { describe, expect, it } from 'vitest';
import {
  isSettled,
  parseDelegateArgs,
  renderRollup,
  repoFromRemote,
  resolveTarget,
} from './gh-overload.js';
import type { RollupItem } from './rest.js';

describe('parseDelegateArgs', () => {
  it('splits --real-gh and the gh argv after --', () => {
    expect(parseDelegateArgs(['--real-gh', '/usr/bin/gh', '--', 'pr', 'checks', '3287', '--watch']))
      .toEqual({ realGh: '/usr/bin/gh', ghArgs: ['pr', 'checks', '3287', '--watch'] });
  });
  it('defaults realGh to bare gh', () => {
    expect(parseDelegateArgs(['--', 'pr', 'checks'])).toEqual({ realGh: 'gh', ghArgs: ['pr', 'checks'] });
  });
});

describe('repoFromRemote', () => {
  it('parses ssh and https remotes', () => {
    expect(repoFromRemote('git@github.com:phnx-labs/agi-cli.git')).toBe('phnx-labs/agi-cli');
    expect(repoFromRemote('https://github.com/phnx-labs/agi-cli.git')).toBe('phnx-labs/agi-cli');
    expect(repoFromRemote('https://github.com/phnx-labs/agi-cli')).toBe('phnx-labs/agi-cli');
  });
  it('returns null for a non-github remote', () => {
    expect(repoFromRemote('git@gitlab.com:x/y.git')).toBeNull();
  });
});

describe('resolveTarget', () => {
  it('parses a PR URL argument (no git/network needed)', async () => {
    const t = await resolveTarget(
      ['pr', 'checks', 'https://github.com/phnx-labs/agi-cli/pull/3287'],
      '/tmp',
      'gh',
    );
    expect(t).toEqual({ repo: 'phnx-labs/agi-cli', number: 3287 });
  });
  it('honors --repo with a bare number', async () => {
    const t = await resolveTarget(['pr', 'checks', '42', '--repo', 'o/r'], '/tmp', 'gh');
    expect(t).toEqual({ repo: 'o/r', number: 42 });
  });
});

describe('isSettled — the empty/pending green trap (PHNX-3042 sibling)', () => {
  const green: RollupItem[] = [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }];
  it('is NOT settled while a check-suite is still registering, even on an empty rollup', () => {
    expect(isSettled([], 2)).toBe(false);
  });
  it('is NOT settled while a check is in_progress', () => {
    expect(isSettled([{ name: 'test', status: 'IN_PROGRESS' }], 0)).toBe(false);
  });
  it('is settled once every check is terminal and no suites pend', () => {
    expect(isSettled(green, 0)).toBe(true);
  });
  it('a non-empty terminal rollup is settled even with a stuck queued App suite', () => {
    // claude/cursor reviewer suites stay `queued` forever without posting runs —
    // real checks decide, exactly as `gh pr checks` ignores them.
    expect(isSettled(green, 2)).toBe(true);
  });
  it('an empty rollup with zero pending suites is settled (genuinely no checks)', () => {
    expect(isSettled([], 0)).toBe(true);
  });
});

describe('renderRollup', () => {
  const rollup: RollupItem[] = [
    { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', link: 'https://x/1' },
    { name: 'lint', status: 'IN_PROGRESS' },
  ];
  it('emits gh-style lines with marks', () => {
    const out = renderRollup(rollup, false);
    expect(out).toContain('✓ test');
    expect(out).toContain('* lint');
  });
  it('emits JSON with lowercased state when --json (sorted by name)', () => {
    const j = JSON.parse(renderRollup(rollup, true)) as Array<{ name: string; state: string }>;
    expect(j.map((c) => c.name)).toEqual(['lint', 'test']); // deterministic sort
    expect(j.find((c) => c.name === 'test')).toMatchObject({ state: 'success' });
    expect(j.find((c) => c.name === 'lint')).toMatchObject({ state: 'in_progress' });
  });
});
