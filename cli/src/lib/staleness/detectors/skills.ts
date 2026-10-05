/** Skills detector: names of skill directories in the version home that match the central
 * source content (mirrors versions.ts:359-389). */
import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from '../../types.js';
import { AGENTS, agentConfigDirName } from '../../agents.js';
import { capableAgents } from '../../capabilities.js';
import { resolveSkillSource } from '../writers/sources.js';
import type { ResourceDetector, DetectArgs } from './types.js';
import { lazyAgentMap } from '../writers/lazy-map.js';

const SKILL_COPY_IGNORE = new Set(['.DS_Store', '.git', '.gitignore', '.venv', '__pycache__', 'node_modules']);

/** Exported for unit tests (RUSH-2320 #2). Production callers: list() below. */
export function skillDirsMatch(src: string, dest: string): boolean {
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
      // Stat-first (RUSH-2320 #2): a size mismatch is a definitive miss with no content reads.
      // Equal mtimes are not equal content: src and dest are different trees and copyFileSync does
      // not preserve mtime. Compare content only when sizes match.
      let srcStat: fs.Stats;
      let destStat: fs.Stats;
      try {
        srcStat = fs.statSync(srcPath);
        destStat = fs.statSync(destPath);
      } catch {
        return false;
      }
      if (srcStat.size !== destStat.size) return false;
      // Raw bytes: decoding a binary asset (an image, a dataset) to a string costs far more than comparing it.
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
        if (!src) {
          // True orphan — no source. Still count so cleanup knows it's accounted for.
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
