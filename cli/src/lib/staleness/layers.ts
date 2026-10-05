
import * as path from 'path';
import * as fs from 'fs';
import {
  getProjectAgentsDir,
  getUserAgentsDir,
  getAgentsDir,
  getEnabledExtraRepos,
} from '../state.js';

export type LayerScope = 'project' | 'user' | 'system' | 'extra';

export interface Layer {
  scope: LayerScope;
  base: string;
  alias?: string;
}


// These caches mirror writer precedence for one stable configuration snapshot.
// Long-running callers must clearLayerCache after configuration changes.
const firstWinsCache = new Map<string, Layer[]>();
let hookLayersCache: Layer[] | null = null;

export function clearLayerCache(): void {
  firstWinsCache.clear();
  hookLayersCache = null;
}

export function firstWinsLayers(cwd: string): Layer[] {
  // Match writer order exactly: project, user, system, then enabled extras.
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

export function hookLayers(): Layer[] {
  // Executable hooks deliberately exclude untrusted project-local resources.
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
