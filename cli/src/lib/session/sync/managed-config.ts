
export const DEFAULT_SESSIONS_DOMAIN = 'sessions.agents-cli.sh';

export const DEFAULT_SESSIONS_WORKER_NAME = 'agents-sessions';

export const DEFAULT_SESSIONS_BUCKET_NAME = 'agents-sessions';

export function managedSessionsBaseUrl(): string {
  return `https://${DEFAULT_SESSIONS_DOMAIN}`;
}
