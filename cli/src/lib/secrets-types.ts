

// Mirrored wire schema owned by @phnx-labs/secrets-cli. Keep these declarations
// aligned with its schema; this module contributes no runtime implementation.
export type SecretsBackend = 'keychain' | 'file' | 'vault';

export type SecretProvider = 'keychain' | 'env' | 'file' | 'exec';

export interface SecretRef {
  provider: SecretProvider;
  value: string;
}

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

// `always` prompts per read, `hold` reuses a broker unlock, and `never` removes
// the biometric ACL and is reserved for automation credentials.
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
  // Caller attests that the item has no biometric ACL; never set for protected items.
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
  // Ignored: file export never forwards the local passphrase; the remote owns its key.
  passphrase?: string;
  operation: string;
  policyNever?: boolean;
  agentOnly?: boolean;
  literalValues?: Record<string, string>;
  timeoutMs?: number;
  // Applies to import, verification, and literal restoration on the remote.
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
