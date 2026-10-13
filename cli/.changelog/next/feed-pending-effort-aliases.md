- **Session rows say what a session is still waiting on.** `agents feed watch --json`,
  `agents ps watch --json` and `agents ps --json` rows carry `pending`
  (`{subagents, shells, monitors}`, each `[{id, description, startedAtMs}]`): only work running
  now, read from the transcript — subagents whose status is `running`, Claude background shells
  (`run_in_background`, or a call the harness moved to the background) with no completion
  notification and no `TaskStop`, and `Monitor` watches that have not ended or expired. It is
  absent when nothing is pending, and shells and monitors count only while the harness process
  is alive. An `idle` row with `pending` is waiting on itself, not on you; `subAgentCount` is
  still the cumulative total and says nothing about liveness.
  Source: `cli/src/lib/session/pending-work.ts`, `cli/src/lib/session/session-cache.ts`.
- **Rows carry `effort` and `fast` when the transcript records them.** Claude rows take
  `effort` from the latest reply's `effort` and `fast` from its `usage.speed`; Codex rows take
  `effort` from the latest `turn_context`. Each is absent when the session does not say.
  Source: `cli/src/lib/session/pending-work.ts`.
- **Project aliases.** A project definition may list `aliases:` — former names of the project.
  A session that resolves to a former name, or a peer row that still reports one, is filed under
  the current name (`confirmedProject`, the feed's project bucket). Two definitions claiming the
  same alias is an error.
  Source: `cli/src/lib/projects.ts`, `cli/src/lib/feed/watch.ts`, `cli/src/lib/session/remote/watch.ts`.
