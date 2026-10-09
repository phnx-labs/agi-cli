- **Browser and computer history come from the standalone tools (PHNX-4227).**
  `agents sessions --browser` and `agents sessions --computer` are removed: run
  `browser sessions` / `computer sessions` (or `agents browser sessions` /
  `agents computer sessions`) instead. `agents browser sessions` and
  `agents computer sessions` now run the standalone tool's own picker, so their
  flags are the engine's (`--since`, `--until`, `--search`, `--tasks`, `--open`, …).
  The fleet-wide `--device` listing of computer runs went with the alias; run
  `computer sessions` on that box (`agents ssh <box> computer sessions`). The
  browser and computer rows on `agents feed watch --json` are read from
  `browser sessions --tasks --json` and `computer sessions --json`; agents-cli adds
  only the agent-session link, and a missing tool, a failed run, or unreadable
  output keeps the rows already on the stream instead of removing them. The
  `computer` floor in `agents setup tools` is now 0.1.7, the first release whose
  `computer sessions --json` honors `--limit`. A computer row's `agent` now comes
  from the linked session only, since the engine records no harness name.
  agents-cli no longer writes `browser_sessions` / `computer_sessions` rows (the
  engines keep their own history and adopted those tables once) and no longer
  opens the browser events pipe; the tables and migrations stay. `agents computer
  sessions` also runs off macOS, since listing history drives nothing. Source:
  `cli/src/lib/feed/tool-activity.ts`, `cli/src/lib/feed/tools.ts`,
  `cli/src/commands/browser.ts`, `cli/src/commands/computer.ts`,
  `cli/src/commands/sessions.ts`, `cli/src/lib/standalone-tools.ts`,
  `cli/src/lib/browser-client.ts`, `cli/src/lib/computer/record.ts`, `cli/src/lib/session/db.ts`.
