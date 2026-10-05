import type { AgentId } from '../../types.js';
import { capableAgents } from '../../capabilities.js';
import {
  applyPermissionsToVersion as applyPermsToVersion,
  buildPermissionsFromGroups,
} from '../../permissions.js';
import type { ResourceWriter, WriteArgs, WriteResult } from './types.js';
import { lazyAgentMap } from './lazy-map.js';

function buildPermissionsWriter(agent: AgentId): ResourceWriter<string[]> {
  return {
    kind: 'permissions',
    agent,
    write({ versionHome, selection, cwd }: WriteArgs<string[]>): WriteResult {
      if (selection.length === 0) return { synced: [] };
      const built = buildPermissionsFromGroups(selection);
      const hasAllow = built.allow.length > 0;
      const hasDeny = (built.deny?.length ?? 0) > 0;
      if (!hasAllow && !hasDeny) return { synced: [] };
      const r = applyPermsToVersion(agent, built, versionHome, true, cwd);
      return { synced: r.success ? selection : [] };
    },
  };
}

export const permissionsWriters = lazyAgentMap<ResourceWriter<string[]>>(() => {
  const m: Partial<Record<AgentId, ResourceWriter<string[]>>> = {};
  for (const agent of capableAgents('allowlist')) m[agent] = buildPermissionsWriter(agent);
  return m;
});
