
import { loadDevicesSync } from '../devices/registry.js';
import { readDeviceConfigValues } from '../device-config.js';
import { readMeta } from '../state.js';
import { unionDeviceHosts } from '../devices/device-docs.js';

export function resolveRemoteOsSync(name: string): string | undefined {
  try {
    const configured = readDeviceConfigValues(name).platform;
    if (typeof configured === 'string' && configured !== 'unknown') return configured;
    const platform = loadDevicesSync()[name]?.platform;
    if (platform && platform !== 'unknown') return platform;
  } catch {
  }
  return ({ ...readMeta().hosts, ...unionDeviceHosts() }[name])?.os;
}
