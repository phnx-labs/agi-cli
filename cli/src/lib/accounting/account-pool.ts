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

export function registryAccountServesHarness(
  record: Pick<RegistryAccountRecord, 'provider' | 'auth'>,
  agent: AgentId,
  includeKeyed = false,
): boolean {
  return (record.auth === 'setup-token' || includeKeyed) && providerAuthenticatesHarness(record.provider, record.auth, agent);
}

export function registryPoolCandidates(
  records: RegistryAccountRecord[],
  agent: AgentId,
  includeKeyed = false,
): RegistryAccountInput[] {
  const out: RegistryAccountInput[] = [];
  for (const r of records) {
    if (!registryAccountServesHarness(r, agent, includeKeyed)) continue;
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
