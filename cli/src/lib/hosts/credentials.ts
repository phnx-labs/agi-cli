/** Credential provisioning for `agents run --device --copy-creds`. It refuses to copy rotating
 * native OAuth logins (SING-1b: a shared refresh token invalidates every other copy) and steers
 * to `agents accounts sync`. */

import type { AgentId } from '../types.js';
import type { DetectedRuntime } from '../crabbox/runtimes.js';
import { isNativeOAuthRuntime, nativeOAuthTransferRefusal } from '../crabbox/runtimes.js';

// The native-OAuth predicate + refusal are canonical in `crabbox/runtimes.ts`
// (next to `LEASE_RUNTIMES`), so `--copy-creds` here and `--lease` there refuse
// against exactly the same set. Re-export for this module's existing consumers.
export { isNativeOAuthRuntime, nativeOAuthTransferRefusal } from '../crabbox/runtimes.js';

export interface HostCredentials {
  runtimes: AgentId[];
  detected: DetectedRuntime[];
  claudeCredentialsJson?: string | null;
}

/** Build the setup/teardown scripts for a `--copy-creds` run. Every handled runtime is a native
 * login, so this throws with the `agents accounts` steer before serializing anything (SING-1b);
 * an empty set is a no-op. */
export function buildHostCredentialScript(opts: HostCredentials): { setup: string; teardown: string } {
  const native = opts.runtimes.filter(isNativeOAuthRuntime);
  if (native.length > 0) {
    throw new Error(nativeOAuthTransferRefusal(native));
  }
  return { setup: '', teardown: '' };
}

/** Wrap a remote command with `--copy-creds` setup/teardown; refuses via
 * buildHostCredentialScript for native logins. */
export function wrapHostCommandWithCredentials(innerCommand: string, opts: HostCredentials): string {
  const { setup, teardown } = buildHostCredentialScript(opts);
  return [
    'set -uo pipefail',
    setup,
    innerCommand,
    'rc=$?',
    teardown,
    'exit $rc',
  ]
    .filter((l) => l.length > 0)
    .join('\n');
}
