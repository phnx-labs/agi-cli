import { parseBundleValue, secretsKeychainItem, type BundleValue } from './secrets-client.js';
import type { SecretsBundle } from './secrets-types.js';
import type { AccountAuthKind } from './account-provider-registry.js';

export const ACCOUNT_VARS = {
  id: 'ACCOUNT_ID',
  provider: 'PROVIDER',
  authType: 'AUTH_TYPE',
  baseUrl: 'BASE_URL',
  apiKey: 'API_KEY',
  token: 'TOKEN',
} as const;

// Identity fields are literals; only API_KEY/TOKEN are keychain references.
// Policy never keeps worker/headless reads and fleet sync free of biometric ACLs.
export const ACCOUNT_POLICY = 'never' as const;

export interface AccountSchemaRecord {
  id: string;
  name: string;
  provider: string;
  auth: AccountAuthKind;
  baseUrl?: string;
}

export function secretVarFor(auth: AccountAuthKind): 'API_KEY' | 'TOKEN' {
  return auth === 'api-key' ? ACCOUNT_VARS.apiKey : ACCOUNT_VARS.token;
}

export function accountSecretItem(name: string, auth: AccountAuthKind): string {
  return secretsKeychainItem(name, secretVarFor(auth));
}

function literalOf(raw: BundleValue | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const parsed = parseBundleValue(raw);
  return 'literal' in parsed ? parsed.literal : undefined;
}

function isAccountAuthKind(value: string | undefined): value is AccountAuthKind {
  return value === 'api-key' || value === 'setup-token' || value === 'bearer-token';
}

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
  // Escape BASE_URL as a literal so ref-looking URLs such as env://... stay URLs.
  if (record.baseUrl) vars[ACCOUNT_VARS.baseUrl] = { value: record.baseUrl };
  const bundle: SecretsBundle = { name: record.name, policy: ACCOUNT_POLICY, vars };
  const items = new Map<string, string>([[secretsKeychainItem(record.name, secretVar), secret]]);
  return { bundle, items };
}

export function parseAccountBundle(bundle: SecretsBundle): AccountSchemaRecord | null {
  const id = literalOf(bundle.vars[ACCOUNT_VARS.id]);
  const provider = literalOf(bundle.vars[ACCOUNT_VARS.provider]);
  const auth = literalOf(bundle.vars[ACCOUNT_VARS.authType]);
  if (!id || !provider || !isAccountAuthKind(auth)) return null;
  const baseUrl = literalOf(bundle.vars[ACCOUNT_VARS.baseUrl]);
  return { id, name: bundle.name, provider, auth, baseUrl };
}
