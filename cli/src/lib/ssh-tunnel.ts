/**
 * ssh-tunnel.ts — the generic `ssh -L localPort:127.0.0.1:remotePort -N`
 * port-forward, plus the fleet-device resolution that names its far end.
 *
 * WHY IT LIVES HERE. These primitives used to sit in `lib/computer/ssh-tunnel.ts`
 * alongside the Windows computer-helper provisioning, because `agents computer
 * --device` was their second caller after the browser CDP driver. The computer
 * engine has since moved to the standalone `computer` CLI (PHNX-4075), so a
 * generic tunnel parked in a deleted subsystem's directory would have gone with
 * it and taken `agents browser`'s remote path down. It is fleet plumbing — the
 * devices registry, the hardened ssh baseline, a local loopback port — and
 * belongs in the fleet layer, not under a feature.
 *
 * Both remaining callers are thin:
 *   - `browser/drivers/ssh.ts` holds a foreground tunnel for one CDP session.
 *   - `commands/computer.ts` opens a DETACHED tunnel for `--device` and hands
 *     the resulting loopback endpoint to the standalone engine in its context
 *     (`lib/computer/context.ts`). Fleet resolution stays on this side of the
 *     seam; the engine only ever sees `127.0.0.1:<port>`.
 */

import { spawn, type ChildProcess } from 'child_process';
import * as net from 'net';
import { SSH_OPTS, assertValidSshTarget } from './ssh-exec.js';
import { backgroundSpawnOptions } from './platform/process.js';
import { getDevice, type DeviceProfile } from './devices/registry.js';
import { deviceIdentityArgs, sshTargetFor } from './devices/connect.js';
import { hostNameFor } from './devices/ssh-config.js';

export interface StartTunnelOptions {
  /**
   * Detach the tunnel so it OUTLIVES this CLI process. Used by
   * `agents computer start --device` — the tunnel must persist across separate
   * verb invocations (`apps`, `click`, …) until `stop --device` tears it down.
   * The browser driver leaves this false: it holds the tunnel for the lifetime
   * of one CDP session and kills it on cleanup.
   */
  detached?: boolean;
  extraSshArgs?: string[];
}

/** Build the ssh argv (after the `ssh` program name) for an `-L` tunnel. Pure.
 *
 * Composes the shared hardened baseline (`SSH_OPTS`) rather than re-listing it,
 * so the tunnel inherits the same options — crucially the keepalive, which lets
 * a dropped `-N` tunnel exit instead of lingering as a zombie on the laptop. */
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

/**
 * Spawn `ssh -L localPort:127.0.0.1:remotePort -N user@host`.
 *
 * Foreground (default): stderr is captured so a tunnel that dies inside 500ms
 * rejects with the ssh error — the browser driver's original contract. Detached
 * mode ignores stdio and `unref`s the child so the parent can exit while the
 * tunnel lives; liveness is then confirmed by the caller probing the service.
 */
export function startSSHTunnel(
  user: string,
  host: string,
  localPort: number,
  remotePort: number,
  opts: StartTunnelOptions = {},
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    // `user`/`host` can originate from a browser ssh:// profile or a device
    // record. buildTunnelArgs places `${user}@${host}` before `-N`/SSH_OPTS, so
    // a `-`-leading user would be parsed as an ssh option flag (option
    // injection). Validate at the spawn sink so every caller is covered; reject
    // (rather than throw synchronously) to keep the Promise contract.
    try {
      assertValidSshTarget(`${user}@${host}`);
    } catch (err) {
      reject(err as Error);
      return;
    }
    const args = buildTunnelArgs(user, host, localPort, remotePort, opts.extraSshArgs);

    const tunnel = spawn('ssh', args, {
      stdio: opts.detached ? 'ignore' : ['ignore', 'ignore', 'pipe'],
      ...(opts.detached ? backgroundSpawnOptions() : { detached: false, windowsHide: true }),
    });

    let stderr = '';
    tunnel.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    tunnel.on('error', (err) => {
      reject(new Error(`SSH tunnel failed: ${err.message}`));
    });

    setTimeout(() => {
      if (tunnel.killed) {
        reject(new Error(`SSH tunnel died: ${stderr}`));
      } else {
        // Let the CLI exit without waiting on a persistent tunnel.
        if (opts.detached) tunnel.unref();
        resolve(tunnel);
      }
    }, 500);
  });
}

/** Reserve a free local TCP port by binding :0 and reading the assigned port. */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('could not reserve a local port'))));
    });
  });
}

/** One registered device, resolved to everything an ssh invocation needs. */
export interface ResolvedRemoteDevice {
  device: DeviceProfile;
  target: string;
  user: string;
  host: string;
  /** Per-device identity flags (`-i <key> -o IdentitiesOnly=yes`), possibly empty. */
  identityArgs: string[];
}

/**
 * Resolve a registered device to its ssh pieces, or throw a clear error.
 *
 * `expectPlatform` is how a caller keeps a platform requirement it used to
 * hard-code: `agents computer --device` drives the Windows helper daemon, so it
 * passes `'windows'` and gets the same refusal as before. Callers with no
 * platform requirement (the browser driver) omit it. The gate is a parameter
 * rather than a baked-in check so this module stays fleet-generic — a
 * hard-coded `windows` here would be a feature rule in shared plumbing.
 */
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
