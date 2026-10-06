- **`agents insights resources` reports skill and command usage (PHNX-4227).**
  It runs the same report as `agents sessions stats`, which stays registered for
  now: the same flags, the all-time default window, and the same `--json`
  envelope (`schemaVersion: 2`, `kind: "sessions-stats"`). `--agent` works before
  or after `resources`; two different agents exit 1 instead of being merged.
  Source: `cli/src/commands/sessions-stats.ts`, `cli/src/commands/insights.ts`.
