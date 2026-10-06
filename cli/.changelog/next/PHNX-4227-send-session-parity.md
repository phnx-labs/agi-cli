- **`agents send --channel session` covers every `sessions inject` mode (PHNX-4227).**
  New session-only options: `--pane <id>` (with `--socket <path>`) types into a known
  tmux pane without session lookup and replaces `--to`; `--no-enter` types without
  submitting; `--combined` sends text and Enter as one write. The session channel now
  delivers the text exactly as given, so surrounding spaces and newlines are kept and
  `--text ""` presses Enter alone; other channels still trim. A `--to` prefix that
  matches several live sessions is refused instead of picking one (this also applies
  to `sessions inject`), and the four options are refused on every other channel and
  on `--to owner`. `--json` adds `backend`, `writes` and `confirmed` to the existing
  result fields. Source: `cli/src/commands/send.ts`, `cli/src/lib/channels/send.ts`,
  `cli/src/lib/channels/providers/session.ts`, `cli/src/lib/session/inject-target.ts`.
