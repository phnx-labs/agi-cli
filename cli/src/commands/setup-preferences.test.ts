/**
 * Pure chooser logic behind the setup preferences prompts (which machine you
 * sit at, which browser agents drive). The prompts themselves need a TTY; the
 * choice/default math is extracted pure so it is testable without one.
 */
import { describe, it, expect } from 'vitest';
import {
  defaultInteractiveHostChoice,
  macDeviceNames,
} from './setup-preferences.js';
import type { DeviceProfile } from '../lib/devices/registry.js';

function device(name: string, platform: DeviceProfile['platform']): DeviceProfile {
  return {
    name,
    platform,
    shell: platform === 'windows' ? 'powershell' : 'posix',
    address: { via: 'manual' },
    auth: { method: 'key' },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('macDeviceNames', () => {
  it('keeps only macOS devices, sorted by name', () => {
    const reg = {
      zion: device('zion', 'macos'),
      'win-mini': device('win-mini', 'windows'),
      'mac-mini': device('mac-mini', 'macos'),
      'yosemite-s0': device('yosemite-s0', 'linux'),
    };
    expect(macDeviceNames(reg)).toEqual(['mac-mini', 'zion']);
  });

  it('returns [] when no macOS device is registered', () => {
    expect(macDeviceNames({ 'win-mini': device('win-mini', 'windows') })).toEqual([]);
  });
});

describe('defaultInteractiveHostChoice', () => {
  it('is null with no candidates', () => {
    expect(defaultInteractiveHostChoice([], 'zion')).toBeNull();
  });

  it('highlights this machine when it is a candidate', () => {
    expect(defaultInteractiveHostChoice(['mac-mini', 'zion'], 'zion')).toBe('zion');
  });

  it('falls back to the first candidate when this machine is not one', () => {
    expect(defaultInteractiveHostChoice(['mac-mini', 'zion'], 'laptop')).toBe('mac-mini');
  });
});
