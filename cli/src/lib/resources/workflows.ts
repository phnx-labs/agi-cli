/**
 * Workflows resource handler.
 *
 * Workflows are directory bundles with a WORKFLOW.md containing YAML frontmatter.
 * They optionally contain subagents/, skills/, and plugins/ subdirectories.
 * Resolution order (docs/07-entrypoints): project > user > plugin > extra > system.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentId, Layer, ResolvedItem, ResourceHandler, LayerDirs } from './types.js';
import {
  getProjectAgentsDir,
  getUserWorkflowsDir,
  getSystemWorkflowsDir,
  getEnabledExtraRepos,
} from '../state.js';
import {
  parseWorkflowFrontmatter,
  countWorkflowSubagents,
  listPluginWorkflowDirs,
  resolveWorkflowRef,
  parseWorkflowRef,
} from '../workflows.js';

interface WorkflowItem {
  name: string;
  description: string;
  model?: string;
  subagentCount: number;
}

function getLayerDirs(cwd?: string): LayerDirs {
  const projectDir = getProjectAgentsDir(cwd);
  const extraRepos = getEnabledExtraRepos();
  return {
    system: getSystemWorkflowsDir(),
    user: getUserWorkflowsDir(),
    project: projectDir ? path.join(projectDir, 'workflows') : null,
    extra: extraRepos.map(e => path.join(e.dir, 'workflows')),
  };
}

function listWorkflowsInDir(dir: string): Array<{ name: string; path: string }> {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') &&
        fs.existsSync(path.join(dir, e.name, 'WORKFLOW.md')))
      .map(e => ({ name: e.name, path: path.join(dir, e.name) }));
  } catch {
    return [];
  }
}

/** Precedence-ordered (dir, layer) pairs for name lookup / listing. */
function orderedWorkflowSearchDirs(cwd?: string): Array<{ dir: string; layer: Layer }> {
  const dirs = getLayerDirs(cwd);
  const out: Array<{ dir: string; layer: Layer }> = [];
  if (dirs.project) out.push({ dir: dirs.project, layer: 'project' });
  out.push({ dir: dirs.user, layer: 'user' });
  for (const pluginDir of listPluginWorkflowDirs(cwd ?? process.cwd())) {
    out.push({ dir: pluginDir, layer: 'plugin' });
  }
  for (const extraDir of dirs.extra) out.push({ dir: extraDir, layer: 'system' });
  out.push({ dir: dirs.system, layer: 'system' });
  return out;
}

/** Map a resolved absolute workflow dir to its origin layer (best-effort). */
function layerForWorkflowPath(workflowPath: string, cwd?: string): Layer {
  const abs = path.resolve(workflowPath);
  const under = (root: string) => {
    const r = path.resolve(root);
    return abs === r || abs.startsWith(r + path.sep);
  };
  const projectDir = getProjectAgentsDir(cwd);
  if (projectDir && under(path.join(projectDir, 'workflows'))) return 'project';
  if (under(getUserWorkflowsDir())) return 'user';
  if (under(getSystemWorkflowsDir())) return 'system';
  for (const extra of getEnabledExtraRepos()) {
    if (under(path.join(extra.dir, 'workflows'))) return 'system';
  }
  // Plugin marketplaces (and anything else plugin-shaped).
  return 'plugin';
}

class WorkflowsHandlerImpl implements ResourceHandler<WorkflowItem> {
  readonly kind = 'workflow' as const;

  listAll(_agent: AgentId, cwd?: string): ResolvedItem<WorkflowItem>[] {
    const seen = new Set<string>();
    const results: ResolvedItem<WorkflowItem>[] = [];

    for (const { dir, layer } of orderedWorkflowSearchDirs(cwd)) {
      for (const { name, path: workflowPath } of listWorkflowsInDir(dir)) {
        if (seen.has(name)) continue;
        const fm = parseWorkflowFrontmatter(workflowPath);
        if (!fm) continue;
        seen.add(name);
        results.push({
          name,
          item: {
            name: fm.name || name,
            description: fm.description,
            model: fm.model,
            subagentCount: countWorkflowSubagents(workflowPath),
          },
          layer,
          path: workflowPath,
        });
      }
    }

    return results.sort((a, b) => a.name.localeCompare(b.name));
  }

  resolve(_agent: AgentId, name: string, cwd?: string): ResolvedItem<WorkflowItem> | null {
    // Delegate to resolveWorkflowRef so bare, workflow:, and name@source share one path.
    const workflowPath = resolveWorkflowRef(name, cwd ?? process.cwd());
    if (!workflowPath) return null;
    const fm = parseWorkflowFrontmatter(workflowPath);
    if (!fm) return null;
    const parsed = parseWorkflowRef(name);
    const displayName = parsed?.name ?? path.basename(workflowPath);
    return {
      name: displayName,
      item: {
        name: fm.name || displayName,
        description: fm.description,
        model: fm.model,
        subagentCount: countWorkflowSubagents(workflowPath),
      },
      layer: layerForWorkflowPath(workflowPath, cwd),
      path: workflowPath,
    };
  }

  sync(_agent: AgentId, _versionHome: string, _cwd?: string): void {
    // Version-home copies are written by syncResourcesToVersion in versions.ts.
    // exec.ts resolves workflows at run time from source dirs directly.
  }

  format(_agent: AgentId): 'md' {
    return 'md';
  }

  targetDir(_agent: AgentId): string {
    return 'workflows';
  }
}

export const WorkflowsHandler = new WorkflowsHandlerImpl();
