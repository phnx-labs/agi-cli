/** Agent CLI binary names, the `cliCommand` of each harness in AGENTS. A zero-import leaf so
 * brand.ts's eager graph never pulls agents.ts/versions.ts (RUSH-2331). agent-cli-commands.test.ts
 * pins it equal to AGENTS. */

/** Every managed harness CLI binary name (no `agents` / `ag`). */
export const AGENT_CLI_COMMANDS: readonly string[] = [
  'claude',
  'codex',
  'cursor-agent',
  'opencode',
  'openclaw',
  'copilot',
  'amp',
  'goose',
  'agy',
  'grok',
  'kimi',
  'droid',
  'hermes',
  'muse',
  'warp',
] as const;
