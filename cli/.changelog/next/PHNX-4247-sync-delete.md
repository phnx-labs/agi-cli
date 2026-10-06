- **`agents sync <repo> --delete` removes what a repo deleted.** A plugin, command or
  skill deleted from a DotAgents repo used to stay installed in agent homes, most
  visibly when a non-interactive sync skipped the resource selection. `--delete`
  trashes the ones whose recorded source is in the named repo and is gone from it,
  unregisters removed plugins from `settings.json`, and keeps everything from other
  repos or installed by hand (`kept: N not from <repo>`). It needs a repo, works
  without a TTY, and previews with `--dry-run`. A sync without `--delete` is
  unchanged. Source: `cli/src/lib/sync-delete.ts`, `cli/src/commands/sync.ts`.
- **`agents sync` no longer hangs without a terminal.** When new resources were
  pending, a sync with no TTY opened the "Sync new resources?" prompt anyway and
  could wait forever (it never resolved under Bun). It now skips the selection,
  syncs nothing new, and says so: `Skipped resource selection for <agent>@<v> (no
  terminal; rerun with --yes to sync new resources)`.
