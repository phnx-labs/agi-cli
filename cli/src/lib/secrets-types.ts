/** Wire-shared types for the standalone `secrets` CLI (PHNX-3989), re-declared so secrets-client.ts
 * keeps static types. Keep byte-for-byte in sync with `secrets-cli/src/schema.ts` and
 * `src/core/bundles.ts`. */


// Mirrored wire schema owned by @phnx-labs/secrets-cli. Keep these declarations
// aligned with its schema; this module contributes no runtime implementation.
export type SecretsBackend = 'keychain' | 'file' | 'vault';

export type SecretProvider = 'keychain' | 'env' | 'file' | 'exec';

export interface SecretRef {
  provider: SecretProvider;
  value: string;
}

/** A bundle value: a string (literal or provider-prefixed ref) or `{value: string}` to escape a
 * literal that would parse as a ref. */
export type BundleValue = string | { value: string };

export type RemoteBackend = 'keychain' | 'file';


const SECRET_TYPES = [
  'api-key',
  'token',
  'password',
  'url',
  'database-url',
  'ssh-key',
  'certificate',
  'webhook',
  'note',
] as const;
type SecretType = (typeof SECRET_TYPES)[number];

export interface VarMeta {
  type?: SecretType;
  expires?: string;
  note?: string;
}

/** Bundle prompt policy. `hold` (default): one Touch ID per ~7d hold window. `always`: prompt every
 * read. `never`: no biometry ACL, automation-only. */
export type SecretsPolicy = 'always' | 'hold' | 'never';

export interface SecretsBundle {
  name: string;
  description?: string;
  allow_exec?: boolean;
  backend?: SecretsBackend;
  policy?: SecretsPolicy;
  created_at?: string;
  updated_at?: string;
  last_used?: string;
  vars: Record<string, BundleValue>;
  meta?: Record<string, VarMeta>;
}

export interface BundleEntryInfo {
  key: string;
  kind: 'literal' | 'keychain' | 'env' | 'file' | 'exec';
  detail: string;
}


export interface WriteBundleOptions {
  // Broker eviction and reserved-store access are privileged system behaviors.
  skipBrokerEviction?: boolean;
  allowReservedStore?: boolean;
}

export interface ResolveBundleOptions {
  caller?: string;
  agent?: string;
  duration?: string;
  interactiveUnlock?: boolean;
  noAgent?: boolean;
  // Broker-only resolution must fail before prompting or direct keychain reads.
  agentOnly?: boolean;
  keys?: string[];
  allowExpired?: boolean;
  keyMode?: 'process' | 'storage';
  allowReservedStore?: boolean;
}

export interface RenameOptions {
  force?: boolean;
}

export interface RotateOptions {
  newValue: string;
  clearMeta?: boolean;
  meta?: Partial<VarMeta>;
}

export interface KeychainReadContext {
  agent?: string;
  bundle?: string;
  sessionId?: string;
  reason?: string;
  duration?: string;
  defaultPolicy?: 'hold' | 'always' | 'never';
  forceDuration?: boolean;
  /** The caller attests the item(s) carry NO biometry ACL, so the read is silent. Never pass this
   * for an ACL-protected item. */
  silentNoAcl?: boolean;
}


export interface AgentStatusEntry {
  name: string;
  expiresAt: number;
  keyCount: number;
  harness: string;
  leaseId?: string;
  keys?: string[];
}


export interface PushBundleOptions {
  remoteBackend: RemoteBackend;
  force?: boolean;
  /** Ignored: file-backend export never forwards the passphrase (PHNX-2371). Kept so existing
   * callers still compile. */
  passphrase?: string;
  operation: string;
  policyNever?: boolean;
  agentOnly?: boolean;
  literalValues?: Record<string, string>;
  timeoutMs?: number;
  /** State root (`SECRETS_HOME`) the remote `secrets` runs under for the whole push;
   * remote-relative, `~/` resolves against the remote home. The client wrapper fills in the user
   * agents dir so a push lands where the receiving agents-cli reads (MIG-1). */
  remoteSecretsHome?: string;
}

export interface PushBundleResult {
  ok: boolean;
  host: string;
  bundle: string;
  keyCount: number;
  message: string;
}

export interface RemoteBundleSummary {
  name: string;
  updated_at: string;
}

export interface PullOptions {
  passphrase: string;
  force?: boolean;
}


export interface RcSecretFinding {
  file: string;
  line: number;
  name: string;
  isMasterPassphrase: boolean;
}
