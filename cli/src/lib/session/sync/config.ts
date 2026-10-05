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

export const SYNC_BUNDLE = 'r2.backups';

export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  syncEncKey?: string;
}

function resolveR2Config(): R2Config {
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
    endpoint: env.R2_ENDPOINT?.trim() || `https://${accountId}.r2.cloudflarestorage.com`,
    syncEncKey,
  };
}

let cachedConfig: R2Config | null = null;

export function clearR2ConfigCache(): void {
  cachedConfig = null;
}

export function loadR2Config(): R2Config {
  if (cachedConfig) return cachedConfig;
  cachedConfig = resolveR2Config();
  return cachedConfig;
}

export function isSyncConfigured(_now: number = Date.now()): boolean {
  if (cachedConfig) return true;
  try {
    loadR2Config();
    return true;
  } catch {
    return false;
  }
}

export { machineId, normalizeHost } from '../../machine-id.js';
