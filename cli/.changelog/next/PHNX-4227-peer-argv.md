- **Fleet hops call peers by the canonical `ps` and `daemon index` spellings (PHNX-4227).**
  A session on another device is now stopped there with `agents ps stop <id> --local`
  and detached with `agents ps detach <id> --local`, the fleet roster asks each peer
  for `agents ps --local --json`, and `backfill tools --fleet`/`--device` drives
  each peer with `agents daemon index backfill tools --json --local` plus the same
  filters. Each peer must run a CLI that has these commands: 1.22.121 or newer
  for the `ps` hops, and a release newer than 1.22.122 for the backfill hop.
  An older peer is not detected or worked around: its roster and backfill rows
  read as unreachable, and a stop or detach prints the peer's own unknown-command
  error. The `sessions` spellings still work on this machine. Source:
  `cli/src/commands/sessions-stop.ts`, `cli/src/commands/detach.ts`,
  `cli/src/lib/session/remote-active.ts`, `cli/src/commands/sessions-backfill.ts`.
