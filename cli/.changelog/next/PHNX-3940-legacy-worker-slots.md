- **Workers now materialize a slot for every registered Claude account, not only
  the ones added through the v2 `accounts add` flow (PHNX-3940).** The daemon's
  slot reconciliation skipped any account row without a `workerCredential` field —
  every account registered before the v2 model — on the assumption that a legacy
  row "resolves its token at spawn". That holds for `agents run claude#<name>` but
  not for the interactive picker, so on a worker whose `auth` bundle already held
  all eight setup-tokens `agents run claude --interactive --device auto` listed the
  installed version labels, showed most of them `logged out`, and launching one put
  a Claude login screen on a headless box. `reconcileLocalWorkerSlots` now resolves
  each row through the same `reservedSyncTargets` the push plan uses (a v2 row's
  reserved `__claude__` key, a legacy row's email-keyed `auth` token), so every
  account whose token is on the box gets a `durable` slot with a 0600
  `.oauth_token` and the seeded identity the adapter injects from. Two related
  fixes ride along: the credential publisher is now a ready **headed** device
  (`electPublisher`, headed-first then by name) instead of the alphabetically first
  ready box, which had made a worker the fleet's source of truth; and slot
  reconciliation runs first in the `auth-sync` tick, so a failed shared-state git
  exchange no longer postpones local provisioning. Source:
  `cli/src/lib/secrets/reserved-sync.ts`, `cli/src/lib/daemon/auth-sync-service.ts`.
