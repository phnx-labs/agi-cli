import type { AgentId } from '../types.js';
import { readAccountRegistry } from '../account-registry.js';
import { hasKeychainTokenSync, isSecretsTransportError } from '../secrets-client.js';
import { getGlobalDefault, listInstalledVersions } from '../installations/versions.js';
import { collectRunCandidates, type RotateCandidate } from './rotate.js';
import { registryPoolCandidates, type RegistryAccountRecord } from './account-pool.js';

function localRegistryRecords(): RegistryAccountRecord[] {
  try {
    return Object.values(readAccountRegistry().accounts)
      .filter((a) => hasKeychainTokenSync(a.secretRef))
      .map((a) => ({ id: a.id, name: a.name, provider: a.provider, auth: a.auth, secretPresent: true }));
  } catch (err) {
    if (isSecretsTransportError(err)) return [];
    throw err;
  }
}

export interface RunCandidateInputs {
  native: RotateCandidate[];
  records: RegistryAccountRecord[];
  runVersion: string | undefined;
}

export function foldRegistryCandidates(agent: AgentId, inputs: RunCandidateInputs): RotateCandidate[] {
  const { native, records, runVersion } = inputs;
  if (!runVersion) return native;

  const seen = new Set(native.filter((c) => c.accountKey).map((c) => c.accountKey as string));
  const extra: RotateCandidate[] = registryPoolCandidates(records, agent)
    .filter((r) => !seen.has(r.accountKey))
    .map((r) => ({
      agent,
      version: runVersion,
      accountKey: r.accountKey,
      accountLabel: r.name,
      email: null,
      usageKey: null,
      usageStatus: null,
      usageSnapshot: null,
      usageError: null,
      usageMinutesToLimit: null,
      plan: null,
      signedIn: r.secretPresent,
      authVerdict: null,
      lastActive: null,
      providerAccount: r.name,
      providerAccountId: r.id,
    }));

  return [...native, ...extra];
}

export async function collectRunCandidatesForRun(agent: AgentId): Promise<RotateCandidate[]> {
  const native = await collectRunCandidates(agent);
  const runVersion = getGlobalDefault(agent) ?? listInstalledVersions(agent)[0];
  return foldRegistryCandidates(agent, { native, records: localRegistryRecords(), runVersion });
}
