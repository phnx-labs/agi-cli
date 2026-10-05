/** MCP writer: a thin dispatcher into `installMcpServers` from `lib/mcp.ts`. Per-agent format
 * handling (Claude CLI, Codex TOML, Cursor JSON) stays there to avoid the import cycle with
 * `versions.ts`. */
import * as fs from 'fs';
import type { AgentId } from '../../types.js';
import { capableAgents } from '../../capabilities.js';
import { installMcpServers } from '../../mcp.js';
import { getMcpConfigPathForHome } from '../../agents.js';
import type { ResourceWriter, WriteArgs, WriteResult } from './types.js';
import { lazyAgentMap } from './lazy-map.js';

function buildMcpWriter(agent: AgentId): ResourceWriter<string[]> {
  return {
    kind: 'mcp',
    agent,
    write({ version, versionHome, selection, cwd }: WriteArgs<string[]>): WriteResult {
      const r = installMcpServers(agent, version, versionHome, selection, { cwd });
      // Forward r.errors: dropping them let a harness with no config writer report a clean sync
      // (RUSH-2677). The config file is recorded only if it exists after the write, so a CLI that
      // wrote elsewhere never yields a perpetually stale manifest (#2398).
      const configPath = getMcpConfigPathForHome(agent, versionHome);
      const paths = r.applied.length > 0 && fs.existsSync(configPath) ? [configPath] : [];
      return { synced: r.applied, paths, ...(r.errors.length ? { errors: r.errors } : {}) };
    },
  };
}

export const mcpWriters = lazyAgentMap<ResourceWriter<string[]>>(() => {
  const m: Partial<Record<AgentId, ResourceWriter<string[]>>> = {};
  for (const agent of capableAgents('mcp')) m[agent] = buildMcpWriter(agent);
  return m;
});
