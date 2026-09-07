/**
 * Reserved per-harness credential stores (PHNX-3940 / PHNX-3989).
 *
 * One store name per `ALL_AGENT_IDS` entry: `__<harness>__`. A user-created
 * bundle can never collide (the standalone rejects `__`-prefixed names unless
 * explicitly allowed). The legacy `auth` bundle remains a readable alias for
 * `__claude__` — this module does not migrate data.
 *
 * Deliberately a LEAF module (no import of `claude-account-token.ts` or
 * `secrets-policy.ts`): both of those need these constants, and
 * `claude-account-token.ts` is itself a dependency of `secrets-policy.ts`'s
 * fleet-sync helpers — importing this module's exports from `secrets-policy.js`
 * instead would form a real circular import that throws
 * `ReferenceError: Cannot access '...' before initialization` under real ESM
 * evaluation order (reproduced running this suite outside vitest's
 * mock-tolerant transform). Keep it a leaf; `secrets-policy.ts` re-exports it
 * for the existing public surface.
 */
import { bundleExistsSync, bundleBackendSync, isSecretsClientError } from './secrets-client.js';
import type { SecretsBackend } from './secrets-types.js';
import { AGENT_IDS, type AgentId } from './types.js';

/** Legacy readable alias for `__claude__`. Not migrated in this track. */
export const AUTH_STORE_ALIAS = 'auth';
/** The one reserved bundle name most callers actually need. */
export const AUTH_BUNDLE_NAME = AUTH_STORE_ALIAS;

/**
 * The reserved `auth` bundle holds per-account Claude setup-tokens for
 * unattended usage/probe and MUST be file-backed (headless, fleet-shareable —
 * credential-management.md invariant 7). The standalone enforces the same
 * rule on its write path (`WRONG_BACKEND`); agents-cli asserts it on every
 * read so a keychain/vault-backed `auth` left over from an older layout fails
 * loud instead of silently being ignored by usage/probe (SEC-GAP-3).
 */
export const AUTH_BUNDLE_BACKEND: SecretsBackend = 'file';

export const RESERVED_BUNDLE_NAMES = new Set([AUTH_BUNDLE_NAME]);

export function isReservedBundleName(name: string): boolean {
  return RESERVED_BUNDLE_NAMES.has(name.trim().toLowerCase());
}

/** Thrown when the reserved `auth` bundle is found on the wrong backend. */
export class ReservedBundleWrongBackendError extends Error {
  readonly bundle: string;
  readonly backend: SecretsBackend;
  constructor(bundle: string, backend: SecretsBackend) {
    super(
      `Bundle '${bundle}' is reserved for file-backed setup-tokens (headless, fleet-shareable). ` +
        `A ${backend}-backed '${bundle}' bundle is ignored by usage/probe instead of authenticating. ` +
        `Recreate it as file-backed: agents secrets delete ${bundle} --yes && agents secrets create ${bundle} --backend file`,
    );
    this.name = 'ReservedBundleWrongBackendError';
    this.bundle = bundle;
    this.backend = backend;
  }
}

/** Fail loud when the reserved `auth` bundle is on any backend but `file`. */
export function assertReservedAuthBackend(backend: SecretsBackend): void {
  if (backend !== AUTH_BUNDLE_BACKEND) throw new ReservedBundleWrongBackendError(AUTH_STORE_ALIAS, backend);
}

/**
 * True for the wrong-backend refusal in either shape: raised here from a
 * read-side check, or returned by the standalone (`WRONG_BACKEND`) when its
 * own write/resolve guard fired.
 */
export function isReservedBundleBackendError(error: unknown): boolean {
  return error instanceof ReservedBundleWrongBackendError || isSecretsClientError(error, 'WRONG_BACKEND');
}

export const RESERVED_STORES: Record<AgentId, string> = Object.fromEntries(
  AGENT_IDS.map((id) => [id, `__${id}__`]),
) as Record<AgentId, string>;

export function reservedStoreName(harness: AgentId): string {
  const name = RESERVED_STORES[harness];
  if (!name) throw new Error(`No reserved store for '${harness}'.`);
  return name;
}

export function isReservedStoreName(name: string): boolean {
  const n = name.trim().toLowerCase();
  if (n === AUTH_STORE_ALIAS) return true;
  return AGENT_IDS.some((id) => RESERVED_STORES[id].toLowerCase() === n);
}

export type StorableCredentialKind = 'setup-token' | 'api-key';

/**
 * Fail loud at the write boundary: only a setup-token or an API key may enter
 * a reserved store. Rotating OAuth/session credentials stay in their slot on
 * the device that minted them.
 */
export function assertStorableCredentialKind(
  kind: string,
  harness?: AgentId,
): asserts kind is StorableCredentialKind {
  if (kind === 'setup-token' || kind === 'api-key') return;
  throw new Error(storableCredentialRefusal(kind, harness));
}

function storableCredentialRefusal(kind: string, harness?: AgentId): string {
  if (harness === 'codex') return 'codex: auth.json is a rotating session; add an API key instead';
  if (harness === 'droid') return 'droid: refresh tokens are single-use and collapse the fleet when copied; add a FACTORY_API_KEY instead';
  if (harness === 'claude') return 'claude: native OAuth (.credentials.json) is a rotating session; mint a setup-token instead';
  if (harness === 'grok') return 'grok: auth.json is a rotating session; add an XAI_API_KEY instead';
  if (harness === 'kimi' || harness === 'antigravity') return `${harness}: no portable worker credential; log in per device`;
  const who = harness ?? 'this harness';
  return `${who}: reserved stores accept only a setup-token or an API key, not '${kind}'`;
}

/**
 * Whether the local reserved `auth` bundle exists and is on the expected
 * (file) backend. `ok: true` on a missing bundle — nothing to be wrong about.
 * Read-only status probe (`agents doctor`, `agents fleet apply`); an
 * unreachable standalone is treated the same as "bundle absent" so a
 * diagnostic never crashes over one optional finding.
 */
export function inspectReservedAuthBundle(): {
  exists: boolean;
  backend: SecretsBackend | null;
  ok: boolean;
} {
  let exists: boolean;
  try {
    exists = bundleExistsSync(AUTH_BUNDLE_NAME);
  } catch {
    return { exists: false, backend: null, ok: true };
  }
  if (!exists) return { exists: false, backend: null, ok: true };
  const backend = bundleBackendSync(AUTH_BUNDLE_NAME);
  return { exists: true, backend, ok: backend === AUTH_BUNDLE_BACKEND };
}
