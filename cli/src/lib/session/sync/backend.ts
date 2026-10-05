/** SessionsBackend: token-source seam for `sessions export --to-r2` / `import --from-r2`. Managed
 * (Phoenix sign-in, `sessions.agents-cli.sh`) comes first: an r2.backups bundle alone is NOT a BYO
 * override; only `--byo`, AGENTS_SESSIONS_BACKEND=byo or a DI write token. BYO is zero-knowledge. */

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

/** The sessions BYO-override signals: `--byo`, a caller-supplied write token, or
 * `AGENTS_SESSIONS_BACKEND=byo`. Which signals count is surface-specific; the decision is the
 * shared policy. A persisted r2.backups bundle is deliberately not an override. */
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

/** Resolve the backend for a session backup/restore: managed when signed in with no BYO
 * override, else BYO. Fails loud when neither can authenticate; the actionable message lives
 * here, not in the shared policy. */
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
