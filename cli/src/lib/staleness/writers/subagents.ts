/** Subagents writer. Each agent's on-disk layout is declared once in the subagent registry; this
 * writer is generic and iterates it. Source discovery is `listInstalledSubagents` (user + system
 * only; project excluded as for commands/skills/hooks). */
import * as fs from 'fs';
import type { AgentId } from '../../types.js';
import { capableAgents } from '../../capabilities.js';
import { listInstalledSubagents } from '../../subagents.js';
import { subagentTarget } from '../../subagents-registry.js';
import type { ResourceWriter, WriteArgs, WriteResult } from './types.js';
import { lazyAgentMap } from './lazy-map.js';

function buildSubagentsWriter(agent: AgentId): ResourceWriter<string[]> {
  return {
    kind: 'subagents',
    agent,
    write({ versionHome, selection }: WriteArgs<string[]>): WriteResult {
      const target = subagentTarget(agent);
      if (!target) return { synced: [] };

      const all = listInstalledSubagents();
      const map = new Map(all.map(s => [s.name, s]));
      const dir = target.dir(versionHome);
      const synced: string[] = [];
      const paths: string[] = [];
      const errors: string[] = [];

      for (const name of selection) {
        const sub = map.get(name);
        if (!sub) {
          errors.push(`subagent '${name}': no parseable AGENT.md in ~/.agents/subagents`);
          continue;
        }
        try {
          target.write(dir, sub);
          synced.push(sub.name);
          for (const entry of target.occupied(dir, sub.name)) {
            if (fs.existsSync(entry.path)) paths.push(entry.path);
          }
        } catch (e) {
          errors.push(`subagent '${sub.name}': ${(e as Error).message}`);
        }
      }

      return errors.length > 0 ? { synced, paths, errors } : { synced, paths };
    },
  };
}

export const subagentsWriters = lazyAgentMap<ResourceWriter<string[]>>(() => {
  const m: Partial<Record<AgentId, ResourceWriter<string[]>>> = {};
  for (const agent of capableAgents('subagents')) m[agent] = buildSubagentsWriter(agent);
  return m;
});
