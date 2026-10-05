
import type { AgentId } from '../types.js';
import type { DetectedRuntime } from '../crabbox/runtimes.js';
import { isNativeOAuthRuntime, nativeOAuthTransferRefusal } from '../crabbox/runtimes.js';

export { isNativeOAuthRuntime, nativeOAuthTransferRefusal } from '../crabbox/runtimes.js';

export interface HostCredentials {
  runtimes: AgentId[];
  detected: DetectedRuntime[];
  claudeCredentialsJson?: string | null;
}

export function buildHostCredentialScript(opts: HostCredentials): { setup: string; teardown: string } {

  const native = opts.runtimes.filter(isNativeOAuthRuntime);
  if (native.length > 0) {
    throw new Error(nativeOAuthTransferRefusal(native));
  }
  return { setup: '', teardown: '' };
}

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
