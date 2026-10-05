/** Plugins writer: thin wrapper around `syncPluginToVersion`; discovery and per-agent format
 * work live in lib/plugins.ts. */
import type { AgentId } from '../../types.js';
import { capableAgents } from '../../capabilities.js';
import { discoverPlugins, syncPluginToVersion, pluginSupportsAgent, cleanOrphanedPluginSkills } from '../../plugins/plugins.js';
import type { ResourceWriter, WriteArgs, WriteResult } from './types.js';
import { lazyAgentMap } from './lazy-map.js';

function buildPluginsWriter(agent: AgentId): ResourceWriter<string[]> {
  return {
    kind: 'plugins',
    agent,
    write({ version, versionHome, selection }: WriteArgs<string[]>): WriteResult {
      const all = discoverPlugins();
      const map = new Map(all.map(p => [p.name, p]));

      // Clean orphan plugin-skills from plugins that no longer exist. Pass discovered plugins, not
      // just names, so a stale install under one marketplace is trashed even when another still
      // ships that name (the PHNX-2618 shadow `code` plugin).
      cleanOrphanedPluginSkills(agent, versionHome, all);

      const synced: string[] = [];
      for (const name of selection) {
        const plugin = map.get(name);
        if (!plugin || !pluginSupportsAgent(plugin, agent)) continue;
        const r = syncPluginToVersion(plugin, agent, versionHome, { version });
        if (r.success) synced.push(name);
      }
      return { synced };
    },
  };
}

export const pluginsWriters = lazyAgentMap<ResourceWriter<string[]>>(() => {
  const m: Partial<Record<AgentId, ResourceWriter<string[]>>> = {};
  for (const agent of capableAgents('plugins')) m[agent] = buildPluginsWriter(agent);
  return m;
});
