/** Isolated Cloudflare resource choices for the managed session-backup store, the zero-setup
 * Phoenix-gated path behind `sessions export --to-r2` / `import --from-r2`. Mirrors
 * `lib/traces/config.ts`; its own subdomain, Worker and bucket limit blast radius to one surface. */

/** Managed sessions Worker domain — its own subdomain, separate from traces/share. */
export const DEFAULT_SESSIONS_DOMAIN = 'sessions.agents-cli.sh';

/** Cloudflare Worker name for the managed sessions deployment. */
export const DEFAULT_SESSIONS_WORKER_NAME = 'agents-sessions';

/** R2 bucket name backing the managed sessions Worker. */
export const DEFAULT_SESSIONS_BUCKET_NAME = 'agents-sessions';

/** Public base URL of the managed sessions Worker, no trailing slash. */
export function managedSessionsBaseUrl(): string {
  return `https://${DEFAULT_SESSIONS_DOMAIN}`;
}
