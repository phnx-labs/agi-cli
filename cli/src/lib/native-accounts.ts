/** Native-account lookup leaf (PHNX-3940): PURE and types-only, answering "which account is this
 * email / what does its identity key decode to" from a caller-supplied `Meta`. It must not import
 * `account-registry` (agent-spec/agents.ts uses it: a cycle); `account-registry` re-exports both. */
import type { AgentId, Meta, NativeAccountRecord } from './types.js';

/** Central + device-scoped native rows, device winning on a shared id. */
function mergedNativeAccounts(
  meta: Pick<Meta, 'accounts' | 'deviceAccounts'>,
): NativeAccountRecord[] {
  const merged = { ...meta.accounts?.native, ...meta.deviceAccounts?.native };
  return Object.values(merged);
}

/** The one native row for `agent` whose `identityLabel` (email) matches, or null when zero OR
 * several match; never guesses. A Team seat and a personal Max can share an email (two orgs), and
 * picking one would misattribute a worker home. Callers fall closed to email-only identity. */
export function registeredNativeAccountForEmail(
  meta: Pick<Meta, 'accounts' | 'deviceAccounts'>,
  agent: AgentId,
  email: string,
): NativeAccountRecord | null {
  const needle = email.trim().toLowerCase();
  if (!needle) return null;
  const matches = mergedNativeAccounts(meta).filter(
    (account) => account.agent === agent && account.identityLabel?.trim().toLowerCase() === needle,
  );
  return matches.length === 1 ? matches[0]! : null;
}

/** Decodes an `<agent>:<label>=<value>[:<label>=<value>...]` identity key (as `buildIdentityKey` in
 * agent-spec/agents.ts writes, e.g. `claude:account=<uuid>:org=<uuid>`) into its parts, or null
 * when it isn't `agent`'s or is malformed. */
export function parseNativeIdentityKey(
  agent: AgentId,
  identityKey: string,
): Record<string, string> | null {
  const prefix = `${agent}:`;
  if (!identityKey.startsWith(prefix)) return null;
  const parts: Record<string, string> = {};
  for (const segment of identityKey.slice(prefix.length).split(':')) {
    const eq = segment.indexOf('=');
    if (eq < 1 || eq === segment.length - 1) return null;
    parts[segment.slice(0, eq)] = segment.slice(eq + 1);
  }
  return Object.keys(parts).length > 0 ? parts : null;
}
