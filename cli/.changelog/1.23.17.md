- **A worker with one stale account and the rest unknown now launches.** `balanced`
  routing refused with `NO_VERIFIED_USAGE` whenever any account's usage was stale, even
  when every other account simply had no usage number yet. It now refuses only when
  every account is stale, as documented; a pool with unknown-usage accounts picks one
  and relies on the existing failover if it is rejected. Source:
  `cli/src/lib/accounting/rotate.ts`.
