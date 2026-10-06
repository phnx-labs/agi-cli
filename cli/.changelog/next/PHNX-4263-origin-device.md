- **A tab that dispatches an agent to another box binds to its session for every harness (PHNX-4263).**
  `agents run --device` now forwards `AGENTS_ORIGIN_DEVICE` (the dispatching machine id)
  beside `AGENTS_ORIGIN_TERMINAL_ID`. The remote run records both in its pid entry as
  `originTerminal`, and the fleet projection adds `{device, terminalId, launchId}` for
  that desktop to the row's `observerTerminals`. Codex and Grok tabs launched with
  `--device auto` no longer stay on "tracking session": before, only Claude got a
  desktop-side observation, because only Claude has a pre-minted session id. A
  `live-terminals.json` entry with a `terminalId` and no `sessionId` now produces a
  terminal row instead of being dropped.
  Source: `cli/src/lib/launch-identity.ts`, `cli/src/lib/session/projection.ts`,
  `cli/src/lib/session/active.ts`.
