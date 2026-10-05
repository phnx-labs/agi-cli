/** MCP detector: parses the agent's canonical MCP config in the version home and returns server
 * names (mirrors versions.ts:432-443). */
import * as fs from 'fs';
import type { AgentId } from '../../types.js';
import { capableAgents } from '../../capabilities.js';
import { getMcpConfigPathForHome, parseMcpConfig } from '../../agents.js';
import type { ResourceDetector, DetectArgs } from './types.js';
import { lazyAgentMap } from '../writers/lazy-map.js';

function buildMcpDetector(agent: AgentId): ResourceDetector {
  return {
    kind: 'mcp',
    agent,
    list({ versionHome }: DetectArgs): string[] {
      const p = getMcpConfigPathForHome(agent, versionHome);
      if (!fs.existsSync(p)) return [];
      try {
        return Object.keys(parseMcpConfig(agent, p));
      } catch {
        return [];
      }
    },
  };
}

export const mcpDetectors = lazyAgentMap<ResourceDetector>(() => {
  const m: Partial<Record<AgentId, ResourceDetector>> = {};
  for (const agent of capableAgents('mcp')) m[agent] = buildMcpDetector(agent);
  return m;
});
