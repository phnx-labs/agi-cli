// Cloudflare API credential glue, shared by the commands that provision or read
// Cloudflare-backed endpoints (`agents traces`, `agents sessions backup`).
//
// This used to live in `lib/share/config.ts` alongside the embedded artifact
// share engine. The share engine moved out to `@phnx-labs/artifacts-cli`
// (PHNX-3992); `readCloudflareCreds` stayed because it is a generic Cloudflare
// util that `traces`/`sessions backup` borrow, unrelated to sharing.

import {
  bundleExistsSync as bundleExists,
  readAndResolveBundleEnvSync as readAndResolveBundleEnv,
} from '../secrets-client.js';

export const DEFAULT_CF_BUNDLE = 'cloudflare';

/** Cloudflare API credentials for provisioning, read from `cloudflare` (or a
 * user-named bundle). Fuzzy-matches key names so it works across bundle layouts. */
export function readCloudflareCreds(
  bundle = DEFAULT_CF_BUNDLE,
  override?: { apiToken?: string; accountId?: string },
): { apiToken: string; accountId: string } {
  // Explicit --token/--account bypass the bundle entirely (robust escape hatch).
  if (override?.apiToken) {
    return { apiToken: override.apiToken, accountId: override.accountId ?? '' };
  }
  // Check existence first: resolving a missing bundle through the process client
  // surfaces an opaque transport code (e.g. LOCKED), never naming the bundle the
  // user typed — so name it here.
  if (!bundleExists(bundle)) {
    throw new Error(
      `The '${bundle}' bundle does not exist. ` +
        `Pass credentials directly with --token <t> [--account <id>], or create it: ` +
        `agents secrets add ${bundle} CLOUDFLARE_API_TOKEN`,
    );
  }
  const { env } = readAndResolveBundleEnv(bundle, {
    caller: 'cloudflare',
    // Setup is still a read; only `agents secrets unlock` may authenticate.
    agentOnly: true,
  });
  const find = (re: RegExp): string => {
    for (const [k, v] of Object.entries(env)) if (re.test(k) && v) return v;
    return '';
  };
  const apiToken = env.CLOUDFLARE_API_TOKEN || env.CF_API_TOKEN || find(/API[_-]?TOKEN|(?:^|_)TOKEN$/i);
  const accountId =
    override?.accountId || env.CLOUDFLARE_ACCOUNT_ID || env.CF_ACCOUNT_ID || find(/ACCOUNT[_-]?ID/i);
  if (!apiToken) {
    const keys = Object.keys(env);
    throw new Error(
      `No Cloudflare API token in the '${bundle}' bundle ` +
        `(keys present: ${keys.length ? keys.join(', ') : 'none'}). ` +
        `Pass it directly with --token <t> [--account <id>], or add it: ` +
        `agents secrets add ${bundle} CLOUDFLARE_API_TOKEN`,
    );
  }
  return { apiToken, accountId };
}
