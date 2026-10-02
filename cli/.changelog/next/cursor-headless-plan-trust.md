- **A headless Cursor run in plan mode now runs in folders Cursor has not seen
  before, and prints its answer.** Two bugs stopped `agents run cursor "…" --mode
  plan`, a Cursor teammate (`agents teams add … cursor …`), and a plan-mode Cursor
  routine from working unattended:
  - They passed `--plan` without `--trust`. In a directory Cursor had not seen,
    Cursor stopped on "Do you trust the contents of this directory?" and exited
    with no one to answer, so a teammate failed in 7 seconds with 0 tools. Every
    headless mode except skip (which passes `-f`) now passes `--trust`. `--trust`
    only accepts the configured working directory and does not bypass tool
    permissions.
  - In `--plan` mode Cursor delivers its answer through its createPlan tool, which
    `-p` text output never prints. A run would read the repo for 3 minutes, exit 0,
    and leave an empty log. A headless plan run now uses Cursor's read-only ask
    mode (`--mode ask`), which refuses file writes the same way and prints its
    answer.

  Interactive Cursor runs keep `--plan` and Cursor's own trust prompt. Source:
  `cli/src/lib/harness/adapters/cursor.ts`.
