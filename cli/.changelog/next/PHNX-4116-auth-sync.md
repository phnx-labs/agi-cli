- **`auth-sync` credential pushes plan per peer off that peer's own first-hand reply, with no fleet-wide freshness gate (PHNX-4116).**
  The daemon's `auth-sync` tick no longer skips **every** credential push when the newest fleet exchange goes
  stale — the old `readLastSuccessfulExchangeMs` marker and its "skipping credential push … need one within
  900s" WARN are gone. Reserved-key presence on a peer is now `verdict ∧ fingerprint`: the peer's own per-account
  verdict row (`accounts.rows`) must be non-`missing` AND the credential fingerprint (`workerCredential.mintedAt`)
  the publisher last delivered to that peer must match the account's current one. The verdict half is first-hand
  — a key removed on a worker flips its next verdict to `missing` and the push resumes. The fingerprint half
  catches a re-mint: `agents accounts login <harness>#<name>` rotates the reserved key and bumps `mintedAt` while
  the worker's OLD token still authenticates (verdict stays live), so a publisher-side rotation cursor
  (`reserved-sync-delivered.json`, local-only, never synced) re-pushes the new key within one tick instead of
  reading present forever. A peer that has never replied, or whose reply carries no `accounts.rows` field at all
  (an older CLI — fail closed), is skipped this tick and logged at INFO, not WARN. The push stays idempotent, so
  a stale reply is safe. No user-visible surface change; a re-authed account now reaches every worker within a
  tick, and a briefly-quiet exchange no longer stalls provisioning. Source: `cli/src/lib/daemon/auth-sync-service.ts`,
  `cli/src/lib/secrets-policy.ts`.
