
import { spawn, type ChildProcess } from 'child_process';
import { SSH_OPTS, assertValidSshTarget } from './ssh-exec.js';
import { getDevice, type DeviceProfile } from './devices/registry.js';
import { deviceIdentityArgs, sshTargetFor } from './devices/connect.js';
import { hostNameFor } from './devices/ssh-config.js';

interface StartTunnelOptions {
  extraSshArgs?: string[];
}

export function buildTunnelArgs(
  user: string,
  host: string,
  localPort: number,
  remotePort: number,
  extraSshArgs: string[] = [],
): string[] {
  return [
    '-L',
    `${localPort}:127.0.0.1:${remotePort}`,
    `${user}@${host}`,
    '-N',
    ...extraSshArgs,
    ...SSH_OPTS,
  ];
}

export function startSSHTunnel(
  user: string,
  host: string,
  localPort: number,
  remotePort: number,
  opts: StartTunnelOptions = {},
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    try {
      assertValidSshTarget(`${user}@${host}`);
    } catch (err) {
      reject(err as Error);
      return;
    }
    const args = buildTunnelArgs(user, host, localPort, remotePort, opts.extraSshArgs);

    const tunnel = spawn('ssh', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: false,
      windowsHide: true,
    });

    let stderr = '';
    tunnel.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    tunnel.on('error', (err) => {
      reject(new Error(`SSH tunnel failed: ${err.message}`));
    });

    setTimeout(() => {
      if (tunnel.killed) reject(new Error(`SSH tunnel died: ${stderr}`));
      else resolve(tunnel);
    }, 500);
  });
}

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
