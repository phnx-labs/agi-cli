- **Publish finished CleanShot recordings as organization artifacts (PHNX-4287).**
  `agents recordings watch [--dir …]` enables a daemon-owned, restart-safe watcher;
  `list [--json]`, `upload <file>`, and `unwatch` expose its ledger and controls.
  Settled MP4/MOV files are transcoded through ffmpeg without changing the original,
  identity-gated to organization accounts, deduplicated across CleanShot re-exports,
  and published through the standalone artifacts CLI with org-only visibility.
  Source: `cli/src/lib/recordings/`, `cli/src/commands/recordings.ts`.
