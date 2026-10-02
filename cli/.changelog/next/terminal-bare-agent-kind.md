- **An editor terminal now follows a `claude` restarted by hand (PHNX-4218).** After
  `/exit`, running `claude` again in the same tab starts it without a launcher, so the
  SessionStart hook records its session with an empty agent kind, and the active scan
  skipped that record. The tab kept the old session. The scan now takes the kind
  from the process name when the record has none. Source:
  `cli/src/lib/session/active.ts`.
