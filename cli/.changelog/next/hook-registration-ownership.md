- **Hooks no longer run twice after a sync.** Hook registrations are now matched to the
  manifest by event, matcher and command, and any copy agents-cli wrote into another version
  home or account slot is treated as its own and dropped. Before, a Claude or Codex account
  slot kept the version-home registrations it carried forward next to its own, so every
  Stop, SessionStart and prompt hook ran twice in an account session, and hooks deleted from
  the source repos (or from a removed version) stayed registered. A hook whose script serves
  several events (feed-publish) also kept a direct registration beside its shim, which ran it
  twice on AskUserQuestion. The next sync removes the extra entries. Source:
  `cli/src/lib/hooks/install.ts`.
