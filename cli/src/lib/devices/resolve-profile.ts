/** The effective device profile: the registry's discovery record overlaid with operator config
 * (per-device `config:` over `fleet.defaults.config`). Config wins for ssh.* and `platform` so
 * `agents devices config` works from any box; unset keys fall back to the registry. Idempotent. */

import {
  shellForPlatform,
  type DeviceAuthMethod,
  type DevicePlatform,
  type DeviceProfile,
} from './registry.js';
import { readDeviceConfigValues } from '../device-config.js';

/** Overlay the central config's ssh.* / platform / user keys onto a registry profile. */
export function resolveDeviceProfile(device: DeviceProfile): DeviceProfile {
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
