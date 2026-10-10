# Tool setup

AGI Menu receives standalone tool installation metadata through the shared feed.
Browser CLI, Computer CLI, Secrets CLI and the `term` CLI are detected independently. A legacy
`browser` alias pointing into agents-cli is not a standalone installation.

Read the cached metadata without starting a tool or checking other devices:

```sh
agents setup status --tool all --json
```

Check one tool's health explicitly:

```sh
agents setup status --tool computer --refresh --json
```

Each row separates `installed` from `readiness`, and includes `checkedAtMs` for the
last explicit check. Unknown health is not a missing installation. Browser and
Computer health checks have an eight-second deadline. Overlapping checks share a
disk lock; cached reads spawn no processes. File notifications publish changed
installation metadata and completed checks. There is no recurring health poll.

Secrets detection reads executable metadata only. It does not enumerate bundle
contents, unlock secrets or claim that an installed CLI has permission to read a
particular secret. Computer readiness reports Accessibility trust; capture checks
Screen Recording permission when used.

Install a standalone executable without starting services or changing permissions:

```sh
agents setup browser --install-only
agents setup computer --install-only
agents setup secrets --install-only
```

The existing `agents setup browser`, `agents setup computer` and
`agents setup secrets` commands remain the guided onboarding paths. Remote checks
and actions target only the selected device through `agents ssh <device>`.

From a GUI, `agents setup browser --terminal`, `agents setup computer --terminal`, or `agents setup secrets --terminal` opens the wizard using the existing terminal engine. An optional backend selects the terminal explicitly. The command reports terminal launch errors; the wizard runs interactively in that terminal and publishes its readiness through the setup cache. `--terminal` and `--install-only` are separate modes.

## Pinned standalone releases

Each agents-cli release names the standalone tool releases it is tested against in
`src/lib/standalone-tools.ts` (`STANDALONE_TOOL_PINS`): `sessions`, `browser`,
`secrets`, `computer` and `term`, each a published `@phnx-labs/<tool>-cli` version.
`agents setup tools` reads `<tool> --version` for each and runs
`npm install -g @phnx-labs/<tool>-cli@<pin>` for any tool that is missing or older.
A tool at or above its pin is never reinstalled or downgraded.

```sh
agents setup tools --dry-run           # what is below its pin, install nothing
agents setup tools                     # bring every tool up to its pin
agents setup tools --tool sessions --json
agents ssh <device> 'agents setup tools'   # the same on one fleet device
```

It exits 1 when any tool is still below its pin afterwards, including when an older
copy earlier on `PATH` shadows the fresh install; the row's `error` names it. With
`--json`, npm's own output goes to stderr so stdout stays one JSON array.

The `--install-only` paths above install the same pinned versions when a tool is
absent; they do not upgrade an existing install. Pins move only to releases already
on npm.
