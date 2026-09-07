// Config + credential glue for `agents artifacts share`.
//
// - The endpoint config (base URL, account, worker/bucket names) lives in
//   `agents.yaml` under `share:` (Meta.share) so it syncs fleet-wide via
//   `agents repo push/pull`.
// - The raw write token lives in the `share` secrets bundle (keychain-backed,
//   fleet-injectable) — never on disk in plaintext.
// - The Cloudflare API token (for provisioning) is read from the user's existing
//   `cloudflare` bundle.

import { randomBytes } from 'node:crypto';
import { readMeta, updateMeta } from '../state.js';
import {
  bundleExistsSync as bundleExists,
  keychainRef,
  readAndResolveBundleEnvSync as readAndResolveBundleEnv,
  readBundleSync as readBundle,
  secretsKeychainItem,
  writeBundleWithItemsSync as writeBundleWithItems,
} from '../secrets-client.js';
import type { SecretsBundle } from '../secrets-types.js';

export interface ShareConfig {
  /** Public base, e.g. `https://share.getrush.ai` or `https://agent-share.<acct>.workers.dev`. */
  baseUrl: string;
  accountId: string;
  workerName: string;
  bucketName: string;
  /** Custom domain when mapped (e.g. `share.getrush.ai`). */
  domain?: string;
  /** Cloudflare Web Analytics token injected into published HTML pages. */
  analyticsToken?: string;
  /** sha256 of the Worker script deployed at the last provision/update. Absent
   * on any config written before this field existed — treat that as "unknown",
   * never as "outdated" (there is nothing to compare against). */
  templateHash?: string;
}

export const SHARE_BUNDLE = 'share';
export const SHARE_TOKEN_KEY = 'WRITE_TOKEN';
export const SHARE_TOKEN_ENV_KEY = 'SHARE_WRITE_TOKEN';
export const DEFAULT_CF_BUNDLE = 'cloudflare';
export const DEFAULT_WORKER_NAME = 'agents-share';
export const DEFAULT_BUCKET_NAME = 'agents-share';
// The Rush product share endpoint (PHNX-3960): share.getrush.ai on the product
// domain. Publishing prints this host; bound to the `agents-share` Worker in the
// Phoenix CF account. share.agents-cli.sh + artifacts.prix.dev stay bound as legacy aliases.
export const DEFAULT_SHARE_DOMAIN = 'share.getrush.ai';

// Managed hosts still recognized as "the platform endpoint" for backward
// compatibility. `share.agents-cli.sh` is the pre-PHNX-3960 default: it stays
// attached to the same Worker, so every link already shared on it keeps
// resolving, and a persisted config pointing at it is still treated as managed
// (e.g. for deploy-time PHOENIX_ID_BASE binding). Compared lowercased.
export const LEGACY_MANAGED_SHARE_DOMAINS = ['share.agents-cli.sh', 'artifacts.prix.dev'] as const;

/** The write token may be injected ephemerally into fleet/cloud agents. */
export function readWriteTokenEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const token = env[SHARE_TOKEN_ENV_KEY]?.trim();
  return token ? token : null;
}

/** Trim; empty / whitespace-only strings are absent. */
function nonempty(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

/**
 * Read the persisted endpoint config, or null if there is no `share.baseUrl`.
 *
 * Publish talks only to `baseUrl` with `WRITE_TOKEN`. `accountId` / worker /
 * bucket are provisioning metadata for `setup`/`update`. Requiring all four
 * (and treating `accountId: ""` as missing) made `status` and publish both
 * report "not set up" on an endpoint that still worked — RUSH-2837.
 */
export function readShareConfig(): ShareConfig | null {
  const s = readMeta().share;
  const baseUrl = nonempty(s?.baseUrl)?.replace(/\/+$/, '');
  if (!baseUrl) return null;
  return {
    baseUrl,
    accountId: nonempty(s?.accountId) ?? '',
    workerName: nonempty(s?.workerName) ?? DEFAULT_WORKER_NAME,
    bucketName: nonempty(s?.bucketName) ?? DEFAULT_BUCKET_NAME,
    domain: nonempty(s?.domain),
    analyticsToken: nonempty(s?.analyticsToken),
    templateHash: nonempty(s?.templateHash),
  };
}

/** Persist the endpoint config to `agents.yaml` (syncs across the fleet).
 * Empty strings never overwrite a previously stored value and are not written
 * back as `accountId: ""` (that form made {@link readShareConfig} return null
 * under the old all-fields-required check, and it is still useless). */
export function writeShareConfig(cfg: ShareConfig): void {
  updateMeta((meta) => {
    const prev = meta.share ?? {};
    const next: NonNullable<typeof meta.share> = { ...prev };
    const assign = (key: 'baseUrl' | 'accountId' | 'workerName' | 'bucketName' | 'domain' | 'analyticsToken' | 'templateHash', incoming: string | undefined) => {
      const v = nonempty(incoming);
      if (v) next[key] = v;
    };
    assign('baseUrl', cfg.baseUrl);
    assign('accountId', cfg.accountId);
    assign('workerName', cfg.workerName);
    assign('bucketName', cfg.bucketName);
    assign('domain', cfg.domain);
    assign('analyticsToken', cfg.analyticsToken);
    assign('templateHash', cfg.templateHash);
    for (const key of Object.keys(next) as (keyof typeof next)[]) {
      if (typeof next[key] === 'string' && !nonempty(next[key])) delete next[key];
    }
    return { ...meta, share: next };
  });
}

/** A fresh 32-byte hex write token. */
export function generateWriteToken(): string {
  return randomBytes(32).toString('hex');
}

/** Persist the raw write token into the `share` secrets bundle (keychain-backed,
 * fleet-injectable). Mirrors the add-key sequence in `commands/secrets.ts`. */
export function storeWriteToken(token: string): void {
  let bundle: SecretsBundle;
  try {
    bundle = readBundle(SHARE_BUNDLE);
  } catch {
    bundle = {
      name: SHARE_BUNDLE,
      description: 'agents artifacts share — write token for the R2 share endpoint',
      // A NEW share bundle defaults to the `never` tier (no biometry ACL). The R2
      // write token is low-sensitivity automation infra that is auto-read on EVERY
      // `agents run` (shareRuntimeEnv) — a biometry ACL there is what produced the
      // per-run Touch ID storm. `never` stores it no-ACL so auto-share is silent
      // and needs no unlock. An EXISTING bundle keeps its tier (we never silently
      // downgrade one the user already made); change it explicitly with
      // `agents secrets policy share <tier>`.
      policy: 'never',
      vars: {},
    } as SecretsBundle;
  }
  // writeBundleWithItems decides the ACL (keychain backend) purely from
  // `bundle.policy === 'never'` — the fresh-bundle case above sets it
  // explicitly, and an existing bundle already carries its own explicit tier.
  bundle.vars[SHARE_TOKEN_KEY] = keychainRef(SHARE_TOKEN_KEY);
  const item = secretsKeychainItem(bundle.name, SHARE_TOKEN_KEY);
  writeBundleWithItems(bundle, new Map([[item, token]]));
}

/** Read the raw write token from the `share` secrets bundle. */
export function readWriteTokenFromBundle(): string {
  const { env } = readAndResolveBundleEnv(SHARE_BUNDLE, {
    caller: 'share',
    // Explicit share commands are reads, not authorization to authenticate.
    agentOnly: true,
  });
  const token = env[SHARE_TOKEN_KEY];
  if (!token) {
    throw new Error(
      `No ${SHARE_TOKEN_KEY} in the '${SHARE_BUNDLE}' secrets bundle. ` +
        `Run 'agents artifacts setup' (to provision your own endpoint) or 'agents artifacts share join' (to use an existing one).`,
    );
  }
  return token;
}

/** Read the raw write token from injected env first, then the local bundle.
 * Throws with an actionable message if absent (run setup/join first). */
export function readWriteToken(): string {
  return readWriteTokenEnv() ?? readWriteTokenFromBundle();
}

/** Best-effort runtime env for spawned agents. Never throws AND never prompts.
 *
 * Auto-injecting the share write token on every `agents run` is a background
 * convenience, NOT a user-initiated secret access — so it MUST NOT raise a Touch
 * ID sheet (SEC-13: an agent launch never pops biometry on its own). This was the
 * per-run prompt storm: `share` is a keychain bundle that is rarely broker-held,
 * so an interactive read here spawned the helper and popped Touch ID on EVERY
 * launch. The read is now always `agentOnly` — it resolves the token only from the
 * injected env or an already-held / no-ACL bundle, and silently returns undefined
 * otherwise (the caller runs without auto-share; the agent can still publish via
 * its own `agents artifacts share`). To get zero-friction auto-share with no prompt: unlock
 * once (`agents secrets unlock share`) or make it no-ACL (`agents secrets policy
 * share never`). */
export function shareRuntimeEnv(): Record<string, string> | undefined {
  if (!readShareConfig()) return undefined;
  const fromEnv = readWriteTokenEnv();
  if (fromEnv) return { [SHARE_TOKEN_ENV_KEY]: fromEnv };
  try {
    if (!bundleExists(SHARE_BUNDLE)) return undefined;
    const { env } = readAndResolveBundleEnv(SHARE_BUNDLE, {
      caller: 'share',
      keys: [SHARE_TOKEN_KEY],
      agentOnly: true, // never raise a Touch ID sheet on an agent launch (SEC-13)
    });
    const token = env[SHARE_TOKEN_KEY];
    return token ? { [SHARE_TOKEN_ENV_KEY]: token } : undefined;
  } catch {
    return undefined;
  }
}

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
  // Check existence first (same guard as readShareToken above): resolving a
  // missing bundle through the process client surfaces an opaque transport code
  // (e.g. LOCKED), never naming the bundle the user typed — so name it here.
  if (!bundleExists(bundle)) {
    throw new Error(
      `The '${bundle}' bundle does not exist. ` +
        `Pass credentials directly with --token <t> [--account <id>], or create it: ` +
        `agents secrets add ${bundle} CLOUDFLARE_API_TOKEN`,
    );
  }
  const { env } = readAndResolveBundleEnv(bundle, {
    caller: 'share',
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
