import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from '../../types.js';
import { AGENTS, agentConfigDirName } from '../../agents.js';
import { capableAgents } from '../../capabilities.js';
import { resolveSkillSource } from '../writers/sources.js';
import type { ResourceDetector, DetectArgs } from './types.js';
import { lazyAgentMap } from '../writers/lazy-map.js';

const SKILL_COPY_IGNORE = new Set(['.DS_Store', '.git', '.gitignore', '.venv', '__pycache__', 'node_modules']);

export function skillDirsMatch(src: string, dest: string): boolean {
  // These are different trees: equal mtimes prove nothing, and byte comparison
  // must support binary assets as well as text.
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (SKILL_COPY_IGNORE.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (!fs.existsSync(destPath)) return false;
      if (!skillDirsMatch(srcPath, destPath)) return false;
    } else {
      let srcStat: fs.Stats;
      let destStat: fs.Stats;
      try {
        srcStat = fs.statSync(srcPath);
        destStat = fs.statSync(destPath);
      } catch {
        return false;
      }
      if (srcStat.size !== destStat.size) return false;
      if (!fs.readFileSync(srcPath).equals(fs.readFileSync(destPath))) return false;
    }
  }
  return true;
}

function buildSkillsDetector(agent: AgentId): ResourceDetector {
  return {
    kind: 'skills',
    agent,
    list({ versionHome }: DetectArgs): string[] {
      const skillsDir = path.join(versionHome, agentConfigDirName(agent), 'skills');
      if (!fs.existsSync(skillsDir)) return [];
      const installed = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.'))
        .map(d => d.name);

      const synced: string[] = [];
      for (const name of installed) {
        const src = resolveSkillSource(name);
        // Keep source-less installed names visible so ownership-aware pruning can see orphans.
        if (!src) {
          synced.push(name);
          continue;
        }
        if (skillDirsMatch(src, path.join(skillsDir, name))) {
          synced.push(name);
        }
      }
      return synced;
    },
  };
}

export const skillsDetectors = lazyAgentMap<ResourceDetector>(() => {
  const m: Partial<Record<AgentId, ResourceDetector>> = {};
  for (const agent of capableAgents('skills')) {
    if (AGENTS[agent].nativeAgentsSkillsDir) continue;
    m[agent] = buildSkillsDetector(agent);
  }
  return m;
});
