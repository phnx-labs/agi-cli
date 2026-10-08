### Fixed

- `agents browser <verb> --help`, `agents computer <verb> --help` and
  `agents secrets --help` now print the standalone CLI's own help with its real
  options. The global help conventions re-added agents-cli's `-h, --help` to these
  forwarding commands, so they printed a page with no options and agents guessed
  flags (PHNX-4283).
- The pinned browser engine is now `@phnx-labs/browser-cli` 0.1.16, the release
  that reads the config keys agents-cli writes. Before it, `browser.device` and each
  machine's default browser profile were ignored, so a bare `agents browser start`
  ran on whatever profile the calling box guessed instead of the configured browser.
