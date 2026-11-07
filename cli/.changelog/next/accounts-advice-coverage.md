- **`agents accounts usage` no longer recommends a seat count from a few accounts.** With fewer than
  75% of active accounts measured it reports `confidence: none` and names the accounts with no reading,
  where it used to sum the one measured account and say "keep 1 of 8". Readings already in a box's
  usage cache, local or synced from a peer, now count as history, so the table fills without waiting
  for new status-line samples. Source: `cli/src/lib/accounting/advise.ts`, `usage-history.ts`, `usage-sync.ts`.
