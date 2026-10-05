/** Rules composition: one inlined document from layered `subrules/*.md` and `rules.yaml` presets,
 * precedence project > user > extra > system. Preset-named subrules shadow per name; unnamed
 * user/extra/project subrules auto-append (system never). No `@-import` syntax, no writes. */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

import {
  getResolvedRulesDir,
  getUserRulesDir,
  getProjectAgentsDir,
  getEnabledExtraRepos,
} from '../state.js';
import type { ManifestHook } from '../types.js';

export type LayerScope = 'project' | 'user' | 'extra' | 'system';

export interface RulesLayer {
  scope: LayerScope;
  rulesDir: string;
  alias?: string;
}

interface PresetDef {
  subrules: string[];
}

interface RulesYaml {
  presets?: Record<string, PresetDef>;
}

interface ComposeOptions {
  preset?: string;
  layers: RulesLayer[];
}

export interface ComposedSubrule {
  name: string;
  sourcePath: string;
  layerScope: LayerScope;
  layerAlias?: string;
  subruleDir?: string;
}

interface ComposeResult {
  content: string;
  preset: string;
  presetLayer: LayerScope;
  subrules: ComposedSubrule[];
}

const SUBRULES_DIR_NAME = 'subrules';
const RULES_YAML_NAME = 'rules.yaml';
const DEFAULT_PRESET = 'default';
const SUBRULES_README = 'README.md';
const SUBRULE_RULE_FILE = 'rule.md';
const SUBRULE_HOOKS_FILE = 'hooks.yaml';

/** Resolve a subrule's prose file under `<rulesDir>/subrules/`: the DIRECTORY form `<name>/rule.md`
 * if present, else flat `<name>.md`. Returns the path plus the subrule dir for dir-form (needed to
 * resolve `hooks.yaml` and scripts). */
function resolveSubrulePath(
  rulesDir: string,
  name: string
): { sourcePath: string; subruleDir?: string } | null {
  const dirForm = path.join(rulesDir, SUBRULES_DIR_NAME, name, SUBRULE_RULE_FILE);
  if (fs.existsSync(dirForm)) {
    return { sourcePath: dirForm, subruleDir: path.join(rulesDir, SUBRULES_DIR_NAME, name) };
  }
  const flatForm = path.join(rulesDir, SUBRULES_DIR_NAME, `${name}.md`);
  if (fs.existsSync(flatForm)) return { sourcePath: flatForm };
  return null;
}

function readRulesYaml(rulesDir: string): RulesYaml | null {
  const p = path.join(rulesDir, RULES_YAML_NAME);
  if (!fs.existsSync(p)) return null;
  try {
    const parsed = yaml.parse(fs.readFileSync(p, 'utf-8')) as RulesYaml | null;
    return parsed || {};
  } catch {
    return null;
  }
}

function resolvePreset(
  layers: RulesLayer[],
  preset: string
): { def: PresetDef; layer: RulesLayer } | null {
  for (const layer of layers) {
    const yml = readRulesYaml(layer.rulesDir);
    if (!yml?.presets) continue;
    const def = yml.presets[preset];
    if (def) return { def, layer };
  }
  return null;
}

function findSubrule(
  layers: RulesLayer[],
  name: string
): { sourcePath: string; subruleDir?: string; layer: RulesLayer } | null {
  for (const layer of layers) {
    const found = resolveSubrulePath(layer.rulesDir, name);
    if (found) return { ...found, layer };
  }
  return null;
}

/** List subrule names in a layer, contributed by flat `subrules/<name>.md` or dir form
 * `subrules/<name>/rule.md`; a directory without `rule.md` is not a subrule. */
function listLayerSubruleNames(layer: RulesLayer): string[] {
  const dir = path.join(layer.rulesDir, SUBRULES_DIR_NAME);
  if (!fs.existsSync(dir)) return [];
  try {
    const names = new Set<string>();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (fs.existsSync(path.join(dir, entry.name, SUBRULE_RULE_FILE))) names.add(entry.name);
      } else if (entry.name.endsWith('.md') && entry.name !== SUBRULES_README) {
        names.add(entry.name.slice(0, -3));
      }
    }
    return [...names].sort();
  } catch {
    return [];
  }
}

/** Compose a rules document from the given layers; throws when the preset isn't defined in any
 * layer's rules.yaml (a typo, or no layer ships it). */
export function composeRules(opts: ComposeOptions): ComposeResult {
  // Layers are ordered project, user, extras, system; first match shadows by rule name.
  const presetName = opts.preset || DEFAULT_PRESET;

  const presetMatch = resolvePreset(opts.layers, presetName);
  if (!presetMatch) {
    throw new Error(
      `Preset "${presetName}" not found in any rules.yaml across the active layers.`
    );
  }

  const composed: ComposedSubrule[] = [];
  const seen = new Set<string>();

  for (const name of presetMatch.def.subrules || []) {
    if (seen.has(name)) continue;
    const found = findSubrule(opts.layers, name);
    if (!found) continue;
    composed.push({
      name,
      sourcePath: found.sourcePath,
      layerScope: found.layer.scope,
      layerAlias: found.layer.alias,
      subruleDir: found.subruleDir,
    });
    seen.add(name);
  }

  // Unnamed non-system rules auto-append; system rules require explicit preset membership.
  for (const layer of opts.layers) {
    if (layer.scope === 'system') continue;
    for (const name of listLayerSubruleNames(layer)) {
      if (seen.has(name)) continue;
      const resolved = resolveSubrulePath(layer.rulesDir, name);
      if (!resolved) continue;
      composed.push({
        name,
        sourcePath: resolved.sourcePath,
        layerScope: layer.scope,
        layerAlias: layer.alias,
        subruleDir: resolved.subruleDir,
      });
      seen.add(name);
    }
  }

  const parts = composed.map((c) => fs.readFileSync(c.sourcePath, 'utf-8').replace(/\s+$/, ''));
  const content = parts.length === 0 ? '' : parts.join('\n\n') + '\n';

  return {
    content,
    preset: presetName,
    presetLayer: presetMatch.layer.scope,
    subrules: composed,
  };
}

/** Discover layers at sync time (no cwd) or runtime (with cwd). The project layer is included only
 * when cwd is given AND `<cwd>/.agents/rules/` exists; without cwd only user/extras/system,
 * matching the home-file write at sync time. */
export function discoverRulesLayers(opts: { cwd?: string } = {}): RulesLayer[] {
  const layers: RulesLayer[] = [];

  if (opts.cwd) {
    const projectAgentsDir = getProjectAgentsDir(opts.cwd);
    if (projectAgentsDir) {
      const rulesDir = path.join(projectAgentsDir, 'rules');
      if (fs.existsSync(rulesDir)) {
        layers.push({ scope: 'project', rulesDir });
      }
    }
  }

  const userRulesDir = getUserRulesDir();
  if (fs.existsSync(userRulesDir)) {
    layers.push({ scope: 'user', rulesDir: userRulesDir });
  }

  for (const extra of getEnabledExtraRepos()) {
    const rulesDir = path.join(extra.dir, 'rules');
    if (fs.existsSync(rulesDir)) {
      layers.push({ scope: 'extra', rulesDir, alias: extra.alias });
    }
  }

  const systemRulesDir = getResolvedRulesDir();
  if (fs.existsSync(systemRulesDir)) {
    layers.push({ scope: 'system', rulesDir: systemRulesDir });
  }

  return layers;
}

export function composeRulesFromState(opts: { preset?: string; cwd?: string } = {}): ComposeResult {
  const layers = discoverRulesLayers({ cwd: opts.cwd });
  return composeRules({ preset: opts.preset, layers });
}

/** hooks.yaml shape: `<hookName>: { script (relative to the subrule dir), events: [PreToolUse],
 * matcher (optional), timeout (optional) }`. A wrapped `{ hooks: { ... } }` form is also accepted
 * so the file can carry sibling keys. */
function parseSubruleHooksFile(file: string): Record<string, ManifestHook> {
  const parsed = yaml.parse(fs.readFileSync(file, 'utf-8')) as
    | Record<string, ManifestHook>
    | { hooks?: Record<string, ManifestHook> }
    | null;
  if (!parsed || typeof parsed !== 'object') return {};
  const map = (parsed as { hooks?: Record<string, ManifestHook> }).hooks ?? parsed;
  return (map as Record<string, ManifestHook>) || {};
}

/** Collect hooks declared in active subrule directories (same set as {@link composeRules}). Each
 * dir-form hooks.yaml has its `script` rewritten to an ABSOLUTE path and its key namespaced
 * `<subrule>__<hook>`. A malformed hooks.yaml is skipped so it never breaks composition. */
export function collectSubruleHooks(
  layers: RulesLayer[],
  presetName?: string
): Record<string, ManifestHook> {
  const result: Record<string, ManifestHook> = {};
  let composed: ComposeResult;
  try {
    composed = composeRules({ preset: presetName, layers });
  } catch {
    return result;
  }

  for (const sub of composed.subrules) {
    if (!sub.subruleDir) continue;
    const hooksFile = path.join(sub.subruleDir, SUBRULE_HOOKS_FILE);
    if (!fs.existsSync(hooksFile)) continue;
    try {
      const hooks = parseSubruleHooksFile(hooksFile);
      for (const [hookName, def] of Object.entries(hooks)) {
        if (!def || typeof def !== 'object' || typeof def.script !== 'string') continue;
        const absScript = path.resolve(sub.subruleDir, def.script);
        result[`${sub.name}__${hookName}`] = { ...def, script: absScript };
      }
    } catch {
    }
  }

  return result;
}

export function collectSubruleHooksFromState(
  opts: { preset?: string; cwd?: string } = {}
): Record<string, ManifestHook> {
  const layers = discoverRulesLayers({ cwd: opts.cwd });
  return collectSubruleHooks(layers, opts.preset);
}
