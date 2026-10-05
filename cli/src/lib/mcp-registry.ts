/** Declarative MCP-target registry: one `MCP_TARGETS` entry per MCP-capable agent, replacing four
 * copy-pasted switch chains with differing membership (RUSH-2695). Pinned to
 * `capableAgents('mcp')`; `format: null` means paths resolve but writes refuse. */
import * as os from 'os';
import * as path from 'path';
import type { AgentId } from './types.js';

/** The user's real home — read at call time so a test's HOME override applies. */
function realHome(): string {
  return process.env.HOME ?? os.homedir();
}

/** On-disk schema of an agent's MCP config file; one entry per distinct serialization, not per
 * agent (most share Claude's shape). */
export type McpFormat =
  /** `{ "mcpServers": { "<name>": {command,args,env} | {url,headers?} } }` */
  | 'claude-json'
  /** Claude shape, but a remote server is keyed `serverUrl` and has no headers. */
  | 'antigravity-json'
  /** `{ "mcp": { "servers": { "<name>": ... } } }`, remote carries `transport`. */
  | 'openclaw-json'
  /** `{ "mcp": { "<name>": {type:'local',command:[...]} | {type:'remote',url} } }` */
  | 'opencode-jsonc'
  /** `[mcp_servers.<name>]` TOML table. */
  | 'toml'
  /** `mcp_servers:` YAML mapping. */
  | 'yaml'
  /** `{ schema_version, mcp_servers: { "<name>": {transport, ..., enabled} } }` */
  | 'muse-json';

/** The complete MCP contract for one agent. */
interface McpTarget {
  /** MCP config file under a HOME root (a version home, or the real HOME). */
  home(home: string): string;
  /** Project-scoped MCP config file for a repo at `cwd`. */
  project(cwd: string): string;
  /** Serialization of that file, or `null` when agents-cli cannot yet write this harness's MCP
   * config. Paths still resolve for read/detect. */
  format: McpFormat | null;
  /** Required when `format` is null: why the write path refuses. */
  unsupportedReason?: string;
  /** True when the harness reads config from the user's REAL home, so `home()` ignores its
   * argument. Version-isolation logic must check this. */
  homeGlobal?: boolean;
  /** When set, `installMcpServers` registers through the harness's own CLI (`claude mcp add` /
   * `codex mcp add`) instead of writing the file. */
  cli?: 'claude' | 'codex';
}

/** Single source of truth for each MCP-capable agent's config location and format. Keys MUST equal
 * `capableAgents('mcp')` (pinned by mcp-registry.test.ts). */
export const MCP_TARGETS: Partial<Record<AgentId, McpTarget>> = {
  claude: {
    // Claude reads user-scope MCP from ~/.claude.json, not .claude/settings.json.
    home: (h) => path.join(h, '.claude.json'),
    project: (cwd) => path.join(cwd, '.mcp.json'),
    format: 'claude-json',
    cli: 'claude',
  },
  codex: {
    home: (h) => path.join(h, '.codex', 'config.toml'),
    project: (cwd) => path.join(cwd, '.codex', 'config.toml'),
    format: 'toml',
    cli: 'codex',
  },
  cursor: {
    home: (h) => path.join(h, '.cursor', 'mcp.json'),
    project: (cwd) => path.join(cwd, '.cursor', 'mcp.json'),
    format: 'claude-json',
  },
  opencode: {
    // OpenCode loads ~/.config/opencode/opencode.jsonc, not ~/.opencode/.
    home: (h) => path.join(h, '.config', 'opencode', 'opencode.jsonc'),
    project: (cwd) => path.join(cwd, 'opencode.jsonc'),
    format: 'opencode-jsonc',
  },
  openclaw: {
    home: (h) => path.join(h, '.openclaw', 'openclaw.json'),
    project: (cwd) => path.join(cwd, '.openclaw', 'openclaw.json'),
    format: 'openclaw-json',
  },
  antigravity: {
    // NOT version-isolated; `home` is ignored. agy reads `~/.gemini/config/mcp_config.json` in the
    // REAL home (only `~/.gemini/antigravity-cli` is symlinked into a version home), so writing
    // under a version home is never read. Same as `antigravityWorkflowsDir` (strace-verified).
    home: () => path.join(realHome(), '.gemini', 'config', 'mcp_config.json'),
    project: (cwd) => path.join(cwd, '.gemini', 'config', 'mcp_config.json'),
    format: 'antigravity-json',
    homeGlobal: true,
  },
  grok: {
    // Grok's MCP servers are [mcp_servers.<name>] tables in config.toml.
    home: (h) => path.join(h, '.grok', 'config.toml'),
    project: (cwd) => path.join(cwd, '.grok', 'config.toml'),
    format: 'toml',
  },
  kimi: {
    home: (h) => path.join(h, '.kimi-code', 'mcp.json'),
    project: (cwd) => path.join(cwd, '.kimi-code', 'mcp.json'),
    format: 'claude-json',
  },
  droid: {
    home: (h) => path.join(h, '.factory', 'mcp.json'),
    project: (cwd) => path.join(cwd, '.factory', 'mcp.json'),
    format: 'claude-json',
  },
  hermes: {
    home: (h) => path.join(h, '.hermes', 'config.yaml'),
    project: (cwd) => path.join(cwd, '.hermes', 'config.yaml'),
    format: 'yaml',
  },
  muse: {
    home: (h) => path.join(h, '.config', 'muse', 'settings.json'),
    project: (cwd) => path.join(cwd, '.muse', 'settings.json'),
    format: 'muse-json',
  },
  warp: {
    // Oz reads the Claude .mcp.json schema from ~/.warp/ and <root>/.warp/.
    home: (h) => path.join(h, '.warp', '.mcp.json'),
    project: (cwd) => path.join(cwd, '.warp', '.mcp.json'),
    format: 'claude-json',
  },

  // Paths known, write format not implemented: these resolve paths (so `agents mcp list` and the
  // staleness detector work) but refuse writes. To implement one, verify its schema against the
  // installed harness and set `format`.
  copilot: {
    home: (h) => path.join(h, '.copilot', 'mcp-config.json'),
    project: (cwd) => path.join(cwd, '.copilot', 'mcp-config.json'),
    format: null,
    unsupportedReason: 'mcp-config.json schema not verified against an installed Copilot CLI',
  },
  amp: {
    home: (h) => path.join(h, '.config', 'amp', 'settings.json'),
    project: (cwd) => path.join(cwd, '.amp', 'settings.json'),
    format: null,
    unsupportedReason: 'Amp nests MCP under a settings key rather than a top-level map; schema not verified',
  },
  goose: {
    home: (h) => path.join(h, '.config', 'goose', 'config.yaml'),
    project: (cwd) => path.join(cwd, '.goose', 'config.yaml'),
    format: null,
    unsupportedReason: 'Goose declares MCP servers as `extensions:` entries, not an mcp_servers map',
  },
};

/** The registry entry for `agent`, or undefined when it stores no MCP config. */
export function mcpTarget(agent: AgentId): McpTarget | undefined {
  return MCP_TARGETS[agent];
}

/** Why the write path refuses `agent`, or null when it can write. Two loud refusals: no entry at
 * all (not MCP-capable or deprecated), or `format: null`. */
export function mcpWriteUnsupportedReason(agent: AgentId): string | null {
  const target = MCP_TARGETS[agent];
  if (!target) return `${agent} has no MCP target registered`;
  if (target.format === null) {
    return `${agent}: ${target.unsupportedReason ?? 'MCP config format not implemented'}`;
  }
  return null;
}
