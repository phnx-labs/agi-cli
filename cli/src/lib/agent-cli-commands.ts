/**
 * Agent CLI binary names — the `cliCommand` field of each harness in AGENTS.
 *
 * Leaf module with zero imports. brand.ts uses this for reservedBrandNames so
 * the eager index.ts → brand.js graph never pulls agents.ts / versions.ts on
 * every invocation (RUSH-2331). agents.ts AGENTS[*].cliCommand values are
 * pinned equal by agent-cli-commands.test.ts — when a harness is added or
 * renamed, both this list and AGENTS must change together.
 */

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
