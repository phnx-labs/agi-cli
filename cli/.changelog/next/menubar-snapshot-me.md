- **`agents menubar snapshot --json` names who is signed in, with a profile picture.**
  The snapshot gains a top-level `me` object (`name`, `email`, `github`, `avatarUrl`,
  `avatarSource`) so AGI Menu can show the person instead of initials. The picture is
  the Phoenix ID one from `agents auth login` when the session carries an https URL,
  else the GitHub avatar from `gh api user`, else null. Both come from local files: the
  session, and a `github-viewer.json` record under `~/.agents/.cache/` that the snapshot
  refreshes through `gh` at most once a day (hourly after a failure), capped at 5 seconds.
  `me` is null when neither source knows anyone. Source: `cli/src/lib/menubar/snapshot.ts`,
  `cli/src/lib/github/viewer.ts`.
