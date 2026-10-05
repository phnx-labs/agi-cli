# Contributing to agi-cli

Thanks for your interest in contributing. This guide covers the setup, conventions, and PR process.

## Setup

```bash
git clone https://github.com/phnx-labs/agi-cli
cd agi-cli/cli
bun install
bun run build
bun run test
```

Requires Node.js 22.5+ and Bun. SQLite support uses the built-in `bun:sqlite` and `node:sqlite` modules; there is no native module rebuild step.

## Project structure

```
cli/src/
  index.ts           # CLI entry point (commander.js)
  commands/          # One file per CLI command
  lib/               # Business logic, types, and integrations
    cloud/           # Cloud dispatch providers (Rush, Codex, Factory)
    session/         # Session discovery, parsing, rendering
    teams/           # Multi-agent coordination
```

Commands live in `cli/src/commands/`, business logic in `cli/src/lib/`. Tests are colocated as `*.test.ts` files under `__tests__/` directories.

## Code conventions

- **TypeScript only** -- strict mode enabled, no `any` where avoidable.
- **Bun** as the package manager and test runner.
- **Comments are exceptional** -- keep directives, non-obvious invariants, security boundaries, and public API details that names and types cannot express. Delete narration and restatements.
- **No emojis** in code, comments, or UI strings.
- **One test file per source file** -- `foo.ts` tests go in `__tests__/foo.test.ts`.
- **Real services in tests** -- no mocking. Tests hit actual code paths.

## Making changes

1. **Build and test before submitting:**
   ```bash
   cd cli && bun run build && bun run test
   ```

2. **Keep PRs focused.** One feature or fix per PR. Don't bundle unrelated changes.

3. **Add tests for non-trivial logic.** Edge cases in parsing, state management, and resource syncing are the most valuable tests.

4. **Make exports self-explanatory.** Add API documentation only when the name and type do not carry the contract.

## Adding a new agent

Agents are defined in `cli/src/lib/agents.ts` as entries in the `AGENTS` object. Each entry declares:

- CLI command name and npm package
- Config directory and file format
- Memory file name (e.g., `CLAUDE.md`, `GEMINI.md`)
- Capability flags (hooks, MCP, skills, commands, permissions)

Add the agent ID to the `AgentId` type in `cli/src/lib/types.ts`, then add the config entry in `cli/src/lib/agents.ts`.

## Adding a cloud provider

Cloud providers implement the `CloudProvider` interface in `cli/src/lib/cloud/types.ts`. See `cli/src/lib/cloud/rush.ts` for a complete example. Register the provider in `cli/src/lib/cloud/registry.ts`.

## Commit messages

Use [conventional commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.

Every commit must carry a Developer Certificate of Origin sign-off. Use
`git commit -s` so the commit includes a `Signed-off-by:` line.

## License

By contributing, you license your work under this project's license
(FSL-1.1-Apache-2.0), including its conversion to Apache-2.0 two years after
the version is made available.
