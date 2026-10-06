- **Browser rows on the feed now act through the standalone `browser` CLI, and the
  AGI Menu floor is 1.14.6 (PHNX-4227).** In `agents feed watch --json`, a live
  browser row's `showCommand` and `closeCommand` now carry `command: "browser"`
  with the same argv minus the `browser` group word (`browser done --task <name>`,
  `browser tab focus <id> --task <name>`). `runOn`, borrowed-tab handling, and the
  rule that computer rows never get a close control are unchanged. `agents menubar`
  now installs AGI Menu 1.14.6 or newer, the first build that runs either command.
  Source: `cli/src/lib/feed/tools.ts`, `cli/src/lib/helper-versions.ts`.
