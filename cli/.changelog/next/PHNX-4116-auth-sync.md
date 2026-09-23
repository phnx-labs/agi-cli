- **`auth-sync` credential pushes plan per peer off that peer's own first-hand reply, with no fleet-wide freshness gate (PHNX-4116).**
  The daemon's `auth-sync` tick no longer skips **every** credential push when the newest fleet exchange goes
  stale — the old `readLastSuccessfulExchangeMs` marker and its "skipping credential push … need one within
  900s" WARN are gone. Each push now reads the peer's own `receivedAt`-stamped daemon-state reply: reserved-key
  presence comes from the peer's per-account verdict rows (`accounts.rows`), so a key removed on a worker flips
  its next verdict to `missing` and the push resumes within a tick — which the retired publisher-side delivery
  memo could never see. A peer that has never replied is skipped this tick and logged at INFO, not WARN. The
  push stays idempotent, so a stale reply is safe. No user-visible surface change; workers converge faster and
  a briefly-quiet exchange no longer stalls provisioning. Source: `cli/src/lib/daemon/auth-sync-service.ts`,
  `cli/src/lib/secrets-policy.ts`.
