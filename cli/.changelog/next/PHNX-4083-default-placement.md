- **A bare interactive run places itself like `--device auto` (PHNX-4083).**
  `agents run <harness>` with no prompt on a real TTY (no `--json`) now
  auto-places onto a fleet worker — the same engine, pool, and banner as
  `--device auto` — instead of always running on the machine you typed it at;
  headless runs (any prompt, `--json`, teams/routines/hooks) are unchanged and
  still run in place. To keep a local interactive run, pass
  `--device <this machine>` or pick this machine (listed first) in the
  `<harness>@` device picker; when placement finds no healthy device (empty
  pool, or the PHNX-4051 stale-usage refusal) the run fails loud with the
  placement error plus `Run here instead: agents run <harness> --device
  <this machine>` — never a silent local fallback. Source:
  `src/commands/exec.ts`, `src/commands/run-account-picker.ts`.
