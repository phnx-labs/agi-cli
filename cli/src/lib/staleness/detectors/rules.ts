/** Rules detector: reports whether the composed instructions file exists in the version home, using
 * the active rules preset name as the resource name (one preset = one synced name, as
 * `getAvailableResources` surfaces under `memory`). */
import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from '../../types.js';
import { AGENTS, agentConfigDirName } from '../../agents.js';
import { capableAgents } from '../../capabilities.js';
import { getActiveRulesPreset } from '../../state.js';
import type { ResourceDetector, DetectArgs } from './types.js';
import { lazyAgentMap } from '../writers/lazy-map.js';

function buildRulesDetector(agent: AgentId): ResourceDetector {
  return {
    kind: 'rules',
    agent,
    list({ version, versionHome }: DetectArgs): string[] {
      const cap = AGENTS[agent].capabilities.rules;
      if (cap === false) return [];
      const agentDir = path.join(versionHome, agentConfigDirName(agent));
      const instrFile = path.join(agentDir, cap.file);
      if (!fs.existsSync(instrFile)) return [];
      return [getActiveRulesPreset(agent, version)];
    },
  };
}

export const rulesDetectors = lazyAgentMap<ResourceDetector>(() => {
  const m: Partial<Record<AgentId, ResourceDetector>> = {};
  for (const agent of capableAgents('rules')) m[agent] = buildRulesDetector(agent);
  return m;
});
