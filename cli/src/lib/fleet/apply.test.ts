import { describe, it, expect } from 'vitest';
import {
  decideSecretPush,
  parseRemoteBundles,
  agentIdOf,
  diffFleet,
  pinnedVersion,
  rosterNeedsVersions,
  expandAllSpecs,
  parseInstalledVersions,
  type SourceAuth,
} from './apply.js';
import type { DeviceDesired, DeviceProbe } from './types.js';

function srcAuth(available: string[], bound: string[] = []): SourceAuth {
  return { available: new Set(available), bound: new Set(bound), filesByAgent: new Map() };
}

const CLI = '1.20.64';

describe('agentIdOf', () => {
  it('strips the version suffix', () => {
    expect(agentIdOf('claude@latest')).toBe('claude');
    expect(agentIdOf('codex@1.2.3')).toBe('codex');
    expect(agentIdOf('gemini')).toBe('gemini');
  });
});

describe('diffFleet', () => {
  const desired: DeviceDesired[] = [
    { device: 's1', agents: ['claude@latest', 'codex@latest'], sync: ['user'], login: 'sync' },
  ];

  it('plans install-cli + add both agents + sync, and surfaces native logins as manual', () => {
    const probes = new Map<string, DeviceProbe>([
      ['s1', { device: 's1', reachable: true, platform: 'linux', cliVersion: undefined, installedAgents: [] }],
    ]);
    const plan = diffFleet(desired, probes, { targetCliVersion: CLI, sourceAuth: srcAuth(['claude', 'codex']) });
    const kinds = plan.actions.map((a) => a.kind);
    expect(kinds).toContain('install-cli');
    expect(kinds.filter((k) => k === 'add-agent')).toHaveLength(2);
    expect(kinds).toContain('sync-config');
    // Both login:sync agents surface as needs-login (log in per box).
    expect(kinds.filter((k) => k === 'needs-login')).toHaveLength(2);
    expect(plan.devices[0].loginBlocked.sort()).toEqual(['claude', 'codex']);
  });

  it('is idempotent: nothing to install when cli + agents already present (login surfaces per box, never pushed)', () => {
    const probes = new Map<string, DeviceProbe>([
      ['s1', { device: 's1', reachable: true, platform: 'linux', cliVersion: CLI, installedAgents: ['claude', 'codex'] }],
    ]);
    const plan = diffFleet(desired, probes, { targetCliVersion: CLI, sourceAuth: srcAuth(['claude', 'codex']) });
    const kinds = plan.actions.map((a) => a.kind);
    expect(kinds).not.toContain('install-cli');
    expect(kinds).not.toContain('upgrade-cli');
    expect(kinds).not.toContain('add-agent');
    expect(kinds).toContain('sync-config');
    expect(kinds.filter((k) => k === 'needs-login')).toHaveLength(2);
  });

  it('plans upgrade-cli on a version mismatch', () => {
    const probes = new Map<string, DeviceProbe>([
      ['s1', { device: 's1', reachable: true, platform: 'linux', cliVersion: '1.20.55', installedAgents: ['claude', 'codex'] }],
    ]);
    const plan = diffFleet(desired, probes, { targetCliVersion: CLI, sourceAuth: srcAuth(['claude', 'codex']) });
    expect(plan.actions.map((a) => a.kind)).toContain('upgrade-cli');
  });

  it('surfaces every login:sync agent with a portable file as needs-login, never push', () => {
    const macDesired: DeviceDesired[] = [
      { device: 'mac', agents: ['claude@latest', 'codex@latest'], sync: [], login: 'sync' },
    ];
    const probes = new Map<string, DeviceProbe>([
      ['mac', { device: 'mac', reachable: true, platform: 'macos', cliVersion: CLI, installedAgents: ['claude', 'codex'] }],
    ]);
    const plan = diffFleet(macDesired, probes, { targetCliVersion: CLI, sourceAuth: srcAuth(['claude', 'codex']) });
    // Both claude and codex are surfaced as needs-login — a native OAuth login is
    // never copied, on any platform.
    for (const id of ['claude', 'codex']) {
      const acts = plan.actions.filter((a) => a.agent === id);
      expect(acts.some((a) => a.kind === 'needs-login')).toBe(true);
    }
    expect(plan.devices[0].loginBlocked.sort()).toEqual(['claude', 'codex']);
  });

  it('does not flag an agent with no portable credential file (cursor) as needs-login', () => {
    const macDesired: DeviceDesired[] = [
      { device: 'mac', agents: ['cursor@latest'], sync: [], login: 'sync' },
    ];
    const probes = new Map<string, DeviceProbe>([
      ['mac', { device: 'mac', reachable: true, platform: 'macos', cliVersion: CLI, installedAgents: ['cursor'] }],
    ]);
    const plan = diffFleet(macDesired, probes, { targetCliVersion: CLI, sourceAuth: srcAuth(['cursor']) });
    expect(plan.actions.some((a) => a.kind === 'needs-login')).toBe(false);
    expect(plan.devices[0].loginBlocked).toEqual([]);
  });

  it('surfaces a portable-file agent as needs-login regardless of source sign-in (nothing is pushed anyway)', () => {
    // grok has a portable file; the source sign-in state is now irrelevant because
    // apply never copies a login — the device is told to log in on the box.
    const macDesired: DeviceDesired[] = [
      { device: 'mac', agents: ['grok@latest'], sync: [], login: 'sync' },
    ];
    const probes = new Map<string, DeviceProbe>([
      ['mac', { device: 'mac', reachable: true, platform: 'macos', cliVersion: CLI, installedAgents: ['grok'] }],
    ]);
    const plan = diffFleet(macDesired, probes, { targetCliVersion: CLI, sourceAuth: srcAuth([]) });
    expect(plan.actions.some((a) => a.agent === 'grok' && a.kind === 'needs-login')).toBe(true);
    expect(plan.devices[0].loginBlocked).toEqual(['grok']);
  });

  it('surfaces a bound source token as needs-login on a linux target (still never pushed)', () => {
    const probes = new Map<string, DeviceProbe>([
      ['s1', { device: 's1', reachable: true, platform: 'linux', cliVersion: CLI, installedAgents: ['claude', 'codex'] }],
    ]);
    const plan = diffFleet(desired, probes, { targetCliVersion: CLI, sourceAuth: srcAuth(['codex'], ['claude']) });
    expect(plan.devices[0].loginBlocked.sort()).toEqual(['claude', 'codex']);
    const detail = plan.actions.find((a) => a.agent === 'claude' && a.kind === 'needs-login')?.detail;
    expect(detail).toMatch(/SING-1b/);
  });

  it('never propagates droid (or any agent) — surfaces per-machine login for all portable-file agents', () => {
    const droidDesired: DeviceDesired[] = [
      { device: 's1', agents: ['droid@latest', 'codex@latest'], sync: [], login: 'sync' },
    ];
    const probes = new Map<string, DeviceProbe>([
      ['s1', { device: 's1', reachable: true, platform: 'linux', cliVersion: CLI, installedAgents: ['droid', 'codex'] }],
    ]);
    const plan = diffFleet(droidDesired, probes, { targetCliVersion: CLI, sourceAuth: srcAuth(['droid', 'codex']) });
    for (const id of ['droid', 'codex']) {
      expect(plan.actions.some((a) => a.agent === id && a.kind === 'needs-login')).toBe(true);
    }
    expect(plan.devices[0].loginBlocked.sort()).toEqual(['codex', 'droid']);
  });

  it('produces no actions for an unreachable device', () => {
    const probes = new Map<string, DeviceProbe>([
      ['s1', { device: 's1', reachable: false, platform: 'linux', installedAgents: [], note: 'unreachable' }],
    ]);
    const plan = diffFleet(desired, probes, { targetCliVersion: CLI, sourceAuth: srcAuth(['claude', 'codex']) });
    expect(plan.actions).toEqual([]);
    expect(plan.devices[0].probe.reachable).toBe(false);
  });

  it('skips login entirely when login mode is skip', () => {
    const skipDesired: DeviceDesired[] = [
      { device: 's1', agents: ['codex@latest'], sync: [], login: 'skip' },
    ];
    const probes = new Map<string, DeviceProbe>([
      ['s1', { device: 's1', reachable: true, platform: 'linux', cliVersion: CLI, installedAgents: ['codex'] }],
    ]);
    const plan = diffFleet(skipDesired, probes, { targetCliVersion: CLI, sourceAuth: srcAuth(['codex']) });
    expect(plan.actions).toEqual([]);
  });
});

describe('diffFleet — secrets surfacing', () => {
  const desired: DeviceDesired[] = [
    { device: 's1', agents: ['codex@latest'], sync: ['user'], login: 'skip' },
  ];
  const converged = new Map<string, DeviceProbe>([
    ['s1', { device: 's1', reachable: true, platform: 'linux', cliVersion: CLI, installedAgents: ['codex'] }],
  ]);

  it('surfaces declared bundles as needs-secret (not executable), one per bundle', () => {
    const plan = diffFleet(desired, converged, {
      targetCliVersion: CLI,
      sourceAuth: srcAuth(['codex']),
      secretsBundles: ['attio', 'ssh-keys'],
    });
    const secretActs = plan.actions.filter((a) => a.kind === 'needs-secret');
    expect(secretActs).toHaveLength(2);
    expect(plan.devices[0].secretsNeeded).toEqual(['attio', 'ssh-keys']);
    // sync-config still fires (scopes declared) but there is nothing executable
    // beyond it — needs-secret must be excluded from the "actions to run" count.
    const executable = plan.actions.filter((a) => a.kind !== 'needs-login' && a.kind !== 'needs-secret');
    expect(executable.map((a) => a.kind)).toEqual(['sync-config']);
  });

  it('pushes nothing without --provision-secrets, and SAYS the capability exists', () => {
    // Off by default. The reason string has to name the flag: an operator who
    // reads only "recreate manually" concludes there is no supported path, which
    // is how a master key got hand-exported across the fleet (RUSH-1968).
    const plan = diffFleet(desired, converged, {
      targetCliVersion: CLI, sourceAuth: srcAuth(['codex']), secretsBundles: ['attio'],
    });
    expect(plan.actions.filter((a) => a.kind === 'push-secret')).toEqual([]);
    const need = plan.actions.find((a) => a.kind === 'needs-secret');
    expect(need?.detail).toContain('--provision-secrets');
  });

  it('pushes when the flag is set AND the host key is pinned', () => {
    const plan = diffFleet(desired, converged, {
      targetCliVersion: CLI,
      sourceAuth: srcAuth(['codex']),
      secretsBundles: ['attio'],
      provisionSecrets: true,
      isHostPinned: () => true,
    });
    const push = plan.actions.filter((a) => a.kind === 'push-secret');
    expect(push).toHaveLength(1);
    expect(push[0].bundle).toBe('attio');
    // A push IS executable, unlike the needs-* reminders.
    expect(plan.devices[0].secretsNeeded).toEqual([]);
  });

  it('refuses an UNPINNED host even with the flag — credential values need a pinned key', () => {
    // Same bar as `exec --copy-creds` (EXEC-34).
    const plan = diffFleet(desired, converged, {
      targetCliVersion: CLI,
      sourceAuth: srcAuth(['codex']),
      secretsBundles: ['attio'],
      provisionSecrets: true,
      isHostPinned: () => false,
    });
    expect(plan.actions.filter((a) => a.kind === 'push-secret')).toEqual([]);
    expect(plan.actions.find((a) => a.kind === 'needs-secret')?.detail).toContain('host key not pinned');
  });

  it('treats a MISSING pin check as unpinned — the gate fails closed', () => {
    const plan = diffFleet(desired, converged, {
      targetCliVersion: CLI, sourceAuth: srcAuth(['codex']), secretsBundles: ['attio'], provisionSecrets: true,
    });
    expect(plan.actions.filter((a) => a.kind === 'push-secret')).toEqual([]);
  });

  it('skips a bundle the device already has, and --force overrides', () => {
    // Without this every apply re-resolves the bundle, and a resolve can prompt
    // for Touch ID — a converged fleet would nag on every run.
    const withBundle = new Map<string, DeviceProbe>([
      ['s1', { ...converged.get('s1')!, remoteBundles: { attio: '2026-08-01T00:00:00Z' } }],
    ]);
    const base = {
      targetCliVersion: CLI, sourceAuth: srcAuth(['codex']),
      secretsBundles: ['attio'], provisionSecrets: true, isHostPinned: () => true,
    };
    const skipped = diffFleet(desired, withBundle, base);
    expect(skipped.actions.filter((a) => a.kind === 'push-secret')).toEqual([]);
    expect(skipped.actions.find((a) => a.kind === 'needs-secret')?.detail).toContain('already present');

    const forced = diffFleet(desired, withBundle, { ...base, forceSecrets: true });
    expect(forced.actions.filter((a) => a.kind === 'push-secret')).toHaveLength(1);
  });

  it('does NOT skip a prototype-named bundle the device lacks', () => {
    // `bundle in remoteBundles` returned true for 'toString' against an EMPTY
    // listing, so that bundle was silently never provisioned. The gate uses an
    // own-property check now.
    const emptyListing = new Map<string, DeviceProbe>([
      ['s1', { ...converged.get('s1')!, remoteBundles: parseRemoteBundles('[]') }],
    ]);
    const plan = diffFleet(desired, emptyListing, {
      targetCliVersion: CLI,
      sourceAuth: srcAuth(['codex']),
      secretsBundles: ['toString'],
      provisionSecrets: true,
      isHostPinned: () => true,
    });
    expect(plan.actions.filter((a) => a.kind === 'push-secret').map((a) => a.bundle)).toEqual(['toString']);
  });

  it('does NOT skip a prototype-named bundle when remoteBundles is a plain object', () => {
    // Defence in depth: parseRemoteBundles returns a null-prototype map where `in` is safe, but
    // `remoteBundles` is a plain field any caller can fill, and a `{}` literal inherits toString.
    // Under `in` this device would be judged already provisioned and skipped.
    const plainLiteral = new Map<string, DeviceProbe>([
      ['s1', { ...converged.get('s1')!, remoteBundles: { somethingElse: 't' } }],
    ]);
    const plan = diffFleet(desired, plainLiteral, {
      targetCliVersion: CLI,
      sourceAuth: srcAuth(['codex']),
      secretsBundles: ['toString'],
      provisionSecrets: true,
      isHostPinned: () => true,
    });
    expect(plan.actions.filter((a) => a.kind === 'push-secret').map((a) => a.bundle)).toEqual(['toString']);
  });

  it('picks file on linux and keychain on macos — the unshared-key default', () => {
    // A headless Linux box has no keychain, and its file store auto-provisions
    // its OWN machine-local key. That per-box key is the alternative to the
    // fleet-wide shared secret RUSH-1968 is about.
    const probe = (platform: string): DeviceProbe =>
      ({ device: 's1', reachable: true, platform, cliVersion: CLI, installedAgents: ['codex'] });
    const ctx = { targetCliVersion: CLI, sourceAuth: srcAuth(['codex']), secretsBundles: ['attio'], provisionSecrets: true, isHostPinned: () => true };
    expect(decideSecretPush('attio', desired[0], probe('linux'), ctx).backend).toBe('file');
    expect(decideSecretPush('attio', desired[0], probe('macos'), ctx).backend).toBe('keychain');
    expect(decideSecretPush('attio', desired[0], probe('windows'), ctx).backend).toBe('keychain');
  });

  it('the reserved auth bundle is always file-backed and skips --provision-secrets', () => {
    const probe = (platform: string): DeviceProbe =>
      ({ device: 's1', reachable: true, platform, cliVersion: CLI, installedAgents: ['codex'] });
    const ctx = { targetCliVersion: CLI, sourceAuth: srcAuth(['codex']), secretsBundles: ['auth'], isHostPinned: () => true };
    expect(decideSecretPush('auth', desired[0], probe('macos'), ctx)).toEqual({
      push: true, backend: 'file', reason: '',
    });
    expect(decideSecretPush('auth', desired[0], probe('linux'), ctx).backend).toBe('file');
    expect(decideSecretPush('attio', desired[0], probe('macos'), ctx).push).toBe(false);
  });

  it('emits nothing for secrets when the profile declares no bundles', () => {
    const plan = diffFleet(desired, converged, { targetCliVersion: CLI, sourceAuth: srcAuth(['codex']) });
    expect(plan.actions.filter((a) => a.kind === 'needs-secret')).toEqual([]);
    expect(plan.devices[0].secretsNeeded).toEqual([]);
  });

  it('does not surface secrets on an unreachable device', () => {
    const offline = new Map<string, DeviceProbe>([
      ['s1', { device: 's1', reachable: false, installedAgents: [] }],
    ]);
    const plan = diffFleet(desired, offline, {
      targetCliVersion: CLI,
      sourceAuth: srcAuth(['codex']),
      secretsBundles: ['attio'],
    });
    expect(plan.devices[0].secretsNeeded).toEqual([]);
  });
});

describe('pinnedVersion', () => {
  it('returns the explicit version', () => {
    expect(pinnedVersion('claude@2.1.170')).toBe('2.1.170');
  });
  it('returns undefined for id-level / label specs', () => {
    expect(pinnedVersion('claude')).toBeUndefined();
    expect(pinnedVersion('claude@latest')).toBeUndefined();
    expect(pinnedVersion('claude@oldest')).toBeUndefined();
    expect(pinnedVersion('claude@all')).toBeUndefined();
  });
});

describe('rosterNeedsVersions', () => {
  it('is true when any device pins a version', () => {
    expect(rosterNeedsVersions([
      { device: 's0', agents: ['claude@latest'], sync: [], login: 'skip' },
      { device: 's1', agents: ['claude@2.1.170'], sync: [], login: 'skip' },
    ])).toBe(true);
  });
  it('is false for a purely id-level roster', () => {
    expect(rosterNeedsVersions([
      { device: 's0', agents: ['claude', 'codex@latest'], sync: [], login: 'skip' },
    ])).toBe(false);
  });
});

describe('expandAllSpecs', () => {
  const versionsOf = (id: string) => (id === 'claude' ? ['2.1.170', '2.1.207'] : []);
  it('expands @all into one pinned spec per source version', () => {
    expect(expandAllSpecs(['claude@all'], versionsOf)).toEqual(['claude@2.1.170', 'claude@2.1.207']);
  });
  it('passes non-@all specs through and de-dups', () => {
    expect(expandAllSpecs(['claude@all', 'claude@2.1.207', 'codex@latest'], versionsOf))
      .toEqual(['claude@2.1.170', 'claude@2.1.207', 'codex@latest']);
  });
  it('throws when @all names an agent with no installed versions', () => {
    expect(() => expandAllSpecs(['codex@all'], versionsOf)).toThrow(/no codex versions installed/);
  });
});

describe('parseInstalledVersions', () => {
  it('maps agent id -> versions from the view --json array', () => {
    const json = JSON.stringify([
      { agent: 'claude', versions: [{ version: '2.1.170' }, { version: '2.1.207' }], profiles: [] },
      { agent: 'codex', versions: [{ version: '0.146.0' }], profiles: [] },
    ]);
    expect(parseInstalledVersions(json)).toEqual({ claude: ['2.1.170', '2.1.207'], codex: ['0.146.0'] });
  });
  it('returns undefined on malformed output', () => {
    expect(parseInstalledVersions('not json')).toBeUndefined();
    expect(parseInstalledVersions('{"not":"an array"}')).toBeUndefined();
  });
});

describe('diffFleet — version-aware add-agent', () => {
  const twoVersions: DeviceDesired[] = [
    { device: 's0', agents: ['claude@2.1.170', 'claude@2.1.207'], sync: [], login: 'skip' },
  ];

  it('installs only the missing version when one is already present', () => {
    const probes = new Map<string, DeviceProbe>([
      ['s0', {
        device: 's0', reachable: true, platform: 'linux', cliVersion: CLI,
        installedAgents: ['claude'], installedVersions: { claude: ['2.1.207'] },
      }],
    ]);
    const plan = diffFleet(twoVersions, probes, { targetCliVersion: CLI, sourceAuth: srcAuth([]) });
    const adds = plan.actions.filter((a) => a.kind === 'add-agent');
    expect(adds).toHaveLength(1);
    expect(adds[0].spec).toBe('claude@2.1.170');
    expect(adds[0].detail).toBe('install claude@2.1.170');
  });

  it('installs every version when the agent id is present but no versions match', () => {
    const probes = new Map<string, DeviceProbe>([
      ['s0', {
        device: 's0', reachable: true, platform: 'linux', cliVersion: CLI,
        installedAgents: ['claude'], installedVersions: { claude: ['2.1.100'] },
      }],
    ]);
    const plan = diffFleet(twoVersions, probes, { targetCliVersion: CLI, sourceAuth: srcAuth([]) });
    expect(plan.actions.filter((a) => a.kind === 'add-agent').map((a) => a.spec))
      .toEqual(['claude@2.1.170', 'claude@2.1.207']);
  });

  it('nothing to add when both versions are already installed', () => {
    const probes = new Map<string, DeviceProbe>([
      ['s0', {
        device: 's0', reachable: true, platform: 'linux', cliVersion: CLI,
        installedAgents: ['claude'], installedVersions: { claude: ['2.1.170', '2.1.207'] },
      }],
    ]);
    const plan = diffFleet(twoVersions, probes, { targetCliVersion: CLI, sourceAuth: srcAuth([]) });
    expect(plan.actions.filter((a) => a.kind === 'add-agent')).toHaveLength(0);
  });

  it('a version-pinned spec installs when the probe has no version info (fallback)', () => {
    const probes = new Map<string, DeviceProbe>([
      ['s0', { device: 's0', reachable: true, platform: 'linux', cliVersion: CLI, installedAgents: ['claude'] }],
    ]);
    const plan = diffFleet(twoVersions, probes, { targetCliVersion: CLI, sourceAuth: srcAuth([]) });
    expect(plan.actions.filter((a) => a.kind === 'add-agent')).toHaveLength(2);
  });

  it('surfaces a needs-login once per id even when @all names claude many times (never a push)', () => {
    const roster: DeviceDesired[] = [
      { device: 's0', agents: ['claude@2.1.170', 'claude@2.1.207'], sync: [], login: 'sync' },
    ];
    const probes = new Map<string, DeviceProbe>([
      ['s0', {
        device: 's0', reachable: true, platform: 'linux', cliVersion: CLI,
        installedAgents: ['claude'], installedVersions: { claude: ['2.1.170', '2.1.207'] },
      }],
    ]);
    const plan = diffFleet(roster, probes, { targetCliVersion: CLI, sourceAuth: srcAuth(['claude']) });
    expect(plan.actions.filter((a) => a.kind === 'needs-login')).toHaveLength(1);
  });
});

describe('parseRemoteBundles — a remote secrets listing, metadata only', () => {
  it('reads name -> updatedAt from the REAL payload shape', () => {
    // Verified against live `agents secrets list --json`: a bare array of rows
    // whose timestamp field is `updatedAt`. The first draft of this parser read
    // `updated_at` and would have recorded an empty timestamp for every bundle.
    const real = '[{"name":"claude-getrush","keys":1,"backend":"file","createdAt":"2026-08-02T10:12:09.610Z","updatedAt":"2026-08-03T01:02:03.000Z"}]';
    expect(parseRemoteBundles(real)).toEqual({ 'claude-getrush': '2026-08-03T01:02:03.000Z' });
  });

  it('also accepts snake_case from an older remote', () => {
    expect(parseRemoteBundles('[{"name":"attio","updated_at":"2026-08-01T00:00:00Z"}]'))
      .toEqual({ attio: '2026-08-01T00:00:00Z' });
  });

  it('reads the same from a { bundles: [...] } envelope', () => {
    expect(parseRemoteBundles('{"bundles":[{"name":"a"},{"name":"b","updated_at":"t"}]}'))
      .toEqual({ a: '', b: 't' });
  });

  it('degrades to {} on junk — unknown must mean PUSH, never skip', () => {
    // Returning a populated map on a parse failure would silently leave a device
    // unprovisioned, which is the worse of the two errors.
    for (const junk of ['', 'not json', 'null', '3', '{"bundles":"nope"}']) {
      expect(parseRemoteBundles(junk)).toEqual({});
    }
  });

  it('a name that collides with an Object prototype key is an OWN property', () => {
    // `{}` inherits toString/constructor/valueOf, and assigning `__proto__` on it
    // hits the prototype setter instead of creating a key. A null-prototype map
    // makes every remote-supplied name a plain own property.
    const out = parseRemoteBundles('[{"name":"toString"},{"name":"__proto__","updatedAt":"t"}]');
    expect(Object.prototype.hasOwnProperty.call(out, 'toString')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true);
    expect(out['__proto__']).toBe('t');
  });

  it('an EMPTY listing claims nothing — not even inherited names', () => {
    // The bug this closes: `'toString' in {}` is true, so a bundle named
    // toString read as already-present on a device that has nothing.
    const empty = parseRemoteBundles('[]');
    for (const name of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
      expect(Object.prototype.hasOwnProperty.call(empty, name)).toBe(false);
      expect(name in empty).toBe(false);
    }
  });

  it('ignores rows with no usable name', () => {
    expect(parseRemoteBundles('[null,"x",{"nope":1},{"name":7},{"name":"ok"}]')).toEqual({ ok: '' });
  });
});
