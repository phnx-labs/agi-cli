import { describe, it, expect } from 'vitest';
import * as yaml from 'yaml';
import { captureFleet } from './capture.js';
import type { FleetManifest } from './types.js';

describe('captureFleet', () => {
  const inputs = {
    devices: ['mac-mini', 'yosemite-s0'],
    defaults: { agents: ['claude@latest', 'codex@latest'], sync: ['user'], login: 'sync' as const },
    agentsByDevice: { 'mac-mini': ['claude@latest', 'droid@latest'] },
    secretsBundles: ['ssh-keys', 'attio'],
    routines: ['review-open-prs', 'cycle-hygiene'],
  };

  it('serializes device names + desired state (no connection details)', () => {
    const m = captureFleet(undefined, inputs);
    expect(m.devices).not.toBe('all');
    const map = m.devices as Record<string, { agents?: string[] }>;
    expect(Object.keys(map).sort()).toEqual(['mac-mini', 'yosemite-s0']);
    expect(map['mac-mini'].agents).toEqual(['claude@latest', 'droid@latest']);
    expect(map['yosemite-s0'].agents).toBeUndefined();
    expect(m.defaults?.agents).toEqual(['claude@latest', 'codex@latest']);
    expect(m.secrets?.bundles).toEqual(['attio', 'ssh-keys']);
    expect(m.routines).toEqual(['cycle-hygiene', 'review-open-prs']);
  });

  it('PRIVACY: the serialized fleet: block carries no IP, username, host, or browser endpoint', () => {
    const m = captureFleet(undefined, inputs);
    const out = yaml.stringify({ fleet: m });
    expect(out).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(out).not.toMatch(/address:/);
    expect(out).not.toMatch(/\buser:/);
    expect(out).not.toMatch(/ssh:\/\//);
    const stripped = out.replace(/@latest/g, '').replace(/@\d[\w.-]*/g, '');
    expect(stripped).not.toMatch(/@/);
  });

  it('never records a browser: block (browser syncs via the central block, not fleet:)', () => {
    const m = captureFleet(undefined, inputs);
    expect((m as Record<string, unknown>).browser).toBeUndefined();
  });

  it('is additive: a hand-authored per-device override is preserved', () => {
    const prev: FleetManifest = {
      defaults: { agents: ['claude@latest'], sync: ['user'], login: 'sync' },
      devices: { 'mac-mini': { agents: ['gemini@latest'], login: 'skip' } },
    };
    const m = captureFleet(prev, inputs);
    const map = m.devices as Record<string, { agents?: string[]; login?: string }>;
    expect(map['mac-mini'].agents).toEqual(['gemini@latest']);
    expect(map['mac-mini'].login).toBe('skip');
    expect(map['yosemite-s0']).toBeDefined();
    expect(m.defaults?.agents).toEqual(['claude@latest']);
  });

  it('omits empty extras rather than writing empty keys', () => {
    const m = captureFleet(undefined, { devices: ['s0'], secretsBundles: [], routines: [] });
    expect(m.secrets).toBeUndefined();
    expect(m.routines).toBeUndefined();
  });

  it('keeps the config of a device missing from the captured roster', () => {
    // `fleet.devices.<name>.config` is the operator-config store, so a capture from a box that had
    // not seen a peer used to erase that peer's settings. Observed for real: capturing on
    // yosemite-s0 deleted zion's whole config block from the shared agents.yaml.
    const prev = {
      devices: {
        zion: { config: { browserRemoteControl: false, defaultBrowserProfile: 'comet-local' } },
        'mac-mini': { agents: ['claude@latest'] },
      },
    } as Parameters<typeof captureFleet>[0];

    const m = captureFleet(prev, { devices: ['yosemite-s0'] });
    const map = m.devices as Record<string, { agents?: string[]; config?: Record<string, unknown> }>;

    expect(map['yosemite-s0']).toBeDefined();
    expect(map['zion'].config).toEqual({
      browserRemoteControl: false,
      defaultBrowserProfile: 'comet-local',
    });
    expect(map['mac-mini']).toBeUndefined();
  });

  it('preserves portable device discovery decisions', () => {
    const prev: FleetManifest = {
      devices: {},
      discovery: { 'mac-mini': 'approved', 'old-laptop': 'ignored' },
    };

    const m = captureFleet(prev, { devices: ['yosemite-s0'] });

    expect(m.discovery).toEqual({ 'mac-mini': 'approved', 'old-laptop': 'ignored' });
  });

  it('never wipes fleet.ignored — dismissals are operator state, not live state', () => {
    const prev: FleetManifest = {
      devices: {},
      ignored: [{ name: 'old-laptop', ignoredAt: '2026-08-20T10:00:00.000Z', ignoredOn: 'zion' }],
    };

    const m = captureFleet(prev, { devices: ['yosemite-s0'] });

    expect(m.ignored).toEqual([{ name: 'old-laptop', ignoredAt: '2026-08-20T10:00:00.000Z', ignoredOn: 'zion' }]);
    prev.ignored![0].name = 'mutated';
    expect(m.ignored![0].name).toBe('old-laptop');
  });
});
