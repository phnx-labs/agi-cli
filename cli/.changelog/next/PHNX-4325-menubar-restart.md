- **`agents menubar restart [--json]` restarts the running AGI Menu (PHNX-4325).** It runs
  `launchctl kickstart -k` on the AGI Menu login item in its own session, so the restart
  finishes even when AGI Menu itself asked for it, then waits up to 15 seconds for exactly
  one new process. JSON reports `outcome` (`restarted` or `failed`), `previousPids`, `pids`
  and `detail`; a turned-off AGI Menu, a failed kickstart, or no new process exits 1 with
  the reason. AGI Menu's Settings and right-click menu call it. Source:
  `cli/src/lib/menubar/install-menubar.ts`, `cli/src/commands/menubar.ts`.
