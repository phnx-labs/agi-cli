- **The `grok` shim runs the release `grok update` installed.** Grok's updater now writes
  `~/.grok/bin/grok-<version>` and repoints `~/.grok/bin/grok`, leaving `downloads/` alone, but the
  shim only scanned `downloads/`, so it kept running the old binary after an update (on one worker,
  1.0.4, which xAI rejects with `426 ... outdated`). The shim, the `grok@<version>` alias, and
  `getBinaryPath` now follow grok's own `bin/grok` pointer first and fall back to the `downloads/`
  scan for older layouts. The shim schema version is bumped so installed shims regenerate.
  Source: `cli/src/lib/installations/shims.ts`, `cli/src/lib/installations/store.ts`.
