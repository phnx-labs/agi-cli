
import {
  shellForPlatform,
  type DeviceAuthMethod,
  type DevicePlatform,
  type DeviceProfile,
} from './registry.js';
import { readDeviceConfigValues } from '../device-config.js';

export function resolveDeviceProfile(device: DeviceProfile): DeviceProfile {
  // Operator config owns platform, user, and auth; shell is always re-derived from that platform.
  const config = readDeviceConfigValues(device.name);
  const platform = (config.platform as DevicePlatform | undefined) ?? device.platform;
  const method = (config.sshAuth as DeviceAuthMethod | undefined) ?? device.auth.method;
  const user = (config.sshUser as string | undefined) ?? device.user;
  const identityFile = (config.sshIdentityFile as string | undefined) ?? device.auth.identityFile;
  const bundle = (config.sshBundle as string | undefined) ?? device.auth.bundle;
  const bundleKey = (config.sshBundleKey as string | undefined) ?? device.auth.bundleKey;
  if (
    platform === device.platform &&
    method === device.auth.method &&
    user === device.user &&
    identityFile === device.auth.identityFile &&
    bundle === device.auth.bundle &&
    bundleKey === device.auth.bundleKey
  ) {
    return device;
  }
  return {
    ...device,
    platform,
    shell: shellForPlatform(platform),
    user,
    auth: { method, identityFile, bundle, bundleKey },
  };
}
