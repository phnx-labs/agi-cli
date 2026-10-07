- **Feed and session watch rows carry a PR's head SHA, title and per-check items,
  and each subagent's model and prompt (PHNX-3939).** On `agents feed watch --json`
  (and `sessions watch --json` for subagents), a live row's `pr` adds `headSha`,
  `title`, and `checkItems` — one `{ name, state, url? }` per check on the head
  commit, `state` being `passed`, `failed`, `running` or `skipped`, a re-run
  check listed once at its latest run, at most 30. They come from the same
  `gh pr view` the row's `checks` verdict already reads; no new GitHub call is
  made. Each `subagents[]` entry adds `model` (the model id its replies report)
  and `prompt` (its first user turn, whitespace-collapsed, at most 400
  characters), read in the existing incremental fold of the child transcript.
  All fields are absent when unknown, so older clients are unaffected.
  Source: `cli/src/lib/feed/pr-status.ts`, `cli/src/lib/session/glance-files.ts`.
