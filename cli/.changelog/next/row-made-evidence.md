- **A row's PR is one the session created, and its Made list shows rendered pages.** A
  `grep 'gh pr create'` whose output held a pull URL made that URL the session's `pr`
  (a plan's `acme/widget/pull/12` example became a PR chip). A create now counts only
  when the command itself runs `gh pr create` (sessions-cli 0.8.10), and schema v54
  re-parses every session that has a PR so a wrong one clears. A live row's artifacts
  now come from every file the session wrote under an agent output folder (created or
  edited, `~/.local/share/agents/artifacts/` included), each shown as its rendered page
  when one sits beside it: `plan.md` and `pr-reviewer.md` read as `plan.html` and
  `pr-reviewer.html`. Source: `cli/src/lib/session/session-cache.ts`, `cli/src/lib/session/db.ts`.
