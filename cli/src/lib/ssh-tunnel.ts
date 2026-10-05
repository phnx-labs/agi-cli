/** The generic `ssh -L` port-forward plus the fleet-device resolution naming its far end. It left
 * `lib/computer/ssh-tunnel.ts` when the computer engine became the standalone CLI (PHNX-4075), so
 * the browser's remote path would not go with it. */

import { spawn, type ChildProcess } from 'child_process';
import { SSH_OPTS, assertValidSshTarget } from './ssh-exec.js';
import { getDevice, type DeviceProfile } from './devices/registry.js';
import { deviceIdentityArgs, sshTargetFor } from './devices/connect.js';
import { hostNameFor } from './devices/ssh-config.js';

interface StartTunnelOptions {
  extraSshArgs?: string[];
}

/** Build the ssh argv for an `-L` tunnel. Pure. Composes the shared `SSH_OPTS` baseline so the
 * tunnel inherits keepalive, which lets a dropped `-N` tunnel exit instead of lingering as a
 * zombie. */
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

/** Spawn `ssh -L localPort:127.0.0.1:remotePort -N user@host`. stderr is captured so a tunnel dying
 * within 500ms rejects with the ssh error (the browser driver's original contract). The tunnel is
 * held by this process for the session. */
export function startSSHTunnel(
  user: string,
  host: string,
  localPort: number,
  remotePort: number,
  opts: StartTunnelOptions = {},
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    // `user`/`host` can come from a browser ssh:// profile or device record, and buildTunnelArgs
    // places `${user}@${host}` before `-N`/SSH_OPTS, so a `-`-leading user would parse as an ssh
    // flag (option injection). Validate at the spawn sink; reject, not throw.
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

/** One registered device, resolved to everything an ssh invocation needs. */
interface ResolvedRemoteDevice {
  device: DeviceProfile;
  target: string;
  user: string;
  host: string;
  /** Per-device identity flags (`-i <key> -o IdentitiesOnly=yes`), possibly empty. */
  identityArgs: string[];
}

/** Resolve a registered device to its ssh pieces, or throw a clear error. `expectPlatform` lets a
 * caller keep a platform requirement (`agents computer --device` passes `'windows'`); a parameter,
 * not a hard-coded check, so this stays fleet-generic. */
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
  const target = sshTargetFor(device); // validates address + injection guard
  const host = hostNameFor(device)!; // sshTargetFor already threw if absent
  const user = device.user || process.env.USER || 'Administrator';
  return { device, target, user, host, identityArgs: deviceIdentityArgs(device) };
}
