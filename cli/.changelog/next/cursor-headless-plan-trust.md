- **A headless Cursor run in plan mode no longer stops on Cursor's workspace trust
  prompt.** `agents run cursor "…" --mode plan`, a Cursor teammate (`agents teams add
  … cursor …`, plan by default), and a plan-mode Cursor routine passed `--plan` without
  `--trust`, so in a directory Cursor had not seen before it printed "Do you trust the
  contents of this directory?" and exited, with no one there to answer. A teammate
  failed in 7 seconds with 0 tools. Headless edit already passed `--trust`; every
  headless mode except skip (which passes `-f`) now does too. `--trust` only accepts the
  configured working directory: it does not bypass tool permissions, and plan stays
  read-only. Interactive runs still prompt. Source:
  `cli/src/lib/harness/adapters/cursor.ts`.
