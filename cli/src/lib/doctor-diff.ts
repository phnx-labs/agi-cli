/**
 * Per-version, per-cwd resource diff for `agents doctor <agent[@version]>`.
 *
 * Mirrors what `syncResourcesToVersion` writes into a version home, then
 * compares each kind back against its resolved source (project > user > system
 * > extra repos). Surfaces:
 *   - ok       — present in home, content matches resolved source
 *   - diff     — present in home, content differs from resolved source
 *   - missing  — resolved source exists, not present in home
 *   - extra    — present in home, no source in any layer
 *
 * Coverage — every kind `syncResourcesToVersion` writes is content-aware, so a
 * byte change under an unchanged name is `diff`, never a false `ok` (PHNX-3504):
 *   commands, skills, hooks, rules — full content compare with source layer.
 *   mcp        — structural compare of the home server def vs resolved source.
 *   subagents  — re-render source through the registry transform, byte-compare.
 *   workflows  — layout-aware per-harness content compare (dir tree or file).
 *   memory     — knowledge facts (~/.agents/memory/*.md), per-fact byte-compare.
 *   plugins    — per-item content compare of the marketplace mirror.
 *   permissions — per-rule compare in the harness's native vocabulary for the
 *     representable harnesses (claude/opencode/cursor/droid/openclaw); the lossy
 *     TOML/flag harnesses stay presence-only with an honest `detail`, never a
 *     faked `ok`.
 * A completeness test binds `DOCTOR_ALL_KINDS` to the writer set so a future
 * synced kind cannot silently become a blind spot. `promptcuts` is NOT a kind —
 * it is not version-scoped, so there is nothing per-home to diff.
 *
 * Intentional asymmetries (must mirror sync):
 *   - hooks ignore the project layer (`syncResourcesToVersion` skips
 *     project/.agents/hooks/ for safety).
 *   - rules/AGENTS.md is compared against the preset composition the rules writer
 *     emits (`composeRulesFromState`), re-rendered from the current `subrules/`
 *     fragments — so a fragment edit is caught even though `rules/AGENTS.md`
 *     never changed. A non-@-import home compiled by `agents refresh-rules`
 *     carries a leading `COMPILED_HEADER`, which is stripped before comparing so
 *     a header-compiled home still reconciles (the header is not source content).
 */

import * as fs from 'fs';
import * as path from 'path';
import { AGENTS, agentConfigDirName, getMcpConfigPathForHome } from './agents.js';
import type { AgentId } from './types.js';
import {
  getProjectAgentsDir,
  getUserAgentsDir,
  getSystemAgentsDir,
  getEnabledExtraRepos,
  getResolvedRulesDir,
  getUserRulesDir,
  getActiveRulesPreset,
} from './state.js';
import { composeRulesFromState } from './rules/compose.js';
import { COMPILED_HEADER, supportsRulesImports } from './rules/compile.js';
import { dirsContentMatch, filesContentMatch } from './resource-content-diff.js';
import { subagentContentMatches } from './subagents-registry.js';
import { getMcpServersByName, mcpServerMatches } from './mcp.js';
import { permissionsGroupMatches, PERMISSIONS_REPRESENTABLE } from './permissions.js';
import { resolveWorkflowRef } from './workflows.js';
import { workflowContentMatches } from './workflows-registry.js';
import { listMemoryFacts, memoryTargetDir } from './memory.js';
import {
  getAvailableResources,
  getActuallySyncedResources,
  getVersionHomePath,
  compareVersions,
} from './installations/versions.js';
import { discoverPlugins, marketplaceSpecForName } from './plugins/plugins.js';
import type { DiscoveredPlugin } from './types.js';
import { pluginInstallDir, repairableManifestFields } from './plugins/plugin-marketplace.js';
import { markdownToToml } from './convert.js';
import { listCommandsInVersionHome, getVersionCommandsDir, listPluginCommandNames } from './commands.js';
import { shouldInstallCommandAsSkill, commandSkillMatches, commandSkillName, skillSourceExists, readSkillSourceCommandMarker } from './command-skills.js';
import { trustedSkillRoots } from './staleness/writers/sources.js';
import { gooseCommandMatches, gooseCommandsDir } from './goose-commands.js';
import { supports } from './capabilities.js';
import { isDirectoryDoc } from './resources.js';
import { listSkillsInVersionHome, getVersionSkillsDir } from './plugins/skills.js';
import { listHookEntriesFromDir, type HookWiringReport } from './hooks/install.js';
import { getResourceInventory, type ResourceInventory } from './resource-inventory.js';

const RULES_DOC_FILENAME = 'README.md';

export type DoctorKind =
  | 'commands'
  | 'skills'
  | 'hooks'
  | 'rules'
  | 'mcp'
  | 'permissions'
  | 'subagents'
  | 'plugins'
  | 'workflows'
  | 'memory';

export type DiffStatus = 'ok' | 'diff' | 'missing' | 'extra';

export type SourceLayer = 'project' | 'user' | 'system' | 'extra';

export interface ResourceDiff {
  kind: DoctorKind;
  name: string;
  status: DiffStatus;
  source?: SourceLayer;
  /** Absolute path to the resolved source file/dir (when source is known). */
  sourcePath?: string;
  /** Absolute path to the file/dir inside the version home (when present). */
  homePath?: string;
  /** Human-readable specifics for a divergent row — e.g. for a stale plugin:
   *  "0.6.1→0.7.0, missing skills: ship, learn". Currently set for plugins. */
  detail?: string;
}

/** A source layer (user / system / an extra repo) that is behind its upstream —
 *  reconciled against stale truth. Attached to the report by the doctor command
 *  (needs a git probe, kept out of the pure per-version diff). */
export interface SourceLayerBehind {
  layer: 'user' | 'system' | 'extra';
  /** Human label for the layer's on-disk root (e.g. `~/.agents`). */
  label: string;
  /** `agents repo pull` alias for the remediation hint. */
  alias: string;
  behind: number;
  /** Upstream ref the layer trails (e.g. `origin/main`). */
  branch: string;
}

export interface VersionResourceReport {
  agent: AgentId;
  version: string;
  home: string;
  cwd: string;
  layers: {
    project: string | null;
    user: string;
    system: string;
    extras: Array<{ alias: string; dir: string }>;
  };
  kinds: Record<DoctorKind, ResourceDiff[]>;
  summary: { ok: number; diff: number; missing: number; extra: number };
  /** Wiring inspection for the version's native settings.json (claude/droid).
   *  Populated only when the `hooks` kind is in scope. */
  hookWiring?: HookWiringReport;
  /** Harness-scoped hook state from the shared inventory engine. */
  hookInventory?: ResourceInventory;
  /** Source layers behind their upstream. Filled by the doctor command (a git
   *  probe), not the pure diff — undefined when uncomputed. */
  sourceBehind?: SourceLayerBehind[];
}

const ALL_KINDS: DoctorKind[] = [
  'commands',
  'skills',
  'hooks',
  'rules',
  'mcp',
  'permissions',
  'subagents',
  'plugins',
  'workflows',
  'memory',
];

interface SourceCandidate {
  layer: SourceLayer;
  path: string;
  /** Optional alias when layer === 'extra'. */
  alias?: string;
}

function normalize(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

function readSafe(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

function fileExists(p: string | null | undefined): p is string {
  return !!p && fs.existsSync(p) && !fs.lstatSync(p).isSymbolicLink();
}

/**
 * True when `filePath` is a git symlink that was CHECKED OUT AS A PLAIN TEXT
 * FILE — the shape git produces on a client without symlink support (Windows
 * without Developer Mode, `core.symlinks=false`). Such a file holds exactly the
 * link target (a relative path, no trailing newline) instead of the pointed-to
 * content. `lstat().isSymbolicLink()` is FALSE for it, so callers that only
 * skip real symlinks (e.g. the rules/permissions alias files CLAUDE.md /
 * GEMINI.md, which are symlinks to AGENTS.md in the repo) wrongly treat it as
 * an independent resource that no sync can ever reconcile (PHNX-3187). The
 * signal is unambiguous: a whole file with no newline whose entire content
 * resolves to an existing sibling path. Real markdown rule files always contain
 * newlines, so this never false-positives on genuine content.
 */
export function isCheckedOutSymlink(filePath: string): boolean {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return false;
  }
  // A git symlink blob is the bare target with no newline; any newline means
  // this is real file content, not a link.
  if (content.length === 0 || content.length > 255 || /[\r\n]/.test(content)) return false;
  const target = content.trim();
  if (!target) return false;
  const resolved = path.resolve(path.dirname(filePath), target);
  try {
    return fs.statSync(resolved).isFile();
  } catch {
    return false;
  }
}

function findFirst(candidates: SourceCandidate[]): SourceCandidate | null {
  for (const c of candidates) {
    if (fileExists(c.path) || (fs.existsSync(c.path) && fs.lstatSync(c.path).isDirectory())) {
      return c;
    }
  }
  return null;
}

function buildLayerBases(cwd: string, kind: DoctorKind, opts: { excludeProject?: boolean } = {}) {
  const projectDir = opts.excludeProject ? null : getProjectAgentsDir(cwd);
  const userDir = getUserAgentsDir();
  const systemDir = getSystemAgentsDir();
  const extras = getEnabledExtraRepos();
  const out: SourceCandidate[] = [];
  if (projectDir) out.push({ layer: 'project', path: path.join(projectDir, kind) });
  out.push({ layer: 'user', path: path.join(userDir, kind) });
  out.push({ layer: 'system', path: path.join(systemDir, kind) });
  for (const e of extras) out.push({ layer: 'extra', path: path.join(e.dir, kind), alias: e.alias });
  return out;
}

/**
 * Resolve directory-shaped source resources of `kind` by name across the layers
 * (project > user > system > extra; first layer wins a name collision), keeping
 * only entries whose directory satisfies `predicate` (e.g. holds `AGENT.md`).
 */
function resolveSourceDirsByName(
  kind: DoctorKind,
  cwd: string,
  excludeProject: boolean,
  predicate: (dir: string) => boolean,
): Map<string, SourceCandidate> {
  const out = new Map<string, SourceCandidate>();
  for (const base of buildLayerBases(cwd, kind, { excludeProject })) {
    if (!fs.existsSync(base.path)) continue;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(base.path, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (out.has(entry.name)) continue;
      const dir = path.join(base.path, entry.name);
      if (!predicate(dir)) continue;
      out.set(entry.name, { layer: base.layer, path: dir, alias: base.alias });
    }
  }
  return out;
}

// ─── commands ─────────────────────────────────────────────────────────────────

function diffCommands(agent: AgentId, version: string, cwd: string, excludeProject = false): ResourceDiff[] {
  const agentConfig = AGENTS[agent];
  const isToml = agentConfig.format === 'toml';
  const ext = isToml ? '.toml' : '.md';
  const homeDir = getVersionCommandsDir(agent, version);
  // Command-as-skill agents (kimi, codex>=0.117, grok) install every command as a
  // SKILL wrapper at <agentDir>/skills/<cmd>/SKILL.md, not a native command file.
  // The compare must follow that or every command false-reports as drifted.
  const asSkill = shouldInstallCommandAsSkill(agent, version);
  // Agents that hold commands neither natively nor as skills (e.g. goose) must not
  // report source commands as "missing" — they structurally can't take them.
  if (!asSkill && !supports(agent, 'commands', version).ok) return [];
  const agentDir = path.join(getVersionHomePath(agent, version), agentConfigDirName(agent));
  const installed = new Set(listCommandsInVersionHome(agent, version));
  const layerBases = buildLayerBases(cwd, 'commands', { excludeProject });

  const sourceByName = new Map<string, SourceCandidate>();
  for (const base of layerBases) {
    if (!fs.existsSync(base.path)) continue;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(base.path, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const name = entry.name.replace(/\.md$/, '');
      // Directory docs (README/AGENTS/CLAUDE/GEMINI) live in commands/ but are
      // documentation, not commands. `discoverCommands` and `resolveResource`
      // both refuse them, so the sync writer never installs them — mirror that
      // here or every one false-reports as a missing command no sync can clear.
      if (isDirectoryDoc('commands', name)) continue;
      if (sourceByName.has(name)) continue;
      sourceByName.set(name, { layer: base.layer, path: path.join(base.path, entry.name), alias: base.alias });
    }
  }

  // The trusted skill roots the commands-as-skills writer consults to decide
  // whether a real skill of the same name already owns a command's target slot.
  const skillRoots = asSkill ? trustedSkillRoots() : [];

  const rows: ResourceDiff[] = [];
  const seen = new Set<string>();

  for (const [name, src] of sourceByName) {
    seen.add(name);
    if (!installed.has(name)) {
      // Command-as-skill agents (codex >= 0.117, kimi): when a real skill of the
      // same name exists in the sources, the skill wins the shared
      // `skills/<name>/` slot and `installCommandSkillToVersion` deliberately
      // writes no command wrapper (versions.ts keeps the real skill in
      // skillsToSync and overwrites any wrapper). The command's behavior is
      // provided by that same-named skill, so it is NOT missing drift — reporting
      // it so drove an unclearable "N missing" loop (PHNX-3186). Mirror the
      // writer's skip predicate exactly: a skill source of this name whose
      // `agents_command` marker is not this command (a real skill, or a different
      // command).
      if (asSkill && skillSourceExists(name, skillRoots) && readSkillSourceCommandMarker(name, skillRoots) !== name) {
        rows.push({
          kind: 'commands',
          name,
          status: 'ok',
          source: src.layer,
          sourcePath: src.path,
          detail: 'provided by same-named skill',
        });
        continue;
      }
      rows.push({ kind: 'commands', name, status: 'missing', source: src.layer, sourcePath: src.path });
      continue;
    }
    if (asSkill) {
      // Compare against the installed command-skill wrapper, not a native path.
      const matches = commandSkillMatches(agentDir, name, src.path);
      rows.push({
        kind: 'commands',
        name,
        status: matches ? 'ok' : 'diff',
        source: src.layer,
        sourcePath: src.path,
        homePath: path.join(agentDir, 'skills', commandSkillName(name), 'SKILL.md'),
      });
      continue;
    }
    if (agent === 'goose') {
      // Compare against the installed Goose recipe YAML + slash_commands registration.
      const matches = gooseCommandMatches(getVersionHomePath(agent, version), name, src.path);
      rows.push({
        kind: 'commands',
        name,
        status: matches ? 'ok' : 'diff',
        source: src.layer,
        sourcePath: src.path,
        homePath: path.join(gooseCommandsDir(getVersionHomePath(agent, version)), `${name}.yaml`),
      });
      continue;
    }
    const homePath = path.join(homeDir, `${name}${ext}`);
    const installedContent = readSafe(homePath);
    const sourceContent = readSafe(src.path);
    if (installedContent == null || sourceContent == null) {
      rows.push({ kind: 'commands', name, status: 'diff', source: src.layer, sourcePath: src.path, homePath });
      continue;
    }
    const expected = isToml ? markdownToToml(name, sourceContent) : sourceContent;
    const matches = normalize(installedContent) === normalize(expected);
    rows.push({
      kind: 'commands',
      name,
      status: matches ? 'ok' : 'diff',
      source: src.layer,
      sourcePath: src.path,
      homePath,
    });
  }

  // Plugin-bundled commands (installed as `<plugin>-<cmd>`) are source-managed by
  // their plugin, tracked under the `plugins` kind — not extras. Without this,
  // `agents doctor` shows every plugin command (swarm-plan, code-review, …) as an
  // unmanaged extra, mirroring the orphan false-positive the prune path had.
  const pluginCommands = listPluginCommandNames();
  for (const name of installed) {
    if (seen.has(name)) continue;
    // Directory docs are excluded from the source scan above; a leftover copy in
    // the home is not a command orphan — leave it out of the command diff
    // entirely rather than flip it to a spurious `extra` row.
    if (isDirectoryDoc('commands', name)) continue;
    if (pluginCommands.has(name)) continue;
    const extraHome = asSkill
      ? path.join(agentDir, 'skills', commandSkillName(name), 'SKILL.md')
      : agent === 'goose'
        ? path.join(gooseCommandsDir(getVersionHomePath(agent, version)), `${name}.yaml`)
        : path.join(homeDir, `${name}${ext}`);
    rows.push({ kind: 'commands', name, status: 'extra', homePath: extraHome });
  }

  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── skills ───────────────────────────────────────────────────────────────────

function diffSkills(agent: AgentId, version: string, cwd: string, excludeProject = false): ResourceDiff[] {
  // Native ~/.agents/skills consumers (Gemini, …) read central skills directly.
  // The orchestrator DELETES their version-home skills dir (syncResourcesToVersion)
  // and registers no skills writer, so there is nothing in the version home to
  // reconcile. Mirror diffVersionSkills' native gate (skills.ts) — without it
  // every central skill is false-reported `missing` and held as unreconcilable
  // forever (drift never clears for these agents).
  if (AGENTS[agent].nativeAgentsSkillsDir) return [];
  const homeDir = getVersionSkillsDir(agent, version);
  const installed = new Set(listSkillsInVersionHome(agent, version));
  const layerBases = buildLayerBases(cwd, 'skills', { excludeProject });

  const sourceByName = new Map<string, SourceCandidate>();
  for (const base of layerBases) {
    if (!fs.existsSync(base.path)) continue;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(base.path, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (!fs.existsSync(path.join(base.path, entry.name, 'SKILL.md'))) continue;
      if (sourceByName.has(entry.name)) continue;
      sourceByName.set(entry.name, { layer: base.layer, path: path.join(base.path, entry.name), alias: base.alias });
    }
  }

  const rows: ResourceDiff[] = [];
  const seen = new Set<string>();
  for (const [name, src] of sourceByName) {
    seen.add(name);
    const homePath = path.join(homeDir, name);
    if (!installed.has(name)) {
      rows.push({ kind: 'skills', name, status: 'missing', source: src.layer, sourcePath: src.path });
      continue;
    }
    const matches = dirsContentMatch(src.path, homePath);
    rows.push({
      kind: 'skills',
      name,
      status: matches ? 'ok' : 'diff',
      source: src.layer,
      sourcePath: src.path,
      homePath,
    });
  }

  for (const name of installed) {
    if (seen.has(name)) continue;
    rows.push({ kind: 'skills', name, status: 'extra', homePath: path.join(homeDir, name) });
  }

  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── hooks ────────────────────────────────────────────────────────────────────

function diffHooks(agent: AgentId, version: string, cwd: string, inventory: ResourceInventory): ResourceDiff[] {
  if (!AGENTS[agent].supportsHooks) return [];
  const installedByName = new Map(inventory.onDisk.map((e) => [e.name, e]));
  // Sync intentionally excludes project/.agents/hooks/ — mirror that.
  const layerBases = buildLayerBases(cwd, 'hooks', { excludeProject: true });

  // Group source files the same way the hook installer does (basename across
  // script + sidecar data file); first-layer wins on name collision.
  const sourceByName = new Map<string, { layer: SourceLayer; alias?: string; entry: ReturnType<typeof listHookEntriesFromDir>[number] }>();
  for (const base of layerBases) {
    if (!fs.existsSync(base.path)) continue;
    for (const entry of listHookEntriesFromDir(base.path)) {
      if (sourceByName.has(entry.name)) continue;
      sourceByName.set(entry.name, { layer: base.layer, alias: base.alias, entry });
    }
  }

  const rows: ResourceDiff[] = [];
  const seen = new Set<string>();
  for (const [name, src] of sourceByName) {
    seen.add(name);
    const installed = installedByName.get(name);
    if (!installed) {
      rows.push({ kind: 'hooks', name, status: 'missing', source: src.layer, sourcePath: src.entry.scriptPath });
      continue;
    }
    const a = readSafe(src.entry.scriptPath);
    const b = readSafe(installed.path);
    let matches = a != null && b != null && normalize(a) === normalize(b);
    if (matches && src.entry.dataFile && installed.detail) {
      const ad = readSafe(src.entry.dataFile);
      const bd = readSafe(installed.detail);
      matches = ad != null && bd != null && normalize(ad) === normalize(bd);
    } else if (matches && (!!src.entry.dataFile !== !!installed.detail)) {
      matches = false;
    }
    rows.push({
      kind: 'hooks',
      name,
      status: matches ? 'ok' : 'diff',
      source: src.layer,
      sourcePath: src.entry.scriptPath,
      homePath: installed.path,
    });
  }

  for (const [name, installed] of installedByName) {
    if (seen.has(name)) continue;
    rows.push({ kind: 'hooks', name, status: 'extra', homePath: installed.path });
  }

  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── rules / memory ───────────────────────────────────────────────────────────

function listRulesNames(cwd: string, excludeProject = false): Map<string, SourceCandidate> {
  const projectDir = excludeProject ? null : getProjectAgentsDir(cwd);
  const userRules = getUserRulesDir();
  const systemRules = getResolvedRulesDir();
  const extras = getEnabledExtraRepos();
  const layers: SourceCandidate[] = [];
  if (projectDir) layers.push({ layer: 'project', path: path.join(projectDir, 'rules') });
  layers.push({ layer: 'user', path: userRules });
  layers.push({ layer: 'system', path: systemRules });
  for (const e of extras) layers.push({ layer: 'extra', path: path.join(e.dir, 'rules'), alias: e.alias });

  const out = new Map<string, SourceCandidate>();
  for (const base of layers) {
    if (!fs.existsSync(base.path)) continue;
    let entries: string[];
    try { entries = fs.readdirSync(base.path); } catch { continue; }
    for (const file of entries) {
      if (!file.endsWith('.md') || file === RULES_DOC_FILENAME) continue;
      const filePath = path.join(base.path, file);
      const stat = fs.lstatSync(filePath);
      // Skip the CLAUDE.md / GEMINI.md alias symlinks — both when they are real
      // symlinks (posix) and when git checked them out as plain text files
      // (Windows), so they are never mistaken for independent rule sources the
      // writer can't produce (PHNX-3187).
      if (stat.isSymbolicLink() || isCheckedOutSymlink(filePath)) continue;
      const name = file.replace(/\.md$/, '');
      if (out.has(name)) continue;
      out.set(name, { layer: base.layer, path: path.join(base.path, file), alias: base.alias });
    }
  }
  return out;
}

function expectedRuleContent(agent: AgentId, name: string, version: string, sourcePath: string): string | null {
  // The instruction file (AGENTS → the agent's CLAUDE.md/GEMINI.md/AGENTS.md)
  // is COMPOSED from `subrules/` fragments for the version's active preset —
  // that is exactly what the rules writer emits (see
  // staleness/writers/rules.ts → composeRulesFromState). Compare against the
  // same rendering so a correctly-synced home file reconciles instead of being
  // held forever against the raw `rules/AGENTS.md` (the whole-repo doc, which a
  // preset composition deliberately never equals — system subrules don't
  // auto-append). The `agent` is not part of the rendering (every capable agent
  // gets identical composed bytes); it is kept for symmetry with the writer's
  // per-agent dispatch and future per-agent presets.
  if (name === 'AGENTS') {
    try {
      return composeRulesFromState({ preset: getActiveRulesPreset(agent, version) }).content;
    } catch {
      // No rules.yaml / unknown preset — the writer skips too; treat as unknown.
      return null;
    }
  }
  // Any sibling top-level rules file syncs as a raw copy.
  return readSafe(sourcePath);
}

function diffRules(agent: AgentId, version: string, cwd: string, excludeProject = false): ResourceDiff[] {
  const agentConfig = AGENTS[agent];
  const versionHome = getVersionHomePath(agent, version);
  const configDir = path.join(versionHome, agentConfigDirName(agent));
  const sourcesByName = listRulesNames(cwd, excludeProject);

  // Files actually present in the version home. Include *.md siblings AND the
  // agent's own instructions filename even when it is not *.md — cursor's rules
  // file is `.cursorrules`, so an `.md`-only scan never saw it and reported the
  // AGENTS rule `missing` on every sync, a phantom no reconcile could clear
  // (PHNX-3186).
  const homeFiles = new Set<string>();
  if (fs.existsSync(configDir)) {
    for (const f of fs.readdirSync(configDir)) {
      if (!f.endsWith('.md') && f !== agentConfig.instructionsFile) continue;
      homeFiles.add(f);
    }
  }

  const rows: ResourceDiff[] = [];
  const homeSeen = new Set<string>();

  for (const [name, src] of sourcesByName) {
    const targetName = name === 'AGENTS' ? agentConfig.instructionsFile : `${name}.md`;
    homeSeen.add(targetName);
    const homePath = path.join(configDir, targetName);

    if (!homeFiles.has(targetName)) {
      rows.push({ kind: 'rules', name, status: 'missing', source: src.layer, sourcePath: src.path });
      continue;
    }
    const expected = expectedRuleContent(agent, name, version, src.path);
    let actual = readSafe(homePath);
    if (expected == null || actual == null) {
      rows.push({ kind: 'rules', name, status: 'diff', source: src.layer, sourcePath: src.path, homePath });
      continue;
    }
    // A non-@-import home compiled by `agents refresh-rules` carries a leading
    // COMPILED_HEADER the raw preset composition does not. Strip it before the
    // compare so a header-compiled home still reconciles — the header is
    // agents-cli provenance, not source content (PHNX-3504).
    if (name === 'AGENTS' && !supportsRulesImports(agent) && actual.startsWith(COMPILED_HEADER)) {
      actual = actual.slice(COMPILED_HEADER.length);
    }
    rows.push({
      kind: 'rules',
      name,
      status: normalize(expected) === normalize(actual) ? 'ok' : 'diff',
      source: src.layer,
      sourcePath: src.path,
      homePath,
    });
  }

  // Anything in the configDir matching an instructions filename or AGENTS.md
  // but with no source is an extra. We only report files that look like rules
  // — i.e. the agent's instructionsFile, plus any *.md siblings that came
  // from the rules sync.
  const rulesFilenames = new Set<string>();
  rulesFilenames.add(agentConfig.instructionsFile);
  for (const targetName of homeSeen) rulesFilenames.add(targetName);
  for (const f of homeFiles) {
    if (homeSeen.has(f)) continue;
    if (!rulesFilenames.has(f) && f !== agentConfig.instructionsFile) continue;
    const name = f === agentConfig.instructionsFile ? 'AGENTS' : f.replace(/\.md$/, '');
    rows.push({ kind: 'rules', name, status: 'extra', homePath: path.join(configDir, f) });
  }

  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── mcp (content-aware) ────────────────────────────────────────────────────

function diffMcp(
  agent: AgentId,
  version: string,
  cwd: string,
  available: string[],
  synced: string[],
): ResourceDiff[] {
  const versionHome = getVersionHomePath(agent, version);
  const syncedSet = new Set(synced);
  const availableSet = new Set(available);
  const homePath = getMcpConfigPathForHome(agent, versionHome);
  // Resolve each available server's source def once (project trust off — this is
  // a read-only diff, and the writer applies the same servers).
  const sourceByName = new Map(
    getMcpServersByName(available, { cwd, enforceProjectTrust: false }).map((s) => [s.name, s]),
  );
  const rows: ResourceDiff[] = [];
  for (const name of available) {
    if (!syncedSet.has(name)) {
      rows.push({ kind: 'mcp', name, status: 'missing', sourcePath: sourceByName.get(name)?.path });
      continue;
    }
    const source = sourceByName.get(name);
    const matches = source ? mcpServerMatches(agent, versionHome, name, source.config) : false;
    rows.push({
      kind: 'mcp',
      name,
      status: matches ? 'ok' : 'diff',
      sourcePath: source?.path,
      homePath,
    });
  }
  for (const name of synced) {
    if (!availableSet.has(name)) rows.push({ kind: 'mcp', name, status: 'extra', homePath });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── permissions (content-aware where the native format allows) ──────────────

function diffPermissions(
  agent: AgentId,
  version: string,
  available: string[],
  synced: string[],
): ResourceDiff[] {
  const versionHome = getVersionHomePath(agent, version);
  const syncedSet = new Set(synced);
  const availableSet = new Set(available);
  const representable = PERMISSIONS_REPRESENTABLE.has(agent);
  const rows: ResourceDiff[] = [];
  for (const name of available) {
    if (!syncedSet.has(name)) {
      rows.push({ kind: 'permissions', name, status: 'missing' });
      continue;
    }
    if (representable) {
      const matches = permissionsGroupMatches(agent, versionHome, name);
      rows.push({ kind: 'permissions', name, status: matches ? 'ok' : 'diff' });
    } else {
      // Lossy TOML/flag harness — the on-disk format carries no faithful
      // per-group rule provenance, so we can only attest presence. Say so
      // explicitly rather than fake a verified `ok` (PHNX-3504).
      rows.push({ kind: 'permissions', name, status: 'ok', detail: 'format cannot verify content' });
    }
  }
  for (const name of synced) {
    if (!availableSet.has(name)) rows.push({ kind: 'permissions', name, status: 'extra' });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── subagents (content-aware) ───────────────────────────────────────────────

function diffSubagents(
  agent: AgentId,
  version: string,
  cwd: string,
  available: string[],
  synced: string[],
): ResourceDiff[] {
  const versionHome = getVersionHomePath(agent, version);
  const syncedSet = new Set(synced);
  const availableSet = new Set(available);
  // Resolve sources across the SAME layers `available` was built from
  // (getAvailableResources is project-inclusive), so every available name finds
  // its source dir for the content compare rather than false-diffing.
  const sourceByName = resolveSourceDirsByName('subagents', cwd, false, (dir) =>
    fs.existsSync(path.join(dir, 'AGENT.md')),
  );
  const rows: ResourceDiff[] = [];
  for (const name of available) {
    const src = sourceByName.get(name);
    if (!syncedSet.has(name)) {
      rows.push({ kind: 'subagents', name, status: 'missing', source: src?.layer, sourcePath: src?.path });
      continue;
    }
    const matches = src ? subagentContentMatches(agent, versionHome, name, src.path) : false;
    rows.push({
      kind: 'subagents',
      name,
      status: matches ? 'ok' : 'diff',
      source: src?.layer,
      sourcePath: src?.path,
    });
  }
  for (const name of synced) {
    if (!availableSet.has(name)) rows.push({ kind: 'subagents', name, status: 'extra' });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── workflows (content-aware) ───────────────────────────────────────────────

function diffWorkflows(
  agent: AgentId,
  version: string,
  cwd: string,
  available: string[],
  synced: string[],
): ResourceDiff[] {
  const versionHome = getVersionHomePath(agent, version);
  const syncedSet = new Set(synced);
  const availableSet = new Set(available);
  const rows: ResourceDiff[] = [];
  for (const name of available) {
    const sourcePath = resolveWorkflowRef(name, cwd);
    if (!syncedSet.has(name)) {
      rows.push({ kind: 'workflows', name, status: 'missing', sourcePath: sourcePath ?? undefined });
      continue;
    }
    const matches = sourcePath ? workflowContentMatches(agent, versionHome, name, sourcePath) : false;
    rows.push({
      kind: 'workflows',
      name,
      status: matches ? 'ok' : 'diff',
      sourcePath: sourcePath ?? undefined,
    });
  }
  for (const name of synced) {
    if (!availableSet.has(name)) rows.push({ kind: 'workflows', name, status: 'extra' });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── memory (knowledge facts — content-aware) ────────────────────────────────

/**
 * Diff synced knowledge-fact memory (~/.agents/memory/*.md fanned into each
 * capable home under `memoryTargetDir`). Distinct from the rules-preset list
 * that overloads `AvailableResources.memory` — this reads the canonical facts
 * (`listMemoryFacts`) and the home copies bounded by the `.agents-cli-memory.json`
 * manifest, so an untracked native memory file the user authored is never
 * mistaken for drift (PHNX-3504).
 */
function diffMemory(agent: AgentId, version: string, cwd: string): ResourceDiff[] {
  if (!supports(agent, 'memory', version).ok) return [];
  const versionHome = getVersionHomePath(agent, version);
  const targetDir = path.join(versionHome, memoryTargetDir(agent));
  const facts = listMemoryFacts(cwd);

  // The manifest names exactly the fact files agents-cli wrote (plus 'MEMORY').
  const managedManifestPath = path.join(targetDir, '.agents-cli-memory.json');
  let managed: string[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(managedManifestPath, 'utf-8')) as { facts?: unknown };
    if (Array.isArray(raw.facts)) managed = raw.facts.filter((f): f is string => typeof f === 'string');
  } catch { /* no manifest → nothing managed yet */ }
  const managedSet = new Set(managed);

  const rows: ResourceDiff[] = [];
  const factNames = new Set(facts.map((f) => f.name));
  for (const fact of facts) {
    const homePath = path.join(targetDir, `${fact.name}.md`);
    if (!fs.existsSync(homePath)) {
      rows.push({ kind: 'memory', name: fact.name, status: 'missing', source: fact.layer, sourcePath: fact.path });
      continue;
    }
    const matches = filesContentMatch(fact.path, homePath);
    rows.push({
      kind: 'memory',
      name: fact.name,
      status: matches ? 'ok' : 'diff',
      source: fact.layer,
      sourcePath: fact.path,
      homePath,
    });
  }
  // A managed fact still on disk but no longer in the canonical set is an orphan
  // the next sync would prune — surface it as extra. Never flag 'MEMORY' (the
  // index, always regenerated) or an unmanaged native file (not ours to reconcile).
  for (const name of managedSet) {
    if (name === 'MEMORY' || factNames.has(name)) continue;
    const homePath = path.join(targetDir, `${name}.md`);
    if (fs.existsSync(homePath)) rows.push({ kind: 'memory', name, status: 'extra', homePath });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── plugins (content-aware) ───────────────────────────────────────────────

function listPluginSkillDirs(pluginDir: string): string[] {
  const d = path.join(pluginDir, 'skills');
  try {
    return fs.readdirSync(d, { withFileTypes: true })
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && fs.existsSync(path.join(d, e.name, 'SKILL.md')))
      .map((e) => e.name);
  } catch { return []; }
}

function listPluginCommandFiles(pluginDir: string): string[] {
  const d = path.join(pluginDir, 'commands');
  try {
    return fs.readdirSync(d).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
  } catch { return []; }
}

/**
 * Describe how a version's marketplace MIRROR of a plugin diverges from its
 * central source — the detail presence-only checks miss. Surfaces a stale mirror
 * version, a Claude-invalid manifest, and (the part users care about) the
 * plugin's own skills/commands that never made it into the mirror. Returns null
 * when the mirror faithfully matches source.
 */
export function describePluginDrift(central: DiscoveredPlugin, mirrorDir: string): string | null {
  if (!fs.existsSync(mirrorDir)) return 'mirror missing';
  const parts: string[] = [];

  let mManifest: Record<string, unknown> | null = null;
  try {
    mManifest = JSON.parse(fs.readFileSync(path.join(mirrorDir, '.claude-plugin', 'plugin.json'), 'utf-8'));
  } catch { mManifest = null; }

  const mVer = mManifest && typeof mManifest.version === 'string' ? mManifest.version : undefined;
  const cVer = central.manifest.version;
  if (mVer && cVer && compareVersions(cVer, mVer) > 0) parts.push(`${mVer}→${cVer}`);
  if (mManifest && repairableManifestFields(mManifest).length > 0) parts.push('invalid manifest');

  const centralSkills = listPluginSkillDirs(central.root);
  const mirrorSkills = new Set(listPluginSkillDirs(mirrorDir));
  const missSkills = centralSkills.filter((s) => !mirrorSkills.has(s)).sort();
  const centralCmds = listPluginCommandFiles(central.root);
  const mirrorCmds = new Set(listPluginCommandFiles(mirrorDir));
  const missCmds = centralCmds.filter((c) => !mirrorCmds.has(c)).sort();
  if (missSkills.length) parts.push(`missing skill${missSkills.length > 1 ? 's' : ''}: ${missSkills.join(', ')}`);
  if (missCmds.length) parts.push(`missing command${missCmds.length > 1 ? 's' : ''}: ${missCmds.join(', ')}`);

  // Content drift of a skill/command that exists in BOTH — the mirror kept the
  // dir/file but its bytes went stale (PHNX-2955: a skill edit landed on origin
  // and was pulled into central, but the per-version marketplace copy was never
  // refreshed, so agents kept executing the OLD skill text while `plugins list`
  // and `doctor` reported it `everywhere`/`ok`). Presence alone missed this; a
  // content compare is what turns a stale mirror into a reportable `diff`.
  const staleSkills = centralSkills
    .filter((s) => mirrorSkills.has(s))
    .filter((s) => !dirsContentMatch(path.join(central.root, 'skills', s), path.join(mirrorDir, 'skills', s)))
    .sort();
  const staleCmds = centralCmds
    .filter((c) => mirrorCmds.has(c))
    .filter((c) => {
      const a = readSafe(path.join(central.root, 'commands', `${c}.md`));
      const b = readSafe(path.join(mirrorDir, 'commands', `${c}.md`));
      return a == null || b == null || normalize(a) !== normalize(b);
    })
    .sort();
  if (staleSkills.length) parts.push(`stale skill${staleSkills.length > 1 ? 's' : ''}: ${staleSkills.join(', ')}`);
  if (staleCmds.length) parts.push(`stale command${staleCmds.length > 1 ? 's' : ''}: ${staleCmds.join(', ')}`);

  return parts.length ? parts.join(', ') : null;
}

function diffPlugins(agent: AgentId, version: string, cwd: string): ResourceDiff[] {
  const versionHome = getVersionHomePath(agent, version);
  const synced = new Set(getActuallySyncedResources(agent, version, { cwd }).plugins);
  const rows: ResourceDiff[] = [];
  const seen = new Set<string>();

  for (const p of discoverPlugins({ cwd })) {
    if (seen.has(p.name)) continue; // dedupe across marketplaces for the readout
    seen.add(p.name);
    if (!synced.has(p.name)) {
      rows.push({ kind: 'plugins', name: p.name, status: 'missing', sourcePath: p.root });
      continue;
    }
    const mirror = pluginInstallDir(p, marketplaceSpecForName(p.marketplace), agent, versionHome);
    const detail = describePluginDrift(p, mirror);
    rows.push({
      kind: 'plugins',
      name: p.name,
      status: detail ? 'diff' : 'ok',
      sourcePath: p.root,
      homePath: mirror,
      ...(detail ? { detail } : {}),
    });
  }
  for (const name of synced) {
    if (!seen.has(name)) rows.push({ kind: 'plugins', name, status: 'extra' });
  }

  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── public API ───────────────────────────────────────────────────────────────

interface DiffOptions {
  cwd?: string;
  /** Restrict to specific kinds; undefined = all. */
  kinds?: DoctorKind[];
  /**
   * Drop the project (`<cwd>/.agents/`) layer from resolution. Used by the heal
   * path: the GLOBAL version home is only ever reconciled against user/system/
   * extra sources — project resources are layered at launch, never synced into
   * the global home, so counting them as "missing" there is a false gap.
   */
  excludeProject?: boolean;
}

export function diffVersionResources(
  agent: AgentId,
  version: string,
  options: DiffOptions = {},
): VersionResourceReport {
  const rawCwd = options.cwd ?? process.cwd();
  const excludeProject = options.excludeProject ?? false;
  const home = getVersionHomePath(agent, version);
  const requested = new Set<DoctorKind>(options.kinds ?? ALL_KINDS);

  // When excluding the project layer, resolve every per-cwd lookup against a
  // neutral cwd so no `<cwd>/.agents/` is ever discovered.
  const cwd = rawCwd;
  const projectDir = excludeProject ? null : getProjectAgentsDir(cwd);

  const available = getAvailableResources(cwd);
  const synced = getActuallySyncedResources(agent, version, { cwd });

  const empty: Record<DoctorKind, ResourceDiff[]> = {
    commands: [],
    skills: [],
    hooks: [],
    rules: [],
    mcp: [],
    permissions: [],
    subagents: [],
    plugins: [],
    workflows: [],
    memory: [],
  };

  if (requested.has('commands')) empty.commands = diffCommands(agent, version, cwd, excludeProject);
  if (requested.has('skills')) empty.skills = diffSkills(agent, version, cwd, excludeProject);
  const hookInventory = requested.has('hooks') ? getResourceInventory(agent, version, 'hooks', { cwd }) : undefined;
  if (hookInventory) empty.hooks = diffHooks(agent, version, cwd, hookInventory);
  // Wiring check: a hook FILE can be present and byte-identical to source (ok
  // above) yet never referenced in settings.json, so it never fires. Only
  // meaningful when hooks are in scope.
  const hookWiring = hookInventory?.wiring;
  if (requested.has('rules')) empty.rules = diffRules(agent, version, cwd, excludeProject);
  if (requested.has('mcp')) empty.mcp = diffMcp(agent, version, cwd, available.mcp, synced.mcp);
  if (requested.has('permissions')) {
    empty.permissions = diffPermissions(
      agent,
      version,
      supports(agent, 'allowlist', version).ok ? available.permissions : [],
      synced.permissions,
    );
  }
  // Subagents are version-gated (e.g. kimi >= 0.29.0). A version below the floor
  // is never written any subagent by the sync writer, so counting the source
  // ones as "missing" is phantom drift no sync can clear (PHNX-3186). Zero the
  // available set when unsupported; a stale installed copy still surfaces `extra`.
  if (requested.has('subagents')) {
    empty.subagents = diffSubagents(
      agent,
      version,
      cwd,
      supports(agent, 'subagents', version).ok ? available.subagents : [],
      synced.subagents,
    );
  }
  if (requested.has('plugins')) empty.plugins = diffPlugins(agent, version, cwd);
  // Workflows are version-gated too (e.g. grok >= 0.2.111); zero the available
  // set below the floor so a source workflow is not phantom-missing drift.
  if (requested.has('workflows')) {
    empty.workflows = diffWorkflows(
      agent,
      version,
      cwd,
      supports(agent, 'workflows', version).ok ? available.workflows : [],
      synced.workflows,
    );
  }
  if (requested.has('memory')) empty.memory = diffMemory(agent, version, cwd);

  let ok = 0, diff = 0, missing = 0, extra = 0;
  for (const list of Object.values(empty)) {
    for (const r of list) {
      if (r.status === 'ok') ok++;
      else if (r.status === 'diff') diff++;
      else if (r.status === 'missing') missing++;
      else if (r.status === 'extra') extra++;
    }
  }

  return {
    agent,
    version,
    home,
    cwd,
    layers: {
      project: projectDir,
      user: getUserAgentsDir(),
      system: getSystemAgentsDir(),
      extras: getEnabledExtraRepos().map((e) => ({ alias: e.alias, dir: e.dir })),
    },
    kinds: empty,
    summary: { ok, diff, missing, extra },
    ...(hookWiring ? { hookWiring } : {}),
    ...(hookInventory ? { hookInventory } : {}),
  };
}

export const DOCTOR_ALL_KINDS = ALL_KINDS;
