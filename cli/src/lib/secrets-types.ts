

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
  skipBrokerEviction?: boolean;
  allowReservedStore?: boolean;
}

export interface ResolveBundleOptions {
  caller?: string;
  agent?: string;
  duration?: string;
  interactiveUnlock?: boolean;
  noAgent?: boolean;
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
  passphrase?: string;
  operation: string;
  policyNever?: boolean;
  agentOnly?: boolean;
  literalValues?: Record<string, string>;
  timeoutMs?: number;
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
