import type { AgentId } from '../types.js';
import type { AccountAuthKind } from '../account-provider-registry.js';
import { providerAuthenticatesHarness } from '../account-provider-registry.js';

/**
 * The provider-account side of the run-candidate pool (RUSH-3182).
 *
 * `--strategy balanced` used to enumerate only version-home native logins, so a
 * setup-token / API-key account added via `agents accounts add` never balanced.
 * This module turns the account registry into the extra candidates the run path
 * folds in — see `collectRunCandidatesForRun` in `account-pool-collect.ts`.
 *
 * Pure + dependency-light so the harness-capability filter is unit-tested in
 * isolation with fixtures.
 */

/** A provider account record as stored in the registry (identity captured separately). */
export interface RegistryAccountRecord {
  id?: string;
  name: string;
  provider: string;
  auth: AccountAuthKind;
  /**
   * Whether this account's secret is actually present on THIS device
   * (`hasKeychainToken(secretRef)`, checked by the record's builder). Carried
   * through rather than assumed, so a candidate's `signedIn` reflects a real
   * check instead of a literal disconnected from it (PHNX-3502) — a registry
   * entry can exist with no local secret (added on another device, or
   * revoked), and folding it in as unconditionally signed-in would let
   * `--strategy balanced` pick an account that fails at spawn.
   */
  secretPresent: boolean;
}

/** A registry account eligible to run one harness, ready to map to a candidate. */
interface RegistryAccountInput {
  id?: string;
  /** Agent-scoped key so `(claude, X)` and `(codex, X)` stay distinct. */
  accountKey: string;
  email: string | null;
  name: string;
  provider: string;
  auth: AccountAuthKind;
  /** See {@link RegistryAccountRecord.secretPresent}. */
  secretPresent: boolean;
}

/** Which provider accounts can authenticate `agent`: only those whose adapter has `envFor(H, kind)`
 * (a Cursor key never enters Claude's pool); no adapter (kimi) returns []. `accountKey` is
 * synthetic until identity capture backfills it; null `email` = unverified, still a candidate. */
export function registryPoolCandidates(
  records: RegistryAccountRecord[],
  agent: AgentId,
): RegistryAccountInput[] {
  const out: RegistryAccountInput[] = [];
  for (const r of records) {
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
