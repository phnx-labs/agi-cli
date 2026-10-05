
import { readSession, type PhoenixSession } from '../../identity/client.js';
import { selectStorageBackendKind } from '../../storage/selection.js';
import { loadR2Config, type R2Config } from './config.js';
import { managedSessionsBaseUrl } from './managed-config.js';

export const SESSIONS_BACKEND_ENV = 'AGENTS_SESSIONS_BACKEND';

interface ManagedSessionsBackend {
  kind: 'managed';
  baseUrl: string;
  token: string;
  userId: string;
}

interface ByoSessionsBackend {
  kind: 'byo';
  r2: R2Config;
}

type SessionsBackend = ManagedSessionsBackend | ByoSessionsBackend;

interface ResolveSessionsBackendOpts {
  byo?: boolean;
  writeToken?: string;
  session?: PhoenixSession | null;
}

// Managed-first: a stored r2.backups bundle is not an override; only explicit BYO inputs select it.
function sessionsByoOverride(opts: ResolveSessionsBackendOpts): boolean {
  if (opts.byo === true) return true;
  if (opts.writeToken) return true;
  return (process.env[SESSIONS_BACKEND_ENV] ?? '').trim().toLowerCase() === 'byo';
}

export function shouldUseManagedSessions(opts: ResolveSessionsBackendOpts = {}): boolean {
  return (
    selectStorageBackendKind({ byoOverride: sessionsByoOverride(opts), session: opts.session }) ===
    'managed'
  );
}

// Resolve Phoenix identity once so logout cannot switch principals mid-flight.
export function resolveSessionsBackend(opts: ResolveSessionsBackendOpts = {}): SessionsBackend {
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
  try {
    return { kind: 'byo', r2: loadR2Config() };
  } catch (err) {
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
