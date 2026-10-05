import { describe, expect, it } from 'vitest';
import { withAlias, withoutAlias } from '../state.js';


describe('withAlias', () => {
  it('inserts <alias>:* immediately before project:* (after system/user)', () => {
    expect(withAlias(['system:*', 'user:*', 'project:*'], 'extras')).toEqual([
      'system:*',
      'user:*',
      'extras:*',
      'project:*',
    ]);
  });

  it('appends when there is no project layer (e.g. hooks)', () => {
    expect(withAlias(['system:*', 'user:*'], 'extras')).toEqual([
      'system:*',
      'user:*',
      'extras:*',
    ]);
  });

  it('keeps multiple extras in registration order, all before project', () => {
    const once = withAlias(['system:*', 'user:*', 'project:*'], 'rush');
    expect(withAlias(once, 'extras')).toEqual([
      'system:*',
      'user:*',
      'rush:*',
      'extras:*',
      'project:*',
    ]);
  });

  it('is idempotent — re-adding the same alias is a no-op and returns the same ref', () => {
    const input = ['system:*', 'user:*', 'extras:*', 'project:*'];
    const out = withAlias(input, 'extras');
    expect(out).toBe(input);
  });

  it('does not double-add when the alias is referenced by a specific include', () => {
    const input = ['system:*', 'user:*', 'extras:my-skill', 'project:*'];
    expect(withAlias(input, 'extras')).toBe(input);
  });

  it('does not re-add an alias the user explicitly excluded', () => {
    const input = ['system:*', 'user:*', '!extras:noisy', 'project:*'];
    expect(withAlias(input, 'extras')).toBe(input);
  });

  it('does not confuse a prefix-sharing alias (extras2 vs extras)', () => {
    expect(withAlias(['system:*', 'user:*', 'extras2:*', 'project:*'], 'extras')).toEqual([
      'system:*',
      'user:*',
      'extras2:*',
      'extras:*',
      'project:*',
    ]);
  });
});

describe('withoutAlias', () => {
  it('removes the alias include and leaves everything else', () => {
    expect(withoutAlias(['system:*', 'user:*', 'extras:*', 'project:*'], 'extras')).toEqual([
      'system:*',
      'user:*',
      'project:*',
    ]);
  });

  it('removes specific includes and excludes for the alias', () => {
    expect(withoutAlias(['user:*', 'extras:a', '!extras:b', 'project:*'], 'extras')).toEqual([
      'user:*',
      'project:*',
    ]);
  });

  it('returns the same ref when the alias is absent (no-op)', () => {
    const input = ['system:*', 'user:*', 'project:*'];
    expect(withoutAlias(input, 'extras')).toBe(input);
  });

  it('does not strip a prefix-sharing alias', () => {
    expect(withoutAlias(['user:*', 'extras2:*', 'extras:*'], 'extras')).toEqual([
      'user:*',
      'extras2:*',
    ]);
  });
});
