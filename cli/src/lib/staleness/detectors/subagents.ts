/** Subagents detector. Installed-name enumeration per agent layout is declared once in the subagent
 * registry; this detector is generic and delegates to `listInstalledSubagentNames`. */
import type { AgentId } from '../../types.js';
import { capableAgents } from '../../capabilities.js';
import { listInstalledSubagentNames } from '../../subagents-registry.js';
import type { ResourceDetector, DetectArgs } from './types.js';
import { lazyAgentMap } from '../writers/lazy-map.js';

function buildSubagentsDetector(agent: AgentId): ResourceDetector {
  return {
    kind: 'subagents',
    agent,
    list({ versionHome }: DetectArgs): string[] {
      return listInstalledSubagentNames(agent, versionHome);
    },
  };
}

export const subagentsDetectors = lazyAgentMap<ResourceDetector>(() => {
  const m: Partial<Record<AgentId, ResourceDetector>> = {};
  for (const agent of capableAgents('subagents')) m[agent] = buildSubagentsDetector(agent);
  return m;
});
