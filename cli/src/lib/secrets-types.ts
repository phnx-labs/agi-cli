/** Wire-shared types for the standalone `secrets` CLI (PHNX-3989), re-declared so secrets-client.ts
 * keeps static types. Keep byte-for-byte in sync with `secrets-cli/src/schema.ts` and
 * `src/core/bundles.ts`. */

// --- backend / provider vocabulary -----------------------------------------

/** Supported bundle storage backends. */
export type SecretsBackend = 'keychain' | 'file' | 'vault';

/** Supported secret resolution providers for a bundle var. */
export type SecretProvider = 'keychain' | 'env' | 'file' | 'exec';

/** A typed reference to a secret: a provider plus a provider-specific value. */
export interface SecretRef {
  provider: SecretProvider;
  value: string;
}

/** A bundle value: a string (literal or provider-prefixed ref) or `{value: string}` to escape a
 * literal that would parse as a ref. */
export type BundleValue = string | { value: string };

/** Remote (bundle@host) push destination backend. */
export type RemoteBackend = 'keychain' | 'file';

// --- bundle document ---------------------------------------------------

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

/** Per-secret metadata; absent fields are omitted at write time. */
export interface VarMeta {
  type?: SecretType;
  /** Future-dated ISO date ('YYYY-MM-DD'). */
  expires?: string;
  note?: string;
}

/** Bundle prompt policy. `hold` (default): one Touch ID per ~7d hold window. `always`: prompt every
 * read. `never`: no biometry ACL, automation-only. */
export type SecretsPolicy = 'always' | 'hold' | 'never';

/** A named set of environment variable definitions backed by secret stores. */
export interface SecretsBundle {
  name: string;
  description?: string;
  allow_exec?: boolean;
  /** Absent ⇒ `keychain`. */
  backend?: SecretsBackend;
  /** Absent ⇒ configured default (`hold`). */
  policy?: SecretsPolicy;
  created_at?: string;
  updated_at?: string;
  last_used?: string;
  vars: Record<string, BundleValue>;
  meta?: Record<string, VarMeta>;
}

/** Per-key kind breakdown of an already-resolved bundle. */
export interface BundleEntryInfo {
  key: string;
  kind: 'literal' | 'keychain' | 'env' | 'file' | 'exec';
  /** Ref target, or empty for a literal. Never a resolved value. */
  detail: string;
}

// --- operation options ------------------------------------------------------

/** Options for `writeBundle` / `writeBundleWithItems`. */
export interface WriteBundleOptions {
  /** Skip evicting the broker-held copy (no-op writers such as `stampLastUsed`). */
  skipBrokerEviction?: boolean;
  /** Allow writing a reserved `__<harness>__` store. */
  allowReservedStore?: boolean;
}

/** Options for `readAndResolveBundleEnv`. */
export interface ResolveBundleOptions {
  caller?: string;
  /** Harness type whose unlock may be reused. */
  agent?: string;
  /** Duration shown in the Touch ID prompt. */
  duration?: string;
  /** Allow this call to raise an interactive biometric prompt. */
  interactiveUnlock?: boolean;
  /** Skip the broker fast-path and read from the keychain directly. */
  noAgent?: boolean;
  /** Resolve only from an already-unlocked broker snapshot; fail before prompting. */
  agentOnly?: boolean;
  /** Inject only these keys. Errors if any requested key is absent. */
  keys?: string[];
  /** Skip the per-key expiry gate. */
  allowExpired?: boolean;
  /** `process` projects dotted keys to shell-safe env names; `storage` preserves them. */
  keyMode?: 'process' | 'storage';
  /** Read a reserved `__<harness>__` store (system readers only). */
  allowReservedStore?: boolean;
}

/** Options for `renameBundle`. */
export interface RenameOptions {
  /** Overwrite an existing destination bundle. */
  force?: boolean;
}

/** Options for `rotateBundleSecret`. */
export interface RotateOptions {
  /** New plaintext value to write into the store (replaces the old one). */
  newValue: string;
  /** When true, drop existing meta for this key. Mutually exclusive with `meta`. */
  clearMeta?: boolean;
  /** Patch to merge into existing meta. Undefined fields preserve current values. */
  meta?: Partial<VarMeta>;
}

/** Reading a keychain-backed item through the standalone. */
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

// --- broker status -----------------------------------------------------

/** One held bundle unlock reported by `agent.agentStatus`. */
export interface AgentStatusEntry {
  name: string;
  expiresAt: number;
  keyCount: number;
  harness: string;
  leaseId?: string;
  keys?: string[];
}

// --- remote (bundle@host) push/pull -----------------------------------

/** Options for `pushBundleToHost` / `pushBundleToHostAsync`. */
export interface PushBundleOptions {
  remoteBackend: RemoteBackend;
  /** Overwrite a key that already exists on the remote. */
  force?: boolean;
  /** Ignored: file-backend export never forwards the passphrase (PHNX-2371). Kept so existing
   * callers still compile. */
  passphrase?: string;
  /** Label for the audit trail — `export --device` vs `fleet apply`. */
  operation: string;
  /** Preserve an automation account's permanent prompt-free policy remotely. */
  policyNever?: boolean;
  /** Permit a human-invoked push to read locally without requiring the agent broker. */
  agentOnly?: boolean;
  /** Non-secret literals whose bundle value kind must survive the dotenv transport. */
  literalValues?: Record<string, string>;
  /** Per-SSH-operation deadline. Async daemon callers must set this explicitly. */
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
  /** One line for the caller to render. Never contains a secret value. */
  message: string;
}

/** Lightweight listing entry returned by the managed sync transport. */
export interface RemoteBundleSummary {
  name: string;
  updated_at: string;
}

/** Options for `pullBundle` (the `agents sync --secrets` umbrella stage). */
export interface PullOptions {
  passphrase: string;
  /** When true, overwrite an existing local bundle. */
  force?: boolean;
}

// --- rc-hygiene (agents doctor) -----------------------------------------

/** One credential-shaped shell-rc export finding. */
export interface RcSecretFinding {
  /** Basename of the rc file, e.g. `.zshenv`. */
  file: string;
  /** 1-based line number of the export. */
  line: number;
  /** The exported variable name. Never the value. */
  name: string;
  /** The file-store master passphrase gets called out separately. */
  isMasterPassphrase: boolean;
}
