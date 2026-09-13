/**
 * Credential transport policy for a fleet host (agents-owned, PHNX-3989).
 *
 * Whether a durable credential may leave this device for a given host is
 * agents fleet policy, not a secrets-engine concern: it hangs off the managed
 * `known_hosts` pin and the hosts/devices registry. The standalone `secrets`
 * CLI only carries the bundle once agents-cli has decided the destination is
 * trustworthy, so these guards live here and are passed INTO the transport,
 * never re-implemented on the engine side.
 */
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

/**
 * Resolve a `--device` value to an ssh target string for a credential-carrying
 * remote operation. Delegates to the same resolver `run --device` uses; on a
 * miss, treats the value as a raw ssh target and validates it.
 */
export async function resolveHostSshTarget(nameOrAlias: string): Promise<string> {
  const host = await resolveHost(nameOrAlias);
  if (host) return sshTargetFor(host);
  assertValidSshTarget(nameOrAlias);
  return nameOrAlias;
}
