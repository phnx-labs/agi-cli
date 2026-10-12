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
      accountKey: `${agent}:name=${r.name}`,
      email: null,
      name: r.name,
      provider: r.provider,
      auth: r.auth,
      secretPresent: r.secretPresent,
    });
  }
  return out;
}
