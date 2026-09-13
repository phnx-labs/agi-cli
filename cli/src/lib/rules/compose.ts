/**
 * Rules composition — assemble a fully-inlined rules document from layered
 * `subrules/` fragments and `rules.yaml` preset definitions.
 *
 * The model:
 *   - Every DotAgents repo holds `<repo>/rules/subrules/*.md` (rule fragments)
 *     and `<repo>/rules/rules.yaml` (preset definitions).
 *   - Layers are read in precedence order (highest first):
 *       project > user > extra > system.
 *   - The active preset's `subrules:` list is resolved against the layer set
 *     using per-name shadowing — a project subrule shadows a user/system one
 *     of the same name.
 *   - Subrules in the user / extra / project layers that the preset did NOT
 *     name are auto-appended in precedence order. (System auto-append is
 *     opt-in only: system never auto-appends to avoid noise.)
 *   - Output is a single concatenated string with no `@-import` syntax.
 *
 * No filesystem writes happen here — callers (`syncResourcesToVersion`,
 * project-rules compile) decide where to land the composed output.
 */

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
  /** Set when scope is 'extra'; undefined otherwise. */
  alias?: string;
}

interface PresetDef {
  /** Subrule names (without `.md`), in concatenation order. */
  subrules: string[];
}

interface RulesYaml {
  presets?: Record<string, PresetDef>;
}

interface ComposeOptions {
  /** Defaults to `"default"`. */
  preset?: string;
  /** Layers in precedence order, highest first. */
  layers: RulesLayer[];
}

export interface ComposedSubrule {
  name: string;
  sourcePath: string;
  layerScope: LayerScope;
  layerAlias?: string;
  /** Set when the subrule is dir-form (`subrules/<name>/`); the dir itself. */
  subruleDir?: string;
}

interface ComposeResult {
  /** Fully concatenated, no @-imports. */
  content: string;
  /** The preset name that was applied. */
  preset: string;
  /** The layer that defined the preset. */
  presetLayer: LayerScope;
  /** Subrules included, in concatenation order. */
  subrules: ComposedSubrule[];
}

const SUBRULES_DIR_NAME = 'subrules';
const RULES_YAML_NAME = 'rules.yaml';
const DEFAULT_PRESET = 'default';
const SUBRULES_README = 'README.md';
/** Inside a dir-form subrule, the prose file. */
const SUBRULE_RULE_FILE = 'rule.md';
/** Inside a dir-form subrule, the optional hook manifest. */
const SUBRULE_HOOKS_FILE = 'hooks.yaml';

/**
 * Resolve the prose file for a subrule named `name` under `<rulesDir>/subrules/`.
 *
 * A subrule resolves to the DIRECTORY form `subrules/<name>/rule.md` when that
 * file exists, otherwise the flat form `subrules/<name>.md`. Returns the
 * markdown path plus the dir-form subrule directory when applicable (callers
 * that fold hooks need the dir to resolve `hooks.yaml` and relative scripts).
 */
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

/**
 * List subrule names in a layer. A name is contributed by either the flat
 * form `subrules/<name>.md` OR the dir form `subrules/<name>/rule.md`; a
 * directory without `rule.md` is not a subrule and is skipped.
 */
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

/**
 * Compose a rules document from the given layers.
 *
 * Throws when the requested preset isn't defined in any layer's rules.yaml —
 * means the caller passed a typo or no layer ships the named preset.
 */
export function composeRules(opts: ComposeOptions): ComposeResult {
  const presetName = opts.preset || DEFAULT_PRESET;

  const presetMatch = resolvePreset(opts.layers, presetName);
  if (!presetMatch) {
    throw new Error(
      `Preset "${presetName}" not found in any rules.yaml across the active layers.`
    );
  }

  const composed: ComposedSubrule[] = [];
  const seen = new Set<string>();

  // 1. Preset's named subrules, resolved by per-name shadowing.
  for (const name of presetMatch.def.subrules || []) {
    if (seen.has(name)) continue;
    const found = findSubrule(opts.layers, name);
    if (!found) continue; // missing subrule: skip silently — same as @-import miss
    composed.push({
      name,
      sourcePath: found.sourcePath,
      layerScope: found.layer.scope,
      layerAlias: found.layer.alias,
      subruleDir: found.subruleDir,
    });
    seen.add(name);
  }

  // 2. Auto-append: any subrule in a non-system layer not yet included.
  //    Honors precedence — project layer's auto-appends come first.
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

  // 3. Concatenate. Trim trailing whitespace on each fragment so spacing is
  //    predictable — fragments often end in a newline already.
  const parts = composed.map((c) => fs.readFileSync(c.sourcePath, 'utf-8').replace(/\s+$/, ''));
  const content = parts.length === 0 ? '' : parts.join('\n\n') + '\n';

  return {
    content,
    preset: presetName,
    presetLayer: presetMatch.layer.scope,
    subrules: composed,
  };
}

/**
 * Discover layers for use at sync time (no cwd) or runtime (with cwd).
 *
 * Project layer is included only when cwd is given AND `<cwd>/.agents/rules/`
 * exists. Without cwd, only user / extras / system are surfaced — matching
 * the home-file write at sync time.
 */
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

/** Convenience wrapper — discovers layers from state, then composes. */
export function composeRulesFromState(opts: { preset?: string; cwd?: string } = {}): ComposeResult {
  const layers = discoverRulesLayers({ cwd: opts.cwd });
  return composeRules({ preset: opts.preset, layers });
}

/**
 * hooks.yaml shape (the bare-map form, chosen for brevity):
 *
 *   <hookName>:
 *     script: enforce.sh        # relative to the subrule dir
 *     events: [PreToolUse]
 *     matcher: "Edit|Write"     # optional
 *     timeout: 30               # optional
 *
 * A wrapped `{ hooks: { <hookName>: {...} } }` form is also accepted so a
 * hooks.yaml can carry sibling keys without confusing the parser.
 */
function parseSubruleHooksFile(file: string): Record<string, ManifestHook> {
  const parsed = yaml.parse(fs.readFileSync(file, 'utf-8')) as
    | Record<string, ManifestHook>
    | { hooks?: Record<string, ManifestHook> }
    | null;
  if (!parsed || typeof parsed !== 'object') return {};
  const map = (parsed as { hooks?: Record<string, ManifestHook> }).hooks ?? parsed;
  return (map as Record<string, ManifestHook>) || {};
}

/**
 * Collect hooks declared inside the active subrule directories.
 *
 * Resolves the same composed subrule set as {@link composeRules} (preset-named
 * plus auto-append, highest-layer-wins per name). For each dir-form subrule
 * that ships a `hooks.yaml`, parses it, rewrites each hook's `script` to an
 * ABSOLUTE path under the subrule dir, and namespaces the key as
 * `<subruleName>__<hookName>` to avoid collisions across subrules.
 *
 * Returns an empty map for flat subrules and dir-form subrules without a
 * `hooks.yaml`. A malformed hooks.yaml is skipped (try/catch) so a bad file
 * never breaks rule composition or hook registration.
 */
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
    if (!sub.subruleDir) continue; // flat subrule — no hooks
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
      // Malformed hooks.yaml — skip this subrule's hooks, keep the rest.
    }
  }

  return result;
}

/** Convenience wrapper — discovers layers from state, then collects hooks. */
export function collectSubruleHooksFromState(
  opts: { preset?: string; cwd?: string } = {}
): Record<string, ManifestHook> {
  const layers = discoverRulesLayers({ cwd: opts.cwd });
  return collectSubruleHooks(layers, opts.preset);
}
