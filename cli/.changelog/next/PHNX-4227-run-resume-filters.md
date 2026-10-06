- **`agents run <harness> --resume` takes the session picker's filters (PHNX-4227).**
  A bare `--resume` now accepts `--all`, `--teams`, `--since <time>` and
  `-n/--limit <n>` and passes them to the same picker `agents sessions resume`
  uses, so `agents run claude --resume --all --since 7d` matches
  `agents sessions resume --agent claude --all --since 7d`. The defaults are
  unchanged (this project, last 30 days, 200 rows). The four options are refused
  with `--resume <id>` or without `--resume`, and they are removed from the
  command that resumes the chosen session, so they never reach the harness.
  Anything after `--` is still forwarded verbatim. Source:
  `cli/src/commands/exec.ts`, `cli/src/commands/sessions-resume.ts`.
