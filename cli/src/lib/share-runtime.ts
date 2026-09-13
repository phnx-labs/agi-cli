// Runtime share-token injection for spawned agents.
//
// The artifact share ENGINE moved to `@phnx-labs/artifacts-cli` (PHNX-3992);
// agents-cli no longer publishes artifacts itself. What stays here is the thin
// glue that lets a dispatched agent inherit the operator's BYO write token so
// its own `artifacts share` can publish headlessly: `run`/`teams`/`cloud`
// dispatch call `shareRuntimeEnv()` and forward the result into the agent env.
// artifacts-cli honors the same `SHARE_WRITE_TOKEN` variable, so the injection
// contract is unchanged by the extraction.
//
// The endpoint config still lives in `agents.yaml` under `share:` (Meta.share)
// so a previously-provisioned BYO endpoint keeps syncing fleet-wide; the raw
// write token lives in the keychain-backed `share` secrets bundle, never on disk.

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

/** Best-effort runtime env for spawned agents. Never throws AND never prompts.
 *
 * Auto-injecting the share write token on every `agents run` is a background
 * convenience, NOT a user-initiated secret access — so it MUST NOT raise a Touch
 * ID sheet (SEC-13: an agent launch never pops biometry on its own). The read is
 * always `agentOnly`: it resolves the token only from the injected env or an
 * already-held / no-ACL bundle, and silently returns undefined otherwise (the
 * agent can still publish via its own `artifacts share` credentials). For
 * zero-friction auto-share with no prompt: unlock once (`agents secrets unlock
 * share`) or make it no-ACL (`agents secrets policy share never`). */
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
