import type { AgentId } from '../../types.js';
import { capableAgents } from '../../capabilities.js';
import { listInstalledWorkflows } from '../../workflows.js';
import { syncWorkflowToVersion } from '../../workflows-registry.js';
import type { ResourceWriter, WriteArgs, WriteResult } from './types.js';
import { lazyAgentMap } from './lazy-map.js';

function buildWorkflowsWriter(agent: AgentId): ResourceWriter<string[]> {
  return {
    kind: 'workflows',
    agent,
    write({ versionHome, selection }: WriteArgs<string[]>): WriteResult {
      const all = listInstalledWorkflows();
      const synced: string[] = [];
      for (const name of selection) {
        const wf = all.get(name);
        if (!wf) continue;
        try {
          const r = syncWorkflowToVersion(wf.path, name, agent, versionHome);
          if (r.success) synced.push(name);
        } catch {  }
      }
      return { synced };
    },
  };
}

export const workflowsWriters = lazyAgentMap<ResourceWriter<string[]>>(() => {
  const m: Partial<Record<AgentId, ResourceWriter<string[]>>> = {};
  for (const agent of capableAgents('workflows')) m[agent] = buildWorkflowsWriter(agent);
  return m;
});
