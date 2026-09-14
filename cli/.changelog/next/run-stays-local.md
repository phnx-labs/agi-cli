- **A bare interactive `agents run <harness>` runs on the machine you typed it on again.**
  Since PHNX-4083 a bare human-facing run (no prompt, real TTY) placed itself like
  `--device auto`, so `agents run claude` on a laptop landed on whichever fleet worker had
  the most headroom, including a Windows box the operator never chose. Placement is now
  opt-in: `--device auto`, `--device <box>`, or the `<harness>@` picker. Headless runs are
  unchanged, and `--local` still pins this machine against a `--where` default. The
  `Run here instead` hint is gone with the default that needed it.
  Source: `cli/src/commands/exec.ts`, `cli/docs/hosts.md`.
