- **Capture a to-do into Linear from one line: `agents projects todo`.** `add "Renew npm
  token #AGI tomorrow !!"` reads the project, due day and priority from the text and
  creates a Linear issue assigned to you in the active cycle; `list` shows your open
  quick to-dos and anything due today or overdue; `done` closes one; `undo` reopens a
  closed one or cancels a to-do created moments ago. All take `--json`; AGI Menu's Home
  to-do line runs them. Linear is the record: nothing is stored locally. Source:
  `cli/src/lib/quick-todo.ts`.
