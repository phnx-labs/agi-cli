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
- **Routing and picker flags inside a short-option cluster are recognized (PHNX-4227).**
  The option-aware scan behind `--device` routing and the resume picker filters now
  walks a short-option cluster the way Commander does, so `-bn5` and `-bn 5` drop
  only the `-n` limit and keep `-b`, and `-bDpeer` routes to `peer`. A cluster that is
  another option's value, or that follows `--`, is left alone. Source:
  `cli/src/lib/hosts/routing-flag.ts`, `cli/src/lib/hosts/remote-cmd.ts`.
