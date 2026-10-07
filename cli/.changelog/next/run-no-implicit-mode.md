### Changed

- `agents run` no longer adds a permission flag when you did not choose a mode.
  Without `--mode` or a configured `run.<agent>@*.mode`, the harness's own
  settings decide (for Claude, `permissions.defaultMode` in its settings), the
  same as launching it directly. Set a default for agents-cli runs with
  `agents config set 'run.claude@*.mode' auto`. This also fixes
  `agents run claude#work -- rc`, which Claude refused because
  `--permission-mode plan` came before the `remote-control` verb.
