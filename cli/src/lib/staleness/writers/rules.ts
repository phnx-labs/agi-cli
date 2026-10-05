/** Rules writer: composes one instruction file per supported agent (single target; RulesCapability
 * is `{ file } | false`) via `lib/rules/compose.ts`. The project layer is never written into the
 * version home; `compileRulesForProject` resolves it at run time. */
import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from '../../types.js';
import { AGENTS, agentConfigDirName } from '../../agents.js';
import { capableAgents, supports } from '../../capabilities.js';
import { composeRulesFromState } from '../../rules/compose.js';
import type { ResourceWriter, WriteArgs, WriteResult } from './types.js';
import { lazyAgentMap } from './lazy-map.js';

export interface RulesSelection {
  preset: string;
}

function buildRulesWriter(agent: AgentId): ResourceWriter<RulesSelection> {
  return {
    kind: 'rules',
    agent,
    write({ versionHome, selection }: WriteArgs<RulesSelection>): WriteResult {
      const cap = AGENTS[agent].capabilities.rules;
      if (cap === false) {
        throw new Error(`rules writer reached for ${agent} (rules: false)`);
      }
      const targetName = cap.file;
      const composed = composeRulesFromState({ preset: selection.preset || undefined });
      const agentDir = path.join(versionHome, agentConfigDirName(agent));
      const destFile = path.join(agentDir, targetName);
      fs.mkdirSync(path.dirname(destFile), { recursive: true });
      // Unlink a stale symlink before writing so we never follow and clobber its external target.
      try {
        const st = fs.lstatSync(destFile);
        if (st.isSymbolicLink() || st.isFile()) fs.unlinkSync(destFile);
      } catch {  }
      fs.writeFileSync(destFile, composed.content);
      return { synced: [targetName], paths: [destFile] };
    },
  };
}

export const rulesWriters = lazyAgentMap<ResourceWriter<RulesSelection>>(() => {
  const m: Partial<Record<AgentId, ResourceWriter<RulesSelection>>> = {};
  for (const agent of capableAgents('rules')) m[agent] = buildRulesWriter(agent);
  return m;
});
