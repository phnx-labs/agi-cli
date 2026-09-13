/**
 * Isolated Cloudflare resource choices for the managed session-backup store.
 *
 * The managed sessions backend is the Phoenix-gated, zero-setup path behind
 * `agents sessions export --to-r2` / `import --from-r2` for a signed-in user —
 * the sessions analogue of the managed `agents traces sync` store. A signed-in
 * user never has to provision their own `r2.backups` bucket; the CLI talks to
 * this already-live Worker under their Phoenix bearer.
 *
 * Mirrors `lib/traces/config.ts` + `managedTracesBaseUrl()`. The endpoint host
 * is its own subdomain (a separate Worker + bucket from traces/share), so the
 * blast radius of a bug or a quota exhaustion is one surface, not three.
 */

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
