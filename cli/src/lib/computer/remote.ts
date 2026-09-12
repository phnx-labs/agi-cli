/**
 * remote.ts — `agents computer --device <name>`: fleet resolution and the
 * loopback tunnel that puts a remote helper daemon within the engine's reach.
 *
 * THE SEAM. agents-cli owns the fleet: the devices registry, ssh identity, the
 * hardened ssh baseline, and therefore the `ssh -L` tunnel. The standalone
 * `computer` engine owns the helper and its RPC. So `--device <name>` resolves
 * here, the tunnel opens here, its lifetime is recorded here — and the engine is
 * handed one thing it can understand without knowing the fleet exists:
 * `127.0.0.1:<localPort>`.
 *
 * That split is what keeps the extraction honest. If the engine resolved device
 * names it would need the registry, Tailscale addressing, and per-device ssh
 * keys — i.e. it would need to be agents-cli. If agents-cli kept the RPC it
 * would need the helper protocol back. Neither happens: one side names the
 * endpoint, the other speaks to it.
 *
 * The auth token is deliberately NOT recorded here. It is minted when the engine
 * provisions the remote helper (`computer setup --device`) and read back by the
 * engine when it connects; agents-cli never holds it. Before PHNX-4075 this file's
 * predecessor stored the token because the same process did both jobs — keeping
 * that would have left a live shared secret in a component that no longer has any
 * use for it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getCacheDir } from '../state.js';
import { startSSHTunnel, pickFreePort, resolveRemoteDevice } from '../ssh-tunnel.js';

/** Loopback TCP port the remote helper daemon binds. Stable so setup/start pair up. */
export const REMOTE_HELPER_PORT = 8765;

/** Persisted per-device tunnel state so verbs can reconnect after `start --device`. */
export interface RemoteTunnelState {
  device: string;
  target: string;
  localPort: number;
  remotePort: number;
  tunnelPid: number;
  startedAt: number;
}

function remoteStateDir(): string {
  return path.join(getCacheDir(), 'computer', 'remote');
}

/** State file path for a device. Device names are ssh-alias safe (validated). */
export function remoteStatePath(device: string): string {
  return path.join(remoteStateDir(), `${device}.json`);
}

export function readRemoteState(device: string): RemoteTunnelState | null {
  try {
    return JSON.parse(fs.readFileSync(remoteStatePath(device), 'utf-8')) as RemoteTunnelState;
  } catch {
    return null;
  }
}

export function writeRemoteState(state: RemoteTunnelState): void {
  const dir = remoteStateDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(remoteStatePath(state.device), JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function clearRemoteState(device: string): void {
  try {
    fs.unlinkSync(remoteStatePath(device));
  } catch {
    /* already gone */
  }
}

/**
 * Is a recorded tunnel still alive? `process.kill(pid, 0)` is the liveness
 * probe — it signals nothing and throws ESRCH when the pid is gone. A state
 * file outliving its ssh process is the common case (reboot, network drop), and
 * reporting that stale file as a live tunnel is how a verb ends up connecting
 * to a dead port and timing out instead of saying "run start --device".
 */
export function isTunnelAlive(state: RemoteTunnelState | null): boolean {
  if (!state?.tunnelPid) return false;
  try {
    process.kill(state.tunnelPid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * `start --device`: resolve the device, open a detached `ssh -L` tunnel to its
 * helper daemon, and record it so later verbs reconnect without re-tunnelling.
 *
 * Liveness is NOT probed here. Proving the daemon answers means speaking its RPC,
 * which is the engine's job now — `commands/computer.ts` runs the engine's own
 * `status` through the fresh endpoint and calls `rollback()` if it refuses. The
 * alternative (agents-cli keeping a probe client) would have meant keeping the
 * whole protocol for one call.
 */
export async function startRemoteTunnel(name: string): Promise<{
  state: RemoteTunnelState;
  rollback: () => void;
}> {
  const { device, target, user, host, identityArgs } = await resolveRemoteDevice(name, {
    expectPlatform: 'windows',
    forWhat: '`agents computer --device` drives the Windows computer-helper daemon, so it',
  });
  void device;
  const remotePort = REMOTE_HELPER_PORT;
  const localPort = await pickFreePort();

  const tunnel = await startSSHTunnel(user, host, localPort, remotePort, {
    detached: true,
    extraSshArgs: identityArgs,
  });
  const tunnelPid = tunnel.pid ?? 0;

  const state: RemoteTunnelState = {
    device: name,
    target,
    localPort,
    remotePort,
    tunnelPid,
    startedAt: Date.now(),
  };
  writeRemoteState(state);

  return {
    state,
    rollback: () => {
      try {
        if (tunnelPid) process.kill(tunnelPid);
      } catch {
        /* already gone */
      }
      clearRemoteState(name);
    },
  };
}

/**
 * `stop --device`: kill the local tunnel and clear the persisted state.
 *
 * Unregistering the remote scheduled task is the ENGINE's half of stop (it
 * registered it), and `commands/computer.ts` runs that first. This function is
 * the fleet half and must still succeed when the box is offline — otherwise a
 * dead remote would leave a zombie tunnel on the laptop forever.
 */
export function stopRemoteTunnel(name: string): { tunnelKilled: boolean } {
  const state = readRemoteState(name);
  let tunnelKilled = false;
  if (state?.tunnelPid) {
    try {
      process.kill(state.tunnelPid);
      tunnelKilled = true;
    } catch {
      /* already gone */
    }
  }
  clearRemoteState(name);
  return { tunnelKilled };
}

/**
 * Resolve a device name to the live loopback endpoint recorded for it, or fail
 * loud with the command that creates one. Returns null when the caller wants to
 * handle absence itself (`status --device` reports "no tunnel" rather than exiting).
 */
export function resolveDeviceEndpoint(name: string): { host: string; port: number } | null {
  const state = readRemoteState(name);
  if (!isTunnelAlive(state)) return null;
  return { host: '127.0.0.1', port: state!.localPort };
}
