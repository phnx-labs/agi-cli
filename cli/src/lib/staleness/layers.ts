/** Layer resolution for resources, shared by every checker and the sync writer. First-wins
 * (project > user > system > extras): commands, skills, mcp, subagents, workflows, plugins. Hooks:
 * first-wins with NO project layer (security exclusion). Permissions merge; rules are composed. */

import * as path from 'path';
import * as fs from 'fs';
import {
  getProjectAgentsDir,
  getUserAgentsDir,
  getAgentsDir,
  getEnabledExtraRepos,
} from '../state.js';

/** Layer of provenance for a single resource entry. */
export type LayerScope = 'project' | 'user' | 'system' | 'extra';

export interface Layer {
  scope: LayerScope;
  /** Absolute path of the repo root (e.g. `~/.agents`). */
  base: string;
  /** Set only when scope === 'extra'. */
  alias?: string;
}

// Per-process memoization: `firstWinsLayers(cwd)` and `hookLayers()` run 50+ times per `isStale`
// and each walks the filesystem and reads agents.yaml. Safe because cwd and base dirs do not
// change mid-process; tests use separate subprocesses (`_harness.ts`).

const firstWinsCache = new Map<string, Layer[]>();
let hookLayersCache: Layer[] | null = null;

export function clearLayerCache(): void {
  firstWinsCache.clear();
  hookLayersCache = null;
}

/** All layers a "first-wins with project" resource consults, in precedence order. */
export function firstWinsLayers(cwd: string): Layer[] {
  const cached = firstWinsCache.get(cwd);
  if (cached) return cached;

  const layers: Layer[] = [];
  const project = getProjectAgentsDir(cwd);
  if (project) layers.push({ scope: 'project', base: project });
  layers.push({ scope: 'user',   base: getUserAgentsDir() });
  layers.push({ scope: 'system', base: getAgentsDir() });
  for (const extra of getEnabledExtraRepos()) {
    layers.push({ scope: 'extra', base: extra.dir, alias: extra.alias });
  }
  firstWinsCache.set(cwd, layers);
  return layers;
}

/** Hooks-only: layers excluding project (security exclusion). */
export function hookLayers(): Layer[] {
  if (hookLayersCache) return hookLayersCache;

  const layers: Layer[] = [];
  layers.push({ scope: 'user',   base: getUserAgentsDir() });
  layers.push({ scope: 'system', base: getAgentsDir() });
  for (const extra of getEnabledExtraRepos()) {
    layers.push({ scope: 'extra', base: extra.dir, alias: extra.alias });
  }
  hookLayersCache = layers;
  return layers;
}

/** Resolve a single resource by name: the first matching layer's absolute path and scope, or
 * null if no layer has it. */
export function resolveByName(
  layers: Layer[],
  relative: string,
  predicate: (full: string) => boolean
): { path: string; layer: Layer } | null {
  for (const layer of layers) {
    const full = path.join(layer.base, relative);
    if (predicate(full)) return { path: full, layer };
  }
  return null;
}

/** Convenience: list names found by reading a relative subdir across all given layers. */
export function listAcrossLayers(
  layers: Layer[],
  relative: string,
  filter: (name: string, fullPath: string) => boolean
): string[] {
  const seen = new Set<string>();
  for (const layer of layers) {
    const dir = path.join(layer.base, relative);
    let entries: string[];
    try { entries = fs.readdirSync(dir); }
    catch { continue; }
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      if (!filter(name, path.join(dir, name))) continue;
      seen.add(name);
    }
  }
  return Array.from(seen);
}
