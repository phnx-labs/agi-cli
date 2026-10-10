- **`agents ps preview <id>` shows the rich session card (PHNX-4227).** It is the
  same command as `agents sessions preview` with the same flags, JSON envelope,
  durable remote-preview cache and exit codes; `sessions preview` and
  `sessions --preview` keep working unchanged, and peers are still asked with the
  old `sessions preview` argv so a not-yet-upgraded device answers. Source:
  `cli/src/commands/ps.ts`, `cli/src/lib/session/presentation.ts`.
