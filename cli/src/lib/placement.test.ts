import { describe, it, expect } from 'vitest';

import {
  parseWhereSpec,
  placementFromRunFlags,
  expandPlacementToRunFlags,
  placementFromHostStrategy,
  formatPlacement,
  PlacementError,
  hostFamilyTarget,
} from './placement.js';

describe('parseWhereSpec', () => {
  it('parses reserved kinds', () => {
    expect(parseWhereSpec('local')).toEqual({ kind: 'local', source: '--where' });
    expect(parseWhereSpec('AUTO')).toEqual({ kind: 'device', target: 'auto', source: '--where' });
    expect(parseWhereSpec('fleet')).toEqual({ kind: 'fleet', source: '--where' });
    expect(parseWhereSpec('cloud')).toEqual({ kind: 'cloud', source: '--where' });
    expect(parseWhereSpec('lease')).toEqual({ kind: 'lease', source: '--where' });
  });

  it('parses device/host targets and bare names', () => {
    expect(parseWhereSpec('device:yosemite-s0')).toEqual({
      kind: 'device',
      target: 'yosemite-s0',
      source: '--where',
    });
    expect(parseWhereSpec('host:mac-mini')).toEqual({
      kind: 'device',
      target: 'mac-mini',
      source: '--where',
    });
    expect(parseWhereSpec('yosemite-s0')).toEqual({
      kind: 'device',
      target: 'yosemite-s0',
      source: '--where',
    });
    expect(parseWhereSpec('device:auto')).toEqual({
      kind: 'device',
      target: 'auto',
      source: '--where',
    });
  });

  it('parses lease backends and rejects empty tails', () => {
    expect(parseWhereSpec('lease:hetzner')).toEqual({
      kind: 'lease',
      target: 'hetzner',
      source: '--where',
    });
    expect(() => parseWhereSpec('device:')).toThrow(PlacementError);
    expect(() => parseWhereSpec('')).toThrow(PlacementError);
    expect(() => parseWhereSpec('device')).toThrow(PlacementError);
  });
});

describe('placementFromRunFlags', () => {
  it('defaults to local', () => {
    expect(placementFromRunFlags({})).toEqual({ kind: 'local', source: 'default' });
    expect(placementFromRunFlags({ local: true })).toEqual({ kind: 'local', source: '--local' });
  });

  it('maps host family and lease', () => {
    expect(placementFromRunFlags({ host: 'zion' })).toEqual({
      kind: 'device',
      target: 'zion',
      source: '--device',
    });
    expect(placementFromRunFlags({ device: 'auto' })).toEqual({
      kind: 'device',
      target: 'auto',
      source: '--device',
    });
    expect(placementFromRunFlags({ lease: true })).toEqual({
      kind: 'lease',
      target: undefined,
      source: '--lease',
    });
    expect(placementFromRunFlags({ lease: 'hetzner' })).toEqual({
      kind: 'lease',
      target: 'hetzner',
      source: '--lease',
    });
    expect(placementFromRunFlags({ box: 'warm-1' })).toEqual({
      kind: 'lease',
      target: 'warm-1',
      source: '--box',
    });
  });

  it('maps --cloud to a cloud placement, carrying --provider as the target', () => {
    expect(placementFromRunFlags({ cloud: true })).toEqual({
      kind: 'cloud',
      target: undefined,
      source: '--cloud',
    });
    expect(placementFromRunFlags({ cloud: true, provider: 'codex' })).toEqual({
      kind: 'cloud',
      target: 'codex',
      source: '--cloud',
    });
  });

  it('accepts --where alone and rejects mixes', () => {
    expect(placementFromRunFlags({ where: 'auto' })).toEqual({
      kind: 'device',
      target: 'auto',
      source: '--where',
    });
    expect(() => placementFromRunFlags({ where: 'local', host: 'zion' })).toThrow(/Conflicting placement/);
    expect(() => placementFromRunFlags({ local: true, host: 'zion' })).toThrow(/Conflicting placement/);
    expect(() => placementFromRunFlags({ local: true, where: 'auto' })).toThrow(/Conflicting placement/);
    expect(() => placementFromRunFlags({ local: true, cloud: true })).toThrow(/Conflicting placement/);
    expect(() => placementFromRunFlags({ where: 'lease', lease: true })).toThrow(/Conflicting placement/);
    expect(() => placementFromRunFlags({ host: 'a', lease: true })).toThrow(/Conflicting placement/);
    // Placements are mutually exclusive by definition: --cloud with any
    // machine placement (--device family, --lease, --box) is an error.
    expect(() => placementFromRunFlags({ cloud: true, host: 'zion' })).toThrow(/Conflicting placement/);
    expect(() => placementFromRunFlags({ cloud: true, lease: true })).toThrow(/Conflicting placement/);
    expect(() => placementFromRunFlags({ cloud: true, box: 'warm-1' })).toThrow(/Conflicting placement/);
    expect(() => placementFromRunFlags({ cloud: true, where: 'auto' })).toThrow(/Conflicting placement/);
  });
});

describe('expandPlacementToRunFlags', () => {
  it('expands device and lease for run dispatch', () => {
    expect(expandPlacementToRunFlags(parseWhereSpec('device:yosemite-s0'))).toEqual({
      host: 'yosemite-s0',
    });
    expect(expandPlacementToRunFlags(parseWhereSpec('auto'))).toEqual({ host: 'auto' });
    expect(expandPlacementToRunFlags(parseWhereSpec('lease'))).toEqual({ lease: true });
    expect(expandPlacementToRunFlags(parseWhereSpec('lease:hetzner'))).toEqual({ lease: 'hetzner' });
    expect(expandPlacementToRunFlags(parseWhereSpec('local'))).toEqual({});
  });

  it('expands --where cloud[:provider] into the --cloud flag form', () => {
    expect(expandPlacementToRunFlags(parseWhereSpec('cloud'))).toEqual({ cloud: true });
    expect(expandPlacementToRunFlags(parseWhereSpec('cloud:codex'))).toEqual({
      cloud: true,
      provider: 'codex',
    });
  });

  it('rejects fleet on bare run', () => {
    expect(() => expandPlacementToRunFlags(parseWhereSpec('fleet'))).toThrow(/routines/);
  });
});

describe('placementFromHostStrategy / format / hostFamily', () => {
  it('maps routine strategies', () => {
    expect(placementFromHostStrategy('local')).toEqual({ kind: 'local', source: 'hostStrategy:local' });
    expect(placementFromHostStrategy('host', 'mac-mini')).toEqual({
      kind: 'device',
      target: 'mac-mini',
      source: 'hostStrategy:host',
    });
    expect(placementFromHostStrategy('fleet').kind).toBe('fleet');
    expect(placementFromHostStrategy('cloud').kind).toBe('cloud');
  });

  it('formats compactly', () => {
    expect(formatPlacement({ kind: 'local', source: 'x' })).toBe('local');
    expect(formatPlacement({ kind: 'device', target: 'auto', source: 'x' })).toBe('device:auto');
    expect(formatPlacement({ kind: 'lease', source: 'x' })).toBe('lease');
  });

  it('picks first host-family value', () => {
    expect(hostFamilyTarget({ device: 'a', host: 'b' })).toBe('b');
    expect(hostFamilyTarget({ on: 'c' })).toBe('c');
    expect(hostFamilyTarget({})).toBeUndefined();
  });
});
