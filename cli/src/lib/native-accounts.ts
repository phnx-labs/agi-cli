import type { AgentId, Meta, NativeAccountRecord } from './types.js';

// Pure leaf: no state, keychain, network, or account-registry imports; device rows override central rows.

function mergedNativeAccounts(
  meta: Pick<Meta, 'accounts' | 'deviceAccounts'>,
): NativeAccountRecord[] {
  const merged = { ...meta.accounts?.native, ...meta.deviceAccounts?.native };
  return Object.values(merged);
}

export function registeredNativeAccountForEmail(
  meta: Pick<Meta, 'accounts' | 'deviceAccounts'>,
  agent: AgentId,
  email: string,
): NativeAccountRecord | null {
  // Multiple identity matches are ambiguous and must not be guessed.
  const needle = email.trim().toLowerCase();
  if (!needle) return null;
  const matches = mergedNativeAccounts(meta).filter(
    (account) => account.agent === agent && account.identityLabel?.trim().toLowerCase() === needle,
  );
  return matches.length === 1 ? matches[0]! : null;
}

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
