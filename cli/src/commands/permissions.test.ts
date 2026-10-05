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

  // Without this case the check is untested in the direction that matters: the assertions above
  // also hold for `return !allowBroadPermissions`, a guard that ignored `permissions` and refused
  // every install, so nothing proved it inspects the rules it is named for.
  it('lets a narrowly-scoped pack through even without --allow-broad-permissions', () => {
    // Scoped on both axes: a specific bash command, and a read confined to a
    // subtree. `Read(*)` would NOT do — containsBroadGrants counts a bare `*`
    // or `**` read/write pattern as broad (lib/permissions.ts:112-115).
    const permissions = pack('narrow', ['Bash(git status)', 'Read(src/**)']);

    expect(shouldRefuseBroadPermissions(permissions, false)).toBe(false);
    expect(shouldRefuseBroadPermissions(permissions, true)).toBe(false);
  });

  it('refuses a mixed set: one broad pack among narrow ones still trips the gate', () => {
    const permissions = [...pack('narrow', ['Bash(git status)']), ...pack('broad', ['Bash(*)'])];

    expect(shouldRefuseBroadPermissions(permissions, false)).toBe(true);
  });
});
