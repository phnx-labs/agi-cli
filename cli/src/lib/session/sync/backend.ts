/**
 * SessionsBackend — the token-source seam for `agents sessions export --to-r2` /
 * `import --from-r2`.
 *
 * Two legitimate principals, picked once at backup time through the ONE shared
 * managed-vs-BYO policy (`selectStorageBackendKind`):
 *
 *   - **managed**: the caller is signed in to Phoenix (`readSession()`), no
 *     explicit BYO override. Token is the Phoenix access_token; endpoint is the
 *     managed `sessions.agents-cli.sh` Worker; the namespace is the verified
 *     userId. ZERO Cloudflare setup — the user never provisions an r2.backups
 *     bucket. This is the whole point of the surface (the sessions analogue of
 *     managed `agents traces sync`).
 *   - **byo**: the existing `r2.backups` secrets bundle (`loadR2Config()`).
 *     Unchanged for power users / self-hosters / a zero-knowledge backup that
 *     Phoenix can never read.
 *
 * MANAGED-FIRST — the mere PRESENCE of an r2.backups bundle is NOT a BYO
 * override. A signed-in user with a stale r2.backups bundle still backs up to
 * managed unless they opt out explicitly: `--byo`, `AGENTS_SESSIONS_BACKEND=byo`,
 * or a DI write token. This mirrors the artifact-share backend contract (a
 * persisted BYO config is deliberately not an override) so the product's
 * managed-first contract is identical across surfaces.
 */

import { readSession, type PhoenixSession } from '../../identity/client.js';
import { selectStorageBackendKind } from '../../storage/selection.js';
import { loadR2Config, type R2Config } from './config.js';
import { managedSessionsBaseUrl } from './managed-config.js';

/** Env var that forces the BYO path. Value must be exactly `byo`. */
export const SESSIONS_BACKEND_ENV = 'AGENTS_SESSIONS_BACKEND';

interface ManagedSessionsBackend {
  kind: 'managed';
  /** Public base URL of the managed sessions Worker, no trailing slash. */
  baseUrl: string;
  /** Bearer sent as `Authorization`. The Phoenix access_token. */
  token: string;
  /** Phoenix userId — the object-store namespace prefix (path segment 0). */
  userId: string;
}

interface ByoSessionsBackend {
  kind: 'byo';
  /** The resolved r2.backups credentials for the S3-compatible client. */
  r2: R2Config;
}

type SessionsBackend = ManagedSessionsBackend | ByoSessionsBackend;

interface ResolveSessionsBackendOpts {
  /** Force the BYO r2.backups path even when signed in. */
  byo?: boolean;
  /** DI seam — a static write token selects BYO (tests / self-host). */
  writeToken?: string;
  /** DI seam — override `readSession()`. `null` means explicitly signed out. */
  session?: PhoenixSession | null;
}

/**
 * The sessions surface's BYO-override signals: an explicit `--byo`, a
 * caller-supplied static write token, or `AGENTS_SESSIONS_BACKEND=byo`. Detecting
 * WHICH signals count is surface-specific; the managed-vs-BYO decision itself is
 * the shared policy. A persisted r2.backups bundle is deliberately NOT an
 * override — a signed-in user still backs up to managed unless they opt out.
 */
function sessionsByoOverride(opts: ResolveSessionsBackendOpts): boolean {
  if (opts.byo === true) return true;
  if (opts.writeToken) return true;
  return (process.env[SESSIONS_BACKEND_ENV] ?? '').trim().toLowerCase() === 'byo';
}

/** True when the shared policy resolves to the managed principal for sessions. */
export function shouldUseManagedSessions(opts: ResolveSessionsBackendOpts = {}): boolean {
  return (
    selectStorageBackendKind({ byoOverride: sessionsByoOverride(opts), session: opts.session }) ===
    'managed'
  );
}

/**
 * Resolve the backend for a session backup / restore. Managed when signed in and
 * no explicit BYO override; otherwise BYO. Fails loud when neither principal can
 * authenticate — the actionable message ("run auth login" or "add r2.backups")
 * lives here, not in the shared policy.
 */
export function resolveSessionsBackend(opts: ResolveSessionsBackendOpts = {}): SessionsBackend {
  // Resolve identity ONCE. Reading it for selection and then again for the
  // backend creates a race where logout can flip the principal mid-preflight.
  const session = opts.session === undefined ? readSession() : opts.session;
  const explicitByo = sessionsByoOverride(opts);
  if (selectStorageBackendKind({ byoOverride: explicitByo, session }) === 'managed') {
    if (!session) {
      throw new Error("Not signed in. Run 'agents auth login' to back up sessions to your Phoenix account.");
    }
    if (!session.access_token) {
      throw new Error("Session has no access token. Run 'agents auth login' again.");
    }
    const userId = (session.userId ?? '').trim();
    if (!userId) {
      throw new Error("Signed in but the session has no user id. Run 'agents auth login' again.");
    }
    return { kind: 'managed', baseUrl: managedSessionsBaseUrl(), token: session.access_token, userId };
  }
  // BYO: the existing r2.backups bundle. loadR2Config throws an actionable error
  // when the bundle is missing or locked.
  try {
    return { kind: 'byo', r2: loadR2Config() };
  } catch (err) {
    // A user who is simply signed out (not an explicit --byo) and has no bundle
    // should hear about the zero-setup managed path FIRST, then the BYO one.
    if (!explicitByo) {
      throw new Error(
        "Not signed in, and no r2.backups bucket is configured. Run 'agents auth login' to " +
        'back up to the managed Phoenix store (zero setup), or add the r2.backups bundle to ' +
        'use your own bucket: agents secrets add r2.backups R2_ACCOUNT_ID R2_BUCKET_NAME R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY',
      );
    }
    throw err;
  }
}
