/** ssh_config render correctness: the rendered include lets plain ssh/scp/rsync and `agents
 * sessions --device` resolve logical device names. */
import { describe, expect, it } from 'vitest';
import { renderSshConfig, hostNameFor } from './ssh-config.js';
import type { DeviceProfile, DeviceRegistry } from './registry.js';

function dev(over: Partial<DeviceProfile> & { name: string }): DeviceProfile {
  return {
    name: over.name,
    platform: over.platform ?? 'linux',
    shell: over.shell ?? 'posix',
    user: over.user,
    address: over.address ?? { via: 'tailscale', dnsName: `${over.name}.ts.net`, ip: '100.0.0.1' },
    auth: over.auth ?? { method: 'key' },
    createdAt: '2026-06-30T00:00:00Z',
    updatedAt: '2026-06-30T00:00:00Z',
  };
}

describe('renderSshConfig', () => {
  it('renders Host/HostName/User, prefers DNS, skips addressless, sorts stably', () => {
    const reg: DeviceRegistry = {
      // intentionally out of order to prove the render sorts
      zebra: dev({ name: 'zebra', user: 'z', address: { via: 'tailscale', dnsName: 'zebra.ts.net', ip: '100.0.0.9' } }),
      'win-mini': dev({ name: 'win-mini', platform: 'windows', shell: 'powershell', user: 'muqsit', auth: { method: 'key', identityFile: '/keys/win mini' }, address: { via: 'tailscale', dnsName: 'win-mini.ts.net', ip: '100.68.123.39' } }),
      noaddr: dev({ name: 'noaddr', address: { via: 'manual' } }), // must be skipped
      iponly: dev({ name: 'iponly', user: 'root', address: { via: 'manual', ip: '10.0.0.5' } }),
    };

    const out = renderSshConfig(reg);

    // Addressless device omitted entirely.
    expect(out).not.toContain('Host noaddr');

    // DNS preferred when present; IP used only when there's no DNS name.
    expect(out).toContain('Host win-mini\n    HostName win-mini.ts.net\n    User muqsit');
    expect(out).toContain('    IdentityFile /keys/win mini\n    IdentitiesOnly yes');
    expect(out).toContain('Host iponly\n    HostName 10.0.0.5\n    User root');

    // Stable alphabetical ordering: iponly < win-mini < zebra.
    const order = ['Host iponly', 'Host win-mini', 'Host zebra'].map((h) => out.indexOf(h));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i >= 0)).toBe(true);
  });
});

describe('hostNameFor', () => {
  it('prefers dnsName then falls back to ip', () => {
    expect(hostNameFor(dev({ name: 'a', address: { via: 'tailscale', dnsName: 'a.ts.net', ip: '1.2.3.4' } }))).toBe('a.ts.net');
    expect(hostNameFor(dev({ name: 'b', address: { via: 'manual', ip: '1.2.3.4' } }))).toBe('1.2.3.4');
    expect(hostNameFor(dev({ name: 'c', address: { via: 'manual' } }))).toBeUndefined();
  });
});
