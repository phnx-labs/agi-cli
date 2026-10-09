- **Session rows report a rendered artifact as its page (PHNX-4269).** `@phnx-labs/sessions-cli`
  0.7.0: when a session writes `plan.md` and `artifacts render` writes `plan.html` beside it,
  the row's `artifacts` list `plan.html` with its `<title>`, last changed when either file was;
  any listed page carries its title. Rule and memory files an agent edits or names
  (`AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md`, `GEMINI.md`, `MEMORY.md`) are no longer listed.
  The release also stops harness envelopes (`<task-notification>`, `<system-reminder>`) from
  reading as user turns, so a session's title and preview no longer become "Another Claude
  session sent a message", and brings `@phnx-labs/secrets-cli` 0.3.0 in as a sessions-cli
  dependency (session backup). Source: `cli/package.json`.
