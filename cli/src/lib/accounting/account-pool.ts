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
): RegistryAccountInput[] {
  const out: RegistryAccountInput[] = [];
  for (const r of records) {
    // Only a subscription credential (a setup-token) joins the automatic pool. An api-key or bearer-token account
    // bills per token (OpenRouter, an Anthropic or OpenAI API key, a gateway), so balanced or available rotation never
    // picks one; it runs only when named (`--account`, a binding or `accounts default`). Owner decision 2026-10-12.
    if (r.auth !== 'setup-token') continue;
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
