- **`agents ps` gains `--bookmarks`, `--routine [name]` and `ps migrations` (PHNX-4227).**
  `ps --bookmarks` and `ps --routine [name]` (also spelled `--routines`) narrow the
  live roster exactly as `sessions --active --bookmarks` / `--routine` do, and compose
  with `--status waiting`, which still exits 1 when a selected session waits.
  `agents ps migrations [--json] [--session <id>]` reads the same migration ledger as
  `agents sessions migrations`; each spelling's empty-ledger hint and `migrate --help`
  name its own group. `agents sessions migrations --json` now prints JSON: before,
  the parent `sessions --json` consumed the flag and the table printed instead.
  Source: `cli/src/commands/ps.ts`, `cli/src/commands/sessions-migrate.ts`.
