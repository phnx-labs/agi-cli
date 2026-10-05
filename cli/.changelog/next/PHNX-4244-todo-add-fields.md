- **`agents projects todo add` takes a description, assignee, due date and priority
  (PHNX-4244).** `--description`, `--assignee <name|email>`, `--due YYYY-MM-DD` and
  `--priority urgent|high|medium|low|none` back AGI Menu's quick-add form; each beats
  the same field typed in the line (so does `--project` now). The issue still lands in
  the active cycle as Todo with no delegate, so any agent's queue picks it up. A title
  under 3 or over 120 characters, a due date in the past, and a description over
  10,000 characters are refused before anything is created.
  Source: `cli/src/lib/quick-todo.ts`, `cli/src/commands/projects-todo.ts`.
