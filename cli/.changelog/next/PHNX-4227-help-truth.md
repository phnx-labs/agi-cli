- **Help text teaches the commands that exist today.** `--help` for `sessions`, `browser`,
  `secrets`, `trace`, `fork`, `logs`, `run` and every `-D/--device` option was still
  pointing at removed or legacy spellings (`agents hosts`, `agents sessions --active`,
  `agents sessions resume <id>`, `agents sessions stats`). It now teaches the standalone
  `sessions`, `browser` and `secrets` CLIs, `agents ps` for the live roster,
  `agents ps focus` to attach, `agents run auto --resume <id>` to continue a session, and
  `agents daemon index` for index maintenance. `agents computer` keeps its spelling, since
  it supplies the permission allow list and session recording. No command or flag changed.
