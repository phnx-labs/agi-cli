import type { AgentId } from '../types.js';
import type { AccountAuthKind } from '../account-provider-registry.js';
import { providerAuthenticatesHarness } from '../account-provider-registry.js';


export interface RegistryAccountRecord {
  id?: string;
  name: string;
  provider: string;
  auth: AccountAuthKind;
  secretPresent: boolean;
}

interface RegistryAccountInput {
  id?: string;
  accountKey: string;
  email: string | null;
  name: string;
  provider: string;
  auth: AccountAuthKind;
  secretPresent: boolean;
}

/** The usage-cache key a provider (setup-token) account's rate limits are credited to. */
export function providerAccountUsageKey(agent: AgentId, name: string): string {
  return `${agent}:name=${name}`;
}

export function registryPoolCandidates(
  records: RegistryAccountRecord[],
  agent: AgentId,
  includeKeyed = false,
): RegistryAccountInput[] {
  const out: RegistryAccountInput[] = [];
  for (const r of records) {
    if (r.auth !== 'setup-token' && !includeKeyed) continue;
    if (!providerAuthenticatesHarness(r.provider, r.auth, agent)) continue;
    out.push({
      id: r.id,
      accountKey: providerAccountUsageKey(agent, r.name),
      email: null,
      name: r.name,
      provider: r.provider,
      auth: r.auth,
      secretPresent: r.secretPresent,
    });
  }
  return out;
}
