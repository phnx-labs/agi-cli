- **A Codex install whose platform binary npm skipped is now caught and repaired (PHNX-4342).**
  Codex 0.162 reports a missing platform package as `Missing optional dependency
  @openai/codex-linux-x64`, which the launch check did not recognize, so it passed a
  dead binary. Updates committed it, the daemon never healed it, and `agents run codex`
  launched it and exited 1 within a fraction of a second, which showed up as
  `Connection to <device> closed.` after `--device auto`. The check now recognizes that
  wording, so the run repairs the install before it launches, and an update that
  produces one rolls back. Its message now quotes the matching line instead of a stack
  frame. Source: `cli/src/lib/installations/versions.ts`.
- **`--device auto` no longer says `no ready harness account` when it never heard back (PHNX-4342).**
  When a worker's readiness probe ran past its 8 second budget, the refusal said the
  worker had no ready account even when it had a signed-in one. It now says
  `readiness probe timed out` and counts it in the retry hint, or `readiness probe did
  not answer` for any other silent failure. A worker that did answer `not ready` now
  shows its own reason, for example `no ready harness account (all signed_out)`. That
  reason was being dropped before it reached the message.
  Source: `cli/src/lib/teams/placement-probe.ts`, `cli/src/lib/smart-launch.ts`.
