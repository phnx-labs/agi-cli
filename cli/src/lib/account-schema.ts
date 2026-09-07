/**
 * Canonical on-disk shape of a provider credential account.
 *
 * RUSH-2470 makes a `agents secrets` bundle the single source of truth for a
 * credential account: one account IS one bundle. The bundle's label is the
 * account name; its variables carry the account's identity plus its secret:
 *
 *   ACCOUNT_ID   the stable UUID (a literal, survives rename)
 *   PROVIDER     the provider id (a literal, e.g. 'openrouter')
 *   AUTH_TYPE    'api-key' | 'setup-token' | 'bearer-token' (a literal)
 *   BASE_URL     optional endpoint override (a literal)
 *   API_KEY      the secret, for AUTH_TYPE 'api-key'      (a keychain ref)
 *   TOKEN        the secret, for setup-token/bearer-token (a keychain ref)
 *
 * The identity vars are non-secret literals stored inline in the bundle
 * metadata; only API_KEY / TOKEN reference a keychain-backed value. Account
 * bundles use the `never` prompt policy so their values carry no biometry ACL
 * and sync (and read headlessly) with no Touch ID — the whole point of the
 * change. This module is pure: it builds a bundle from a record and parses a
 * record back out, with no I/O. The registry ([[account-registry]]) owns
 * reads and writes; the catalog ([[account-catalog]]) owns discovery.
 */
import { parseBundleValue, secretsKeychainItem, type BundleValue } from './secrets-client.js';
import type { SecretsBundle } from './secrets-types.js';
import type { AccountAuthKind } from './account-provider-registry.js';

/** Canonical bundle variable names for a provider-account bundle. */
export const ACCOUNT_VARS = {
  id: 'ACCOUNT_ID',
  provider: 'PROVIDER',
  authType: 'AUTH_TYPE',
  baseUrl: 'BASE_URL',
  apiKey: 'API_KEY',
  token: 'TOKEN',
} as const;

/**
 * Account bundles are stored with the `never` prompt policy: no biometry ACL,
 * so reads are silent and the bundle syncs across the fleet without Touch ID.
 */
export const ACCOUNT_POLICY = 'never' as const;

/** The parsed identity of an account, independent of where its bytes live. */
export interface AccountSchemaRecord {
  id: string;
  name: string;
  provider: string;
  auth: AccountAuthKind;
  baseUrl?: string;
}

/** The single secret var name that carries the credential for an auth kind. */
export function secretVarFor(auth: AccountAuthKind): 'API_KEY' | 'TOKEN' {
  return auth === 'api-key' ? ACCOUNT_VARS.apiKey : ACCOUNT_VARS.token;
}

/** The keychain item that stores an account bundle's secret value. */
export function accountSecretItem(name: string, auth: AccountAuthKind): string {
  return secretsKeychainItem(name, secretVarFor(auth));
}

/** Read a bundle var as a literal string, or undefined if it is a secret ref. */
function literalOf(raw: BundleValue | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const parsed = parseBundleValue(raw);
  return 'literal' in parsed ? parsed.literal : undefined;
}

function isAccountAuthKind(value: string | undefined): value is AccountAuthKind {
  return value === 'api-key' || value === 'setup-token' || value === 'bearer-token';
}

/**
 * Build the canonical account bundle plus the keychain item map holding its
 * secret. The identity vars are literals; the secret var is a `keychain:` ref
 * whose value lives in the returned item map, ready for `writeBundleWithItems`.
 */
export function buildAccountBundle(
  record: AccountSchemaRecord,
  secret: string,
): { bundle: SecretsBundle; items: Map<string, string> } {
  const secretVar = secretVarFor(record.auth);
  const vars: Record<string, BundleValue> = {
    [ACCOUNT_VARS.id]: record.id,
    [ACCOUNT_VARS.provider]: record.provider,
    [ACCOUNT_VARS.authType]: record.auth,
    [secretVar]: `keychain:${secretVar}`,
  };
  // Wrap BASE_URL as an escaped literal so a URL that happens to start with a
  // ref prefix (e.g. 'env://…') is never misread as a secret reference.
  if (record.baseUrl) vars[ACCOUNT_VARS.baseUrl] = { value: record.baseUrl };
  const bundle: SecretsBundle = { name: record.name, policy: ACCOUNT_POLICY, vars };
  const items = new Map<string, string>([[secretsKeychainItem(record.name, secretVar), secret]]);
  return { bundle, items };
}

/**
 * Parse an account record from a bundle, or null when the bundle is not an
 * account bundle (missing ACCOUNT_ID / PROVIDER / a known AUTH_TYPE). The
 * catalog uses the null return to keep ordinary secrets bundles out of the
 * account list.
 */
export function parseAccountBundle(bundle: SecretsBundle): AccountSchemaRecord | null {
  const id = literalOf(bundle.vars[ACCOUNT_VARS.id]);
  const provider = literalOf(bundle.vars[ACCOUNT_VARS.provider]);
  const auth = literalOf(bundle.vars[ACCOUNT_VARS.authType]);
  if (!id || !provider || !isAccountAuthKind(auth)) return null;
  const baseUrl = literalOf(bundle.vars[ACCOUNT_VARS.baseUrl]);
  return { id, name: bundle.name, provider, auth, baseUrl };
}
