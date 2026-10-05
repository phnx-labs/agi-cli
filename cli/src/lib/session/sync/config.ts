/** R2 credential resolution and this machine's identity. `--encrypt`/`import` use only
 * `R2_SYNC_ENC_KEY`; `--to-r2`/`--from-r2` (RUSH-2437) use the full set and fail loud if absent.
 * An on-demand backup target, not the retired CRDT sync. Creds never come from env or disk. */

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
  /** Shared 32-byte key (hex or base64) for client-side transcript encryption, held as
   * `R2_SYNC_ENC_KEY`. Separate from the R2 credentials so token rotation never orphans encrypted
   * bundles. */
  syncEncKey?: string;
}

/** Resolve R2 credentials from the `r2.backups` bundle. Throws an actionable error if the
 * bundle or any key is missing: sync cannot proceed without real credentials. */
function resolveR2Config(): R2Config {
  // Session-sync is a background read, so it must never raise a Touch ID sheet (SEC-13). The read
  // is `agentOnly`: no-ACL or broker-held bundles resolve silently; a locked bundle throws 'unlock
  // r2.backups', which isSyncConfigured catches and degrades to no transport.
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

// Checked every ~90s by the daemon. A success is memoized per process (cleared on SIGHUP via
// clearR2ConfigCache); a failure (absent or locked bundle) is not, so it is re-checked each cycle.
// No prompt-backoff cooldown is needed: `agentOnly` never shows a sheet.
let cachedConfig: R2Config | null = null;

/** Drop the cached resolution so the next call reads the bundle fresh. Called on
 *  daemon SIGHUP (to pick up rotated credentials) and between tests. */
export function clearR2ConfigCache(): void {
  cachedConfig = null;
}

/** Resolve R2 credentials, reading the keychain at most once per process. The `agentOnly` read
 * never prompts; success is memoized, and a missing or locked bundle throws (not memoized),
 * which isSyncConfigured catches. */
export function loadR2Config(): R2Config {
  if (cachedConfig) return cachedConfig;
  cachedConfig = resolveR2Config();
  return cachedConfig;
}

/** True when the sync bundle exists and resolves, without throwing. A missing or locked bundle
 * yields false and is re-checked each cycle, so `agents secrets add`/`unlock r2.backups` is picked
 * up without a restart. */
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
