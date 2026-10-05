import * as fs from 'fs';
import { agentConfigDirName } from '../../agents.js';
import * as path from 'path';
import type { AgentId } from '../../types.js';
import { capableAgents } from '../../capabilities.js';
import { safeJoin } from '../../paths.js';
import { registerHooksToSettings } from '../../hooks/install.js';
import type { ResourceWriter, WriteArgs, WriteResult, RemoveArgs, RemoveResult } from './types.js';
import { resolveHookSource } from './sources.js';
import { lazyAgentMap } from './lazy-map.js';

function removePath(target: string): void {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || stat.isFile()) {
      fs.unlinkSync(target);
    } else if (stat.isDirectory()) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  } catch {
  }
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const srcPath = safeJoin(src, entry.name);
    const destPath = safeJoin(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
      fs.chmodSync(destPath, fs.statSync(srcPath).mode);
    }
  }
}

function copyHookSource(src: string, dest: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(src);
  } catch {
    return false;
  }
  if (stat.isSymbolicLink()) return false;

  removePath(dest);
  if (stat.isDirectory()) {
    copyDir(src, dest);
    return true;
  }
  if (stat.isFile()) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, 0o755);
    return true;
  }
  return false;
}

function buildHooksWriter(agent: AgentId): ResourceWriter<string[]> {
  return {
    kind: 'hooks',
    agent,
    write({ versionHome, selection }: WriteArgs<string[]>): WriteResult {
      const agentDir = path.join(versionHome, agentConfigDirName(agent));
      const hooksTarget = path.join(agentDir, 'hooks');
      fs.mkdirSync(hooksTarget, { recursive: true });

      const synced: string[] = [];
      const paths: string[] = [];
      for (const hook of selection) {
        const srcFile = resolveHookSource(hook);
        if (!srcFile) continue;
        const destFile = safeJoin(hooksTarget, hook);
        if (copyHookSource(srcFile, destFile)) {
          synced.push(hook);
          paths.push(destFile);
        }
      }

      // Copying is insufficient for settings-backed hooks, including Grok's subrule guards.
      if (agent === 'claude' || agent === 'codex' || agent === 'antigravity' || agent === 'kimi' || agent === 'droid' || agent === 'copilot' || agent === 'goose' || agent === 'cursor' || agent === 'grok' || agent === 'hermes' || agent === 'muse') {
        registerHooksToSettings(agent, versionHome);
      }
      return { synced, paths };
    },
    remove({ versionHome, name }: RemoveArgs): RemoveResult {
      const agentDir = path.join(versionHome, agentConfigDirName(agent));
      const hookTarget = safeJoin(path.join(agentDir, 'hooks'), name);
      try {
        if (fs.existsSync(hookTarget)) {
          removePath(hookTarget);
          return { removed: true };
        }
      } catch {  }
      return { removed: false };
    },
  };
}

export const hooksWriters = lazyAgentMap<ResourceWriter<string[]>>(() => {
  const m: Partial<Record<AgentId, ResourceWriter<string[]>>> = {};
  for (const agent of capableAgents('hooks')) m[agent] = buildHooksWriter(agent);
  return m;
});
