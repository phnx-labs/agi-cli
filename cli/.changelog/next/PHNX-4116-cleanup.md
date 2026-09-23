- **Drop stale worker account slots and their credentials (PHNX-4116).** On a
  worker, `reconcileLocalWorkerSlots` now removes any `deviceAccounts.slots`
  record whose account is no longer registered — the leftovers of an older
  account-id generation, each a full HOME carrying a live `.claude/.oauth_token`
  — deleting the 0600 credential while KEEPING the directory (its
  `.claude/projects` holds transcripts) and logging one line per drop. It fails
  closed: an empty or unreadable account registry drops nothing, so a transient
  read can never strip a healthy box's whole slot set. Source:
  `cli/src/lib/secrets-policy.ts`, `cli/src/lib/accounts/slots.ts`.

- **A routine skipped by an overlapping run reads `blocked`, not "wedged"
  (PHNX-4116).** Since there is no longer a "wedged" daemon state, a routine
  whose prior run is still active now reports `blocked: run <id> active since
  <t>` — naming the live run and when it started — instead of the stale "wedged:
  a prior run is still active". Source: `cli/src/commands/routines.ts`.

- **`agents daemon status` no longer calls a worker's absent secrets broker
  `down` (PHNX-4116).** On a box that reads file-backed secret stores (every
  headless worker), an unreachable broker is expected — secrets read one-shot
  with no broker — so the health line now reads `info  secrets agent not running
  (file-backed stores)` instead of `down  secrets broker (unreachable)`. A
  keychain-backed box with no broker is still a real fault and still reads
  `down`. Source: `cli/src/commands/daemon.ts`.
