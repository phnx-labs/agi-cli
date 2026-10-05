
import { loadDevices, getDevice, type DeviceProfile } from '../../devices/registry.js';
import { resolveDeviceProfile } from '../../devices/resolve-profile.js';
import type { Host, HostProvider, HostProviderCapabilities, HostStatus } from '../types.js';
import { DeviceOffloadUnsupportedError } from '../types.js';

function statusOf(device: DeviceProfile): HostStatus {
  if (!device.tailscale) return 'unknown';
  return device.tailscale.online ? 'online' : 'offline';
}

function deviceToPoolHost(rawDevice: DeviceProfile): Host | null {
  // Password-auth devices remain visible but are never dispatchable in BatchMode.
  const device = resolveDeviceProfile(rawDevice);
  const address = device.address.dnsName ?? device.address.ip;
  if (!address) return null;
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
    const device = resolveDeviceProfile(raw);
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
