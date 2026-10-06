- **Browser rows on the feed read the engine's native task history (PHNX-4227).**
  `agents feed watch --json`, `agents browser sessions` and the browser picker now
  include tasks recorded in `~/.agents/.history/browser/history.db`, which
  browser-cli 0.1.16+ writes. Values from native history take precedence over
  agents' own `browser_sessions` row, which fills in whatever native history does
  not record.
  - A finished task that captured nothing still has a row.
  - After its tabs close, a task keeps its session link, start time, recorded
    capture counts, and the machine it ran on.
  - Browser rows carry new optional `machine`, `captureDir`, and `capturesRemote`
    fields.
  - Both stores are read-only, and the feed no longer prunes `sessions.db` on
    every refresh.
  - An unreadable history record keeps the existing rows instead of removing them.
  - Action commands are unchanged (`command: "agents"`).
  Source: `cli/src/lib/browser/sessions-list.ts`, `cli/src/lib/feed/tool-activity.ts`,
  `cli/src/lib/feed/tools.ts`, `cli/src/lib/sqlite.ts`.
