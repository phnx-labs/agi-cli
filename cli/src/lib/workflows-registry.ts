/**
 * Workflow target registry — the ONE place that says how each
 * workflows-capable harness stores a synced workflow on disk.
 *
 * `WORKFLOW_TARGETS` is the declarative shape (container dir, file layout,
 * transform, ownership marker); the engine below (`listWorkflowsForAgent`,
 * `syncWorkflowToVersion`, `removeWorkflowFromVersion`,
 * `workflowContentMatches`) and the staleness detector are generic over it, so
 * adding a harness is one entry here plus its `workflows` capability flag in
 * `agent-spec/agents.ts` — never another `if (agent === '...')` arm in the
 * writer, the lister, the remover, the doctor drift check, and the detector.
 * A completeness test pins `Object.keys(WORKFLOW_TARGETS)` to
 * `capableAgents('workflows')` so the flag and the shape cannot drift.
 *
 * Same pattern as `SUBAGENT_TARGETS` in `subagents-registry.ts`.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from './types.js';
import { getVersionHomePath } from './installations/versions.js';
import { dirsContentMatch, normalizeResourceContent } from './resource-content-diff.js';
import {
  antigravityWorkflowMarker,
  antigravityWorkflowsDir,
  grokWorkflowMarker,
  kimiWorkflowMarker,
  openclawWorkflowMarker,
  parseWorkflowFrontmatter,
  renderGooseRecipeYaml,
  selectedWorkflowSubagents,
  transformWorkflowForAntigravity,
  transformWorkflowForGrok,
  transformWorkflowForKimi,
  transformWorkflowForOpenClaw,
  writeGooseSubrecipe,
} from './workflows.js';

/** A central workflow bundle: its synced name and the source dir holding WORKFLOW.md. */
interface WorkflowSource {
  name: string;
  path: string;
}

/**
 * The complete on-disk contract for one harness's workflows. Every operation
 * is expressed here so the engine below never branches on the agent id.
 */
interface WorkflowTarget {
  /** Noun used in ownership errors, e.g. "Kimi skill", "Grok workflow". */
  readonly label: string;
  /**
   * Absolute container dir for `versionHome`. A harness whose native store is
   * HOME-global (antigravity) ignores `versionHome` and resolves from `$HOME`.
   */
  dir(versionHome: string): string;
  /** Names of the workflows in `dir` that agents-cli manages (lister + detector). */
  names(dir: string): string[];
  /** Materialize `wf` into `dir`. Throws on an invalid source or fs error. */
  write(dir: string, wf: WorkflowSource): void;
  /** Paths workflow `name` occupies in `dir`; empty when it is not installed. */
  occupied(dir: string, name: string): string[];
  /**
   * Ownership of what sits at `name` in `dir`: `null` when nothing is there,
   * `true` when agents-cli wrote it (or the format has no ownership marker),
   * `false` when a user-authored file of the same name is in the way.
   */
  managed(dir: string, name: string): boolean | null;
  /**
   * True when the installed copy byte-matches what `write` would render from
   * `wf.path` NOW — the drift predicate `agents doctor` uses. Re-renders the
   * current source through the same transform the writer uses (never a stored
   * hash), so a body edit to the source surfaces as drift under an unchanged name.
   */
  matches(dir: string, wf: WorkflowSource): boolean;
}

function readdirSafe(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function renderedMatches(homePath: string, expected: string): boolean {
  let actual: string;
  try {
    actual = fs.readFileSync(homePath, 'utf-8');
  } catch {
    return false;
  }
  return normalizeResourceContent(actual) === normalizeResourceContent(expected);
}

// ── layouts ──────────────────────────────────────────────────────────────────

/**
 * One rendered `<name><ext>` file per workflow, owned via a marker the
 * transform embeds (antigravity, openclaw, grok).
 */
function renderedFile(opts: {
  label: string;
  dir: (versionHome: string) => string;
  ext: string;
  transform: (workflowPath: string, name: string) => string;
  marker: (filePath: string) => string | null;
}): WorkflowTarget {
  const file = (dir: string, name: string): string => path.join(dir, `${name}${opts.ext}`);
  return {
    label: opts.label,
    dir: opts.dir,
    names(dir) {
      return readdirSafe(dir)
        .filter((d) => d.isFile() && d.name.endsWith(opts.ext) && !d.name.startsWith('.'))
        .map((d) => d.name.slice(0, -opts.ext.length))
        .filter((base) => opts.marker(file(dir, base)) === base);
    },
    write(dir, wf) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file(dir, wf.name), opts.transform(wf.path, wf.name), 'utf-8');
    },
    occupied(dir, name) {
      const target = file(dir, name);
      return fs.existsSync(target) ? [target] : [];
    },
    managed(dir, name) {
      const target = file(dir, name);
      if (!fs.existsSync(target)) return null;
      return opts.marker(target) === name;
    },
    matches(dir, wf) {
      return renderedMatches(file(dir, wf.name), opts.transform(wf.path, wf.name));
    },
  };
}

/**
 * Kimi flow skill: a `<name>/SKILL.md` directory whose frontmatter carries
 * `type: flow` and the `agents_workflow` marker.
 */
const kimiFlowSkill: WorkflowTarget = {
  label: 'Kimi skill',
  dir: (versionHome) => path.join(versionHome, '.kimi-code', 'skills'),
  names(dir) {
    return readdirSafe(dir)
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'SKILL.md')))
      .filter((d) => kimiWorkflowMarker(path.join(dir, d.name, 'SKILL.md')) === d.name)
      .map((d) => d.name);
  },
  write(dir, wf) {
    const skillDir = path.join(dir, wf.name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), transformWorkflowForKimi(wf.path, wf.name), 'utf-8');
  },
  occupied(dir, name) {
    const skillDir = path.join(dir, name);
    return fs.existsSync(skillDir) ? [skillDir] : [];
  },
  managed(dir, name) {
    const skillDir = path.join(dir, name);
    if (!fs.existsSync(skillDir)) return null;
    return kimiWorkflowMarker(path.join(skillDir, 'SKILL.md')) === name;
  },
  matches(dir, wf) {
    return renderedMatches(path.join(dir, wf.name, 'SKILL.md'), transformWorkflowForKimi(wf.path, wf.name));
  },
};

/**
 * Goose recipe: `<name>.yaml` plus a `<name>.subrecipes/` dir holding one YAML
 * per selected workflow subagent. Goose has no ownership marker, so presence
 * is ownership.
 */
const gooseRecipe: WorkflowTarget = {
  label: 'Goose recipe',
  dir: (versionHome) => path.join(versionHome, '.config', 'goose', 'recipes'),
  names(dir) {
    return readdirSafe(dir)
      .filter((d) => d.isFile() && d.name.endsWith('.yaml') && !d.name.startsWith('.'))
      .map((d) => d.name.slice(0, -'.yaml'.length));
  },
  write(dir, wf) {
    const frontmatter = parseWorkflowFrontmatter(wf.path);
    const recipeYaml = frontmatter ? renderGooseRecipeYaml(wf.path, wf.name) : null;
    if (!frontmatter || recipeYaml == null) {
      throw new Error(`Workflow '${wf.name}' has invalid WORKFLOW.md frontmatter`);
    }
    const subrecipesDir = path.join(dir, `${wf.name}.subrecipes`);
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(subrecipesDir)) {
      fs.rmSync(subrecipesDir, { recursive: true, force: true });
    }
    for (const subagentName of selectedWorkflowSubagents(wf.path, frontmatter.allowedAgents)) {
      writeGooseSubrecipe(wf.path, subagentName, subrecipesDir);
    }
    fs.writeFileSync(path.join(dir, `${wf.name}.yaml`), recipeYaml, 'utf-8');
  },
  occupied(dir, name) {
    return [path.join(dir, `${name}.yaml`), path.join(dir, `${name}.subrecipes`)].filter((p) => fs.existsSync(p));
  },
  managed(dir, name) {
    return gooseRecipe.occupied(dir, name).length > 0 ? true : null;
  },
  matches(dir, wf) {
    const expected = renderGooseRecipeYaml(wf.path, wf.name);
    if (expected == null) return false;
    return renderedMatches(path.join(dir, `${wf.name}.yaml`), expected);
  },
};

/**
 * The canonical bundle copied verbatim: `<name>/WORKFLOW.md` (plus its
 * subagents/ tree) under `{versionHome}/workflows/`. No marker — the dir is
 * agents-cli's by construction.
 */
const workflowBundle: WorkflowTarget = {
  label: 'Workflow',
  dir: (versionHome) => path.join(versionHome, 'workflows'),
  names(dir) {
    return readdirSafe(dir)
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'WORKFLOW.md')))
      .map((d) => d.name);
  },
  write(dir, wf) {
    const target = path.join(dir, wf.name);
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
    fs.cpSync(wf.path, target, { recursive: true });
  },
  occupied(dir, name) {
    const target = path.join(dir, name);
    return fs.existsSync(target) ? [target] : [];
  },
  managed(dir, name) {
    return fs.existsSync(path.join(dir, name)) ? true : null;
  },
  matches(dir, wf) {
    return dirsContentMatch(wf.path, path.join(dir, wf.name));
  },
};

// ── the registry ─────────────────────────────────────────────────────────────

/**
 * Single source of truth for how each workflows-capable harness stores
 * workflows. The keys MUST match `capableAgents('workflows')` (the `workflows`
 * flag in `agent-spec/agents.ts`): the capability flag is the version gate,
 * this table is the shape.
 */
export const WORKFLOW_TARGETS: Partial<Record<AgentId, WorkflowTarget>> = {
  claude: workflowBundle,
  kimi: kimiFlowSkill,
  goose: gooseRecipe,
  // Antigravity discovers workflows in the shared HOME-global dir `agy` scans
  // at startup, never in a version home — see `antigravityWorkflowsDir`.
  antigravity: renderedFile({
    label: 'Antigravity workflow',
    dir: () => antigravityWorkflowsDir(),
    ext: '.md',
    transform: transformWorkflowForAntigravity,
    marker: antigravityWorkflowMarker,
  }),
  openclaw: renderedFile({
    label: 'OpenClaw workflow',
    dir: (versionHome) => path.join(versionHome, '.openclaw', 'workflows'),
    ext: '.lobster',
    transform: transformWorkflowForOpenClaw,
    marker: openclawWorkflowMarker,
  }),
  grok: renderedFile({
    label: 'Grok workflow',
    dir: (versionHome) => path.join(versionHome, '.grok', 'workflows'),
    ext: '.rhai',
    transform: transformWorkflowForGrok,
    marker: grokWorkflowMarker,
  }),
};

/** The registered target for `agent`; throws for a harness that has none. */
export function workflowTarget(agent: AgentId): WorkflowTarget {
  const target = WORKFLOW_TARGETS[agent];
  if (!target) {
    throw new Error(`${agent} has no workflow target (not in capableAgents('workflows'))`);
  }
  return target;
}

// ── the generic engine ───────────────────────────────────────────────────────

/** Workflow names agents-cli has synced into `versionHome` for `agent`. */
export function listWorkflowsForAgent(agent: AgentId, versionHome: string): string[] {
  const target = workflowTarget(agent);
  return target.names(target.dir(versionHome));
}

/**
 * Materialize the central bundle at `workflowPath` as `name` in `agent`'s
 * `versionHome`, in that harness's native layout. Refuses to clobber a
 * user-authored file of the same name (the ownership marker is the tell) and
 * is idempotent over an agents-cli-managed one.
 */
export function syncWorkflowToVersion(
  workflowPath: string,
  name: string,
  agent: AgentId,
  versionHome: string,
): { success: boolean; error?: string } {
  const target = workflowTarget(agent);
  const dir = target.dir(versionHome);
  try {
    if (target.managed(dir, name) === false) {
      return { success: false, error: `${target.label} '${name}' already exists and is not managed by agents-cli` };
    }
    target.write(dir, { name, path: workflowPath });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** Remove workflow `name` from `agent@version`; refuses a user-authored file. */
export function removeWorkflowFromVersion(
  agent: AgentId,
  version: string,
  name: string,
): { success: boolean; error?: string } {
  const target = workflowTarget(agent);
  const dir = target.dir(getVersionHomePath(agent, version));
  const occupied = target.occupied(dir, name);
  if (occupied.length === 0) {
    return { success: false, error: `Workflow '${name}' not synced to ${agent}@${version}` };
  }
  if (target.managed(dir, name) === false) {
    return { success: false, error: `${target.label} '${name}' is not managed by agents-cli` };
  }
  try {
    for (const entry of occupied) {
      fs.rmSync(entry, { recursive: true, force: true });
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * True when workflow `name` materialized in `agent`'s `versionHome` byte-matches
 * what the writer would produce NOW from `sourcePath` — the content-drift
 * predicate `agents doctor` uses. Returns false when the home copy is absent
 * (surfaced as `missing` at the name level, not here).
 */
export function workflowContentMatches(
  agent: AgentId,
  versionHome: string,
  name: string,
  sourcePath: string,
): boolean {
  const target = workflowTarget(agent);
  return target.matches(target.dir(versionHome), { name, path: sourcePath });
}
