/**
 * The ONE managed-vs-BYO storage-backend selection policy.
 *
 * Every surface that persists to Phoenix-managed storage (`agents artifacts
 * share` today, `agents sessions` sync next) makes the SAME choice: run on OUR
 * managed infrastructure when the caller is signed in to Phoenix, and only fall
 * back to a bring-your-own bucket when the caller explicitly asked for it. This
 * module owns that decision so it is not re-derived — and re-drifted — per
 * surface.
 *
 * What lives here is ONLY the identity + selection policy. It deliberately does
 * NOT know a surface's endpoint, namespace shape, public-read semantics, or OG
 * covers — those differ (share uses an email-handle namespace with public reads
 * and covers; a traces/sessions adapter uses the userId and differs again). Each
 * surface keeps its own DISCRIMINATED, typed adapter that reads this decision and
 * returns its own `kind`-tagged backend. See `lib/traces/backend.ts` for a
 * concrete adapter.
 */

import { readSession, type PhoenixSession } from '../identity/client.js';

/** The two legitimate principals any managed-capable surface can resolve to. */
export type StorageBackendKind = 'managed' | 'byo';

export interface StorageSelectionOpts {
  /**
   * True when the SURFACE detected an explicit bring-your-own override — a
   * `--byo` flag, a caller-supplied static write token, a `…_BACKEND=byo` env,
   * or a full BYO endpoint config. Detecting WHICH signals count is the
   * surface's job (they differ per surface); this policy only honors the boolean.
   */
  byoOverride?: boolean;
  /**
   * DI seam for the Phoenix session. `undefined` reads the real persisted
   * session (`readSession()`); `null` means "explicitly signed out".
   */
  session?: PhoenixSession | null;
}

/**
 * Pick the storage principal. Managed when signed in (`readSession() != null`)
 * AND the surface reported no explicit BYO override; otherwise BYO.
 *
 * This is not a fallback chain — it is a single decision. A surface that cannot
 * authenticate EITHER principal (signed out AND no BYO config) still reads `byo`
 * here and fails loud in its own adapter, where the actionable "run auth login
 * or set up your bucket" message belongs.
 */
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
