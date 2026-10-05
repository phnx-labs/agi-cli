- **See why CI failed, re-run it, and spot a stalled release from `agents projects prs`.**
  `agents projects prs failure <project> --repo <r> --sha <commit> --json` lists each
  failing check on a commit with the error lines of its GitHub Actions job log
  (timestamps, colour and runner cleanup removed, at most 12 lines), and
  `agents projects prs rerun <project> --repo <r> --run-id <id>` re-runs a workflow
  run's failed jobs. Each repository in `prs --json` now carries `release`: the latest
  version tag, when it was cut, how many merges landed since, and the npm version of
  the package it released, so AGI Menu can say "v1.22.121 tagged · npm still 1.22.120".
  Two new AGI Menu preferences, `menubar.menu.prGroupOpen` and
  `menubar.menu.prGroupMerged` (`none`, `type` or `day`), remember how the PR board is
  grouped. All GitHub reads are REST. Source: `cli/src/lib/github/ci-failure.ts`,
  `cli/src/lib/github/release-drift.ts`.
