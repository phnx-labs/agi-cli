// Runtime share-token injection for spawned agents; the share engine moved to artifacts-cli
// (PHNX-3992). Dispatch forwards `shareRuntimeEnv()` (`SHARE_WRITE_TOKEN`) into the agent env.
// The raw write token lives in the keychain-backed `share` bundle, never on disk.

import { readMeta } from './state.js';
import {
  bundleExistsSync as bundleExists,
  readAndResolveBundleEnvSync as readAndResolveBundleEnv,
} from './secrets-client.js';

const SHARE_BUNDLE = 'share';
const SHARE_TOKEN_KEY = 'WRITE_TOKEN';
const SHARE_TOKEN_ENV_KEY = 'SHARE_WRITE_TOKEN';

/** Trim; empty / whitespace-only strings are absent. */
function nonempty(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

/** Whether a BYO share endpoint is still configured in `agents.yaml`. */
function hasShareEndpoint(): boolean {
  return !!nonempty(readMeta().share?.baseUrl);
}

/** The write token as injected ephemerally into fleet/cloud agents. */
function readWriteTokenEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const token = env[SHARE_TOKEN_ENV_KEY]?.trim();
  return token ? token : null;
}

/** Best-effort runtime env for spawned agents; never throws and never prompts. Auto-injecting the
 * share token on `agents run` is background convenience, so it must not raise a Touch ID sheet
 * (SEC-13). The read is `agentOnly` and silently returns undefined otherwise. */
export function shareRuntimeEnv(): Record<string, string> | undefined {
  if (!hasShareEndpoint()) return undefined;
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
