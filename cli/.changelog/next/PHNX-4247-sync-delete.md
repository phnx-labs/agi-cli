- **`agents sync <repo> --delete` removes what a repo deleted.** A plugin, command or
  skill deleted from a DotAgents repo used to stay installed in agent homes, most
  visibly when a non-interactive sync skipped the resource selection. `--delete`
  trashes the ones whose recorded source is in the named repo and is gone from it,
  unregisters removed plugins from `settings.json`, and keeps everything from other
  repos or installed by hand (`kept: N not from <repo>`). It needs a repo, works
  without a TTY, and previews with `--dry-run`. A sync without `--delete` is
  unchanged. Source: `cli/src/lib/sync-delete.ts`, `cli/src/commands/sync.ts`.
