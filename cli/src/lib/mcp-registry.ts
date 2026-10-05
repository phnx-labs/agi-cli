import * as os from 'os';
import * as path from 'path';
import type { AgentId } from './types.js';

function realHome(): string {
  return process.env.HOME ?? os.homedir();
}

export type McpFormat =
  | 'claude-json'
  | 'antigravity-json'
  | 'openclaw-json'
  | 'opencode-jsonc'
  | 'toml'
  | 'yaml'
  | 'muse-json';

// Keep this table in parity with MCP capabilities; paths and schemas are native contracts.
interface McpTarget {
  home(home: string): string;
  project(cwd: string): string;
  format: McpFormat | null;
  unsupportedReason?: string;
  homeGlobal?: boolean;
  cli?: 'claude' | 'codex';
}

export const MCP_TARGETS: Partial<Record<AgentId, McpTarget>> = {
  claude: {
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
    // Antigravity intentionally owns one real global home, not an isolated version home.
    home: () => path.join(realHome(), '.gemini', 'config', 'mcp_config.json'),
    project: (cwd) => path.join(cwd, '.gemini', 'config', 'mcp_config.json'),
    format: 'antigravity-json',
    homeGlobal: true,
  },
  grok: {
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
    home: (h) => path.join(h, '.warp', '.mcp.json'),
    project: (cwd) => path.join(cwd, '.warp', '.mcp.json'),
    format: 'claude-json',
  },

  copilot: {
    home: (h) => path.join(h, '.copilot', 'mcp-config.json'),
    project: (cwd) => path.join(cwd, '.copilot', 'mcp-config.json'),
    // null means the path is detectable but writes are refused until its schema is verified.
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

export function mcpTarget(agent: AgentId): McpTarget | undefined {
  return MCP_TARGETS[agent];
}

export function mcpWriteUnsupportedReason(agent: AgentId): string | null {
  const target = MCP_TARGETS[agent];
  if (!target) return `${agent} has no MCP target registered`;
  if (target.format === null) {
    return `${agent}: ${target.unsupportedReason ?? 'MCP config format not implemented'}`;
  }
  return null;
}
