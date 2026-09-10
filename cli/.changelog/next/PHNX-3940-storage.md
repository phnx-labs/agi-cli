- **Account-first storage, sync, and lifecycle (PHNX-3940).** Sync and resource
  projection now target account slots through a single home-targeted writer,
  `syncResourcesToHome`, instead of detecting and copying a version home's output:
  `agents sync` reconciles every materialized account slot for a harness beside the
  version home, and the version-scoped staleness manifest, project fan-out, and
  resource-pattern defaults stay scoped to the managed installation. `agents accounts
  logout` and legacy attach resolve the account-owned home (its slot first, a legacy
  version home only for an unmigrated account) and never recreate or carry credentials
  into a version-owned home. A binary version switch, update, or uninstall no longer
  copies freshest auth forward or deletes an adopted account's credentials, settings,
  or history once that harness has adopted slots — account state lives outside the
  version tree. `agents accounts migrate` is strengthened, not rebuilt: the final
  active recheck and every home/binary move run under the shared per-installation
  exclusion so a launch that starts after planning is deferred rather than raced; the
  journal is crash-recoverable and an interrupted apply resumes idempotently from it;
  and a legacy home whose account already holds a provisioned slot is preserved inside
  that slot (differing settings and transcripts kept, sessions reindexed) rather than
  trashed. Source: `cli/src/lib/accounts/slots.ts`, `cli/src/lib/accounts/migrate.ts`,
  `cli/src/lib/accounts/add.ts`, `cli/src/lib/installations/versions.ts`,
  `cli/src/lib/installations/shims.ts`, `cli/src/commands/accounts.ts`,
  `cli/src/commands/sync.ts`.
