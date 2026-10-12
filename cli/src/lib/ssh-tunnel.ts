import { getDevice, type DeviceProfile } from './devices/registry.js';
import { deviceIdentityArgs, sshTargetFor } from './devices/connect.js';
import { hostNameFor } from './devices/ssh-config.js';

interface ResolvedRemoteDevice {
  device: DeviceProfile;
  target: string;
  user: string;
  host: string;
  identityArgs: string[];
}

export async function resolveRemoteDevice(
  name: string,
  opts: { expectPlatform?: DeviceProfile['platform']; forWhat?: string } = {},
): Promise<ResolvedRemoteDevice> {

  const device = await getDevice(name);
  if (!device) {
    throw new Error(`Unknown device '${name}'. Register it with \`agents devices add\` / \`agents devices sync\`, then retry.`);
  }
  if (opts.expectPlatform && device.platform !== opts.expectPlatform) {
    const what = opts.forWhat ?? `this command`;
    throw new Error(`Device '${name}' is ${device.platform}, not ${opts.expectPlatform}. ${what} needs a ${opts.expectPlatform} device.`);
  }
  const target = sshTargetFor(device);
  const host = hostNameFor(device)!;
  const user = device.user || process.env.USER || 'Administrator';
  return { device, target, user, host, identityArgs: deviceIdentityArgs(device) };
}
