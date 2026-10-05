/** Credential transport policy for a fleet host (PHNX-3989): whether a durable credential may
 * leave this device is agents fleet policy, so these guards live here and are passed into the
 * secrets transport. */
import { assertValidSshTarget } from '../ssh-exec.js';
import { resolveHost } from './registry.js';
import { sshTargetFor } from './types.js';
import { isHostPinned } from '../devices/known-hosts.js';

/** The host part of an ssh target (`user@host` -> `host`) for known_hosts matching. */
function hostKeyLookupName(target: string): string {
  return target.split('@').pop() ?? target;
}

/** Refuse durable credential transfer until the destination SSH key is pinned. */
export function assertCredentialTransportHostPinned(target: string, pinned = isHostPinned(hostKeyLookupName(target))): void {
  if (pinned) return;
  throw new Error(
    `Refusing to transfer provider credentials to '${target}' before its SSH host key is pinned. ` +
    `Connect once with 'agents ssh ${target}' and verify the host, then retry.`,
  );
}

/** Resolve a `--device` value to an ssh target for a credential-carrying operation; a miss is
 * validated as a raw target. */
export async function resolveHostSshTarget(nameOrAlias: string): Promise<string> {
  const host = await resolveHost(nameOrAlias);
  if (host) return sshTargetFor(host);
  assertValidSshTarget(nameOrAlias);
  return nameOrAlias;
}
