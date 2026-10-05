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
