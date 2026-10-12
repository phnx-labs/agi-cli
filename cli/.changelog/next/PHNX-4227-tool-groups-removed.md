- **`agents browser`, `agents computer`, `agents secrets` and `agents sessions` are removed (PHNX-4227, owner decision 2026-10-12).**
  There is no alias, passthrough or forwarder. Each exits 1 with one line naming
  what to run instead, including under `--help`:
  `error: 'agents browser' was removed; use the standalone 'browser' CLI (browser --help).`
  Call the standalone `browser`, `computer`, `secrets` and `sessions` CLIs directly
  (`agents setup tools` installs the pinned releases). The `sessions` verbs that
  agents-cli owned have homes of their own, and the refusal names them:
  `sessions resume` → `agents run auto --resume <id>`, `sessions --active` → `agents ps`,
  `stop`/`focus`/`detach`/`migrate`/`migrations`/`preview` → `agents ps <verb>`,
  `watch` → `agents ps watch --json`, `inject` → `agents send --channel session`,
  `fork` → `agents fork` (now listed in `--help`), `backfill`/`optimize`/`--roots` →
  `agents daemon index`, `stats` → `agents insights resources`, `insights` →
  `agents insights`, `backup-setup` → `agents setup session-backup`.
  Source: `cli/src/lib/startup/command-registry.ts`, `cli/src/bootstrap.ts`.
- **Fleet peers are asked with the new spellings, so every device needs this release.**
  Selector resolution (what `agents run --resume <id>`, `ps focus` and `ps preview`
  use to find a session on another box) asks the hidden `agents ps resolve <selector>
  --json --local`; launch-id lookup after a `--device` dispatch asks `agents ps resolve
  --launch-id <id>`; remote previews ask `agents ps preview <id> --local --json`; the
  fleet session stream asks `agents ps watch --json --local`. The session picker's
  history pool now asks each peer's standalone `sessions --all --json --local`. A peer
  on an older agents-cli answers with an unknown command and reads as unreachable until
  it updates (auto-update runs within 24 hours).
  Source: `cli/src/commands/ps.ts`, `cli/src/lib/session/selection.ts`,
  `cli/src/lib/session/remote/watch.ts`, `cli/src/commands/sessions-browser.ts`.
- **Session rows recover with `agents ps focus <id>`.** The `recovery` command on
  `agents ps watch --json` and `agents feed watch --json` rows was
  `agents sessions resume <id> --device <owner>`; it is now `agents ps focus <id>`,
  which attaches a live pane or recovers an ended session on its owning device.
  Source: `cli/src/lib/session/remote/watch.ts`, `cli/src/lib/session/projection.ts`.
- **`devices.<name>.computer.host` is removed** with the `agents computer --device`
  path that read it. Drive another desktop with `computer <verb> --host <address>`.
  Source: `cli/src/lib/device-config.ts`, `cli/src/lib/computer-client.ts`.
- **Help, prompts and scripts name the commands that exist.** `--help` for `run`,
  `trace`, `fork` and every `-D/--device` option no longer points at `agents hosts`
  or the removed groups. Agent-facing text
  (the watchdog nudge, the migrate rehydrate prompt, the rotate resume prompt) now
  says `sessions <id>` to read a transcript, and the release and CI scripts call
  `secrets exec` directly.
- **The `agents ps` picker's `y` key copies a command that runs.** It copied
  `ag sessions …`; a running or status view now copies `agents ps` with its
  `--status`, `-D`, `--bookmarks` and `--routine` flags, and a history view copies
  the standalone `sessions …` with its filters.
  Source: `cli/src/commands/sessions-browser.ts`.
