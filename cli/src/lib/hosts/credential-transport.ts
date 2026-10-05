import { assertValidSshTarget } from '../ssh-exec.js';
import { resolveHost } from './registry.js';
import { sshTargetFor } from './types.js';
import { isHostPinned } from '../devices/known-hosts.js';

function hostKeyLookupName(target: string): string {
  return target.split('@').pop() ?? target;
}

export function assertCredentialTransportHostPinned(target: string, pinned = isHostPinned(hostKeyLookupName(target))): void {

  if (pinned) return;
  throw new Error(
    `Refusing to transfer provider credentials to '${target}' before its SSH host key is pinned. ` +
    `Connect once with 'agents ssh ${target}' and verify the host, then retry.`,
  );
}

export async function resolveHostSshTarget(nameOrAlias: string): Promise<string> {

  const host = await resolveHost(nameOrAlias);
  if (host) return sshTargetFor(host);
  assertValidSshTarget(nameOrAlias);
  return nameOrAlias;
}
