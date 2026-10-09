- **`agents ps focus <id>` jumps to the VSCodium tab that holds the session.** It used to
  stop at "no attach rail (not tmux/Ghostty)" for a session in an editor tab, or, without
  `--attach-only`, start a duplicate copy of a running session in a new terminal. A session
  running on another device through a local tab tried a tmux pane on that device instead.
  Focus now finds the tab on this machine (by session id, or by the tab a `--device` run
  was launched from), brings its window to the front and selects it. The same applies to
  `agents://session/<id>` links, which focus a local tab before sweeping the fleet when the
  id (at least the 8-character short id) names exactly one live tab here, even if the link
  names another host. `agents sessions --active --json` rows from an editor tab carry
  `workspaceDir`, the window's folder.
