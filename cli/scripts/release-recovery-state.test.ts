import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, 'release-recovery-state.sh');

function state(published: boolean, tag = '', branch = '') {
  const result = spawnSync('bash', [SCRIPT, String(published), tag, branch], { encoding: 'utf-8' });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

describe('release operator recovery state', () => {
  it('recovers the exact tagged SHA even when npm is already visible', () => {
    const result = state(true, 'immutable-sha', 'immutable-sha');
    expect(result.status, result.out).toBe(0);
    expect(result.out.trim()).toBe('retry-tag:immutable-sha');
  });

  it('resumes the exact branch SHA before a tag exists', () => {
    const result = state(false, '', 'immutable-sha');
    expect(result.status, result.out).toBe(0);
    expect(result.out.trim()).toBe('retry-branch:immutable-sha');
  });

  it('rejects a registry version with no immutable release identity', () => {
    const result = state(true);
    expect(result.status).not.toBe(0);
    expect(result.out).toContain('without a matching immutable release branch/tag');
  });

  it('rejects a tag and branch that name different commits', () => {
    const result = state(false, 'tag-sha', 'branch-sha');
    expect(result.status).not.toBe(0);
    expect(result.out).toContain('tag points at tag-sha but the release branch points at branch-sha');
  });

  it('starts a new release only when neither registry nor refs already own the version', () => {
    const result = state(false);
    expect(result.status, result.out).toBe(0);
    expect(result.out.trim()).toBe('new');
  });
});
