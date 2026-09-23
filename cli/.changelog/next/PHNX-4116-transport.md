- **Usage rows and daemon state travel over SSH; the shared user repo carries no daemon state (PHNX-4116).**
  The 15-minute `usage-sync` tick used to commit every device's `devices/<device>/daemon-state.json`
  into the fleet-synced user repo and exchange it under a lock and a 45 s deadline. That grew the
  shared store to 1.1 GiB and 18,358 commits (100% of the last 2,000 were `chore(devices): publish
  <device> daemon state`), one worker's clone fell 10,398 commits behind with `git fetch timed out`
  on every tick, and a box holding a valid setup-token could not be scheduled because a repo was
  bloated. A headed (`personal`/`desktop`) daemon now dials every dialable peer in parallel with
  `agents __usage-ingest --reply` (20 s per peer; a timed-out peer is skipped for that tick), sending
  its own envelope on stdin; the peer merges the usage rows into its cache newest-wins, stores the
  envelope as that peer's file, and prints its own state back, which the headed box stores stamped
  `receivedAt`. Workers never initiate. The placement probe ingests the dispatcher's usage rows on the
  same round-trip, so the chosen worker holds current numbers at dispatch. `agents repo sync user` is
  a plain fetch-and-fast-forward of human-authored resources again; the 8-minute kickoff offset that
  only existed to dodge the repo lock is gone. `__usage-ingest` gains `--reply`; the legacy v1 payload
  from an older headed peer is still accepted. Source: `cli/src/lib/accounting/usage-sync.ts`,
  `cli/src/lib/accounting/usage-ingest.ts`, `cli/src/lib/daemon/usage-sync-service.ts`.
