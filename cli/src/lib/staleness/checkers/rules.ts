
import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from '../../types.js';
import { fingerprintFile, isFileStale } from '../fingerprint.js';
import { composeRulesFromState } from '../../rules/compose.js';
import {
  getActiveRulesPreset,
  getUserRulesDir,
  getResolvedRulesDir,
  getProjectAgentsDir,
  getEnabledExtraRepos,
} from '../../state.js';
import type { RulesEntry, FileEntry } from '../types.js';
import type { LayerScope } from '../layers.js';

function rulesDirForLayer(scope: LayerScope, cwd: string): string | null {
  if (scope === 'project') {
    const proj = getProjectAgentsDir(cwd);
    return proj ? path.join(proj, 'rules') : null;
  }
  if (scope === 'user')   return getUserRulesDir();
  if (scope === 'system') return getResolvedRulesDir();
  const extras = getEnabledExtraRepos();
  return extras.length > 0 ? path.join(extras[0].dir, 'rules') : null;
}

function activeSources(agent: AgentId, version: string, cwd: string): Record<string, string> {
  // Fingerprint the composer's actual contributors, including directory-form
  // rule.md plus adjacent hooks.yaml; reconstructing preset paths misses both.
  const result: Record<string, string> = {};
  let compose;
  try {
    const preset = getActiveRulesPreset(agent, version);
    compose = composeRulesFromState({ preset, cwd });
  } catch {
    return result;
  }

  const yamlDir = rulesDirForLayer(compose.presetLayer as LayerScope, cwd);
  if (yamlDir) {
    const yamlPath = path.join(yamlDir, 'rules.yaml');
    if (fs.existsSync(yamlPath)) result['rules.yaml'] = yamlPath;
  }
  for (const sub of compose.subrules) {
    if (sub.subruleDir) {
      result[`subrules/${sub.name}/rule.md`] = sub.sourcePath;
      const hooksFile = path.join(sub.subruleDir, 'hooks.yaml');
      if (fs.existsSync(hooksFile)) result[`subrules/${sub.name}/hooks.yaml`] = hooksFile;
    } else {
      result[`subrules/${sub.name}.md`] = sub.sourcePath;
    }
  }
  return result;
}

export function buildRules(agent: AgentId, version: string, cwd: string): RulesEntry {
  const files: Record<string, FileEntry> = {};
  for (const [key, srcPath] of Object.entries(activeSources(agent, version, cwd))) {
    const fp = fingerprintFile(srcPath);
    if (fp) files[key] = { source: fp };
  }
  return { files };
}

export function isRulesStale(
  stored: RulesEntry,
  agent: AgentId,
  version: string,
  cwd: string
): boolean {
  const current = activeSources(agent, version, cwd);
  const storedKeys = Object.keys(stored.files).sort();
  const currentKeys = Object.keys(current).sort();
  if (storedKeys.length !== currentKeys.length) return true;
  for (let i = 0; i < storedKeys.length; i++) {
    if (storedKeys[i] !== currentKeys[i]) return true;
  }
  for (const [key, srcPath] of Object.entries(current)) {
    const entry = stored.files[key];
    if (!entry || isFileStale(entry.source, srcPath)) return true;
  }
  return false;
}
