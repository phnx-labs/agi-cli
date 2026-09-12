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
export interface RegistryAccountInput {
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

/**
 * Which provider accounts can authenticate `agent`. An account is a candidate for
 * harness H only when its provider adapter has an `envFor(H, kind)` mapping
 * (`providerAuthenticatesHarness`, the same check the account UI uses) — so a
 * Cursor key never enters Claude's pool and a Claude setup-token never enters
 * Codex's. This is registry-driven, no per-harness `else if`: a harness gets a
 * provider-account pool exactly when the adapter table maps a provider to it —
 * today claude, codex, grok, cursor, opencode (plus gemini/antigravity). A harness
 * with only a native OAuth login and no provider adapter — kimi — returns `[]`
 * here and keeps balancing its native logins only.
 *
 * `accountKey` is synthetic here (`${agent}:name=${name}`) — a stable per-account
 * key so balancing can include it immediately; the real agent-scoped identity
 * (email / org uuid) is backfilled by identity capture and replaces it. `email`
 * is null until then, which routes the account as usage-unverified but still a
 * candidate, never excluded.
 */
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
