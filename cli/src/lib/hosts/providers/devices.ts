/** Devices host provider: bridges the devices registry into the host pool as dispatch targets
 * with capability routing. Password-auth devices are listed but `dispatchable: false`. It
 * registers after `local`, so an enrolled host shadows a same-name device. */

import { loadDevices, getDevice, type DeviceProfile } from '../../devices/registry.js';
import { resolveDeviceProfile } from '../../devices/resolve-profile.js';
import type { Host, HostProvider, HostProviderCapabilities, HostStatus } from '../types.js';
import { DeviceOffloadUnsupportedError } from '../types.js';

/** Tailscale's own presence bit, when the sync captured one. */
function statusOf(device: DeviceProfile): HostStatus {
  if (!device.tailscale) return 'unknown';
  return device.tailscale.online ? 'online' : 'offline';
}

/** Bridge a device profile into a `Host`, preferring the stable dnsName over ip; `source:
 * 'inline'` makes `sshTargetFor` emit `user@address`. Capability tags come from an enrolled
 * `Meta.hosts` overlay, which shadows this row by provider precedence. */
function deviceToPoolHost(rawDevice: DeviceProfile): Host | null {
  // Effective profile: central config (ssh.*/platform) overlays discovery.
  const device = resolveDeviceProfile(rawDevice);
  const address = device.address.dnsName ?? device.address.ip;
  if (!address) return null; // unreachable profile — nothing to dispatch to
  return {
    name: device.name,
    provider: 'devices',
    source: 'inline',
    address,
    user: device.user,
    identityFile: device.auth.identityFile,
    ...(device.platform !== 'unknown' ? { os: device.platform } : {}),
    enrolled: true,
    status: statusOf(device),
    dispatchable: device.auth.method !== 'password',
  };
}

export class DevicesHostProvider implements HostProvider {
  readonly id = 'devices' as const;

  capabilities(): HostProviderCapabilities {
    // mutate stays false: `agents devices sync/add/set` own the registry.
    return { directory: true, mutate: false, presence: true, relay: false, lease: false };
  }

  async list(): Promise<Host[]> {
    const devices = await loadDevices();
    const out: Host[] = [];
    for (const device of Object.values(devices)) {
      const host = deviceToPoolHost(device);
      if (host) out.push(host);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async resolve(name: string): Promise<Host | null> {
    const raw = await getDevice(name);
    if (!raw) return null;
    // Effective profile: central config (ssh.*/platform) overlays discovery —
    // the password-auth refusal and the dial shape both follow the config.
    const device = resolveDeviceProfile(raw);
    // Keep the long-standing typed refusal for password auth (BatchMode=yes
    // can't answer a prompt).
    if (device.auth.method === 'password') {
      throw new DeviceOffloadUnsupportedError(device.name);
    }
    const host = deviceToPoolHost(device);
    if (!host) {
      throw new Error(`Device "${device.name}" has no address (Tailscale DNS name or IP) to reach it by.`);
    }
    return host;
  }

  async presence(name: string): Promise<HostStatus> {
    const device = await getDevice(name);
    return device ? statusOf(device) : 'unknown';
  }
}
