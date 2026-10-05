
import type { HostEntry } from '../types.js';

export type HostProviderId = 'local' | 'devices';

export type HostStatus = 'online' | 'offline' | 'unknown';

export interface Host extends HostEntry {
  name: string;
  provider: HostProviderId;
  enrolled?: boolean;
  status?: HostStatus;
  dispatchable?: boolean;
}

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
  directory: boolean;
  mutate: boolean;
  presence: boolean;
  relay: boolean;
  lease: boolean;
}

export interface HostProvider {
  id: HostProviderId;
  capabilities(): HostProviderCapabilities;
  list(): Promise<Host[]>;
  resolve(name: string): Promise<Host | null>;
  register?(spec: Host): Promise<Host>;
  remove?(name: string): Promise<void>;
  presence?(name: string): Promise<HostStatus>;
}

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
