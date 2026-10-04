- **`agents menubar snapshot --json` names who is signed in, with a profile picture.**
  The snapshot gains a top-level `me` object (`name`, `email`, `github`, `avatarUrl`,
  `avatarSource`) so AGI Menu can show the person instead of initials. When you are
  signed in with `agents auth login`, that session is the person: its name, email and
  picture are used, and your `gh` account adds its login (and fills a missing name or
  picture) only when its public profile email matches the session email. Without a
  Phoenix ID session, the `gh` account supplies everything except the email. `me` is
  null when neither is available. GitHub facts come from `gh api user`, recorded in
  `~/.agents/.cache/github-viewer.json` (no email, only a SHA-256 of the public one).
  A snapshot spawns `gh` only when that record is stale: at most once a day, or once
  an hour after a failed read, which keeps the last good answer. Each spawn is capped
  at 5 seconds. `agents auth login` and `agents auth whoami` now save your Phoenix ID display name,
  and the session file is rewritten atomically and kept at mode 0600.
  Source: `cli/src/lib/menubar/snapshot.ts`, `cli/src/lib/github/viewer.ts`.
