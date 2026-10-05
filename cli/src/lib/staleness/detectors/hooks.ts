import * as fs from 'fs';
import { agentConfigDirName } from '../../agents.js';
import * as path from 'path';
import type { AgentId } from '../../types.js';
import { capableAgents } from '../../capabilities.js';
import { resolveHookSource } from '../writers/sources.js';
import type { ResourceDetector, DetectArgs } from './types.js';
import { lazyAgentMap } from '../writers/lazy-map.js';

function hookSourcesMatch(src: string, dest: string): boolean {
  const srcStat = fs.lstatSync(src);
  if (srcStat.isSymbolicLink()) return false;

  if (srcStat.isDirectory()) {
    if (!fs.existsSync(dest) || !fs.lstatSync(dest).isDirectory()) return false;
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (!hookSourcesMatch(srcPath, destPath)) return false;
    }
    return true;
  }

  if (!srcStat.isFile()) return false;
  if (!fs.existsSync(dest) || !fs.lstatSync(dest).isFile()) return false;
  return fs.readFileSync(src, 'utf-8') === fs.readFileSync(dest, 'utf-8');
}

function buildHooksDetector(agent: AgentId): ResourceDetector {
  return {
    kind: 'hooks',
    agent,
    list({ versionHome }: DetectArgs): string[] {
      const hooksDir = path.join(versionHome, agentConfigDirName(agent), 'hooks');
      if (!fs.existsSync(hooksDir)) return [];
      const installed = fs.readdirSync(hooksDir).filter(f => !f.startsWith('.'));

      const synced: string[] = [];
      for (const hook of installed) {
        const src = resolveHookSource(hook);
        if (!src) {
          synced.push(hook);
          continue;
        }
        try {
          if (hookSourcesMatch(src, path.join(hooksDir, hook))) {
            synced.push(hook);
          }
        } catch {  }
      }
      return synced;
    },
  };
}

export const hooksDetectors = lazyAgentMap<ResourceDetector>(() => {
  const m: Partial<Record<AgentId, ResourceDetector>> = {};
  for (const agent of capableAgents('hooks')) m[agent] = buildHooksDetector(agent);
  return m;
});
