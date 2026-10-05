
import { readMeta } from './state.js';
import {
  bundleExistsSync as bundleExists,
  readAndResolveBundleEnvSync as readAndResolveBundleEnv,
} from './secrets-client.js';

const SHARE_BUNDLE = 'share';
const SHARE_TOKEN_KEY = 'WRITE_TOKEN';
const SHARE_TOKEN_ENV_KEY = 'SHARE_WRITE_TOKEN';

function nonempty(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

function hasShareEndpoint(): boolean {
  return !!nonempty(readMeta().share?.baseUrl);
}

function readWriteTokenEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const token = env[SHARE_TOKEN_ENV_KEY]?.trim();
  return token ? token : null;
}

export function shareRuntimeEnv(): Record<string, string> | undefined {
  if (!hasShareEndpoint()) return undefined;
  const fromEnv = readWriteTokenEnv();
  if (fromEnv) return { [SHARE_TOKEN_ENV_KEY]: fromEnv };
  try {
    if (!bundleExists(SHARE_BUNDLE)) return undefined;
    const { env } = readAndResolveBundleEnv(SHARE_BUNDLE, {
      caller: 'share',
      keys: [SHARE_TOKEN_KEY],
      agentOnly: true,
    });
    const token = env[SHARE_TOKEN_KEY];
    return token ? { [SHARE_TOKEN_ENV_KEY]: token } : undefined;
  } catch {
    return undefined;
  }
}
