/**
 * The ONE visibility model, identical on every surface that publishes to managed
 * storage. Three levels the operator ever chooses between:
 *
 *   - PRIVATE  = `me`      — owner-only, Phoenix-gated. THE DEFAULT for a new
 *                            managed share (see {@link MANAGED_DEFAULT_VISIBILITY}).
 *   - TEAM     = `org`     — everyone at the sharer's signed-in email DOMAIN,
 *                            Phoenix-gated. Automatic from the domain — there is
 *                            no organization to create and no member to add.
 *   - PUBLIC   = `public`  — explicit opt-in; listed in the gallery, gets an OG
 *                            card.
 *
 * Two capability-URL levels remain for the power path (unguessable link, not a
 * login gate): `unlisted` (obscurity — noindex, gallery-hidden, still
 * world-readable) and `private`-token-gated (`--protected`: a `?k=` key the
 * Worker checks, 404 without it). `me`/`org` require a Phoenix session; the
 * Worker refuses them for a bare WRITE_TOKEN (BYO) publish, which is why the BYO
 * default stays `public`.
 *
 * The names match the managed share Worker's own metadata vocabulary (the Worker
 * now lives in the standalone `artifacts` CLI, PHNX-3992), so this module is the
 * single client-side source of truth for the level set and the DEFAULT, reusable
 * by any surface.
 */

/** Every visibility level the Worker understands. `me`/`org` are the
 * Phoenix-gated (login-required) levels; `public`/`unlisted`/`private` are the
 * link-reachable levels. */
export type ShareVisibility = 'public' | 'unlisted' | 'private' | 'me' | 'org';

/** The levels a publish (`share <file> --visibility`) may select. */
export const PUBLISH_VISIBILITY_LEVELS: readonly ShareVisibility[] = [
  'public',
  'unlisted',
  'private',
  'me',
  'org',
];

/** The levels an ALREADY-published page may be re-scoped to in place
 * (`share visibility <target> <level>`). Excludes `private`: re-scoping to
 * token-gated needs a fresh viewer token, which only the publish path mints. */
export const EDITABLE_VISIBILITY_LEVELS: readonly ShareVisibility[] = [
  'public',
  'unlisted',
  'me',
  'org',
];

/**
 * The product default for a MANAGED (signed-in) share: PRIVATE = owner-only,
 * Phoenix-gated. A publish with no visibility flag lands here.
 */
export const MANAGED_DEFAULT_VISIBILITY: ShareVisibility = 'me';

/**
 * The default for a BYO (bring-your-own bucket) publish. `me`/`org` are refused
 * server-side for a WRITE_TOKEN publish — there is no Phoenix owner to gate on —
 * so a BYO share with no flag stays `public`, matching the pre-managed behavior.
 */
export const BYO_DEFAULT_VISIBILITY: ShareVisibility = 'public';

import type { StorageBackendKind } from './selection.js';

/** The no-flags default for a given storage backend: `me` on managed,
 * `public` on BYO. */
export function defaultVisibilityForBackend(kind: StorageBackendKind): ShareVisibility {
  return kind === 'managed' ? MANAGED_DEFAULT_VISIBILITY : BYO_DEFAULT_VISIBILITY;
}

export interface VisibilityFlags {
  /** An explicit `--visibility <level>`. */
  visibility?: ShareVisibility;
  /** `--unlisted` / `--private` (obscurity, not read-auth). */
  unlisted?: boolean;
  /** `--protected` — token-gated read auth (maps to `private`). */
  protected?: boolean;
}

/**
 * The visibility the caller EXPLICITLY asked for, or `undefined` when they
 * passed no visibility signal at all. `--protected` wins over `--unlisted`
 * (stronger control), which wins over an explicit `--visibility`.
 *
 * The distinction between "explicit" and "no preference" is what lets a caller
 * apply the product default only when nothing was asked — a caller that passes
 * `--visibility public` gets `public`, never the `me` default.
 */
export function explicitVisibility(opts: VisibilityFlags = {}): ShareVisibility | undefined {
  if (opts.protected === true) return 'private';
  if (opts.unlisted === true) return 'unlisted';
  if (
    opts.visibility === 'public' ||
    opts.visibility === 'unlisted' ||
    opts.visibility === 'private' ||
    opts.visibility === 'me' ||
    opts.visibility === 'org'
  ) {
    return opts.visibility;
  }
  return undefined;
}

/**
 * Resolve visibility from the caller's flags, falling back to `fallback` when no
 * explicit signal was given. The library fallback stays `public` so a caller
 * that hasn't opted into the managed private default (e.g. an existing lib
 * consumer) is never silently flipped; the surface applies the product default
 * itself via {@link defaultVisibilityForBackend}.
 */
export function resolveVisibility(
  opts: VisibilityFlags = {},
  fallback: ShareVisibility = 'public',
): ShareVisibility {
  return explicitVisibility(opts) ?? fallback;
}

/**
 * The visibility a PUBLISH should stamp: the caller's explicit flag if any, else
 * the product default for the resolved backend (`me` on managed, `public` on
 * BYO). This is the one call a publishing surface makes — `agents artifacts
 * share` today, `agents sessions` sync next — so "private by default when signed
 * in" is decided in exactly one place.
 */
export function publishVisibility(opts: VisibilityFlags, kind: StorageBackendKind): ShareVisibility {
  return explicitVisibility(opts) ?? defaultVisibilityForBackend(kind);
}
