/** Plugins detector: asks `isPluginSynced` whether each discovered plugin's expected artifacts are
 * present in the version home (mirrors versions.ts:541-549). */
import type { AgentId } from '../../types.js';
import { capableAgents } from '../../capabilities.js';
import { discoverPlugins, isPluginSynced } from '../../plugins/plugins.js';
import type { ResourceDetector, DetectArgs } from './types.js';
import { lazyAgentMap } from '../writers/lazy-map.js';

function buildPluginsDetector(agent: AgentId): ResourceDetector {
  return {
    kind: 'plugins',
    agent,
    list({ versionHome }: DetectArgs): string[] {
      const synced: string[] = [];
      for (const plugin of discoverPlugins()) {
        if (isPluginSynced(plugin, agent, versionHome)) synced.push(plugin.name);
      }
      return synced;
    },
  };
}

export const pluginsDetectors = lazyAgentMap<ResourceDetector>(() => {
  const m: Partial<Record<AgentId, ResourceDetector>> = {};
  for (const agent of capableAgents('plugins')) m[agent] = buildPluginsDetector(agent);
  return m;
});
