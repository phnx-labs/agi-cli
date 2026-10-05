/** Agent-host provider contract: a `HostProvider` answers "what are my hosts and how do I reach
 * them?". Shipped: `local` (ssh-config plus inline registry) and `devices` (Tailscale fleet);
 * `rush`/`crabbox` are fast-follows. Capability-gated so partial providers are first-class. */

import type { HostEntry } from '../types.js';

export type HostProviderId = 'local' | 'devices';

export type HostStatus = 'online' | 'offline' | 'unknown';

/** A host as seen at runtime: its persisted entry plus name/provider/status. */
export interface Host extends HostEntry {
  name: string;
  provider: HostProviderId;
  /** True when the host has an explicit overlay/inline entry in the registry. */
  enrolled?: boolean;
  status?: HostStatus;
  /** False when the host is listed but can't carry a `--device` run (today: password-auth
   * devices, since offload rides BatchMode=yes ssh); absent means dispatchable. Cap routing and
   * target pickers filter on this. */
  dispatchable?: boolean;
}

/** Thrown when a device resolves but authenticates with a password: offload runs over `sshExec`,
 * whose `SSH_OPTS` force `BatchMode=yes`, so only key/ssh-config auth works. Lives here so
 * providers can throw it without a cycle; registry.ts re-exports it. */
export class DeviceOffloadUnsupportedError extends Error {
  constructor(name: string) {
    super(
      `Device "${name}" uses password auth, which --device offload can't use yet ` +
        `(runs go over ssh with BatchMode=yes). Switch it to key auth with ` +
        `\`agents devices config ${name} ssh.auth key\`.`,
    );
    this.name = 'DeviceOffloadUnsupportedError';
  }
}

export interface HostProviderCapabilities {
  /** Can list/track hosts. */
  directory: boolean;
  /** Can add/remove hosts. */
  mutate: boolean;
  /** Reports online/offline without an explicit probe. */
  presence: boolean;
  /** Can dispatch a command without an SSH address (its own relay). */
  relay: boolean;
  /** Can provision new hosts. */
  lease: boolean;
}

export interface HostProvider {
  id: HostProviderId;
  capabilities(): HostProviderCapabilities;
  /** Every host this provider knows about. */
  list(): Promise<Host[]>;
  /** Resolve one host by name, or null if unknown to this provider. */
  resolve(name: string): Promise<Host | null>;
  /** Persist a host (mutate-capable providers only). */
  register?(spec: Host): Promise<Host>;
  /** Remove a host (mutate-capable providers only). */
  remove?(name: string): Promise<void>;
  /** Presence without an explicit probe (presence-capable providers only). */
  presence?(name: string): Promise<HostStatus>;
}

/** The ssh target for a host: the bare name for ssh-config hosts (ssh resolves
 * HostName/User/Port/Identity), else `user@address` (or `address`). */
export function sshTargetFor(host: Host): string {
  if (host.source === 'ssh-config') return host.name;
  if (!host.address) {
    throw new Error(`Host "${host.name}" is inline but has no address.`);
  }
  return host.user ? `${host.user}@${host.address}` : host.address;
}

export function hostIdentityArgs(host: Host): string[] {
  return host.identityFile ? ['-i', host.identityFile, '-o', 'IdentitiesOnly=yes'] : [];
}
