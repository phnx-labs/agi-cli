import type { AgentId } from '../types.js';
import { readAccountRegistry } from '../account-registry.js';
import { hasKeychainTokenSync, isSecretsTransportError } from '../secrets-client.js';
import { getGlobalDefault, listInstalledVersions } from '../installations/versions.js';
import { collectRunCandidates, type RotateCandidate } from './rotate.js';
import { registryPoolCandidates, type RegistryAccountRecord } from './account-pool.js';

/**
 * Provider accounts whose credential is present on THIS device, as capability
 * records. A registry entry with no local secret is skipped: including it would
 * let `--strategy balanced` pick an account that then fails at spawn and exits the
 * whole run (`resolveSpawnAccount` throws on a missing credential) instead of
 * rotating to a healthy one.
 */
function localRegistryRecords(): RegistryAccountRecord[] {
  // Read-only launch input: an unreachable standalone `secrets` (missing binary,
  // timeout, non-JSON) must not abort the run — it just means no provider
  // accounts are foldable here, so the run proceeds on the native login rather
  // than hanging or crashing (PHNX-3989, honoring the ≤3s sync bound). A genuine
  // non-transport error still throws. DIST-1 holds: no embedded-engine fallback.
  try {
    return Object.values(readAccountRegistry().accounts)
      .filter((a) => hasKeychainTokenSync(a.secretRef))
      .map((a) => ({ id: a.id, name: a.name, provider: a.provider, auth: a.auth, secretPresent: true }));
  } catch (err) {
    if (isSecretsTransportError(err)) return [];
    throw err;
  }
}

/** Inputs to {@link foldRegistryCandidates} — injectable so the fold is unit-tested. */
export interface RunCandidateInputs {
  native: RotateCandidate[];
  records: RegistryAccountRecord[];
  runVersion: string | undefined;
}

/**
 * PURE: fold provider-account candidates into the native version-home list.
 *
 * A registry account runs in `runVersion` (the agent's default installed home);
 * the token/key overrides that home's own login at exec, so any home works. It
 * carries `providerAccount` so the run path routes it through the existing
 * `--account` injection (`resolveSpawnAccount` → `accountEnv`). An account already
 * covered by a native login is skipped by accountKey. With no installed version
 * there is nowhere to execute a registry account, so the native list passes
 * through unchanged.
 */
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
      // Derive from the record's real secret-presence field rather than a bare
      // `true` literal (PHNX-3502). Inert on today's only producer
      // (`localRegistryRecords` already filters token-less accounts before the
      // map), but keeps the field honest for any injected record that carries
      // `secretPresent: false`.
      signedIn: r.secretPresent,
      authVerdict: null,
      lastActive: null,
      providerAccount: r.name,
      providerAccountId: r.id,
    }));

  return [...native, ...extra];
}

/**
 * Candidate list for the `agents run` strategy pick, account-centric: the usual
 * native version-home candidates PLUS one candidate per provider account whose
 * provider can authenticate `agent` and whose credential is present locally
 * (RUSH-3182). This is what makes a setup-token / API-key account balance-eligible.
 *
 * Passed as the `collect` argument to {@link resolveRunVersion} on the RUN path,
 * and used by session recovery (`resolveSessionRecovery`, PHNX-3626) so an
 * origin-account limit can rotate to a healthy provider account and stay NATIVE.
 * The other consumers of {@link collectRunCandidates} (watchdog, teams
 * placement) keep calling it directly and are unaffected. The existing
 * {@link pickBalancedCandidate} selects over the combined list, so the
 * revoked / rate-limit / exhausted logic is unchanged.
 */
export async function collectRunCandidatesForRun(agent: AgentId): Promise<RotateCandidate[]> {
  const native = await collectRunCandidates(agent);
  const runVersion = getGlobalDefault(agent) ?? listInstalledVersions(agent)[0];
  return foldRegistryCandidates(agent, { native, records: localRegistryRecords(), runVersion });
}
