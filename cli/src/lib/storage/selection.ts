/** The ONE managed-vs-BYO storage-backend selection policy: managed when signed in to Phoenix,
 * BYO only when the caller explicitly asked. It owns identity and selection only; each surface
 * keeps its own typed adapter for endpoint, namespace and reads (see lib/traces/backend.ts). */

import { readSession, type PhoenixSession } from '../identity/client.js';

/** The two legitimate principals any managed-capable surface can resolve to. */
export type StorageBackendKind = 'managed' | 'byo';

export interface StorageSelectionOpts {
  /** True when the SURFACE detected an explicit BYO override (flag, static token, env, or full
   * endpoint config). Which signals count is the surface's job; the policy honors the boolean. */
  byoOverride?: boolean;
  /** DI seam for the Phoenix session: `undefined` reads the real session, `null` means signed
   * out. */
  session?: PhoenixSession | null;
}

/** Pick the storage principal: managed when signed in and no explicit BYO override, else BYO.
 * A single decision, not a fallback chain. A surface with neither principal still reads `byo`
 * and fails loud in its own adapter, where the actionable message belongs. */
export function selectStorageBackendKind(opts: StorageSelectionOpts = {}): StorageBackendKind {
  if (opts.byoOverride === true) return 'byo';
  const session = opts.session === undefined ? readSession() : opts.session;
  return session != null ? 'managed' : 'byo';
}

/** True when the shared policy resolves to the managed principal. Thin sugar
 * over {@link selectStorageBackendKind} for the common boolean check. */
export function isManagedSelection(opts: StorageSelectionOpts = {}): boolean {
  return selectStorageBackendKind(opts) === 'managed';
}
