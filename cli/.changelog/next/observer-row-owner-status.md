- **`agents ps` drops a dead offloaded tab once its owner answers.** A desktop editor
  tab bound to a session that runs on a fleet worker used to list as its own
  `unknown` session (37 rows on one desktop) even after the worker answered the
  sweep and reported no such live session. The worker is the authority for what
  runs there, so the fleet merge now drops that tab's row when the worker answered
  and lacks the session; a live session still shows as one row with the worker's
  status, and a worker that went unheard still leaves the tab as `unknown`, never
  running. Same rule `agents feed watch` already applied. Source:
  `cli/src/commands/ps-roster.ts`, `cli/src/lib/remote-agents-json.ts`.
