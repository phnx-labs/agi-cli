/**
 * R2 credential resolution + this machine's stable identity. Two consumers read
 * these fields: `agents sessions export --encrypt` / `import` use only the shared
 * `R2_SYNC_ENC_KEY` transcript key (`resolveSyncEncKey`), falling back to an
 * ephemeral key when no bundle is configured; and the off-box backup target
 * (`agents sessions export --to-r2` / `import --from-r2`, RUSH-2437) uses the full
 * credential set (account/bucket/access keys/endpoint) to talk to R2 through the
 * network client in `./r2.ts`. The `--to-r2`/`--from-r2` paths gate on
 * `isSyncConfigured()` and fail loud when the bundle is absent (no silent
 * fallback). This is a pure on-demand backup target, NOT the retired R2/CRDT
 * background sync. Credentials come from the `r2.backups` secrets bundle (OS
 * keychain on macOS, libsecret on Linux) — never from env or disk.
 */

import { readAndResolveBundleEnvSync } from '../../secrets-client.js';

/** Secrets bundle holding the R2 credentials. */
export const SYNC_BUNDLE = 'r2.backups';

export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** S3-compatible endpoint for the account (no bucket, no trailing slash). */
  endpoint: string;
  /**
   * Shared 32-byte key (hex or base64) for client-side transcript encryption,
   * held in the bundle as `R2_SYNC_ENC_KEY`. Optional and deliberately separate
   * from the R2 credentials so rotating the access token never orphans already
   * encrypted bundles. `agents sessions export --encrypt` prefers this key when
   * present, else mints and prints an ephemeral one — see transcript-crypto.ts.
   */
  syncEncKey?: string;
}

/**
 * Resolve R2 credentials from the `r2.backups` bundle. Throws a clear,
 * actionable error if the bundle or any key is missing — sync cannot proceed
 * without real credentials (no silent fallback).
 */
function resolveR2Config(): R2Config {
  // Session-sync is a BACKGROUND read: the daemon's ~90s cycle (and the ~2-min
  // watchdog) resolve this on their own, never at a human's request — so it must
  // NEVER pop a Touch ID sheet, on the interactive launcher included (SEC-13: an
  // agent launch never raises biometry on its own). The read is always
  // `agentOnly`: a `never`/no-ACL or broker-held `r2.backups` bundle resolves
  // silently; a locked `hold`/`always` bundle THROWS the actionable "unlock
  // r2.backups" message instead of prompting. isSyncConfigured catches that throw
  // and degrades to no-transport (sync disabled) with no prompt and no crash —
  // unlock once (`agents secrets unlock r2.backups`) or set it no-ACL
  // (`agents secrets policy r2.backups never`) for silent zero-friction sync.
  const { env } = readAndResolveBundleEnvSync(SYNC_BUNDLE, { caller: 'session-transport', agentOnly: true });
  const accountId = env.R2_ACCOUNT_ID?.trim();
  const bucket = env.R2_BUCKET_NAME?.trim();
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
  const syncEncKey = env.R2_SYNC_ENC_KEY?.trim() || undefined;

  const missing = [
    !accountId && 'R2_ACCOUNT_ID',
    !bucket && 'R2_BUCKET_NAME',
    !accessKeyId && 'R2_ACCESS_KEY_ID',
    !secretAccessKey && 'R2_SECRET_ACCESS_KEY',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(
      `Session R2 transport: bundle '${SYNC_BUNDLE}' is missing ${missing.join(', ')}. ` +
      `Add them with: agents secrets add ${SYNC_BUNDLE} <KEY>`,
    );
  }

  return {
    accountId: accountId!,
    bucket: bucket!,
    accessKeyId: accessKeyId!,
    secretAccessKey: secretAccessKey!,
    // Default to the account's R2 endpoint; an explicit R2_ENDPOINT override
    // points at any S3-compatible store (MinIO, another provider) — which is
    // also how the feature is verified end-to-end without live R2.
    endpoint: env.R2_ENDPOINT?.trim() || `https://${accountId}.r2.cloudflarestorage.com`,
    syncEncKey,
  };
}

// ── Resolution cache ────────────────────────────────────────────────────────
// The daemon calls isSyncConfigured() + syncSessions() every ~90s. The read is
// now `agentOnly` (resolveR2Config) so it can NEVER pop Touch ID — a locked bundle
// throws a cheap, deterministic "unlock r2.backups" error instead. We still resolve
// at most once per process: a success is memoized for the process lifetime (cleared
// on daemon SIGHUP via clearR2ConfigCache), so subsequent cycles never touch the
// keychain again. A failure (absent bundle, or a LOCKED `hold`/`always` bundle) is
// NOT memoized and never prompts, so it is re-checked each cycle — session-sync
// degrades to no-transport until the bundle is added / unlocked, then picks it up
// promptly with no restart.
//
// The historical prompt-backoff cooldown (a cancelled Touch ID sheet) is gone: with
// agentOnly there is no sheet to cancel, so no failure is prompt-bearing and none
// needs a backoff.
let cachedConfig: R2Config | null = null;

/** Drop the cached resolution so the next call reads the bundle fresh. Called on
 *  daemon SIGHUP (to pick up rotated credentials) and between tests. */
export function clearR2ConfigCache(): void {
  cachedConfig = null;
}

/**
 * Resolve R2 credentials, reading the keychain at most once per process. The
 * read is `agentOnly` (resolveR2Config), so it never prompts: a `never`/no-ACL or
 * broker-held bundle resolves silently and is memoized; a locked `hold`/`always`
 * bundle throws the actionable "unlock r2.backups" error. Throws (not memoized)
 * when the bundle/keys are missing or locked — isSyncConfigured catches the throw
 * and degrades to no-transport.
 */
export function loadR2Config(): R2Config {
  if (cachedConfig) return cachedConfig;
  cachedConfig = resolveR2Config();
  return cachedConfig;
}

/**
 * True when the sync bundle exists and resolves, without throwing. A missing OR
 * locked bundle resolves to false (session-sync degrades to no-transport) and,
 * because the `agentOnly` read never prompts, it is re-checked each cycle — so a
 * later `agents secrets add` / `agents secrets unlock r2.backups` is picked up
 * promptly with no daemon restart. `now` is accepted for a stable test signature
 * but no longer gates a cooldown (there is no prompt-bearing failure to back off).
 */
export function isSyncConfigured(_now: number = Date.now()): boolean {
  if (cachedConfig) return true;
  try {
    loadR2Config();
    return true;
  } catch {
    // Absent or locked bundle — never prompted (agentOnly), so no backoff: keep
    // re-checking each cycle for fast pickup once the bundle is added / unlocked.
    return false;
  }
}

// machineId() and normalizeHost() now live in the dependency-free leaf
// ../../machine-id.ts so low-level modules (state.ts) can use them without an
// import cycle. Re-exported here for existing importers.
export { machineId, normalizeHost } from '../../machine-id.js';
