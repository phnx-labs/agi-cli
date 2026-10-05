- **`agents ps`: the live agent roster and the verbs that act on it (PHNX-4227, R1).**
  `agents ps` lists the sessions running now on this machine and every reachable
  device (`--json`, `--local`, `-D/--device`, `--status <state>`), and opens the
  session picker filtered to running sessions on a TTY (`r` toggles the filter).
  `agents ps stop|focus|detach|migrate <id>` run the same code as the `sessions`
  verbs. `agents sessions --active` and every `sessions` verb keep working unchanged;
  callers move in the next release. Source: `cli/src/commands/ps.ts`,
  `cli/src/commands/ps-roster.ts`.
- **`agents send --channel session --to <id>` types into a running agent's terminal**,
  what `agents sessions inject <id>` does (text, then Enter, as two writes). The id
  is a session id or prefix, the `<shortid>` of an `ag-<agent>-<shortid>` tmux name,
  or a `%pane`; `--device <name>` delivers on another box. `--attach`, `--thread` and
  `--from` are refused on this channel. Source: `cli/src/lib/channels/providers/session.ts`.
- **`agents setup tools` installs or upgrades the standalone CLIs to their pinned
  releases**: sessions-cli 0.5.0, browser-cli 0.1.15, secrets-cli 0.1.8,
  computer-cli 0.1.5, term-cli 0.1.0. A newer install is left alone; exit 1 when a
  tool is still below its pin. Source: `cli/src/lib/standalone-tools.ts`.
- **Fix: `sessions --active` read empty after the daemon refreshed the live
  snapshot.** The daemon published local rows without `machine`, which the running
  filter requires, so the roster (and a peer's answer to `-D <device>`) was empty
  whenever the daemon's snapshot was the newest. Rows are now stamped with this
  machine's id. Source: `cli/src/lib/session/session-cache.ts`.
- **`agents send --device <box>` now runs the send on that box**, for any channel. It
  was refused before (`send` had no remote interpretation). It exists so
  `--channel session` can reach a pane on another device.
- **`agents setup secrets` installs secrets-cli 0.1.8, up from 0.1.5**, the same
  version `agents setup tools` pins. Source: `cli/src/lib/secrets-cli.ts`.
