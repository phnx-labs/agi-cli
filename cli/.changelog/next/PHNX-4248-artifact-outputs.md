- **Session rows report what an agent made for you to look at.** With
  `@phnx-labs/sessions-cli` 0.6.0, a row's `artifacts` include created images, video,
  PDFs, SVGs and CSVs (the harness scratchpad excluded) and the viewable files of
  folders the agent names in its replies, when they exist under this machine's home
  outside a git checkout. Each carries `editedAtMs`; the list is newest first, at
  most 60. AGI EXT 0.9.381+ shows them as folder thumbnails in the session sidebar.
  It costs about 0.6 ms more per transcript change on a 2,000-event session.
  Source: `cli/package.json`.
