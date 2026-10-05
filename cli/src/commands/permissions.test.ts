import { describe, expect, it } from 'vitest';
import { shouldRefuseBroadPermissions } from './permissions.js';

describe('permissions add broad grant gate', () => {
  const pack = (name: string, allow: string[]) => [{
    name,
    path: `/tmp/${name}.yml`,
    set: { name, allow, deny: [] },
  }];

  it('refuses broad permission packs unless --allow-broad-permissions is set', () => {
    const permissions = pack('broad', ['Bash(*)']);

    expect(shouldRefuseBroadPermissions(permissions, false)).toBe(true);
    expect(shouldRefuseBroadPermissions(permissions, true)).toBe(false);
  });

  it('lets a narrowly-scoped pack through even without --allow-broad-permissions', () => {
    const permissions = pack('narrow', ['Bash(git status)', 'Read(src/**)']);

    expect(shouldRefuseBroadPermissions(permissions, false)).toBe(false);
    expect(shouldRefuseBroadPermissions(permissions, true)).toBe(false);
  });

  it('refuses a mixed set: one broad pack among narrow ones still trips the gate', () => {
    const permissions = [...pack('narrow', ['Bash(git status)']), ...pack('broad', ['Bash(*)'])];

    expect(shouldRefuseBroadPermissions(permissions, false)).toBe(true);
  });
});
