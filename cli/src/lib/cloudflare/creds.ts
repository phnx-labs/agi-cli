
import {
  bundleExistsSync as bundleExists,
  readAndResolveBundleEnvSync as readAndResolveBundleEnv,
} from '../secrets-client.js';

export const DEFAULT_CF_BUNDLE = 'cloudflare';

export function readCloudflareCreds(
  bundle = DEFAULT_CF_BUNDLE,
  override?: { apiToken?: string; accountId?: string },
): { apiToken: string; accountId: string } {
  if (override?.apiToken) {
    return { apiToken: override.apiToken, accountId: override.accountId ?? '' };
  }
  if (!bundleExists(bundle)) {
    throw new Error(
      `The '${bundle}' bundle does not exist. ` +
        `Pass credentials directly with --token <t> [--account <id>], or create it: ` +
        `agents secrets add ${bundle} CLOUDFLARE_API_TOKEN`,
    );
  }
  const { env } = readAndResolveBundleEnv(bundle, {

    caller: 'cloudflare',
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
