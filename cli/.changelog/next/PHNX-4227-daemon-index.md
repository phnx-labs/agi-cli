- **`agents daemon index` owns session-index maintenance (PHNX-4227).**
  `agents daemon index roots`, `agents daemon index optimize`, and
  `agents daemon index backfill tools|resources|titles` run the same engines as
  `agents sessions --roots --json`, `sessions optimize`, and `sessions backfill`, in
  the foreground; none of them starts, stops, or restarts the daemon. The backfill
  verbs declare their own filters (`--agent`, `--project`, `--since`, `--until`,
  `--unmanaged`, `--teams`, `--local`, `--fleet`, `--device`, `--json`), so
  `sessions backfill … --help` now lists them too. `daemon index backfill tools
  --device <box>` reaches the backfill coordinator instead of being refused by the
  global `--device` dispatcher, and still drives peers with
  `agents sessions backfill tools --local`, which every released CLI understands.
  A `--since`/`--until` value that is neither a duration nor a date now fails before
  anything is indexed, in both spellings; before, it silently meant "all time".
  The `sessions` spellings are unchanged otherwise.
  Source: `cli/src/commands/daemon-index.ts`, `cli/src/commands/sessions-backfill.ts`,
  `cli/src/commands/sessions-optimize.ts`, `cli/src/lib/hosts/passthrough.ts`.
