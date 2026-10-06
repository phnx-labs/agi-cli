- **`agents cloud transcripts [selector]` reads captured Rush Cloud run transcripts (PHNX-4227).**
  It lists runs, or renders the one matching an id, short id, or id prefix, with
  the same `--json`, `--markdown`, `--no-redact`, `--include`/`--exclude`,
  `--first`/`--last` and `--limit` (default 50) behavior as `agents sessions --cloud`,
  which now runs the same handler and stays registered. A failed login or an
  unmatched or ambiguous selector exits 1 without falling back to local sessions.
  Source: `cli/src/commands/cloud-transcripts.ts`, `cli/src/commands/cloud.ts`.
