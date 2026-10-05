
import { readSession } from '../identity/client.js';
import { selectStorageBackendKind } from '../storage/selection.js';

export const DEFAULT_TRACES_DOMAIN = 'traces.agents-cli.sh';

export interface TracesBackend {
  baseUrl: string;
  token: string;
  userId: string;
}

export function resolveTracesBackend(): TracesBackend {
  const envBase = (process.env['AGENTS_TRACES_BASE_URL'] ?? '').replace(/\/+$/, '').trim();
  const envToken = (process.env['AGENTS_TRACES_WRITE_TOKEN'] ?? '').trim();

  const byoOverride = Boolean(envBase && envToken);
  if (selectStorageBackendKind({ byoOverride }) === 'byo') {
    if (byoOverride) {
      return { baseUrl: envBase, token: envToken, userId: 'byo' };
    }
    throw new Error("Not signed in. Run 'agents auth login' to sync traces to your Phoenix account.");
  }

  const session = readSession();
  if (!session) {
    throw new Error("Not signed in. Run 'agents auth login' to sync traces to your Phoenix account.");
  }
  if (!session.access_token) {
    throw new Error("Session has no access token. Run 'agents auth login' again.");
  }
  const userId = (session.userId ?? '').trim();
  if (!userId) {
    throw new Error("Signed in but the session has no user id. Run 'agents auth login' again.");
  }
  return {
    baseUrl: managedTracesBaseUrl(),
    token: session.access_token,
    userId,
  };
}

export function managedTracesBaseUrl(): string {
  return `https://${DEFAULT_TRACES_DOMAIN}`;
}
