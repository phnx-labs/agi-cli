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
          // Requested but not discoverable as an installed central subagent —
          // e.g. its AGENT.md failed to parse. Say so instead of silently
          // dropping it, which read as an unactionable doctor "hold" (PHNX-3187).
          errors.push(`subagent '${name}': no parseable AGENT.md in ~/.agents/subagents`);
          continue;
        }
        try {
          target.write(dir, sub);
          synced.push(sub.name);
          // The registry owns the layout — record the artifact paths this
          // write occupies so a later deletion reads as stale (#2398).
          for (const entry of target.occupied(dir, sub.name)) {
            if (fs.existsSync(entry.path)) paths.push(entry.path);
          }
        } catch (e) {
          // A genuine fs/transform failure must surface with its reason, not
          // vanish behind a bare `catch` (RUSH-2677 / PHNX-3187).
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
