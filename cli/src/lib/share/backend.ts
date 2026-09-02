/**
 * ShareBackend — the token-source seam for `agents artifacts share`.
 *
 * Two legitimate principals, picked once at publish time:
 *   - **managed**: the caller is signed in to Phoenix (`readSession()`), no
 *     explicit BYO override. Token is the Phoenix access_token; endpoint is
 *     the already-live `share.getrush.ai`. Zero Cloudflare setup.
 *   - **byo**: the existing static WRITE_TOKEN path (`readShareConfig()` +
 *     `readWriteToken()`). Unchanged for power users / custom domains / fleet
 *     injection of `SHARE_WRITE_TOKEN`.
 *
 * Dispatch is not a fallback: signed-in AND no BYO override → managed;
 * otherwise BYO. Fail loud when neither principal can authenticate.
 *
 * Explicit BYO override (any one is enough):
 *   - `opts.byo === true`
 *   - `opts.writeToken` (a caller-supplied static token, including tests)
 *   - `AGENTS_SHARE_BACKEND=byo`
 */

import { PHOENIX_ID_BASE, readSession, type PhoenixSession } from '../identity/client.js';
import { selectStorageBackendKind } from '../storage/selection.js';
import {
  DEFAULT_SHARE_DOMAIN,
  LEGACY_MANAGED_SHARE_DOMAINS,
  readShareConfig,
  readWriteToken,
  readWriteTokenEnv,
  type ShareConfig,
} from './config.js';

export type ShareBackendKind = 'managed' | 'byo';

export interface ShareBackend {
  kind: ShareBackendKind;
  /** Public base URL of the share Worker, no trailing slash. */
  baseUrl: string;
  /** Bearer sent as `Authorization`. Phoenix access_token or WRITE_TOKEN. */
  token: string;
  /** URL namespace prefix (`<namespace>/<slug>`). Phoenix handle (email local-part) or GitHub username. */
  namespace: string;
}

export interface ResolveShareBackendOpts {
  /** Force the BYO Cloudflare path even when signed in. */
  byo?: boolean;
  /** Override the namespace (BYO: GitHub username; ignored on managed — the
   * worker 403s a Phoenix PUT whose first segment is not the verified handle). */
  githubUser?: string;
  /** DI seam — a static write token selects BYO. */
  writeToken?: string;
  /** DI seam — persisted BYO endpoint config. */
  config?: ShareConfig;
  /** DI seam — override `readSession()`. `null` means signed out. */
  session?: PhoenixSession | null;
  /**
   * When false, BYO may resolve without a WRITE_TOKEN. Public GET routes
   * (list / revisions / status) don't need one; publish and delete do.
   * Default true.
   */
  requireToken?: boolean;
}

/** Env var that forces the BYO path. Value must be exactly `byo`. */
export const SHARE_BACKEND_ENV = 'AGENTS_SHARE_BACKEND';

/** URL-safe namespace: lowercase `[a-z0-9-]+`. Matches the Worker's sanitize.
 *
 * This is URL-safety, not collision-resistance: two values that differ only
 * in case or punctuation share a prefix. */
export function sanitizeShareNamespace(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Public managed-share handle from a verified email.
 *
 * `muqsitnawaz@gmail.com` → `muqsitnawaz`. Plus-tags are dropped
 * (`muqsitnawaz+dev@gmail.com` → `muqsitnawaz`) so the URL stays the
 * account's default name. Empty / missing email → `''` (caller falls
 * back to userId). Must match the Worker `handleFromEmail`.
 */
export function handleFromEmail(email: string | undefined): string {
  if (!email) return '';
  const local = email.split('@')[0] ?? '';
  const beforePlus = local.split('+')[0] ?? local;
  return sanitizeShareNamespace(beforePlus);
}

/** Managed URL namespace: email handle, else sanitized userId (never empty if either is set). */
export function managedShareHandle(session: Pick<PhoenixSession, 'email' | 'userId'>): string {
  return handleFromEmail(session.email) || sanitizeShareNamespace(session.userId ?? '');
}

export function managedShareBaseUrl(): string {
  return `https://${DEFAULT_SHARE_DOMAIN}`;
}

function shareEndpointHost(value: string): string {
  return value.replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
}

/**
 * True when this config is the platform managed endpoint (`share.getrush.ai`, or a
 * legacy alias — `share.agents-cli.sh` / `artifacts.prix.dev` — still bound to the
 * same Worker). The
 * deploy path uses this — not "the caller is signed in" — to decide whether to
 * bind `PHOENIX_ID_BASE` on the Worker.
 */
export function isManagedShareEndpoint(cfg: { baseUrl?: string; domain?: string }): boolean {
  const managedHosts = new Set(
    [DEFAULT_SHARE_DOMAIN, ...LEGACY_MANAGED_SHARE_DOMAINS].map((h) => h.toLowerCase()),
  );
  if (cfg.domain && managedHosts.has(shareEndpointHost(cfg.domain))) return true;
  if (cfg.baseUrl && managedHosts.has(shareEndpointHost(cfg.baseUrl))) return true;
  return false;
}

/**
 * Phoenix ID URL to bind on a managed Worker deploy. `undefined` for a
 * pure-BYO Worker (WRITE_TOKEN only). Fail loud if this is a managed deploy
 * but the base is empty — never skip-set a blank secret.
 */
export function phoenixIdBaseForDeploy(
  opts: { managed?: boolean } = {},
  cfg?: { baseUrl?: string; domain?: string },
): string | undefined {
  const managed = opts.managed === true || (cfg != null && isManagedShareEndpoint(cfg));
  if (!managed) return undefined;
  const base = PHOENIX_ID_BASE.replace(/\/+$/, '').trim();
  if (!base) {
    throw new Error(
      'Managed share deploy requires PHOENIX_ID_BASE so the Worker can verify Phoenix bearers. Set the PHOENIX_ID_BASE env var.',
    );
  }
  return base;
}

/**
 * Managed collaboration backend config to bind on a managed Worker deploy
 * (PHNX-3835): `PRIX_ARTIFACT_COLLAB_BASE` (the Prix artifact-collaboration API
 * base) and `ARTIFACT_COLLAB_SERVICE_TOKEN` (the service credential the Worker
 * sends as `Authorization: Bearer`, NEVER surfaced to the browser). Both are read
 * from the deploy environment.
 *
 * Deliberately dormant-by-default: the two secrets are applied ONLY when BOTH are
 * present. Until the Prix API counterpart is live an operator leaves them unset,
 * and the Worker fails `/__collab` closed (404) with the artifact page GET
 * unaffected. A pure-BYO endpoint never gets them (it has no Phoenix identity).
 * Unlike `phoenixIdBaseForDeploy` this never throws on absence — collaboration is
 * additive, not required for a working managed deploy.
 */
export function collabConfigForDeploy(
  opts: { managed?: boolean } = {},
  cfg?: { baseUrl?: string; domain?: string },
): { collabBase?: string; collabServiceToken?: string } {
  const managed = opts.managed === true || (cfg != null && isManagedShareEndpoint(cfg));
  if (!managed) return {};
  const base = (process.env.PRIX_ARTIFACT_COLLAB_BASE || '').replace(/\/+$/, '').trim();
  const token = (process.env.ARTIFACT_COLLAB_SERVICE_TOKEN || '').trim();
  if (!base || !token) return {};
  return { collabBase: base, collabServiceToken: token };
}

/**
 * The share surface's BYO-override signals: an explicit `--byo`, a
 * caller-supplied static write token, or `AGENTS_SHARE_BACKEND=byo`. Detecting
 * WHICH signals count is surface-specific; the managed-vs-BYO decision itself is
 * the shared policy (`selectStorageBackendKind`). A persisted BYO endpoint config
 * is deliberately NOT an override here — a signed-in user with a stale BYO config
 * still publishes to managed unless they opt out explicitly (the product's
 * managed-first contract).
 */
function shareByoOverride(opts: ResolveShareBackendOpts): boolean {
  if (opts.byo === true) return true;
  if (opts.writeToken) return true;
  return (process.env[SHARE_BACKEND_ENV] ?? '').trim().toLowerCase() === 'byo';
}

/**
 * Pick the principal via the shared selection policy. Signed-in AND no explicit
 * BYO override → managed; otherwise BYO.
 */
export function shouldUseManaged(opts: ResolveShareBackendOpts = {}): boolean {
  return (
    selectStorageBackendKind({ byoOverride: shareByoOverride(opts), session: opts.session }) ===
    'managed'
  );
}

export function resolveShareBackend(opts: ResolveShareBackendOpts = {}): ShareBackend {
  if (shouldUseManaged(opts)) {
    const session = opts.session === undefined ? readSession() : opts.session;
    if (!session) {
      throw new Error("Not signed in. Run 'agents auth login'.");
    }
    return resolveManagedBackend(session);
  }
  return resolveByoBackend(opts);
}

function resolveManagedBackend(session: PhoenixSession): ShareBackend {
  if (!session.access_token) {
    throw new Error("Not signed in. Run 'agents auth login'.");
  }
  const namespace = managedShareHandle(session);
  if (!namespace) {
    throw new Error("Signed in but the session has no email or user id. Run 'agents auth login' again.");
  }
  return {
    kind: 'managed',
    baseUrl: managedShareBaseUrl(),
    token: session.access_token,
    namespace,
  };
}

function resolveByoBackend(opts: ResolveShareBackendOpts): ShareBackend {
  const cfg = opts.config ?? readShareConfig();
  if (!cfg) {
    throw new Error(
      "Not set up yet. Run 'agents auth login' to publish on the managed endpoint (zero Cloudflare setup), or 'agents artifacts setup' / 'agents artifacts share join' for your own Cloudflare.",
    );
  }
  const token =
    opts.writeToken ??
    (opts.requireToken === false ? (readWriteTokenEnv() ?? '') : readWriteToken());
  // Namespace is the GitHub username. An explicit --github-user is sanitized
  // here; otherwise publish fills it via resolveShareUsername (gh/git config).
  const namespace = opts.githubUser ? sanitizeShareNamespace(opts.githubUser) : '';
  return {
    kind: 'byo',
    baseUrl: cfg.baseUrl.replace(/\/+$/, ''),
    token,
    namespace,
  };
}
