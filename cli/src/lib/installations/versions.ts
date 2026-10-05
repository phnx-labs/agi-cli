/** Version lifecycle, resource sync and agent@version resolution. Each version lives in an
 * isolated home under ~/.agents/.history/versions/{agent}/{version}/. */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'yaml';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import * as TOML from 'smol-toml';
import { checkbox, select, confirm } from '@inquirer/prompts';
import type { AgentId, DiscoveredPlugin, VersionResources } from '../types.js';
import { getVersionsDir, getShimsDir, ensureAgentsDir, readMeta, writeMeta, getCommandsDir, getSkillsDir, getHooksDir, getResolvedRulesDir, getUserRulesDir, getPermissionsDir, getSubagentsDir, getVersionResources, recordVersionResources, ensureVersionResourcePatterns, getMcpDir, getProjectAgentsDir, getPromptcutsPath, getUserPromptcutsPath, getEnabledExtraRepos, getAgentsDir, getOptionalUserAgentsDir, getUserAgentsDir, getTrashVersionsDir, getActiveRulesPreset, getHomeDir } from '../state.js';
import { defaultPatterns, expandPatterns } from '../resource-patterns.js';
import { resolveResource, listResources } from '../resources.js';
import { activeRulesPreset, filterNamesForActiveResourceProfile } from '../resource-profiles.js';
// VERSION_RE + compareVersions are owned by the agent-spec engine primitives
// (single source of truth). Re-exported below so existing importers of
// `compareVersions` from './versions.js' keep working.
import { VERSION_RE, compareVersions } from '../agent-spec/primitives.js';
import { AGENTS, agentConfigDirName, getAccountEmail, getMcpConfigPathForHome, parseMcpConfig, resolveAgentName, formatAgentError, findInPath, isSelfUpdatingAgent, isAgentHardDeprecated, hardDeprecationError } from '../agents.js';
import { getDefaultPermissionSet, applyPermissionsToVersion as applyPermsToVersion, discoverPermissionGroups, getTotalPermissionRuleCount, buildPermissionsFromGroups, CODEX_RULES_FILENAME, getActivePermissionPresetName, readPermissionPresetRecipe, PERMISSION_PRESET_ENV_VAR } from '../permissions.js';
import { installMcpServers, parseMcpConfigForScan, isProjectMcpTrusted } from '../mcp.js';
import { markdownToToml } from '../convert.js';
import {
  createVersionedAlias,
  removeVersionedAlias,
  switchConfigSymlink,
  getConfigSymlinkVersion,
  ensureClaudeInsideSymlink,
  assertIsolationBoundary,
  isIsolationProtected,
} from './shims.js';
import { importInstallScriptBinary } from '../import.js';
import {
  createInstallation,
  readInstallation,
  getBinaryPath,
  getCliVersionFromPath,
  getGlobalDefault,
  getIsolatedDefault,
  getLiveVersion,
  getVersionDir,
  getVersionHomePath,
  invalidateInstalledVersionsCache,
  invalidateLiveVersionCache,
  isGlobalBinaryAgent,
  isVersionInstalled,
  isVersionIsolated,
  listInstalledVersions,
  pickCanonicalGlobalBinaryVersion,
  resolveGrokFallbackBinary,
  resolveVersion,
} from './store.js';
export * from './store.js';
import { INSTALLATION_RECORD_FILE } from './types.js';
import { composeWin32CommandLine } from '../platform/index.js';
import { listInstalledSubagents, transformSubagentForClaude, syncSubagentToOpenclaw } from '../subagents.js';
import { listInstalledWorkflows } from '../workflows.js';
import { parseHookManifest, registerHooksToSettings, selectHookManifest, pruneVersionHomeHookEntriesFromSettings, installSessionTrackerHookSync, installSessionTrackerHook, repairManagedHookRuntimeArtifacts } from '../hooks/install.js';
import { supports, explainSkip, capableAgents } from '../capabilities.js';
import { discoverPlugins, syncPluginToVersion, isPluginSynced, pluginSupportsAgent, cleanOrphanedPluginSkills, marketplaceSpecForName } from '../plugins/plugins.js';
import { composeRulesFromState } from '../rules/compose.js';
import { loadManifest, saveManifest, buildManifest as buildSyncManifest, isStale } from '../staleness/index.js';
import { pruneRemovedResources, type PrunableKind } from '../staleness/prune.js';
import { emit } from '../feed/events.js';
import { withFileLockAsync } from '../fs-atomic.js';
import { installationLockTarget, INSTALLATION_LOCK_OPTIONS } from './installation-lock.js';
import { isInstallationLikelyActive } from './active-check.js';
import { safeJoin } from '../paths.js';
import {
  installCommandSkillToVersion,
  listCommandSkillsInVersion,
  readSkillSourceCommandMarker,
  shouldAlsoInstallCommandAsSkill,
  shouldInstallCommandAsSkill,
} from '../command-skills.js';
import { getWriter, getDetector } from '../staleness/registry.js';
import { syncMemoryToVersionHome, syncClaudeProjectMemoryDir } from '../memory.js';
import { listPluginSkillNames, resolveCommandSource, resolveSkillSource } from '../staleness/writers/sources.js';
import { syncProjectResourcesToAgent } from '../project-resources.js';
import { installClaudeStatusLine } from '../claude-statusline.js';

/** Promisified exec for running shell commands. */
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const RULES_DOC_FILENAME = 'README.md';

// VERSION_RE and compareVersions now live in ./agent-spec/primitives.ts and are
// imported above — kept as the single validation/ordering authority.

/** Resource selection for syncing to a version: 'all', a name list, or undefined (skip). */
export interface ResourceSelection {
  commands?: string[] | 'all';
  skills?: string[] | 'all';
  hooks?: string[] | 'all';
  memory?: string[] | 'all';
  mcp?: string[] | 'all';
  permissions?: string[] | 'all';
  subagents?: string[] | 'all';
  plugins?: string[] | 'all';
  workflows?: string[] | 'all';
}

/** Resources available in ~/.agents/ for syncing. `promptcuts` is a boolean because it is a single, version-unscoped file. */
export interface AvailableResources {
  commands: string[];
  skills: string[];
  hooks: string[];
  memory: string[];
  mcp: string[];
  permissions: string[];
  subagents: string[];
  plugins: string[];
  workflows: string[];
  promptcuts: boolean;
}

type LayeredResourceBase = { source: string; base: string };
type ResourceBase = { scope: 'project' | 'user'; base: string };
type ScopedMcpResource = { name: string; scope: 'project' | 'user' };

function getLayeredResourceBases(cwd: string): LayeredResourceBase[] {
  const projectAgentsDir = getProjectAgentsDir(cwd);
  const userBase = getUserAgentsDir();
  const systemBase = getAgentsDir();
  const resourceBases: LayeredResourceBase[] = [];
  if (projectAgentsDir) {
    resourceBases.push({ source: 'project', base: projectAgentsDir });
  }
  resourceBases.push({ source: 'user', base: userBase });
  resourceBases.push({ source: 'system', base: systemBase });
  for (const extra of getEnabledExtraRepos()) {
    resourceBases.push({ source: extra.alias, base: extra.dir });
  }
  return resourceBases;
}

function getResourceBases(cwd: string): ResourceBase[] {
  return getLayeredResourceBases(cwd).map(({ base, source }) => ({
    base,
    scope: source === 'project' ? 'project' : 'user',
  }));
}

function getScopedMcpResources(cwd: string): ScopedMcpResource[] {
  const resources = new Map<string, ScopedMcpResource>();
  for (const { base, scope } of getResourceBases(cwd)) {
    const mcpDir = path.join(base, 'mcp');
    if (!fs.existsSync(mcpDir)) continue;
    const files = fs.readdirSync(mcpDir)
      .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
    for (const file of files) {
      const config = parseMcpConfigForScan(path.join(mcpDir, file));
      if (config?.name && !resources.has(config.name)) {
        resources.set(config.name, { name: config.name, scope });
      }
    }
  }
  return Array.from(resources.values());
}

function sourceMapFromResources(kind: 'commands' | 'skills' | 'hooks' | 'subagents', cwd: string): Map<string, string> {
  return new Map(listResources(kind, cwd).map(r => [r.name, r.source]));
}

function sourceMapFromLayeredDirectory(cwd: string, relativePath: string[], listNames: (dir: string) => string[]): Map<string, string> {
  const resources = new Map<string, string>();
  for (const { base, source } of getLayeredResourceBases(cwd)) {
    const dir = path.join(base, ...relativePath);
    if (!fs.existsSync(dir)) continue;
    for (const name of listNames(dir)) {
      if (!resources.has(name)) resources.set(name, source);
    }
  }
  return resources;
}

function sourceMapFromPermissionGroups(cwd: string): Map<string, string> {
  return sourceMapFromLayeredDirectory(
    cwd,
    ['permissions', 'groups'],
    (dir) => fs.readdirSync(dir)
      .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
      .map(f => f.replace(/\.(yaml|yml)$/, '')),
  );
}

function sourceMapFromWorkflows(cwd: string): Map<string, string> {
  return sourceMapFromLayeredDirectory(
    cwd,
    ['workflows'],
    (dir) => fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'WORKFLOW.md')))
      .map(d => d.name),
  );
}

// Attribute each plugin to the layer it resolves from so `system:*` selections include system-layer plugins.
function sourceMapFromPlugins(cwd: string): Map<string, string> {
  return sourceMapFromLayeredDirectory(
    cwd,
    ['plugins'],
    (dir) => fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory() && fs.existsSync(path.join(dir, d.name, '.claude-plugin', 'plugin.json')))
      .map(d => d.name),
  );
}

function sourceMapFromPluginSkills(plugins: DiscoveredPlugin[], activePluginNames: Set<string>, cwd: string): Map<string, string> {
  const sourceRank = new Map<string, number>([
    ['user', 0],
    ['system', 1],
    ['project', 3],
  ]);
  const entries = plugins
    .filter(plugin => activePluginNames.has(plugin.name))
    .map(plugin => {
      const spec = marketplaceSpecForName(plugin.marketplace, cwd);
      const source = spec.kind === 'extra' ? spec.alias : spec.kind;
      return { plugin, source, rank: sourceRank.get(source) ?? 2 };
    })
    .sort((a, b) => a.rank - b.rank);
  const sources = new Map<string, string>();
  for (const { plugin, source } of entries) {
    for (const skill of plugin.skills) {
      if (!sources.has(skill)) sources.set(skill, source);
    }
  }
  return sources;
}

/** Discover all resources available for syncing from ~/.agents/. */
export function getAvailableResources(cwd: string = process.cwd()): AvailableResources {
  const result: AvailableResources = {
    commands: [],
    skills: [],
    hooks: [],
    memory: [],
    mcp: [],
    permissions: [],
    subagents: [],
    plugins: [],
    workflows: [],
    promptcuts: false,
  };

  const projectAgentsDir = getProjectAgentsDir(cwd);
  const resourceBases = getResourceBases(cwd);

  // Commands (*.md files)
  const commandNames = new Set<string>();
  for (const { base } of resourceBases) {
    const commandsDir = path.join(base, 'commands');
    if (!fs.existsSync(commandsDir)) continue;
    const names = fs.readdirSync(commandsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''));
    for (const name of names) {
      commandNames.add(name);
    }
  }
  result.commands = filterNamesForActiveResourceProfile('commands', Array.from(commandNames), sourceMapFromResources('commands', cwd));

  // Skills (directories, excluding hidden)
  const skillNames = new Set<string>();
  for (const { base } of resourceBases) {
    const skillsDir = path.join(base, 'skills');
    if (!fs.existsSync(skillsDir)) continue;
    const names = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name);
    for (const name of names) {
      skillNames.add(name);
    }
  }
  result.skills = filterNamesForActiveResourceProfile('skills', Array.from(skillNames), sourceMapFromResources('skills', cwd));

  // Hooks: top-level scripts, expanded one-level group dirs, or whole-dir bundles. Exec bit alone is not the signal (older syncs chmod'd everything).
  const NON_SCRIPT_EXTS = new Set(['.md', '.markdown', '.rst', '.txt', '.yaml', '.yml', '.json', '.toml', '.ini', '.conf']);
  const SCRIPT_EXTS     = new Set(['.sh', '.bash', '.zsh', '.py', '.js', '.ts', '.mjs', '.cjs', '.rb', '.pl', '.ps1']);
  const HOOK_GROUP_SKIP = new Set(['node_modules', '.git', '.cache']);
  const hookNames = new Set<string>();
  const isHookScriptName = (fileName: string, mode: number): boolean => {
    const ext = path.extname(fileName).toLowerCase();
    if (SCRIPT_EXTS.has(ext)) return true;
    return (mode & 0o111) !== 0 && !NON_SCRIPT_EXTS.has(ext);
  };
  for (const { base } of resourceBases) {
    const hooksDir = path.join(base, 'hooks');
    if (!fs.existsSync(hooksDir)) continue;
    for (const name of fs.readdirSync(hooksDir)) {
      if (name.startsWith('.')) continue;
      try {
        const full = path.join(hooksDir, name);
        const stat = fs.lstatSync(full);
        if (stat.isSymbolicLink()) continue;
        if (stat.isFile()) {
          if (isHookScriptName(name, stat.mode)) hookNames.add(name);
          continue;
        }
        if (!stat.isDirectory() || HOOK_GROUP_SKIP.has(name)) continue;
        // Expand dirs containing top-level scripts; bundle dirs without any.
        let nestedNames: string[];
        try {
          nestedNames = fs.readdirSync(full);
        } catch {
          continue;
        }
        const scripts: string[] = [];
        for (const nested of nestedNames) {
          if (nested.startsWith('.')) continue;
          try {
            const nfull = path.join(full, nested);
            const nstat = fs.lstatSync(nfull);
            if (nstat.isSymbolicLink() || !nstat.isFile()) continue;
            if (isHookScriptName(nested, nstat.mode)) scripts.push(nested);
          } catch { /* ignore */ }
        }
        if (scripts.length > 0) {
          for (const s of scripts) hookNames.add(s);
        } else {
          hookNames.add(name);
        }
      } catch { /* ignore unreadable */ }
    }
  }
  result.hooks = filterNamesForActiveResourceProfile('hooks', Array.from(hookNames), sourceMapFromResources('hooks', cwd));

  // Rules — list available presets across layers.
  const presetNames = new Set<string>();
  const rulesDirs: string[] = [];
  if (projectAgentsDir) rulesDirs.push(path.join(projectAgentsDir, 'rules'));
  rulesDirs.push(getUserRulesDir());
  rulesDirs.push(getResolvedRulesDir());
  for (const extra of getEnabledExtraRepos()) {
    rulesDirs.push(path.join(extra.dir, 'rules'));
  }
  for (const rulesDir of rulesDirs) {
    const rulesYamlPath = path.join(rulesDir, 'rules.yaml');
    if (!fs.existsSync(rulesYamlPath)) continue;
    try {
      const parsed = yaml.parse(fs.readFileSync(rulesYamlPath, 'utf-8')) as { presets?: Record<string, unknown> } | null;
      for (const name of Object.keys(parsed?.presets || {})) {
        presetNames.add(name);
      }
    } catch {
      // malformed rules.yaml — skip silently; the composer will surface the error.
    }
  }
  result.memory = filterNamesForActiveResourceProfile('memory', Array.from(presetNames));

  const scopedMcp = getScopedMcpResources(cwd);
  result.mcp = filterNamesForActiveResourceProfile(
    'mcp',
    scopedMcp.map(resource => resource.name),
    new Map(scopedMcp.map(resource => [resource.name, resource.scope])),
  );

  const permissionSources = sourceMapFromPermissionGroups(cwd);
  result.permissions = filterNamesForActiveResourceProfile('permissions', Array.from(permissionSources.keys()), permissionSources);

  const subagentNames = new Set<string>();
  for (const { base } of resourceBases) {
    const subagentsDir = path.join(base, 'subagents');
    if (!fs.existsSync(subagentsDir)) continue;
    const names = fs.readdirSync(subagentsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && fs.existsSync(path.join(subagentsDir, d.name, 'AGENT.md')))
      .map(d => d.name);
    for (const name of names) {
      subagentNames.add(name);
    }
  }
  result.subagents = filterNamesForActiveResourceProfile('subagents', Array.from(subagentNames), sourceMapFromResources('subagents', cwd));

  const workflowSources = sourceMapFromWorkflows(cwd);
  result.workflows = filterNamesForActiveResourceProfile('workflows', Array.from(workflowSources.keys()), workflowSources);

  // Plugins (directories with .claude-plugin/plugin.json)
  const allPlugins = discoverPlugins();
  result.plugins = filterNamesForActiveResourceProfile('plugins', allPlugins.map(p => p.name), new Map(allPlugins.map(p => [p.name, 'user'])));
  const activePlugins = new Set(result.plugins);
  const pluginSkillNames = filterNamesForActiveResourceProfile(
    'skills',
    listPluginSkillNames({ plugins: activePlugins }),
    sourceMapFromPluginSkills(allPlugins, activePlugins, cwd),
  );
  for (const name of pluginSkillNames) {
    if (!skillNames.has(name)) result.skills.push(name);
  }

  // Promptcuts — present if either layer exists. Reads merge user + system
  // with user precedence (see readMergedPromptcuts); writes always go to user.
  result.promptcuts = fs.existsSync(getUserPromptcutsPath()) || fs.existsSync(getPromptcutsPath());

  return result;
}

// Files/dirs that are never synced into a version home (OS metadata, local tooling).
const SKILL_COPY_IGNORE = new Set(['.DS_Store', '.git', '.gitignore', '.venv', '__pycache__', 'node_modules']);

function shouldSkillEntryBeSkipped(name: string): boolean {
  return SKILL_COPY_IGNORE.has(name);
}

/** Recursively compare two directories for identical content, skipping symlinks and ignored entries. */
function skillDirsMatch(src: string, dest: string): boolean {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (shouldSkillEntryBeSkipped(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (!fs.existsSync(destPath)) return false;
      if (!skillDirsMatch(srcPath, destPath)) return false;
    } else {
      // Size-first check avoids reads on mismatch; equal mtimes are unreliable across trees.
      let srcStat: fs.Stats;
      let destStat: fs.Stats;
      try {
        srcStat = fs.statSync(srcPath);
        destStat = fs.statSync(destPath);
      } catch {
        return false;
      }
      if (srcStat.size !== destStat.size) return false;
      // Raw bytes: decoding a binary asset (an image, a dataset) to a string costs far more than comparing it.
      if (!fs.readFileSync(srcPath).equals(fs.readFileSync(destPath))) return false;
    }
  }
  return true;
}

/** Return what's actually synced to a version home (source of truth, not agents.yaml tracking). */
export function getActuallySyncedResources(agent: AgentId, version: string, options: { cwd?: string } = {}): AvailableResources {
  const versionHome = path.join(getVersionsDir(), agent, version, 'home');
  const cwd = options.cwd || process.cwd();

  const result: AvailableResources = {
    commands: [],
    skills: [],
    hooks: [],
    memory: [],
    mcp: [],
    permissions: [],
    subagents: [],
    plugins: [],
    workflows: [],
    promptcuts: false,
  };

  // Dispatch through per-kind detectors; unsupported (agent, kind) pairs leave the field empty.
  const ctx = { version, versionHome, cwd };
  result.commands    = getDetector('commands',    agent)?.list(ctx) ?? [];
  result.skills      = getDetector('skills',      agent)?.list(ctx) ?? [];
  result.hooks       = getDetector('hooks',       agent)?.list(ctx) ?? [];
  result.memory      = getDetector('rules',       agent)?.list(ctx) ?? [];
  result.mcp         = getDetector('mcp',         agent)?.list(ctx) ?? [];
  result.permissions = getDetector('permissions', agent)?.list(ctx) ?? [];
  result.subagents   = getDetector('subagents',   agent)?.list(ctx) ?? [];
  result.plugins     = getDetector('plugins',     agent)?.list(ctx) ?? [];
  result.workflows   = getDetector('workflows',   agent)?.list(ctx) ?? [];
  return result;
}

/** Resource names that only exist in the project's `.agents/` layer, grouped by kind. */
export interface ProjectOnlyResources {
  commands: Set<string>;
  skills: Set<string>;
  hooks: Set<string>;
  subagents: Set<string>;
  plugins: Set<string>;
  workflows: Set<string>;
}

/** Names that exist only in the project's `.agents/` layer. Sync skips project-layer resources for security, so filter them out of the "new resources" diff. */
export function getProjectOnlyResources(cwd: string = process.cwd()): ProjectOnlyResources {
  const empty: ProjectOnlyResources = {
    commands: new Set(), skills: new Set(), hooks: new Set(),
    subagents: new Set(), plugins: new Set(), workflows: new Set(),
  };

  const projectAgentsDir = getProjectAgentsDir(cwd);
  if (!projectAgentsDir) return empty;

  const trustedBases: string[] = [getUserAgentsDir(), getAgentsDir(), ...getEnabledExtraRepos().map(e => e.dir)];

  const trustedNames = (relSubdir: string, predicate: (full: string, name: string) => boolean): Set<string> => {
    const acc = new Set<string>();
    for (const base of trustedBases) {
      const dir = path.join(base, relSubdir);
      if (!fs.existsSync(dir)) continue;
      try {
        for (const entry of fs.readdirSync(dir)) {
          if (entry.startsWith('.')) continue;
          if (predicate(path.join(dir, entry), entry)) acc.add(entry);
        }
      } catch { /* ignore unreadable */ }
    }
    return acc;
  };

  const readProjectNames = (relSubdir: string, predicate: (full: string, name: string) => boolean): string[] => {
    const dir = path.join(projectAgentsDir, relSubdir);
    if (!fs.existsSync(dir)) return [];
    try {
      return fs.readdirSync(dir)
        .filter(e => !e.startsWith('.'))
        .filter(e => predicate(path.join(dir, e), e));
    } catch { return []; }
  };

  const isMdFile = (full: string, name: string) =>
    name.endsWith('.md') && (() => { try { return fs.statSync(full).isFile(); } catch { return false; } })();
  const isDir = (full: string) => { try { return fs.statSync(full).isDirectory(); } catch { return false; } };
  const hasFile = (sub: string) => (full: string) => isDir(full) && fs.existsSync(path.join(full, sub));

  const stripMd = (n: string) => n.replace(/\.md$/, '');

  const trustedCommands = new Set([...trustedNames('commands', isMdFile)].map(stripMd));
  const projectCommands = readProjectNames('commands', isMdFile).map(stripMd);
  for (const n of projectCommands) if (!trustedCommands.has(n)) empty.commands.add(n);

  const trustedSkills = trustedNames('skills', (full) => isDir(full));
  for (const n of readProjectNames('skills', (full) => isDir(full))) if (!trustedSkills.has(n)) empty.skills.add(n);

  // Hooks: project entries are files; trusted entries are also files. Name match
  // is filename-with-extension (sync compares by full filename, line 2031).
  const trustedHooks = trustedNames('hooks', (full) => { try { return fs.statSync(full).isFile(); } catch { return false; } });
  for (const n of readProjectNames('hooks', (full) => { try { return fs.statSync(full).isFile(); } catch { return false; } })) {
    if (!trustedHooks.has(n)) empty.hooks.add(n);
  }

  const trustedSubagents = trustedNames('subagents', hasFile('AGENT.md'));
  for (const n of readProjectNames('subagents', hasFile('AGENT.md'))) {
    if (!trustedSubagents.has(n)) empty.subagents.add(n);
  }

  const trustedWorkflows = trustedNames('workflows', hasFile('WORKFLOW.md'));
  for (const n of readProjectNames('workflows', hasFile('WORKFLOW.md'))) {
    if (!trustedWorkflows.has(n)) empty.workflows.add(n);
  }

  const trustedPlugins = trustedNames('plugins', hasFile('.claude-plugin/plugin.json'));
  for (const n of readProjectNames('plugins', hasFile('.claude-plugin/plugin.json'))) {
    if (!trustedPlugins.has(n)) empty.plugins.add(n);
  }

  return empty;
}

/** Return resources in `available` that are not yet synced to the version home. `projectOnly` filters project-layer resources that sync skips for security. */
export function getNewResources(
  available: AvailableResources,
  actuallySynced: AvailableResources,
  projectOnly?: ProjectOnlyResources
): AvailableResources {
  const exclude = projectOnly || {
    commands: new Set<string>(), skills: new Set<string>(), hooks: new Set<string>(),
    subagents: new Set<string>(), plugins: new Set<string>(), workflows: new Set<string>(),
  };
  return {
    commands: available.commands.filter(c => !actuallySynced.commands.includes(c) && !exclude.commands.has(c)),
    skills: available.skills.filter(s => !actuallySynced.skills.includes(s) && !exclude.skills.has(s)),
    hooks: available.hooks.filter(h => !actuallySynced.hooks.includes(h) && !exclude.hooks.has(h)),
    // Only one rules preset can be active; if any is synced, don't report others as new.
    memory: actuallySynced.memory.length > 0
      ? []
      : available.memory.filter(m => !actuallySynced.memory.includes(m)),
    mcp: available.mcp.filter(m => !actuallySynced.mcp.includes(m)),
    permissions: available.permissions.filter(p => !actuallySynced.permissions.includes(p)),
    subagents: available.subagents.filter(s => !actuallySynced.subagents.includes(s) && !exclude.subagents.has(s)),
    plugins: available.plugins.filter(p => !actuallySynced.plugins.includes(p) && !exclude.plugins.has(p)),
    workflows: available.workflows.filter(w => !actuallySynced.workflows.includes(w) && !exclude.workflows.has(w)),
    // Promptcuts are not version-scoped; the hook reads the user/system file directly.
    promptcuts: false,
  };
}

/** Return true when `diff` contains any resources the agent/version actually supports. */
export function hasNewResources(diff: AvailableResources, agent?: AgentId, version?: string): boolean {
  const commandsApply = agent ? supports(agent, 'commands', version).ok : true;
  const hooksApply = agent ? supports(agent, 'hooks', version).ok : true;
  const mcpApply = agent ? supports(agent, 'mcp', version).ok : true;
  const permsApply = agent ? supports(agent, 'allowlist', version).ok : true;
  const subagentsApply = agent ? supports(agent, 'subagents', version).ok : true;
  const pluginsApply = agent ? supports(agent, 'plugins', version).ok : true;
  const workflowsApply = agent ? supports(agent, 'workflows', version).ok : true;
  return (
    (diff.commands.length > 0 && commandsApply) ||
    diff.skills.length > 0 ||
    (diff.hooks.length > 0 && hooksApply) ||
    (diff.memory.length > 0 && commandsApply) ||
    (diff.mcp.length > 0 && mcpApply) ||
    (diff.permissions.length > 0 && permsApply) ||
    (diff.subagents.length > 0 && subagentsApply) ||
    (diff.plugins.length > 0 && pluginsApply) ||
    (diff.workflows.length > 0 && workflowsApply)
  );
}

/** Build a human-readable summary of new resources, e.g. "2 commands, 5 permission groups". */
function buildNewResourcesSummary(newResources: AvailableResources, agent: AgentId, version?: string): string {
  const agentConfig = AGENTS[agent];
  const parts: string[] = [];

  // Version-aware gates avoid double-counting commands already emitted as skills (Codex >= 0.117.0).
  const commandsApply = supports(agent, 'commands', version).ok;
  const commandsAsSkills = version ? shouldInstallCommandAsSkill(agent, version) : false;
  const rulesApply = supports(agent, 'rules', version).ok;

  if (newResources.commands.length > 0 && (commandsApply || commandsAsSkills)) {
    parts.push(`${newResources.commands.length} command${newResources.commands.length === 1 ? '' : 's'}`);
  }
  if (newResources.skills.length > 0) {
    parts.push(`${newResources.skills.length} skill${newResources.skills.length === 1 ? '' : 's'}`);
  }
  if (newResources.hooks.length > 0 && agentConfig.supportsHooks) {
    parts.push(`${newResources.hooks.length} hook${newResources.hooks.length === 1 ? '' : 's'}`);
  }
  if (newResources.memory.length > 0 && rulesApply) {
    parts.push(`${newResources.memory.length} rule file${newResources.memory.length === 1 ? '' : 's'}`);
  }
  if (newResources.mcp.length > 0 && supports(agent, 'mcp', version).ok) {
    parts.push(`${newResources.mcp.length} MCP${newResources.mcp.length === 1 ? '' : 's'}`);
  }
  if (newResources.permissions.length > 0 && supports(agent, 'allowlist', version).ok) {
    parts.push(`${newResources.permissions.length} permission group${newResources.permissions.length === 1 ? '' : 's'}`);
  }
  if (newResources.subagents.length > 0 && supports(agent, 'subagents', version).ok) {
    parts.push(`${newResources.subagents.length} subagent${newResources.subagents.length === 1 ? '' : 's'}`);
  }
  if (newResources.plugins.length > 0 && supports(agent, 'plugins', version).ok) {
    parts.push(`${newResources.plugins.length} plugin${newResources.plugins.length === 1 ? '' : 's'}`);
  }
  if (newResources.workflows.length > 0 && supports(agent, 'workflows', version).ok) {
    parts.push(`${newResources.workflows.length} workflow${newResources.workflows.length === 1 ? '' : 's'}`);
  }

  return parts.join(', ');
}

/** Prompt the user to select which new resources to sync. */
export async function promptNewResourceSelection(
  agent: AgentId,
  newResources: AvailableResources,
  version?: string
): Promise<ResourceSelection | null> {
  const agentConfig = AGENTS[agent];
  const selection: ResourceSelection = {};

  // Version-aware gates. When version is known, prefer per-version capability checks; the
  // commands branch is allowed when either native commands are supported OR when the
  // version emits commands as converted skills (Codex >= 0.117.0).
  const commandsApply = supports(agent, 'commands', version).ok;
  const commandsAsSkills = version ? shouldInstallCommandAsSkill(agent, version) : false;
  const commandsBranch = commandsApply || commandsAsSkills;
  const rulesBranch = supports(agent, 'rules', version).ok;

  const permissionGroups = discoverPermissionGroups();
  const newPermissionGroups = permissionGroups.filter(g => newResources.permissions.includes(g.name));
  const totalNewPermissionRules = newPermissionGroups.reduce((sum, g) => sum + g.ruleCount, 0);

  const summary = buildNewResourcesSummary(newResources, agent, version);
  console.log(chalk.cyan(`\nNew resources available:`));
  console.log(chalk.gray(`  ${summary}`));

  const action = await select<'all' | 'specific' | 'skip'>({
    message: 'Sync new resources?',
    choices: [
      { value: 'all', name: 'Yes, sync all new' },
      { value: 'specific', name: 'Select specific items' },
      { value: 'skip', name: 'Skip' },
    ],
    default: 'all',
  });

  if (action === 'skip') {
    return null;
  }

  if (action === 'all') {
    if (newResources.commands.length > 0 && commandsBranch) selection.commands = newResources.commands;
    if (newResources.skills.length > 0) selection.skills = newResources.skills;
    if (newResources.hooks.length > 0 && agentConfig.supportsHooks) selection.hooks = newResources.hooks;
    if (newResources.memory.length > 0 && rulesBranch) selection.memory = newResources.memory;
    if (newResources.mcp.length > 0 && supports(agent, 'mcp', version).ok) selection.mcp = newResources.mcp;
    if (newResources.permissions.length > 0 && supports(agent, 'allowlist', version).ok) selection.permissions = newResources.permissions;
    if (newResources.subagents.length > 0 && supports(agent, 'subagents', version).ok) selection.subagents = newResources.subagents;
    if (newResources.plugins.length > 0 && supports(agent, 'plugins', version).ok) selection.plugins = newResources.plugins;
    if (newResources.workflows.length > 0 && supports(agent, 'workflows', version).ok) selection.workflows = newResources.workflows;
    return selection;
  }

  if (newResources.commands.length > 0 && commandsBranch) {
    const selected = await checkbox({
      message: 'Select new commands to sync:',
      choices: newResources.commands.map(c => ({ name: c, value: c, checked: true })),
    });
    if (selected.length > 0) selection.commands = selected;
  }

  if (newResources.skills.length > 0) {
    const selected = await checkbox({
      message: 'Select new skills to sync:',
      choices: newResources.skills.map(s => ({ name: s, value: s, checked: true })),
    });
    if (selected.length > 0) selection.skills = selected;
  }

  if (newResources.hooks.length > 0 && agentConfig.supportsHooks) {
    const selected = await checkbox({
      message: 'Select new hooks to sync:',
      choices: newResources.hooks.map(h => ({ name: h, value: h, checked: true })),
    });
    if (selected.length > 0) selection.hooks = selected;
  }

  if (newResources.memory.length > 0 && rulesBranch) {
    const selected = await checkbox({
      message: 'Select new rule files to sync:',
      choices: newResources.memory.map(m => ({ name: m, value: m, checked: true })),
    });
    if (selected.length > 0) selection.memory = selected;
  }

  if (newResources.mcp.length > 0 && supports(agent, 'mcp', version).ok) {
    const selected = await checkbox({
      message: 'Select new MCPs to sync:',
      choices: newResources.mcp.map(m => ({ name: m, value: m, checked: true })),
    });
    if (selected.length > 0) selection.mcp = selected;
  }

  if (newResources.permissions.length > 0 && supports(agent, 'allowlist', version).ok) {
    const selected = await checkbox({
      message: 'Select new permission groups to sync:',
      choices: newPermissionGroups.map(g => ({
        name: `${g.name} (${g.ruleCount} rules)`,
        value: g.name,
        checked: true,
      })),
    });
    if (selected.length > 0) selection.permissions = selected;
  }

  if (newResources.subagents.length > 0 && supports(agent, 'subagents', version).ok) {
    const selected = await checkbox({
      message: 'Select new subagents to sync:',
      choices: newResources.subagents.map(s => ({ name: s, value: s, checked: true })),
    });
    if (selected.length > 0) selection.subagents = selected;
  }

  if (newResources.plugins.length > 0 && supports(agent, 'plugins', version).ok) {
    const allPlugins = discoverPlugins();
    const pluginMap = new Map(allPlugins.map(p => [p.name, p]));
    const selected = await checkbox({
      message: 'Select new plugins to sync:',
      choices: newResources.plugins.map(name => {
        const plugin = pluginMap.get(name);
        const desc = plugin?.manifest.description;
        return { name: desc ? `${name} - ${desc}` : name, value: name, checked: true };
      }),
    });
    if (selected.length > 0) selection.plugins = selected;
  }

  if (newResources.workflows.length > 0 && supports(agent, 'workflows', version).ok) {
    const selected = await checkbox({
      message: 'Select new workflows to sync:',
      choices: newResources.workflows.map(w => ({ name: w, value: w, checked: true })),
    });
    if (selected.length > 0) selection.workflows = selected;
  }

  return selection;
}

/** Prompt the user to select which resources to sync from ~/.agents/. */
export async function promptResourceSelection(agent: AgentId): Promise<ResourceSelection | null> {
  const available = getAvailableResources();
  const agentConfig = AGENTS[agent];
  const selection: ResourceSelection = {};

  const permissionGroups = discoverPermissionGroups();
  const totalPermissionRules = permissionGroups.reduce((sum, g) => sum + g.ruleCount, 0);

  // Promptcuts is visible but never synced per-version, so it is omitted from selectable categories.
  type CategoryKey = keyof ResourceSelection;
  const categories: { key: CategoryKey; label: string; available: boolean; displayCount: string }[] = [
    { key: 'commands', label: 'Commands', available: supports(agent, 'commands').ok && available.commands.length > 0, displayCount: `${available.commands.length} available` },
    { key: 'skills', label: 'Skills', available: available.skills.length > 0, displayCount: `${available.skills.length} available` },
    { key: 'hooks', label: 'Hooks', available: agentConfig.supportsHooks && available.hooks.length > 0, displayCount: `${available.hooks.length} available` },
    { key: 'memory', label: 'Rules', available: supports(agent, 'rules').ok && available.memory.length > 0, displayCount: `${available.memory.length} available` },
    { key: 'mcp', label: 'MCPs', available: supports(agent, 'mcp').ok && available.mcp.length > 0, displayCount: `${available.mcp.length} available` },
    { key: 'permissions', label: 'Permissions', available: supports(agent, 'allowlist').ok && permissionGroups.length > 0, displayCount: `${permissionGroups.length} groups, ${totalPermissionRules} rules` },
    { key: 'subagents', label: 'Subagents', available: supports(agent, 'subagents').ok && available.subagents.length > 0, displayCount: `${available.subagents.length} available` },
    { key: 'plugins', label: 'Plugins', available: supports(agent, 'plugins').ok && available.plugins.length > 0, displayCount: `${available.plugins.length} available` },
  ];

  const availableCategories = categories.filter(c => c.available);

  if (availableCategories.length === 0) {
    console.log(chalk.gray('No resources available to sync.'));
    return {};
  }

  console.log();
  const SELECT_ALL_KEY = '__select_all__' as CategoryKey;
  const selectedCategories = await checkbox<CategoryKey>({
    message: 'Which resources would you like to sync?',
    choices: [
      { name: chalk.bold('Select All (sync everything)'), value: SELECT_ALL_KEY, checked: false },
      ...availableCategories.map(c => ({
        name: `${c.label} (${c.displayCount})`,
        value: c.key,
        checked: true, // Default all checked
      })),
    ],
  });

  if (selectedCategories.length === 0) {
    return {};
  }

  const allCategoryKeys = availableCategories.map(c => c.key);
  if (selectedCategories.includes(SELECT_ALL_KEY) || allCategoryKeys.every(k => selectedCategories.includes(k))) {
    for (const c of availableCategories) {
      selection[c.key] = 'all';
    }
    return selection;
  }

  for (const category of selectedCategories) {
    const categoryLabel = categories.find(c => c.key === category)!.label;

    if (category === 'permissions') {
      const choice = await select<'all' | 'specific' | 'skip'>({
        message: `${categoryLabel}:`,
        choices: [
          { name: `Select all (${permissionGroups.length} groups)`, value: 'all' },
          { name: 'Select specific groups', value: 'specific' },
          { name: 'Skip', value: 'skip' },
        ],
        default: 'all',
      });

      if (choice === 'all') {
        selection.permissions = 'all';
      } else if (choice === 'specific') {
        const selected = await checkbox<string>({
          message: 'Select permission groups to sync:',
          choices: permissionGroups.map(g => ({
            name: `${g.name} (${g.ruleCount} rules)`,
            value: g.name,
            checked: true,
          })),
        });
        if (selected.length > 0) {
          selection.permissions = selected;
        }
      }
    } else {
      const items = available[category];

      const choice = await select<'all' | 'specific' | 'skip'>({
        message: `${categoryLabel}:`,
        choices: [
          { name: `Select all (${items.length})`, value: 'all' },
          { name: 'Select specific', value: 'specific' },
          { name: 'Skip', value: 'skip' },
        ],
        default: 'all',
      });

      if (choice === 'all') {
        selection[category] = 'all';
      } else if (choice === 'specific') {
        const selected = await checkbox<string>({
          message: `Select ${categoryLabel.toLowerCase()} to sync:`,
          choices: items.map(item => ({
            name: item,
            value: item,
            checked: true,
          })),
        });
        if (selected.length > 0) {
          selection[category] = selected;
        }
      }
    }
    // 'skip' means we don't set anything for this category
  }

  return selection;
}

/** Parsed agent@version specification from CLI input. */
export interface AgentSpec {
  agent: AgentId;
  version: string;
}

/** Parse an `agent@version` spec; bare agent means `latest`. */
export function parseAgentSpec(spec: string): AgentSpec | null {
  const parts = spec.split('@');
  if (parts.length > 2) {
    return null;
  }
  const version = parts[1] || 'latest';

  const agent = resolveAgentName(parts[0]);
  if (!agent) {
    return null;
  }

  // Reject any version string that could escape an exec context or a
  // bash-shim interpolation. Real agent versions are semver-shaped or "latest".
  if (!VERSION_RE.test(version)) {
    return null;
  }

  return {
    agent,
    version,
  };
}


export async function getLatestNpmVersion(agent: AgentId): Promise<string | null> {
  const agentConfig = AGENTS[agent];
  if (!agentConfig.npmPackage) return null;

  try {
    const { stdout } = await execFileAsync('npm', ['view', agentConfig.npmPackage, 'version'], { shell: process.platform === 'win32' });
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function getOldestNpmVersion(agent: AgentId): Promise<string | null> {
  const agentConfig = AGENTS[agent];
  if (!agentConfig.npmPackage) return null;

  try {
    const { stdout } = await execFileAsync('npm', ['view', agentConfig.npmPackage, 'versions', '--json'], { shell: process.platform === 'win32' });
    const parsed = JSON.parse(stdout.trim());
    // npm view returns an array for multiple versions or a bare string for one.
    const versions: string[] = Array.isArray(parsed) ? parsed : [parsed];
    const sorted = versions.filter((v) => VERSION_RE.test(v)).sort(compareVersions);
    return sorted[0] ?? null;
  } catch {
    return null;
  }
}

/** Check whether the npm `latest` version is installed. */
export async function isLatestInstalled(agent: AgentId): Promise<{ installed: boolean; version: string | null }> {
  const latestVersion = await getLatestNpmVersion(agent);
  if (!latestVersion) {
    return { installed: false, version: null };
  }
  return { installed: isVersionInstalled(agent, latestVersion), version: latestVersion };
}

/** Check whether the npm `oldest` version is installed. */
export async function isOldestInstalled(agent: AgentId): Promise<{ installed: boolean; version: string | null }> {
  const oldestVersion = await getOldestNpmVersion(agent);
  if (!oldestVersion) {
    return { installed: false, version: null };
  }
  return { installed: isVersionInstalled(agent, oldestVersion), version: oldestVersion };
}


/** List every version directory for an agent, including home-only leftovers, for `agents prune
 * cleanup` only. Do not use elsewhere: every other call site assumes a working binary. */
export function listInstalledVersionDirs(agent: AgentId): Array<{ version: string; hasBinary: boolean }> {
  const agentVersionsDir = path.join(getVersionsDir(), agent);
  if (!fs.existsSync(agentVersionsDir)) {
    return [];
  }
  const entries = fs.readdirSync(agentVersionsDir, { withFileTypes: true });
  const out: Array<{ version: string; hasBinary: boolean }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    out.push({
      version: entry.name,
      hasBinary: isVersionInstalled(agent, entry.name),
    });
  }
  return out.sort((a, b) => compareVersions(a.version, b.version));
}


/** Set (or clear) the global default version for an agent. */
export function setGlobalDefault(agent: AgentId, version: string | undefined): void {
  // Setting a global default for an isolated-only agent would breach the isolation boundary; clearing is allowed.
  if (version !== undefined) {
    assertIsolationBoundary(agent, 'set a global default');
  }
  const meta = readMeta();
  if (!meta.agents) {
    meta.agents = {};
  }
  if (version === undefined) {
    delete meta.agents[agent];
  } else {
    meta.agents[agent] = version;
    emit('version.switch', { agent, version });
  }
  writeMeta(meta);
}


/** Set (or clear) the preferred isolated version without touching the launcher, shim, or global default. */
export function setIsolatedDefault(agent: AgentId, version: string | undefined): void {
  const meta = readMeta();
  if (!meta.isolatedAgents) {
    meta.isolatedAgents = {};
  }
  if (version === undefined) {
    delete meta.isolatedAgents[agent];
  } else {
    meta.isolatedAgents[agent] = version;
  }
  writeMeta(meta);
}


/** Move any `grok-<installedVersion>-...` binary and its generic platform copy from
 * `sourceDownloads` into `targetDownloads`. Returns true if the versioned binary was
 * transferred. */
function transferGrokDownloads(
  sourceDownloads: string,
  targetDownloads: string,
  copy: boolean,
): boolean {
  if (!fs.existsSync(sourceDownloads)) return false;
  if (path.resolve(sourceDownloads) === path.resolve(targetDownloads)) return false;

  const entries = fs.readdirSync(sourceDownloads).filter((e) => e.startsWith('grok-'));
  if (entries.length === 0) return false;

  const realBinary = resolveGrokFallbackBinary(sourceDownloads);
  if (!realBinary) return false;
  const transferred = path.join(targetDownloads, path.basename(realBinary));
  try {
    fs.mkdirSync(targetDownloads, { recursive: true });
    if (copy) fs.copyFileSync(realBinary, transferred);
    else fs.renameSync(realBinary, transferred);
  } catch {
    return false;
  }

  // The installer also creates a generic platform binary (e.g. grok-macos-aarch64)
  // that is a copy of the versioned binary. Move it too if its size matches.
  const movedSize = fs.statSync(transferred).size;
  for (const entry of entries) {
    if (entry === path.basename(realBinary)) continue;
    const src = path.join(sourceDownloads, entry);
    const dst = path.join(targetDownloads, entry);
    if (fs.existsSync(dst)) continue;
    try {
      if (fs.statSync(src).size === movedSize) {
        if (copy) fs.copyFileSync(src, dst);
        else fs.renameSync(src, dst);
      }
    } catch {
      /* ignore per-file failures */
    }
  }

  return true;
}

/** grok's installer writes to ~/.grok/downloads, which resolves to the previous default home
 * during `agents add`. Move the new binary into the target version home; if absent, sweep other
 * grok homes for a past mislabeled 'latest' install. */
function relocateGrokBinaryToVersionHome(
  installationLabel: string,
  copyExisting: boolean,
): void {
  const hostGrokLink = path.join(getHomeDir(), agentConfigDirName('grok'));
  let sourceDownloads: string;
  try {
    sourceDownloads = path.join(fs.readlinkSync(hostGrokLink), 'downloads');
  } catch {
    sourceDownloads = path.join(hostGrokLink, 'downloads');
  }
  const targetDownloads = path.join(
    getVersionHomePath('grok', installationLabel),
    agentConfigDirName('grok'),
    'downloads'
  );

  if (transferGrokDownloads(sourceDownloads, targetDownloads, copyExisting)) return;

  for (const version of listInstalledVersions('grok')) {
    if (version === installationLabel) continue;
    const candidate = path.join(getVersionHomePath('grok', version), agentConfigDirName('grok'), 'downloads');
    if (path.resolve(candidate) === path.resolve(sourceDownloads)) continue; // already tried
    if (transferGrokDownloads(candidate, targetDownloads, copyExisting)) return;
  }
}

/** grok's version dir is keyed by release, not account, so two accounts on the same release
 * would share one home and one auth.json. Fail loud if the target home already has a different
 * signed-in account. */
async function checkGrokAccountCollision(installedVersion: string): Promise<void> {
  const targetHome = getVersionHomePath('grok', installedVersion);
  if (!fs.existsSync(targetHome)) return; // fresh directory, nothing to collide with

  const sourceVersion = getGlobalDefault('grok');
  if (!sourceVersion || sourceVersion === installedVersion) return; // same install, not a collision

  const [targetEmail, sourceEmail] = await Promise.all([
    getAccountEmail('grok', targetHome),
    getAccountEmail('grok', getVersionHomePath('grok', sourceVersion)),
  ]);
  if (!targetEmail || !sourceEmail || targetEmail === sourceEmail) return;

  throw new Error(
    `grok@${installedVersion} is already installed for ${targetEmail}, but this update is running as ${sourceEmail}. ` +
    `Grok's self-updater can't distinguish two accounts that land on the same release — sign in to ${targetEmail}'s ` +
    `install (agents use grok@${installedVersion}) before updating it, or wait until the releases diverge.`
  );
}

/** Install a specific version of an agent. */
export async function installVersion(
  agent: AgentId,
  version: string,
  onProgress?: (message: string) => void,
  opts?: { clean?: boolean; installationLabel?: string }
): Promise<{ success: boolean; installedVersion: string; error?: string }> {
  const agentConfig = AGENTS[agent];
  const requestedLabel = opts?.installationLabel ?? version;
  const initialUpdatePolicy = version === 'latest' ? 'latest' : 'pinned';

  if (isAgentHardDeprecated(agent)) {
    return { success: false, installedVersion: version, error: hardDeprecationError(agent) };
  }

  // Also validate at the source so direct callers and tests cannot pass invalid versions.
  if (!VERSION_RE.test(version)) {
    throw new Error(`Invalid version: ${JSON.stringify(version)}`);
  }

  // PHNX-3940: a caller-supplied installation label decouples the version-dir name from the vendor
  // release, so many accounts can share upstream `latest` in distinct homes. It must be a real
  // label, never an alias.
  if (opts?.installationLabel !== undefined) {
    if (!VERSION_RE.test(opts.installationLabel)) {
      throw new Error(`Invalid installation label: ${JSON.stringify(opts.installationLabel)}`);
    }
    if (opts.installationLabel === 'latest' || opts.installationLabel === 'oldest') {
      throw new Error(`Installation label cannot be a release alias ('${opts.installationLabel}').`);
    }
  }

  if (!agentConfig.npmPackage) {
    if (!agentConfig.installScript) {
      return { success: false, installedVersion: version, error: 'Agent has no npm package' };
    }

    // Self-updating agents have no pinnable semver; an installed binary is a no-op, otherwise redirect to latest.
    let runInstaller = true;
    if (version !== 'latest' && isSelfUpdatingAgent(agent)) {
      const liveVersion = await getLiveVersion(agent);
      if (liveVersion) {
        onProgress?.(`${agentConfig.name} is a single self-updating binary — @${version} maps to the already-installed current release (${liveVersion}); nothing to install.`);
        runInstaller = false;
      } else {
        onProgress?.(`${agentConfig.name} is a single self-updating binary with no pinnable versions — installing the current release (ignoring @${version}).`);
      }
      version = 'latest';
    }

    let releaseVersion = version;
    try {
      if (runInstaller) {
        const script = agentConfig.installScript.replaceAll('VERSION', version);
        onProgress?.(`Installing ${agentConfig.name}@${version} via official installer...`);
        await execAsync(script, { timeout: 120000 });
      }

      if (version === 'latest') {
        // A fresh self-updating binary can take a moment to resolve on PATH, so retry rather than
        // fall back to the literal 'latest'. That fallback created a bogus latest/ dir and
        // stranded grok's real binary in the previous default's downloads.
        let probed = await getCliVersionFromPath(agent);
        for (let attempt = 0; !probed && attempt < 2; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          probed = await getCliVersionFromPath(agent);
        }
        if (!probed) {
          return {
            success: false,
            installedVersion: version,
            error: `${agentConfig.name} installed but its version could not be determined after several attempts.`,
          };
        }
        releaseVersion = probed;
        // Fold any stale literal `latest` dir from an earlier probe-failed
        // install into the real version so it stops shadowing `agents view`.
        await reconcileStaleLatestDir(agent, releaseVersion);
      }

      // Self-updating installers always fetch the current release, but a concrete requested token
      // stays the stable installation slot. Separating the two lets several homes share a release
      // without sharing credentials.
      const installationLabel = requestedLabel === 'latest' ? releaseVersion : requestedLabel;

      if (agent === 'grok') {
        await checkGrokAccountCollision(installationLabel);
      }

      onProgress?.(`${agentConfig.name} installed. Setting up agents-cli version home for isolation...`);
    } catch (err: any) {
      emit('version.install', { agent, version, error: err.message });
      return { success: false, installedVersion: version, error: `${agentConfig.name} installer failed: ${err.message}` };
    }

    ensureAgentsDir();
    const installationLabel = requestedLabel === 'latest' ? releaseVersion : requestedLabel;
    const versionDir = getVersionDir(agent, installationLabel);
    fs.mkdirSync(versionDir, { recursive: true });
    fs.mkdirSync(path.join(versionDir, 'home'), { recursive: true });

    // Grok's installer drops the binary into ~/.grok/downloads, which currently
    // resolves to the PREVIOUS default home. Move it into the target version home
    // so version isolation is correct.
    if (agent === 'grok') {
      relocateGrokBinaryToVersionHome(installationLabel, !runInstaller);
    }

    // Symlink the installed binary into node_modules/.bin so listInstalledVersions sees it. Skip
    // resolver-backed agents: `which` can return our own shim (shims dir precedes ~/.local/bin),
    // and linking it would exec itself forever.
    if (agent !== 'grok' && agent !== 'droid' && agent !== 'muse' && agent !== 'warp') {
      // findInPath is a pure-Node PATH scan that skips our shims dir, so it returns the genuine
      // install and never a self-referential dispatcher shim link.
      const installedBinary = findInPath(agentConfig.cliCommand);
      if (installedBinary) {
        importInstallScriptBinary(
          { agentId: agent, npmPackage: agentConfig.npmPackage, cliCommand: agentConfig.cliCommand },
          installationLabel,
          installedBinary,
          versionDir
        );
      }
      /* If null: binary missing from PATH (install script failed silently) or
         only our shim is present. Leave the version dir empty so getBinaryPath
         correctly reports it uninstalled. */
    }

    createVersionedAlias(agent, installationLabel);
    // Freeze this installation's identity. The dir name is its stable label from
    // here on; the release it carries is recorded separately so `agents update`
    // can move the release without invalidating any reference to the label.
    createInstallation(agent, installationLabel, releaseVersion, initialUpdatePolicy);
    const trackerInstall = await installSessionTrackerHook(agent, installationLabel);
    if (!trackerInstall.installed && trackerInstall.error) {
      console.warn(`agents: SessionStart hook not installed for ${agent}@${installationLabel}: ${trackerInstall.error}`);
    }
    // The self-updating binary just changed on disk — drop the cached
    // `--version` so `agents view` reflects the freshly-installed release.
    invalidateLiveVersionCache(agent);
    emit('version.install', { agent, version: installationLabel });
    return { success: true, installedVersion: installationLabel };
  }

  // Resolve `latest`/`oldest` to a concrete npm version up front. Resolving after npm ran used a
  // shared latest/ scratch dir that a concurrent reconcile or install could rename mid-extraction,
  // corrupting the install.
  if (version === 'latest' || version === 'oldest') {
    const resolved = version === 'latest'
      ? await getLatestNpmVersion(agent)
      : await getOldestNpmVersion(agent);
    if (!resolved) {
      return {
        success: false,
        installedVersion: version,
        error: `Could not resolve the ${version} published version for ${agentConfig.name} from npm.`,
      };
    }
    version = resolved;
  }

  // `version` is now the concrete vendor release. The slot is the caller's opaque label when given,
  // else the release (PHNX-3940). Disk state keys on `label`; only the npm spec uses `release`.
  const releaseVersion = version;
  const label = opts?.installationLabel ?? releaseVersion;

  ensureAgentsDir();
  const versionDir = getVersionDir(agent, label);

  return withFileLockAsync(installationLockTarget(agent, label), async () => {
  // Installs and repairs mutate the same executable as updates. Hold the same
  // lock before touching artifacts, even before the first record exists.
  if (await isInstallationLikelyActive({ agent, label })) {
    return { success: false, installedVersion: label, error: `${agent} account home ${label} is in use. Retry after its sessions finish.` };
  }

  // A clean (repair) reinstall wipes a partially extracted node_modules first: npm treats a gutted
  // platform package as installed and skips re-fetching it, so the corrupt vendor/ would survive.
  // home/ is preserved.
  if (opts?.clean && fs.existsSync(versionDir)) {
    removeInstallArtifacts(versionDir);
  }

  // Create version directory and isolated home
  fs.mkdirSync(versionDir, { recursive: true });
  fs.mkdirSync(path.join(versionDir, 'home'), { recursive: true });

  // Initialize package.json (only for real npm agents)
  const packageJson = {
    name: `agents-${agent}-${version}`,
    version: '1.0.0',
    private: true,
  };
  fs.writeFileSync(path.join(versionDir, 'package.json'), JSON.stringify(packageJson, null, 2));

  // `version` is always concrete here, so the spec is pinned. The `@` prefix is load-bearing: it
  // keeps `version` (VERSION_RE allows a leading `-`) from being parsed as an npm CLI flag.
  const packageSpec = `${agentConfig.npmPackage}@${version}`;

  // Set once the install has passed its integrity gate; read after the try so
  // the success path's bookkeeping sits outside the catch's cleanup.
  let healthyVersion: string;

  try {
    // Check npm is available
    const winShell = process.platform === 'win32';
    try {
      await execFileAsync('npm', ['--version'], { shell: winShell });
    } catch {
      return {
        success: false,
        installedVersion: version,
        error: 'npm is not installed. Install Node.js and npm first: https://nodejs.org/',
      };
    }

    onProgress?.(`Installing ${packageSpec}...`);
    await execFileAsync('npm', ['install', packageSpec, '--ignore-scripts'], { cwd: versionDir, shell: winShell });

    // The release installs directly into its final labeled dir, so there is no post-install rename
    // and no shared latest/ dir for a concurrent process to move. `releaseVersion` is what npm
    // staged.
    const installedVersion = label;

    // Create versioned alias (e.g., claude@2.0.65, or claude@ins_… for connect)
    createVersionedAlias(agent, installedVersion);

    // Claude reads its global config from CLAUDE_CONFIG_DIR/.claude.json, inside the per-version
    // dir, while agents-cli manages the home-level file. Symlink inside to outside so both see the
    // same content.
    if (agent === 'claude') {
      try {
        ensureClaudeInsideSymlink(installedVersion);
      } catch {
        /* non-fatal; the install itself succeeded */
      }
    }

    // npm install ran with --ignore-scripts, which also skips the agent package's own postinstall.
    // claude-code needs it to copy the native binary over a stub, so run that one package's
    // postinstall, never `prepare`. Best-effort; the integrity gate below is the backstop.
    if (agentConfig.npmPackage) {
      // The install landed in `versionDir` (the labeled dir) with no rename to
      // chase, so the package root is exactly there.
      const pkgRoot = path.join(versionDir, 'node_modules', agentConfig.npmPackage);
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf-8'));
        const postinstall = pkg?.scripts?.postinstall;
        if (typeof postinstall === 'string' && postinstall.trim()) {
          onProgress?.(`Running ${agentConfig.name} postinstall...`);
          // The declared postinstall is a shell command string, so it must run through a shell on
          // all platforms (shell:true, empty args). cwd is the package root because install.cjs
          // anchors paths to __dirname.
          await execFileAsync(postinstall, [], { cwd: pkgRoot, shell: true });
        }
      } catch {
        /* non-fatal; the integrity gate below catches a still-broken binary */
      }
    }

    // Integrity gate: confirm the install actually launches, not just that the JS wrapper landed. A
    // gutted install would otherwise be pinned as default and crash with ENOENT. Fail loudly so it
    // is never recorded healthy.
    const health = await verifyInstalledBinaryLaunches(agent, installedVersion);
    if (!health.ok) {
      if (fs.existsSync(versionDir)) removeInstallArtifacts(versionDir);
      const detail = health.detail ? ` (${health.detail})` : '';
      emit('version.install', { agent, version: installedVersion, error: `binary failed to launch${detail}` });
      return {
        success: false,
        installedVersion,
        error: `${agentConfig.name}@${installedVersion} installed but its binary failed to launch${detail}. `
          + `The install is incomplete — the platform binary is missing. Re-run: agents add ${agent}@${installedVersion}`,
      };
    }

    // The install is healthy from here. Identity is frozen AFTER the try (see
    // below) so a bookkeeping write failure cannot fall into the catch and wipe
    // a working install.
    healthyVersion = installedVersion;
  } catch (err) {
    // Clean up on failure — preserve `home/` in case a prior install left
    // conversation history behind that we must not wipe on a failed reinstall.
    if (fs.existsSync(versionDir)) {
      removeInstallArtifacts(versionDir);
    }
    emit('version.install', { agent, version, error: (err as Error).message });
    return { success: false, installedVersion: version, error: (err as Error).message };
  }

  // Freeze this installation's identity. The label is the frozen identity; the release is recorded
  // separately so a connect home records the real vendor release, not the label string.
  createInstallation(agent, healthyVersion, releaseVersion, initialUpdatePolicy);
  const trackerInstall = await installSessionTrackerHook(agent, healthyVersion);
  if (!trackerInstall.installed && trackerInstall.error) {
    console.warn(`agents: SessionStart hook not installed for ${agent}@${healthyVersion}: ${trackerInstall.error}`);
  }
  emit('version.install', { agent, version: healthyVersion });
  return { success: true, installedVersion: healthyVersion };
  }, { ...INSTALLATION_LOCK_OPTIONS, realpath: false });
}

// State, not install output, that survives a clean reinstall: home/, the .isolated marker (losing
// it demotes an isolated copy), and installation.json (losing it mints a new id and drops release
// history).
const PRESERVED_ON_CLEAN_REINSTALL = new Set(['home', '.isolated', '.launch-leases', INSTALLATION_RECORD_FILE, `${INSTALLATION_RECORD_FILE}.lock`]);

/** Remove install artifacts from a version dir, preserving home/ (conversation history,
 * sessions) and the .isolated marker. Used by the install pipeline for staging collisions, not
 * by removeVersion, which soft-deletes. */
function removeInstallArtifacts(versionDir: string): void {
  for (const entry of fs.readdirSync(versionDir)) {
    if (PRESERVED_ON_CLEAN_REINSTALL.has(entry) || entry.startsWith('.rollback-')) continue;
    fs.rmSync(path.join(versionDir, entry), { recursive: true, force: true });
  }
}

/** Fold a stale literal `latest` dir into the real version. Script installs probe `<cli>
 * --version`; a failed probe made a latest/ dir that lingers beside the real one. Rename it
 * (keeping home/) or trash it if the real dir exists. */
/** RUSH-1320: fold a stale `latest` home into its concrete version without a fresh install,
 * since reconcileStaleLatestDir only runs at install time. Skipped when the active config
 * symlink still points at `latest`, to avoid dangling it. */
export async function reconcileStaleLatestForAgent(agent: AgentId): Promise<void> {
  // Global-binary agents (droid) can accumulate MANY stale semver dirs — not
  // just a literal `latest` — because every `agents add` after an in-place
  // self-update creates a fresh dir for the same one binary. Fold them all.
  if (isGlobalBinaryAgent(agent)) {
    await reconcileGlobalBinaryVersions(agent);
    return;
  }
  if (!fs.existsSync(getVersionDir(agent, 'latest'))) return;
  if (getConfigSymlinkVersion(agent) === 'latest') return;
  const concrete = await getCliVersionFromPath(agent);
  if (concrete && concrete !== 'latest') {
    await reconcileStaleLatestDir(agent, concrete);
  }
}

/** Fold stale version dirs of a global-binary agent (droid) into one survivor, since all point
 * at one binary. Extras are soft-deleted (home/ recoverable). Survivor follows
 * listInstalledVersions' choice and is not renamed. */
async function reconcileGlobalBinaryVersions(agent: AgentId): Promise<void> {
  // Preserve the literal-`latest` reconcile: fold a probe-failed `latest` dir onto the live version
  // (rename, else trash). Skipped while the config symlink points at `latest`, to avoid dangling
  // it.
  if (fs.existsSync(getVersionDir(agent, 'latest')) && getConfigSymlinkVersion(agent) !== 'latest') {
    const concrete = await getCliVersionFromPath(agent);
    if (concrete && concrete !== 'latest') {
      await reconcileStaleLatestDir(agent, concrete);
    }
  }

  // Step 2 — collapse any remaining phantom SEMVER dirs (successive `agents add`
  // after in-place self-updates) into a single survivor.
  const agentVersionsDir = path.join(getVersionsDir(), agent);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agentVersionsDir, { withFileTypes: true });
  } catch {
    return;
  }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort(compareVersions);
  if (dirs.length <= 1) return;

  // Warm the live-version cache so the survivor pick (and later view labels) can
  // prefer the version the binary actually reports.
  await getLiveVersion(agent);
  const survivor = pickCanonicalGlobalBinaryVersion(agent, dirs);
  const symlinkVersion = getConfigSymlinkVersion(agent);

  let foldedAny = false;
  for (const version of dirs) {
    if (version === survivor) continue;
    // Never trash the dir the live config symlink points at — that would dangle
    // the symlink. pickCanonical already prefers it as survivor; this guards the
    // rare mismatch.
    if (version === symlinkVersion) continue;
    const staleDir = getVersionDir(agent, version);
    const trashPath = softDeleteVersionDir(agent, version);
    if (trashPath) {
      const { updateSessionFilePaths } = await import('../session/db.js');
      updateSessionFilePaths(staleDir, trashPath);
      foldedAny = true;
    }
  }

  if (foldedAny) {
    invalidateInstalledVersionsCache(agent);
    // Keep the recorded default pointing at an existing dir, but never promote an isolated copy
    // into the default slot (same rule as removal promotion and `agents use`). An isolated-only
    // agent has no default by design.
    const def = getGlobalDefault(agent);
    if ((!def || !fs.existsSync(getVersionDir(agent, def))) && !isVersionIsolated(agent, survivor)) {
      setGlobalDefault(agent, survivor);
    }
  }
}

export async function reconcileStaleLatestDir(
  agent: AgentId,
  installedVersion: string,
): Promise<'none' | 'renamed' | 'trashed'> {
  if (installedVersion === 'latest') return 'none';

  const staleLatestDir = getVersionDir(agent, 'latest');
  const realVersionDir = getVersionDir(agent, installedVersion);
  if (staleLatestDir === realVersionDir || !fs.existsSync(staleLatestDir)) {
    return 'none';
  }

  if (!fs.existsSync(realVersionDir)) {
    fs.renameSync(staleLatestDir, realVersionDir);
    return 'renamed';
  }

  // Both dirs exist, and stripping artifacts would not hide `latest` for global-binary agents, so
  // soft-delete the whole dir (home/ stays restorable) and rewrite session paths. The session-db
  // import is lazy: its top-level await breaks the CJS test harness.
  const trashPath = softDeleteVersionDir(agent, 'latest');
  if (trashPath) {
    const { updateSessionFilePaths } = await import('../session/db.js');
    updateSessionFilePaths(staleLatestDir, trashPath);
  }
  return 'trashed';
}

/** Soft-delete a version dir by moving it, home/ included, to
 * ~/.agents/.system/trash/versions/<agent>/<version>/<timestamp>/. Returns the trash path or
 * null. Recoverable via `agents restore`; nothing is hard-deleted. */
export function softDeleteVersionDir(agent: AgentId, version: string): string | null {
  const versionDir = getVersionDir(agent, version);
  if (!fs.existsSync(versionDir)) return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const trashRoot = getTrashVersionsDir();
  const trashAgentDir = path.join(trashRoot, agent, version);
  const trashDest = path.join(trashAgentDir, stamp);

  try {
    fs.mkdirSync(trashAgentDir, { recursive: true, mode: 0o700 });
    try {
      fs.renameSync(versionDir, trashDest);
    } catch (renameErr) {
      // On Windows, rename fails with EPERM/EACCES when any file in the tree
      // is locked by a running process. Fall back to recursive copy + delete.
      if ((renameErr as NodeJS.ErrnoException).code !== 'EPERM' && (renameErr as NodeJS.ErrnoException).code !== 'EACCES') throw renameErr;
      fs.cpSync(versionDir, trashDest, { recursive: true });
      fs.rmSync(versionDir, { recursive: true, force: true });
    }
    return trashDest;
  } catch {
    return null;
  }
}

/** Remove a version by soft-delete only: the whole directory, home/ included, moves to trash and
 * is recoverable via `agents restore`. */
export function removeVersion(agent: AgentId, version: string): boolean {
  const versionDir = getVersionDir(agent, version);

  if (!fs.existsSync(versionDir)) {
    return false;
  }

  const trashPath = softDeleteVersionDir(agent, version);
  if (!trashPath) {
    return false;
  }

  // Remove versioned alias (e.g., claude@2.0.65)
  removeVersionedAlias(agent, version);

  // If the removed version was the global default, reassign it to the newest remaining version,
  // clearing only when none is left. A dangling default pointer broke every launcher.
  if (getGlobalDefault(agent) === version) {
    const remaining = listInstalledVersions(agent);
    // Never auto-promote an isolated install to the global default: it would silently make
    // `<agent>` resolve to it. Prefer the newest non-isolated survivor; if all are isolated, clear
    // the default.
    const promotable = remaining.filter((v) => !isVersionIsolated(agent, v));
    if (promotable.length > 0) {
      const newestRemaining = promotable[promotable.length - 1];
      setGlobalDefault(agent, newestRemaining);
      console.log(chalk.yellow(`Default ${agent} was ${version} (removed); reassigned to ${newestRemaining}. Change it with: agents use ${agent}@<version>`));
    } else {
      setGlobalDefault(agent, undefined);
      console.log(chalk.yellow(`Removed the last non-isolated ${agent} version and cleared its default. Reinstall with: agents add ${agent}, then set one with: agents use ${agent}@<version>`));
    }
  }

  // Same for the isolated pointer: a removed version must not stay the answer to a
  // bare `agents run <agent>`. Prefer the newest remaining isolated copy so removing
  // one of several does not silently drop the user back to their PATH binary.
  if (getIsolatedDefault(agent) === version) {
    const survivors = listInstalledVersions(agent).filter((v) => isVersionIsolated(agent, v));
    setIsolatedDefault(agent, survivors.length > 0 ? survivors[survivors.length - 1] : undefined);
  }

  // Clean up dangling config symlink if it pointed to the removed version
  const symlinkVersion = getConfigSymlinkVersion(agent);
  if (symlinkVersion === version) {
    const configPath = path.join(getHomeDir(), agentConfigDirName(agent));
    try {
      fs.unlinkSync(configPath);
    } catch {
      // Ignore if already gone
    }
  }

  // Clear dead per-version hook entries the removed version left in remaining versions' settings;
  // their command paths point at a gone home and error on every tool call. Limited to Claude-family
  // settings.json (claude, droid).
  if (agent === 'claude' || agent === 'droid') {
    const configDir = agentConfigDirName(agent);
    for (const remaining of listInstalledVersions(agent)) {
      const settingsPath = path.join(getVersionHomePath(agent, remaining), configDir, 'settings.json');
      pruneVersionHomeHookEntriesFromSettings(settingsPath, agent, version);
    }
  }

  // Global hook shims embed one source path; if it pointed into this home, every guard would exit
  // 127 (allow) until a daemon self-heal. Re-point now. Best effort: a repair failure must not
  // abort a bulk removal.
  try {
    repairManagedHookRuntimeArtifacts();
  } catch (err) {
    console.warn(`hook shim repair after removing ${agent}@${version} failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  emit('version.remove', { agent, version });
  return true;
}

/** Print the standard footer after versions are soft-deleted to trash, reminding the user that
 * sessions stay readable and how to restore. */
export function printTrashFooter(moved: Array<{ agent: AgentId; version: string }>): void {
  if (moved.length === 0) return;
  console.log();
  console.log(chalk.gray('Sessions remain accessible via `agents sessions`.'));
  if (moved.length === 1) {
    const { agent, version } = moved[0];
    console.log(chalk.gray(`Restore with: agents restore ${agent}@${version}`));
  } else {
    console.log(chalk.gray('Restore with: agents restore <agent>@<version>  (run `agents trash list` to see)'));
  }
}

/** Remove all versions of an agent while preserving each version's home/, so conversation
 * history is never deleted. */
export function removeAllVersions(agent: AgentId): number {
  const versions = listInstalledVersions(agent);
  let removed = 0;

  for (const version of versions) {
    if (removeVersion(agent, version)) {
      removed++;
    }
  }

  return removed;
}

export interface HealedVersionPointers {
  /** Global default reassigned off a not-installed version (`to: null` = cleared). */
  globalDefault?: { from: string; to: string | null };
  /** Isolated default (bare `agents run <agent>`) reassigned off a not-installed version. */
  isolatedDefault?: { from: string; to: string | null };
  /** `~/.<agent>` config symlink repointed off a not-installed version. */
  configSymlink?: { from: string; to: string };
}

/** RUSH-2471: repoint the global/isolated defaults and the ~/.<agent> symlink off any version no
 * longer installed (binary vanished by self-update, manual delete or half install). Mirrors
 * removeVersion's reassignment; real config dirs and isolated-only agents are untouched. */
export async function healDanglingVersionPointers(
  agent: AgentId,
  cwd: string,
): Promise<HealedVersionPointers> {
  const healed: HealedVersionPointers = {};
  const installed = listInstalledVersions(agent);

  const globalDefault = getGlobalDefault(agent);
  if (globalDefault !== null && !isVersionInstalled(agent, globalDefault)) {
    const promotable = installed.filter((v) => !isVersionIsolated(agent, v));
    const to = promotable.length > 0 ? promotable[promotable.length - 1] : undefined;
    setGlobalDefault(agent, to);
    healed.globalDefault = { from: globalDefault, to: to ?? null };
  }

  const isolatedDefault = getIsolatedDefault(agent);
  if (isolatedDefault !== null && !isVersionInstalled(agent, isolatedDefault)) {
    const survivors = installed.filter((v) => isVersionIsolated(agent, v));
    const to = survivors.length > 0 ? survivors[survivors.length - 1] : undefined;
    setIsolatedDefault(agent, to);
    healed.isolatedDefault = { from: isolatedDefault, to: to ?? null };
  }

  const current = getConfigSymlinkVersion(agent);
  const nonIsolated = installed.filter((v) => !isVersionIsolated(agent, v));
  if (
    current !== null &&
    !isVersionInstalled(agent, current) &&
    !isIsolationProtected(agent) &&
    nonIsolated.length > 0
  ) {
    const pinned = resolveVersion(agent, cwd);
    const target =
      pinned && isVersionInstalled(agent, pinned) && !isVersionIsolated(agent, pinned)
        ? pinned
        : nonIsolated[nonIsolated.length - 1];
    const result = await switchConfigSymlink(agent, target);
    if (result.success) healed.configSymlink = { from: current, to: target };
  }

  return healed;
}

/** Normalize a user-supplied `@version` token. `default`/`pinned`/`any` → undefined; `latest`/`oldest` → extreme installed version; concrete versions must be installed. */
export function resolveVersionAlias(agent: AgentId, raw: string | undefined | null): string | undefined {
  if (!raw || raw === 'default' || raw === 'pinned' || raw === 'any') return undefined;

  if (raw === 'latest' || raw === 'oldest') {
    const installed = listInstalledVersions(agent);
    if (installed.length === 0) {
      console.error(chalk.red(`No ${agent} versions installed.`));
      console.error(chalk.gray(`Install one: agents versions install ${agent}`));
      process.exit(1);
    }
    return raw === 'oldest' ? installed[0] : installed[installed.length - 1];
  }

  if (!isVersionInstalled(agent, raw)) {
    const installed = listInstalledVersions(agent);
    console.error(chalk.red(`${agent}@${raw} is not installed.`));
    if (installed.length > 0) {
      console.error(chalk.gray(`Installed: ${installed.join(', ')}`));
    }
    console.error(chalk.gray(`Install it: agents versions install ${agent}@${raw}`));
    process.exit(1);
  }
  return raw;
}

/** Loose variant of resolveVersionAlias for record filters (sessions, team history): same alias
 * semantics, but explicit versions pass through so records of uninstalled versions stay
 * queryable. */
export function resolveVersionAliasLoose(agent: AgentId, raw: string | undefined | null): string | undefined {
  if (!raw || raw === 'default' || raw === 'pinned' || raw === 'any') return undefined;
  if (raw === 'latest' || raw === 'oldest') {
    const installed = listInstalledVersions(agent);
    if (installed.length === 0) return undefined;
    return raw === 'oldest' ? installed[0] : installed[installed.length - 1];
  }
  return raw;
}


// compareVersions is defined in ./agent-spec/primitives.ts and re-exported here
// so existing `import { compareVersions } from './versions.js'` sites keep working.
export { compareVersions };

/**
 * Get actual version from an installed 'latest' directory.
 */
export async function getInstalledVersion(agent: AgentId, version: string): Promise<string | null> {
  const binaryPath = getBinaryPath(agent, version);
  if (!fs.existsSync(binaryPath)) {
    return null;
  }

  try {
    const { stdout } = await execFileAsync(binaryPath, ['--version']);
    const match = stdout.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : version;
  } catch {
    return version;
  }
}

/** True when probe output shows the runnable binary is missing (the gutted-install ENOENT
 * signature). Deliberately narrow so a nonzero exit or timeout never condemns a healthy
 * install; the trailing phrases catch claude-code's polite stub message. */
export function isMissingBinarySignature(output: string): boolean {
  return /\bENOENT\b|no such file|cannot find|command not found|is not recognized|native binary not installed|postinstall did not run|optional dependency was not downloaded/i.test(output);
}

/** Verify a fresh install can actually launch, not just that its JS wrapper exists, since a
 * gutted install reads healthy and then dies with ENOENT. Probe `--version` under the isolated
 * HOME and fail only on the missing-binary signature. */
/** Compose the spawn spec for a `--version` probe. On Windows the .cmd runs via cmd.exe with one
 * fully quoted command line and empty args (DEP0190-safe), so a spaced profile path cannot
 * split and false-fail a healthy install. Pure for unit tests. */
export function probeSpawnSpec(binary: string, isWin: boolean): { command: string; args: string[]; shell: boolean } {
  if (isWin) return { command: composeWin32CommandLine(binary, ['--version']), args: [], shell: true };
  return { command: binary, args: ['--version'], shell: false };
}

export async function verifyInstalledBinaryLaunches(
  agent: AgentId,
  version: string,
): Promise<{ ok: boolean; detail?: string }> {
  return verifyBinaryLaunches(getBinaryPath(agent, version), getVersionHomePath(agent, version));
}

/** The launch probe by path, shared by verifyInstalledBinaryLaunches and `agents update`, which
 * probes a staged release before the swap. On Windows probe the .cmd wrapper `agents run`
 * execs, since the extensionless bin would ENOENT even when healthy. */
export async function verifyBinaryLaunches(
  posixBinary: string,
  home: string,
): Promise<{ ok: boolean; detail?: string }> {
  const isWin = process.platform === 'win32';
  const binary = isWin ? posixBinary + '.cmd' : posixBinary;
  if (!fs.existsSync(binary)) {
    // Windows: a missing `.cmd` means a non-npm/global agent (droid.exe) we can't
    // safely probe — treat as healthy (isVersionInstalled validates presence).
    // POSIX: a missing launch binary is a genuine gutted install.
    return isWin ? { ok: true } : { ok: false, detail: `binary not found at ${binary}` };
  }
  try {
    // On Windows the .cmd runs via cmd.exe: pass one fully quoted command line and empty args
    // (DEP0190-safe, as exec.ts does) so a space in the profile path cannot split it and trigger a
    // destructive reinstall.
    const spec = probeSpawnSpec(binary, isWin);
    await execFileAsync(spec.command, spec.args, {
      timeout: 15000,
      shell: spec.shell,
      env: { ...process.env, HOME: home },
    });
    return { ok: true };
  } catch (err: any) {
    const blob = `${err?.code ?? ''} ${err?.stdout ?? ''} ${err?.stderr ?? ''} ${err?.message ?? ''}`;
    if (err?.code === 'ENOENT' || isMissingBinarySignature(blob)) {
      const detail = String(err?.stderr || err?.message || '')
        .split('\n').map((s: string) => s.trim()).filter(Boolean)[0];
      return { ok: false, detail: detail || 'native binary missing (ENOENT)' };
    }
    // Launched but exited nonzero without a missing-file signature, or timed out
    // waiting for input: the binary is present and runnable. Healthy.
    return { ok: true };
  }
}

/** Launch-path self-heal for `agents run`: probe, else clean-reinstall in place, else fall back
 * to another installed version, else install latest, else null. Isolated targets only get the
 * reinstall and are never fallbacks. */
export async function ensureAgentRunnable(
  agent: AgentId,
  version: string,
  log?: (message: string) => void,
  opts?: { allowDefaultSwitch?: boolean },
): Promise<string | null> {
  // Whether the heal may repoint the global default. The unattended daemon pass sets this false:
  // switching default makes a fresh empty Claude credential scope, an unprovoked logout. It still
  // repairs the current default in place, else returns null.
  const allowDefaultSwitch = opts?.allowDefaultSwitch ?? true;
  const cfg = AGENTS[agent];
  if (!cfg?.npmPackage) return version;

  if ((await verifyInstalledBinaryLaunches(agent, version)).ok) return version;

  // Read the marker BEFORE the repair: the reinstall rewrites the version dir,
  // so isolation must be decided from the pre-repair state, not re-read after.
  const targetIsolated = isVersionIsolated(agent, version);

  log?.(`${cfg.name}@${version} is broken (platform binary missing) — repairing…`);
  const record = readInstallation(agent, version);
  const repair = await installVersion(agent, record?.releaseVersion ?? version, undefined, { clean: true, installationLabel: version });
  if (repair.success && (await verifyInstalledBinaryLaunches(agent, version)).ok) {
    log?.(`repaired ${cfg.name}@${version}.`);
    return version;
  }

  // An isolated copy is walled off from the rest of the setup: repairing it in
  // place is the ONLY thing we may do. No fallback, no install, no default
  // switch — surface the failure and let the caller tell the user.
  if (targetIsolated || (record && record.label !== record.releaseVersion)) {
    log?.(`${cfg.name}@${version} is an isolated install and could not be repaired — leaving your default ${cfg.name} untouched.`);
    return null;
  }

  // In-place repair failed: normally adopt another installed version and repoint the default. When
  // default-switching is disallowed (daemon pass), refuse, because repointing would swap the
  // credential scope silently. Return so the caller can notify.
  if (!allowDefaultSwitch) {
    log?.(`${cfg.name}@${version} won't launch and could not be repaired in place — NOT repointing your default ${cfg.name} unattended. Run \`agents use ${agent} <version>\` or \`agents add ${agent}@latest\` to choose one.`);
    return null;
  }

  // In-place repair failed → adopt another installed version that launches.
  // Isolated copies are excluded: they are deliberately not promotable.
  const others = listInstalledVersions(agent)
    .filter(v => v !== version && !isVersionIsolated(agent, v))
    .sort(compareVersions)
    .reverse();
  for (const cand of others) {
    if ((await verifyInstalledBinaryLaunches(agent, cand)).ok) {
      setGlobalDefault(agent, cand);
      log?.(`${cfg.name}@${version} could not be repaired — using ${cfg.name}@${cand} instead (now the default).`);
      return cand;
    }
  }

  // Last resort: install latest and pin it, unless `latest` is already held as an isolated copy.
  // Both share one on-disk dir, so installing would commandeer it and pin an isolated install as
  // default. Resolved before installing.
  const latestVersion = await getLatestNpmVersion(agent);
  if (latestVersion && isVersionIsolated(agent, latestVersion)) {
    log?.(`no runnable ${cfg.name} version installed — ${cfg.name}@${latestVersion} is the latest, but you hold it as an isolated copy, so it can't become your default.`);
    log?.(`install one explicitly: agents add ${agent}@latest`);
    return null;
  }

  log?.(`no runnable ${cfg.name} version installed — installing ${cfg.name}@latest…`);
  const latest = await installVersion(agent, 'latest', undefined, { clean: true });
  if (latest.success) {
    // Belt-and-braces: `latest` could have moved between the probe above and the
    // install. Never pin an isolated version, whatever the resolution said.
    if (isVersionIsolated(agent, latest.installedVersion)) {
      log?.(`${cfg.name}@${latest.installedVersion} is an isolated copy and can't be set as your default.`);
      return null;
    }
    setGlobalDefault(agent, latest.installedVersion);
    log?.(`installed ${cfg.name}@${latest.installedVersion} and set it as the default.`);
    return latest.installedVersion;
  }
  return null;
}

/** Daemon launch-health pass: probe each npm-package agent's default and repair any that won't
 * launch via ensureAgentRunnable, before the user's next run hits ENOENT. Returns `repaired`
 * labels and `unhealed` agent@version entries. */
const failedRepairAt = new Map<string, number>();
const REPAIR_COOLDOWN_MS = 24 * 60 * 60_000;

export async function healBrokenDefaultLaunches(
  log?: (m: string) => void,
  opts?: { allowDefaultSwitch?: boolean },
): Promise<{ repaired: string[]; unhealed: string[] }> {
  const repaired: string[] = [];
  const unhealed: string[] = [];
  for (const agent of Object.keys(AGENTS) as AgentId[]) {
    if (!AGENTS[agent].npmPackage) continue; // native/global agents have no gutted-tarball failure mode
    const version = getGlobalDefault(agent);
    if (!version) continue;
    if ((await verifyInstalledBinaryLaunches(agent, version)).ok) continue;
    // Backoff: a version whose repair just failed (offline, npm 404, unsupported arch) must not
    // retrigger a full reinstall every 6h pass. Skip it for a day; a daemon restart clears the
    // memo.
    const key = `${agent}@${version}`;
    const last = failedRepairAt.get(key);
    if (last !== undefined && Date.now() - last < REPAIR_COOLDOWN_MS) {
      log?.(`${AGENTS[agent].name}@${version} still won't launch — repair attempted recently, skipping until cooldown elapses.`);
      continue;
    }
    log?.(`${AGENTS[agent].name}@${version} won't launch — repairing…`);
    const healed = await ensureAgentRunnable(agent, version, log, opts);
    if (healed) {
      failedRepairAt.delete(key);
      repaired.push(`${agent}@${version}${healed === version ? '' : `→${healed}`}`);
    } else {
      failedRepairAt.set(key, Date.now());
      unhealed.push(key);
    }
  }
  return { repaired, unhealed };
}


/** Outcome of syncing resources to a version home, keyed by resource type. */
export interface SyncResult {
  commands: boolean;
  skills: boolean;
  hooks: boolean;
  memory: string[];
  permissions: boolean;
  mcp: string[];
  subagents: string[];
  plugins: string[];
  workflows: string[];
  /** Project files the sync left alone because the workspace already has them (repo-relative).
   * Reported once, grouped, by the rendering command, never one line per file here. */
  projectSkipped: string[];
  /** Resources removed from the version home because they were deleted from source since the
   * last sync (RUSH-2438), per kind. Populated only on a repo-scope reconcile that ran the
   * prune pass. */
  pruned: Record<PrunableKind, string[]>;
  /** RUSH-2677: resources this sync refused to write, as user-facing sentences. An empty list
   * cannot also mean declined, which let a harness with no config writer report a clean sync.
   * The rendering command must print these. */
  declined: string[];
}

/** Enumerate the DotAgent repo names resources can be scoped to: the fixed project/user/system
 * layers plus every enabled extra repo alias. Validates `agents sync <agent> --repo <name>`. */
export function listRepoNames(): string[] {
  return ['project', 'user', 'system', ...getEnabledExtraRepos().map(e => e.alias)];
}

/** Pattern-selectable resource kinds — every kind whose selection is
 * driven by `source:name` patterns (memory is preset-driven, handled apart). */
type SelectableKind = 'commands' | 'skills' | 'hooks' | 'subagents' | 'permissions' | 'mcp' | 'plugins' | 'workflows';

/** Build the name-to-source-layer map for one resource kind, matched against `source:*`
 * patterns. The single source of truth for layer attribution, shared by the persisted-pattern
 * sync and buildRepoScopedSelection so they cannot drift. */
function resourceSourceMap(kind: SelectableKind, cwd: string, available: AvailableResources): Map<string, string> {
  switch (kind) {
    case 'commands':
    case 'skills':
    case 'hooks':
    case 'subagents':
      return new Map(listResources(kind, cwd).map(r => [r.name, r.source]));
    case 'permissions': {
      const sources = sourceMapFromPermissionGroups(cwd);
      return new Map(available.permissions.flatMap((n) => {
        const source = sources.get(n);
        return source ? [[n, source] as [string, string]] : [];
      }));
    }
    case 'mcp':
      return new Map(getScopedMcpResources(cwd).map(r => [r.name, r.scope]));
    case 'plugins': {
      const sources = sourceMapFromPlugins(cwd);
      return new Map(available.plugins.flatMap((n) => {
        const source = sources.get(n);
        return source ? [[n, source] as [string, string]] : [];
      }));
    }
    case 'workflows': {
      const sources = sourceMapFromWorkflows(cwd);
      return new Map(available.workflows.flatMap((n) => {
        const source = sources.get(n);
        return source ? [[n, source] as [string, string]] : [];
      }));
    }
  }
}

/** Build a ResourceSelection from source patterns and an optional per-kind name filter; both
 * compose. Memory is 'all' under patterns or a memory filter (RUSH-1354), skipped when a filter
 * omits it, and 'all' with no filter. */
export function buildSelection(
  patterns: string[],
  kindFilter?: ResourceSelection,
  cwd: string = process.cwd(),
): ResourceSelection {
  const hasPatterns = patterns.length > 0;
  const hasKindFilter = kindFilter !== undefined;

  // Fast path: no restrictions → sync every kind
  if (!hasPatterns && !hasKindFilter) {
    return {
      commands: 'all', skills: 'all', hooks: 'all',
      subagents: 'all', permissions: 'all', mcp: 'all',
      plugins: 'all', workflows: 'all', memory: 'all',
    };
  }

  const selection: ResourceSelection = {};
  const allKinds: SelectableKind[] = [
    'commands', 'skills', 'hooks', 'subagents',
    'permissions', 'mcp', 'plugins', 'workflows',
  ];
  const available = hasPatterns ? getAvailableResources(cwd) : undefined;

  for (const kind of allKinds) {
    const filterVal = kindFilter?.[kind];

    // When a kind filter is active, skip kinds not listed in it
    if (hasKindFilter && filterVal === undefined) continue;

    if (hasPatterns) {
      const sourceMap = resourceSourceMap(kind, cwd, available!);
      const patternNames = expandPatterns(patterns, sourceMap);
      if (patternNames.length === 0) continue;

      if (!filterVal || filterVal === 'all') {
        selection[kind] = patternNames;
      } else {
        // Intersect pattern-expanded names with the caller's name filter
        const filterSet = new Set(filterVal as string[]);
        const intersected = patternNames.filter(n => filterSet.has(n));
        if (intersected.length > 0) selection[kind] = intersected;
      }
    } else {
      // Kind filter only — no pattern restriction; use the filter value directly
      selection[kind] = filterVal === 'all' || !filterVal ? 'all' : (filterVal as string[]);
    }
  }

  // Memory is always 'all' when patterns are active (RUSH-1354), when the
  // memory/rule flag was given, or when no kind filter restricts what is synced.
  const memoryRequested = hasPatterns || kindFilter?.memory !== undefined || !hasKindFilter;
  if (memoryRequested) selection.memory = 'all';

  return selection;
}

/** Build a ResourceSelection for one DotAgent repo by delegating to buildSelection. `memory` is
 * always 'all' because the composed rules file spans all layers and must be recompiled in the
 * same pass (RUSH-1354). */
export function buildRepoScopedSelection(repo: string, cwd: string = process.cwd()): ResourceSelection {
  return buildSelection([`${repo}:*`], undefined, cwd);
}

/** Union several ResourceSelections, deduping names per kind. Pure, so it is unit-tested without
 * a DotAgents layout. Memory is a whole-file merge: `includeMemory` requests a full write
 * ('all'), else the skip sentinel stays. */
export function unionResourceSelections(
  selections: ResourceSelection[],
  includeMemory: boolean,
): ResourceSelection {
  const merged: ResourceSelection = {};
  const kinds: SelectableKind[] = ['commands', 'skills', 'hooks', 'subagents', 'permissions', 'mcp', 'plugins', 'workflows'];
  for (const sel of selections) {
    for (const kind of kinds) {
      const names = sel[kind];
      if (!Array.isArray(names) || names.length === 0) continue;
      const existing = (merged[kind] as string[] | undefined) ?? [];
      merged[kind] = Array.from(new Set([...existing, ...names]));
    }
  }
  merged.memory = includeMemory ? 'all' : [];
  return merged;
}

/** Build one selection across several repos, as an interactive `agents sync` picker collects.
 * Memory is written whole only when the user or system layer is selected, since that is where
 * its content comes from. */
export function mergeRepoScopedSelections(repos: string[], cwd: string = process.cwd()): ResourceSelection {
  const includeMemory = repos.includes('user') || repos.includes('system');
  return unionResourceSelections(repos.map((r) => buildRepoScopedSelection(r, cwd)), includeMemory);
}

/** Sync central resources (~/.agents/) into a version's config directory, optionally limited by
 * `selection` (default: all). Gemini commands are converted from markdown to TOML. */
/** Resolve a hook selection against the available set by exact name or extensionless basename,
 * returning the available (extensioned) name. PHNX-3187: heal passes feed basenames back, which
 * an exact filter matched against nothing, so `agents doctor --fix` never reconciled a hook. */
export function resolveHookSelection(sel: string[] | 'all' | undefined, available: string[]): string[] {
  if (sel === 'all') return available;
  if (!Array.isArray(sel)) return [];
  const stripExt = (n: string): string => n.replace(/\.[^./\\]+$/, '');
  const exact = new Set(available);
  const byBase = new Map<string, string>();
  for (const a of available) {
    const base = stripExt(a);
    if (!byBase.has(base)) byBase.set(base, a); // first available wins the basename
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of sel) {
    const resolved = exact.has(name) ? name : byBase.get(stripExt(name));
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved);
      out.push(resolved);
    }
  }
  return out;
}

export function syncResourcesToVersion(agent: AgentId, version: string, selection?: ResourceSelection, options: { projectDir?: string; cwd?: string; force?: boolean; available?: AvailableResources; prune?: boolean; allowExecSurfaces?: boolean } = {}): SyncResult {
  if (isAgentHardDeprecated(agent)) {
    return { commands: false, skills: false, hooks: false, memory: [], permissions: false, mcp: [], subagents: [], plugins: [], workflows: [], projectSkipped: [], pruned: { commands: [], skills: [] }, declined: [] };
  }

  const agentConfig = AGENTS[agent];
  const versionHome = getVersionHomePath(agent, version);
  const agentDir = path.join(versionHome, agentConfigDirName(agent));
  fs.mkdirSync(agentDir, { recursive: true });
  // Record whether the caller passed a selection: the pattern path reassigns `selection`, but no
  // selection means a full sync, after which the staleness manifest is persisted.
  const userPassedSelection = selection !== undefined;

  const result: SyncResult = { commands: false, skills: false, hooks: false, memory: [], permissions: false, mcp: [], subagents: [], plugins: [], workflows: [], projectSkipped: [], pruned: { commands: [], skills: [] }, declined: [] };
  const cwd = options.cwd || process.cwd();
  const projectAgentsDir = options.projectDir || getProjectAgentsDir(cwd);
  const userAgentsDir = getUserAgentsDir();
  // Extra DotAgent repos registered via `agents repo add`. Looked up last so
  // project/user/system repos win on name collisions.
  const extraRepos = getEnabledExtraRepos();

  // Project-layer fan-out always runs — even on the early guard hit — so the
  // `projectSkipped` contract is preserved for callers (RUSH-2320 #4).
  if (projectAgentsDir) {
    result.projectSkipped = syncProjectResourcesToAgent(agent, version, projectAgentsDir).skipped;
  }

  // Install the shared SessionStart state-writer hook for every hook-capable harness even when the
  // staleness guard skips the sync, because it is registered in the harness's native config, not
  // the tracked resource tree.
  if (supports(agent, 'hooks', version).ok) {
    const trackerResult = installSessionTrackerHookSync(agent, version);
    if (!trackerResult.installed && trackerResult.error) {
      console.warn(`agents: SessionStart hook not installed for ${agent}@${version}: ${trackerResult.error}`);
    }
  }

  if (agent === 'claude') {
    const statusLine = installClaudeStatusLine(versionHome);
    if (statusLine.error) {
      console.warn(`agents: Claude status line not installed for ${agent}@${version}: ${statusLine.error}`);
    }
  }

  // Fast guard before getAvailableResources and pattern expansion (RUSH-2320 #4): the work ahead of
  // it was ~12.5 of the 21.5 ms hit path. A valid manifest implies patterns were written, so
  // skipping that call is safe but not byte-identical.
  if (!userPassedSelection && !options.force) {
    const manifest = loadManifest(agent, version);
    if (manifest && !isStale(manifest, agent, version, cwd)) {
      return { ...result };
    }
  }

  // Prefer a caller-supplied inventory (refresh already built one) so multi-
  // version fan-out does not re-scan resource trees per version (RUSH-2320 #5).
  const available = options.available ?? getAvailableResources(cwd);

  // Write default resource selection patterns for this version (idempotent —
  // only sets fields that aren't already present, preserving user edits).
  {
    const extraAliases = extraRepos.map(e => e.alias);
    const noProject = defaultPatterns(extraAliases, false);
    ensureVersionResourcePatterns(agent, version, {
      commands:    noProject,
      skills:      noProject,
      hooks:       noProject,     // hooks: no project layer (security)
      subagents:   noProject,
      plugins:     noProject,
      workflows:   noProject,
      permissions: ['system:*'],
      mcp:         ['user:*'],
    });
  }

  // With no explicit selection, build one from the persisted resource patterns so users can
  // customize agents.yaml. Default patterns (every layer wildcard) expand to the full available
  // set.
  if (!selection) {
    const vr = getVersionResources(agent, version);
    if (vr) {
      const patternSelection: ResourceSelection = {};

      // Listable resource types: use listResources to get name→source maps.
      const listableTypes: Array<['commands' | 'skills' | 'hooks' | 'subagents', 'commands' | 'skills' | 'hooks' | 'subagents']> = [
        ['commands', 'commands'],
        ['skills',   'skills'],
        ['hooks',    'hooks'],
        ['subagents','subagents'],
      ];
      for (const [type, kind] of listableTypes) {
        const patterns = vr[type];
        if (!Array.isArray(patterns) || patterns.length === 0) continue;
        patternSelection[type] = expandPatterns(patterns, resourceSourceMap(kind, cwd, available));
      }

      // permissions / mcp / plugins / workflows: source attribution lives in
      // resourceSourceMap so it can't drift from buildRepoScopedSelection.
      if (Array.isArray(vr.permissions) && vr.permissions.length > 0) {
        patternSelection.permissions = expandPatterns(vr.permissions, resourceSourceMap('permissions', cwd, available));
      }
      if (Array.isArray(vr.mcp) && vr.mcp.length > 0) {
        patternSelection.mcp = expandPatterns(vr.mcp, resourceSourceMap('mcp', cwd, available));
      }
      if (Array.isArray(vr.plugins) && vr.plugins.length > 0) {
        patternSelection.plugins = expandPatterns(vr.plugins, resourceSourceMap('plugins', cwd, available));
      }
      if (Array.isArray(vr.workflows) && vr.workflows.length > 0) {
        patternSelection.workflows = expandPatterns(vr.workflows, resourceSourceMap('workflows', cwd, available));
      }

      // memory is not pattern-controlled (rulesPreset handles it) — always sync.
      patternSelection.memory = 'all';

      if (Object.keys(patternSelection).length > 0) {
        selection = patternSelection;
      }
    }
  }

  // Helper: remove a path (symlink or real) if it exists
  const removePath = (p: string) => {
    try {
      const stat = fs.lstatSync(p);
      if (stat.isSymbolicLink() || stat.isFile()) {
        fs.unlinkSync(p);
      } else if (stat.isDirectory()) {
        fs.rmSync(p, { recursive: true, force: true });
      }
    } catch { /* file already removed or inaccessible */ }
  };

  // Helper: copy a directory recursively
  const copyDir = (src: string, dest: string) => {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (shouldSkillEntryBeSkipped(entry.name)) continue;
      const srcPath = safeJoin(src, entry.name);
      const destPath = safeJoin(dest, entry.name);
      if (entry.isDirectory()) {
        copyDir(srcPath, destPath);
      } else if (entry.isFile()) {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  };

  // Helper: resolve selection to list of items
  const resolveSelection = (sel: string[] | 'all' | undefined, available: string[]): string[] => {
    if (sel === 'all') return available;
    if (Array.isArray(sel)) {
      const availableSet = new Set(available);
      return sel.filter((item) => availableSet.has(item));
    }
    return [];
  };

  const trustedCommandNames = (names: string[]): string[] => names.filter((name) => resolveCommandSource(name) !== null);

  // Dispatch commands through WRITERS.commands, which picks native copy, commands-as-skills or
  // dual-write. The old COMMANDS_CAPABLE_AGENTS gate excluded skills-only targets such as Kimi and
  // silently dropped every converted command.
  const commandsWriter = getWriter('commands', agent);
  const commandsToSync = selection
    ? trustedCommandNames(resolveSelection(selection.commands, available.commands))
    : trustedCommandNames(available.commands); // No selection = sync all trusted commands, excluding project-only commands
  const commandsAsSkills = shouldInstallCommandAsSkill(agent, version);
  const commandsAlsoAsSkills = shouldAlsoInstallCommandAsSkill(agent, version);
  const commandsInstallAsSkills = commandsAsSkills || commandsAlsoAsSkills;
  let writtenCommands: string[] = [];
  // Artifact paths the writers report (WriteResult.paths), persisted to the
  // manifest as `writtenTargets` after a full sync so isStale can flag a
  // deleted artifact as stale (#2398).
  const writtenTargets: string[] = [];

  if (commandsToSync.length > 0 && commandsWriter) {
    // Agents that replace commands with skills (codex >= 0.117.0, kimi) need the legacy command
    // dir removed, since the orphan sweep is off for them. Gate on `commandsAsSkills`, never
    // `commandsAlsoAsSkills`: a dual-write native dir is live (Cursor IDE).
    if (commandsAsSkills && agentConfig.commandsSubdir) {
      removePath(path.join(agentDir, agentConfig.commandsSubdir));
    }

    const r = commandsWriter.write({ version, versionHome, selection: commandsToSync, cwd });
    writtenCommands = r.synced;
    if (r.paths) writtenTargets.push(...r.paths);
    result.commands = r.synced.length > 0;
  }

  // Orphan-sweep stale command files left by syncs under a different cwd, in full-sync mode only.
  // Explicit selections are additive, so sweeping there would violate that contract; the cross-
  // project leak comes from no-selection full syncs.
  if (!userPassedSelection && commandsWriter && !shouldInstallCommandAsSkill(agent, version)) {
    const commandsTargetSweep = path.join(agentDir, agentConfig.commandsSubdir);
    if (fs.existsSync(commandsTargetSweep)) {
      const ext = agentConfig.format === 'toml' ? '.toml' : '.md';
      const trustedCommands = new Set(commandsToSync);
      // A dual-write target's native directory also belongs to another product
      // surface (Cursor IDE). Delete only names the command writer recorded as
      // successfully emitted during the preceding full sync.
      const previouslyManagedCommands = commandsAlsoAsSkills
        ? new Set(loadManifest(agent, version)?.writtenCommands ?? [])
        : null;
      for (const entry of fs.readdirSync(commandsTargetSweep, { withFileTypes: true })) {
        if (!entry.isFile() || entry.name.startsWith('.')) continue;
        if (!entry.name.endsWith(ext)) continue;
        const name = entry.name.slice(0, -ext.length);
        if (!trustedCommands.has(name) && (!previouslyManagedCommands || previouslyManagedCommands.has(name))) {
          removePath(safeJoin(commandsTargetSweep, entry.name));
        }
      }
    }
  }

  // Sync skills — dispatch through WRITERS.skills. Agents that natively read
  // ~/.agents/skills/ (Gemini) are not registered; we clear the version-home
  // skills dir for them so a stale per-version copy never shadows central.
  const skillsWriter = getWriter('skills', agent);
  const pluginsWriter = getWriter('plugins', agent);
  const pluginsToSync = selection
    ? resolveSelection(selection.plugins, available.plugins)
    : (pluginsWriter ? available.plugins : []);
  const pluginSkillsToSync = listPluginSkillNames({ agent, plugins: new Set(pluginsToSync) });
  const trustedSkillNames = (names: string[]): string[] =>
    names.filter((name) => resolveSkillSource(name, { agent, plugins: new Set(pluginsToSync) }) !== null);
  const selectedSkillsToSync = selection
    ? trustedSkillNames(resolveSelection(selection.skills, available.skills))
    : trustedSkillNames(available.skills);
  let skillsToSync = userPassedSelection
    ? selectedSkillsToSync
    : Array.from(new Set([...selectedSkillsToSync, ...pluginSkillsToSync]));
  if (commandsInstallAsSkills && commandsToSync.length > 0 && skillsToSync.length > 0) {
    const commandNames = new Set(commandsToSync);
    const skillRoots = [
      path.join(getUserAgentsDir(), 'skills'),
      getSkillsDir(),
      ...getEnabledExtraRepos().map((e) => path.join(e.dir, 'skills')),
    ];
    skillsToSync = skillsToSync.filter((skill) => {
      if (!commandNames.has(skill)) return true;
      return readSkillSourceCommandMarker(skill, skillRoots) !== skill;
    });
  }

  if (agentConfig.nativeAgentsSkillsDir) {
    removePath(path.join(agentDir, 'skills'));
  } else if (skillsWriter) {
    if (skillsToSync.length > 0) {
      const r = skillsWriter.write({ version, versionHome, selection: skillsToSync, cwd });
      if (r.paths) writtenTargets.push(...r.paths);
      result.skills = r.synced.length > 0;
    }

    // Orphan-sweep stale skill dirs from syncs under a different cwd, full-sync only (see the
    // commands sweep). Skip dot-dirs to keep plugin subtrees intact, and the harness's own
    // ownedSkillDirs.
    const skillsTargetSweep = path.join(agentDir, 'skills');
    if (!userPassedSelection && fs.existsSync(skillsTargetSweep) && !fs.lstatSync(skillsTargetSweep).isSymbolicLink()) {
      // Trust command-skills too: when commands install as skills, the writer made skill dirs that
      // are not in skillsToSync and would be swept as orphans, silently deleting every converted
      // command (e.g. /recap on Kimi).
      const trustedSkills = new Set([...skillsToSync, ...(agentConfig.ownedSkillDirs ?? [])]);
      if (commandsInstallAsSkills) for (const cmd of commandsToSync) trustedSkills.add(cmd);
      for (const entry of fs.readdirSync(skillsTargetSweep, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        if (!trustedSkills.has(entry.name)) {
          removePath(safeJoin(skillsTargetSweep, entry.name));
        }
      }
    }
  }

  // Sync hooks — dispatch through WRITERS.hooks. supports() gate enforces
  // the version cutoff (codex >= 0.116.0, gemini >= 0.26.0).
  const hooksGate = supports(agent, 'hooks', version);
  const hooksWriter = getWriter('hooks', agent);
  if (agentConfig.supportsHooks && hooksWriter) {
    if (!hooksGate.ok) {
      console.warn(explainSkip(agent, 'hooks', hooksGate, version) + ' -- skipped');
    } else {
      // Resolve hooks by basename as well as exact name. PHNX-3187: available.hooks has extensions
      // (git-guard.sh) but the heal diff uses basenames, so the plain resolveSelection matched
      // nothing and could not reconcile a flagged hook.
      const hooksToSync = selection
        ? resolveHookSelection(selection.hooks, available.hooks)
        : available.hooks;

      let hookManifest: ReturnType<typeof parseHookManifest> = {};
      if (hooksToSync.length > 0) {
        const r = hooksWriter.write({ version, versionHome, selection: hooksToSync, cwd });
        // Remove orphan files from the version home. The trusted set is the manifest-declared hook
        // list, so auxiliary source files like README.md or promptcuts.yaml do not linger from
        // older syncs.
        const hooksTarget = path.join(agentDir, 'hooks');
        const trustedHookNames = new Set(available.hooks);
        if (fs.existsSync(hooksTarget)) {
          for (const file of fs.readdirSync(hooksTarget).filter(f => !f.startsWith('.'))) {
            if (!trustedHookNames.has(file)) {
              removePath(safeJoin(hooksTarget, file));
            }
          }
        }
        if (r.paths) writtenTargets.push(...r.paths);
        result.hooks = r.synced.length > 0;
        hookManifest = selectHookManifest(parseHookManifest(), hooksToSync);
      }
      const hooksInScope = !userPassedSelection || selection?.hooks !== undefined;
      if (agent === 'opencode' && hooksInScope) {
        registerHooksToSettings(agent, versionHome, hookManifest);
      }
    }
  }

  // Dispatch rules through WRITERS.rules, which covers any agent declaring `rules: { file }` (grok
  // included; the old gate used the wrong list and skipped it). Project rules are composed into the
  // workspace at run time, not synced here.
  const skipMemory = selection && Array.isArray(selection.memory) && selection.memory.length === 0;
  const rulesWriter = getWriter('rules', agent);
  if (!skipMemory && rulesWriter) {
    try {
      // If selection.memory names a single preset, treat it as a one-shot
      // override; otherwise read the persisted active preset.
      const overridePreset = Array.isArray(selection?.memory) && selection!.memory.length === 1 && selection!.memory[0] !== 'AGENTS'
        ? selection!.memory[0]
        : null;
      const preset = overridePreset || activeRulesPreset() || getActiveRulesPreset(agent, version);
      const r = rulesWriter.write({ version, versionHome, selection: { preset }, cwd });
      if (r.paths) writtenTargets.push(...r.paths);
      result.memory.push(...r.synced);
      // rulesPreset is tracked separately via setActiveRulesPreset.
    } catch (err) {
      // No rules.yaml yet, or a typo'd preset name. Don't fail the whole sync —
      // just leave the agent without a synced rules file.
      console.warn(`Skipping rules sync for ${agent}@${version}: ${(err as Error).message}`);
    }
  }

  // Apply permissions; AGENTS_PERMISSION_PRESET selects a recipe whose includes filter the groups.
  // Groups are read from user and system only, never a project's .agents/permissions/, so a cloned
  // repo cannot widen its own sandbox.
  const permissionGroups = discoverPermissionGroups();
  const allGroupNames = permissionGroups.map(g => g.name);
  const activePresetName = getActivePermissionPresetName();
  let presetFilteredGroups: string[] | null = null;
  if (activePresetName) {
    const recipe = readPermissionPresetRecipe(activePresetName);
    if (recipe) {
      const available = new Set(allGroupNames);
      presetFilteredGroups = recipe.includes.filter(g => available.has(g));
    } else {
      console.warn(`${PERMISSION_PRESET_ENV_VAR}=${activePresetName} but no recipe at ~/.agents/permissions/presets/${activePresetName}.yaml — falling back to all groups`);
    }
  }
  const permissionsWriter = getWriter('permissions', agent);
  let permsToSync: string[];
  if (selection) {
    permsToSync = resolveSelection(selection.permissions, allGroupNames);
    // An active preset recipe's includes list always wins, even over an explicit selection. Without
    // the intersection, `agents add`'s automatic selection would pass every discovered group
    // (including 99-deny) and bypass the sandbox filter.
    if (presetFilteredGroups) {
      const filterSet = new Set(presetFilteredGroups);
      permsToSync = permsToSync.filter(g => filterSet.has(g));
    }
  } else {
    permsToSync = permissionsWriter ? (presetFilteredGroups ?? allGroupNames) : [];
  }

  if (permsToSync.length > 0 && permissionsWriter) {
    const r = permissionsWriter.write({ version, versionHome, selection: permsToSync, cwd });
    result.permissions = r.synced.length > 0;
    // permissions patterns already written via ensureVersionResourcePatterns above.
  }

  // Install MCP servers (CLI commands for Claude/Codex, config edits otherwise). RUSH-1776:
  // project-scoped MCPs are untrusted by default, since a cloned repo could install an arbitrary
  // command; drop them unless `agents mcp trust` was run. lib/mcp.ts enforces the same.
  const projectMcpTrusted = projectAgentsDir ? isProjectMcpTrusted(projectAgentsDir) : false;
  const untrustedProjectMcpNames = new Set(
    projectMcpTrusted
      ? []
      : getScopedMcpResources(cwd).filter(r => r.scope === 'project').map(r => r.name)
  );
  const mcpWriter = getWriter('mcp', agent);
  const mcpToSyncAll = selection
    ? resolveSelection(selection.mcp, available.mcp)
    : (mcpWriter ? available.mcp : []);
  const mcpToSync = mcpToSyncAll.filter(n => !untrustedProjectMcpNames.has(n));

  if (mcpToSync.length > 0 && mcpWriter) {
    const r = mcpWriter.write({ version, versionHome, selection: mcpToSync, cwd });
    if (r.paths) writtenTargets.push(...r.paths);
    result.mcp = r.synced;
    if (r.errors?.length) result.declined.push(...r.errors.map((e) => `mcp: ${e}`));
    // mcp patterns already written via ensureVersionResourcePatterns above.
  }

  // Sync subagents — dispatch through WRITERS.subagents. listInstalledSubagents
  // reads only user + system layers (project excluded for the same defense
  // as commands/skills/hooks).
  const subagentsWriter = getWriter('subagents', agent);
  const subagentsGate = supports(agent, 'subagents', version);
  const installedSubagentNames = new Set(listInstalledSubagents().map((subagent) => subagent.name));
  const trustedSubagentNames = (names: string[]): string[] => names.filter((name) => installedSubagentNames.has(name));
  const subagentsRequested = selection
    ? trustedSubagentNames(resolveSelection(selection.subagents, available.subagents))
    : (subagentsWriter ? trustedSubagentNames(available.subagents) : []);
  const subagentsToSync = subagentsGate.ok ? subagentsRequested : [];

  if (subagentsRequested.length > 0 && !subagentsGate.ok) {
    console.warn(explainSkip(agent, 'subagents', subagentsGate, version) + ' -- skipped');
  }

  if (subagentsToSync.length > 0 && subagentsWriter) {
    const r = subagentsWriter.write({ version, versionHome, selection: subagentsToSync, cwd });
    if (r.paths) writtenTargets.push(...r.paths);
    result.subagents.push(...r.synced);
    if (r.errors?.length) result.declined.push(...r.errors.map((e) => `subagents: ${e}`));

    // Orphan-sweep for Claude only — see comment on commands/skills sweep
    // for the no-selection guard. OpenClaw stores subagents as siblings of
    // other resources so a readdir sweep would over-reach.
    if (!userPassedSelection && agent === 'claude') {
      const claudeAgentsDir = path.join(agentDir, 'agents');
      if (fs.existsSync(claudeAgentsDir)) {
        const trustedSubagents = new Set(subagentsToSync);
        for (const entry of fs.readdirSync(claudeAgentsDir, { withFileTypes: true })) {
          if (!entry.isFile() || entry.name.startsWith('.')) continue;
          if (!entry.name.endsWith('.md')) continue;
          const name = entry.name.slice(0, -'.md'.length);
          if (!trustedSubagents.has(name)) {
            removePath(safeJoin(claudeAgentsDir, entry.name));
          }
        }
      }
    }
  }

  // Sync plugins — dispatch through WRITERS.plugins (or directly via
  // syncPluginToVersion when allowExecSurfaces is requested, since WriteArgs
  // has no channel for that option).
  if (pluginsToSync.length > 0 && pluginsWriter) {
    if (options.allowExecSurfaces) {
      const allPlugins = discoverPlugins();
      // Pass the discovered plugins (with marketplace provenance) so a stale
      // install under one marketplace is trashed even when another marketplace
      // still ships that name — the PHNX-2618 shadow `code` plugin.
      cleanOrphanedPluginSkills(agent, versionHome, allPlugins);
      const pluginMap = new Map(allPlugins.map(p => [p.name, p]));
      for (const name of pluginsToSync) {
        const plugin = pluginMap.get(name);
        if (!plugin || !pluginSupportsAgent(plugin, agent)) continue;
        const r = syncPluginToVersion(plugin, agent, versionHome, { version, allowExecSurfaces: true });
        if (r.success) result.plugins.push(name);
      }
    } else {
      const r = pluginsWriter.write({ version, versionHome, selection: pluginsToSync, cwd });
      result.plugins.push(...r.synced);
    }
  }

  // Sync workflows — dispatch through WRITERS.workflows.
  const workflowsWriter = getWriter('workflows', agent);
  const workflowsGate = supports(agent, 'workflows', version);
  const trustedWorkflowNames = (names: string[]): string[] => {
    if (names.length === 0) return [];
    const installedWorkflowNames = new Set(listInstalledWorkflows().keys());
    return names.filter((name) => installedWorkflowNames.has(name));
  };
  const workflowsRequested = selection
    ? trustedWorkflowNames(resolveSelection(selection.workflows, available.workflows))
    : (workflowsWriter ? trustedWorkflowNames(available.workflows) : []);
  const workflowsToSync = workflowsGate.ok ? workflowsRequested : [];

  if (workflowsRequested.length > 0 && !workflowsGate.ok) {
    console.warn(explainSkip(agent, 'workflows', workflowsGate, version) + ' -- skipped');
  }

  if (workflowsToSync.length > 0 && workflowsWriter) {
    const r = workflowsWriter.write({ version, versionHome, selection: workflowsToSync, cwd });
    result.workflows.push(...r.synced);
  }

  // Knowledge memory (RUSH-1330) — distinct from selection.memory which still
  // means the composed *rules* file. Always fan out ~/.agents/memory/ facts
  // into capable agent version homes on every full or partial sync.
  if (supports(agent, 'memory', version).ok) {
    syncMemoryToVersionHome(agent, versionHome, cwd);
  }

  // Claude's native per-project auto-memory (.claude/projects/<key>/memory/, PHNX-2817) is
  // unmanaged. Make it version-independent via a shared symlink, as project rules are, so notes
  // survive a version upgrade.
  if (agent === 'claude') {
    syncClaudeProjectMemoryDir(versionHome, cwd);
  }

  // RUSH-2438: prune resources deleted from source, only on a repo-scope reconcile with a caller
  // selection (a full sync sweeps already; additive selections must delete nothing). Manifest-
  // bounded and gone from all layers; no manifest means fail loud.
  if (options.prune && userPassedSelection) {
    const previousManifest = loadManifest(agent, version);
    const outcome = pruneRemovedResources({
      agent,
      version,
      versionHome,
      cwd,
      previousManifest,
      sourceNames: {
        commands: available.commands,
        skills: available.skills,
      },
    });
    result.pruned = outcome.pruned;
    if (outcome.skippedNoManifest) {
      console.warn(
        `agents: prune skipped for ${agent}@${version} — no sync manifest yet, so no removed resources were pruned. ` +
        `Run 'agents sync ${agent}@${version}' (a full sync) to establish the baseline.`,
      );
    }
  }

  // Write the manifest after a full sync so the next launch skips the slow path. Pattern-derived
  // selections count as full. Carry forward still-fresh fingerprints to avoid re-hashing an
  // unchanged tree (RUSH-2320 #3).
  if (!userPassedSelection) {
    const previous = loadManifest(agent, version);
    const manifest = buildSyncManifest(agent, version, cwd, previous);
    manifest.writtenCommands = writtenCommands;
    // Deduped + sorted so repeated full syncs write byte-identical manifests.
    manifest.writtenTargets = Array.from(new Set(writtenTargets)).sort();
    saveManifest(agent, version, manifest);
  }

  return result;
}


/** Result of resolving agent/version targets from CLI input or interactive selection. */
export interface VersionSelectionResult {
  selectedAgents: AgentId[];
  versionSelections: Map<AgentId, string[]>;
}

/** Extended target result that distinguishes managed versions from direct (unmanaged) agent homes. */
export interface InstalledAgentTargetResult {
  selectedAgents: AgentId[];
  directAgents: AgentId[];
  versionSelections: Map<AgentId, string[]>;
}

/** Thrown when an `agent@version` target is not installed; carries the parsed ids so callers can react without parsing the message. */
export class VersionNotInstalledError extends Error {
  constructor(
    public readonly agentId: AgentId,
    public readonly version: string,
    public readonly installedVersions: readonly string[]
  ) {
    const installed = installedVersions.length > 0 ? installedVersions.join(', ') : '(none)';
    super(`Version ${version} is not installed for ${AGENTS[agentId].name}. Installed versions: ${installed}`);
    this.name = 'VersionNotInstalledError';
  }
}

/** Resolve a comma-separated `--agents` list into concrete installed version selections. */
export function resolveAgentVersionTargets(
  value: string,
  availableAgents: readonly AgentId[],
  options: { allVersions?: boolean } = {}
): VersionSelectionResult {
  const selectedAgents: AgentId[] = [];
  const versionSelections = new Map<AgentId, string[]>();
  const explicitSelections = new Set<AgentId>();
  const rawTargets = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  // Expand literal `all` (with optional @all) into every available agent's all
  // installed versions. Skip agents with no installed versions so `all` is
  // lenient — only explicit `claude@all` errors when claude isn't installed.
  const targets: string[] = [];
  for (const t of rawTargets) {
    if (t === 'all' || t === 'all@all') {
      for (const a of availableAgents) {
        if (listInstalledVersions(a).length > 0) {
          targets.push(`${a}@all`);
        }
      }
    } else {
      targets.push(t);
    }
  }

  for (const target of targets) {
    const atIndex = target.indexOf('@');
    const agentToken = (atIndex === -1 ? target : target.slice(0, atIndex)).trim();
    const versionToken = atIndex === -1 ? null : target.slice(atIndex + 1).trim();

    if (!agentToken) {
      continue;
    }

    if (atIndex !== -1 && !versionToken) {
      throw new Error(`Missing version in --agents entry '${target}'. Use agent@x.y.z, agent@default, or agent@all.`);
    }

    const agentId = resolveAgentName(agentToken);
    if (!agentId || !availableAgents.includes(agentId)) {
      throw new Error(formatAgentError(agentToken, [...availableAgents]));
    }

    if (!selectedAgents.includes(agentId)) {
      selectedAgents.push(agentId);
    }

    if (explicitSelections.has(agentId) && !versionToken) {
      continue;
    }

    const installedVersions = listInstalledVersions(agentId);
    const defaultVersion = getGlobalDefault(agentId);

    if (!versionToken) {
      if (installedVersions.length === 0) {
        continue;
      }

      versionSelections.set(
        agentId,
        options.allVersions
          ? [...installedVersions]
          : [defaultVersion || installedVersions[installedVersions.length - 1]]
      );
      continue;
    }

    if (installedVersions.length === 0) {
      throw new Error(`No managed versions are installed for ${AGENTS[agentId].name}. Run: agents add ${agentId}@latest`);
    }

    if (versionToken === 'default') {
      if (!defaultVersion) {
        throw new Error(`No default version set for ${AGENTS[agentId].name}. Run: agents use ${agentId}@<version>`);
      }

      const explicitVersions = explicitSelections.has(agentId)
        ? (versionSelections.get(agentId) || [])
        : [];

      if (!explicitVersions.includes(defaultVersion)) {
        explicitVersions.push(defaultVersion);
      }
      versionSelections.set(agentId, explicitVersions);
      explicitSelections.add(agentId);
      continue;
    }

    if (versionToken === 'all') {
      versionSelections.set(agentId, [...installedVersions]);
      explicitSelections.add(agentId);
      continue;
    }

    if (!installedVersions.includes(versionToken)) {
      throw new VersionNotInstalledError(agentId, versionToken, installedVersions);
    }

    const explicitVersions = explicitSelections.has(agentId)
      ? (versionSelections.get(agentId) || [])
      : [];

    if (!explicitVersions.includes(versionToken)) {
      explicitVersions.push(versionToken);
    }
    versionSelections.set(agentId, explicitVersions);
    explicitSelections.add(agentId);
  }

  return { selectedAgents, versionSelections };
}

/** Resolve a comma-separated `--agents` list into install/apply targets, distinguishing managed versions from direct homes. */
export function resolveInstalledAgentTargets(
  value: string,
  availableAgents: readonly AgentId[],
  options: { allVersions?: boolean } = {}
): InstalledAgentTargetResult {
  const selectedAgents: AgentId[] = [];
  const directAgents: AgentId[] = [];
  const versionSelections = new Map<AgentId, string[]>();
  const rawTargets = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  // Expand literal `all` (optionally @all) into every available agent's installed versions. Skip
  // agents with none so `all` stays lenient; only explicit `claude@all` errors. Mirrors
  // resolveAgentVersionTargets.
  const targets: string[] = [];
  for (const t of rawTargets) {
    if (t === 'all' || t === 'all@all') {
      for (const a of availableAgents) {
        if (listInstalledVersions(a).length > 0) {
          targets.push(`${a}@all`);
        }
      }
    } else {
      targets.push(t);
    }
  }

  const addVersionTarget = (agentId: AgentId, version: string) => {
    const versions = versionSelections.get(agentId) || [];
    if (!versions.includes(version)) {
      versions.push(version);
      versionSelections.set(agentId, versions);
    }

    const directIndex = directAgents.indexOf(agentId);
    if (directIndex !== -1) {
      directAgents.splice(directIndex, 1);
    }
  };

  for (const target of targets) {
    const atIndex = target.indexOf('@');
    const agentToken = (atIndex === -1 ? target : target.slice(0, atIndex)).trim();
    const versionToken = atIndex === -1 ? null : target.slice(atIndex + 1).trim();

    if (!agentToken) {
      continue;
    }

    if (atIndex !== -1 && !versionToken) {
      throw new Error(`Missing version in --agents entry '${target}'. Use agent@x.y.z, agent@default, or agent@all.`);
    }

    const agentId = resolveAgentName(agentToken);
    if (!agentId || !availableAgents.includes(agentId)) {
      throw new Error(formatAgentError(agentToken, [...availableAgents]));
    }

    if (!selectedAgents.includes(agentId)) {
      selectedAgents.push(agentId);
    }

    const installedVersions = listInstalledVersions(agentId);
    const defaultVersion = getGlobalDefault(agentId);

    if (!versionToken) {
      if (installedVersions.length === 0) {
        if (!directAgents.includes(agentId)) {
          directAgents.push(agentId);
        }
        continue;
      }

      const targetVersions = options.allVersions
        ? [...installedVersions]
        : [defaultVersion || installedVersions[installedVersions.length - 1]];

      for (const version of targetVersions) {
        addVersionTarget(agentId, version);
      }
      continue;
    }

    if (versionToken === 'default') {
      if (!defaultVersion) {
        throw new Error(`No default version set for ${AGENTS[agentId].name}. Run: agents use ${agentId}@<version>`);
      }
      addVersionTarget(agentId, defaultVersion);
      continue;
    }

    if (versionToken === 'all') {
      if (installedVersions.length === 0) {
        throw new Error(`No managed versions are installed for ${AGENTS[agentId].name}. Run: agents add ${agentId}@latest`);
      }
      for (const version of installedVersions) {
        addVersionTarget(agentId, version);
      }
      continue;
    }

    if (installedVersions.length === 0) {
      throw new Error(`No managed versions are installed for ${AGENTS[agentId].name}. Run: agents add ${agentId}@latest`);
    }

    if (!installedVersions.includes(versionToken)) {
      throw new VersionNotInstalledError(agentId, versionToken, installedVersions);
    }

    addVersionTarget(agentId, versionToken);
  }

  return { selectedAgents, directAgents, versionSelections };
}

/** Resolve configured manifest targets into direct homes and managed versions. */
export function resolveConfiguredAgentTargets(
  agents: readonly AgentId[] | undefined,
  agentVersions: Partial<Record<AgentId, string[]>> | undefined,
  availableAgents: readonly AgentId[],
  options: { allVersions?: boolean } = {}
): InstalledAgentTargetResult {
  const targetSpecs: string[] = [];
  const broadTargets = agents ? [...agents] : [...availableAgents];

  for (const agentId of broadTargets) {
    if (availableAgents.includes(agentId)) {
      targetSpecs.push(agentId);
    }
  }

  if (agentVersions) {
    for (const [agentId, versions] of Object.entries(agentVersions) as Array<[AgentId, string[] | undefined]>) {
      if (!availableAgents.includes(agentId) || !versions) continue;
      for (const version of versions) {
        targetSpecs.push(`${agentId}@${version}`);
      }
    }
  }

  if (targetSpecs.length === 0) {
    return {
      selectedAgents: [],
      directAgents: [],
      versionSelections: new Map(),
    };
  }

  return resolveInstalledAgentTargets(targetSpecs.join(','), availableAgents, options);
}

/** Prompt the user to select agents and versions for resource installation. */
export async function promptAgentVersionSelection(
  availableAgents: AgentId[],
  options: { skipPrompts?: boolean } = {}
): Promise<VersionSelectionResult> {
  const versionSelections = new Map<AgentId, string[]>();

  // Filter to installed agents (only those with versions managed by agents CLI)
  const installedAgents = availableAgents.filter((id) => {
    const versions = listInstalledVersions(id);
    return versions.length > 0;
  });

  if (installedAgents.length === 0) {
    return { selectedAgents: [], versionSelections };
  }

  const formatAgentLabel = (agentId: AgentId): string => {
    const versions = listInstalledVersions(agentId);
    const defaultVer = getGlobalDefault(agentId);
    if (versions.length === 0) return `${AGENTS[agentId].name}  ${chalk.gray('(not installed)')}`;
    // Surface the version count when there's more than one — mirrors the new
    // `--agents <agent>@all` syntax so users can see at a glance how many
    // versions `@all` would target before the per-version prompt fires.
    const detail = versions.length > 1
      ? (defaultVer
        ? `active: ${defaultVer}, ${versions.length} versions installed`
        : `${versions.length} versions installed`)
      : (defaultVer ?? versions[0]);
    return `${AGENTS[agentId].name}  ${chalk.gray(`(${detail})`)}`;
  };

  let selectedAgents: AgentId[];

  if (options.skipPrompts) {
    // Auto-select all installed agents with default versions
    selectedAgents = [...installedAgents];
    for (const agentId of selectedAgents) {
      const versions = listInstalledVersions(agentId);
      if (versions.length > 0) {
        const defaultVer = getGlobalDefault(agentId);
        versionSelections.set(agentId, defaultVer ? [defaultVer] : [versions[versions.length - 1]]);
      }
    }
  } else {
    // Non-TTY without an explicit --agents value used to silently fall through
    // to default-picking inside the caller. That's surprising in scripts — fail
    // loud and point at the new `--agents` syntax instead.
    if (!(process.stdin.isTTY && process.stdout.isTTY)) {
      throw new Error(
        'Non-interactive shell: cannot prompt for agent/version selection.\n' +
        'Pass --agents explicitly. Examples:\n' +
        '  --agents claude              (default version)\n' +
        '  --agents claude@all          (every installed Claude version)\n' +
        '  --agents claude@2.1.141      (a specific version)\n' +
        '  --agents all                 (every installed version of every capable agent)\n' +
        'Or pass --yes to auto-pick defaults.'
      );
    }
    // Prompt for agent selection
    const checkboxResult = await checkbox<string>({
      message: 'Which agents should receive these resources?',
      choices: [
        { name: chalk.bold('All'), value: 'all', checked: true },
        ...installedAgents.map((id) => ({
          name: `  ${formatAgentLabel(id)}`,
          value: id,
          checked: false,
        })),
      ],
    });

    if (checkboxResult.includes('all')) {
      selectedAgents = [...installedAgents];
    } else {
      selectedAgents = checkboxResult as AgentId[];
    }

    // Version selection per agent
    for (const agentId of selectedAgents) {
      const versions = listInstalledVersions(agentId);
      if (versions.length === 0) continue;
      if (versions.length === 1) {
        versionSelections.set(agentId, [versions[0]]);
        continue;
      }

      const defaultVer = getGlobalDefault(agentId);
      const versionEmails = await Promise.all(
        versions.map((v) =>
          getAccountEmail(agentId, getVersionHomePath(agentId, v)).then((email) => ({ v, email }))
        )
      );
      const versionEmailMap = new Map(versionEmails.map((e) => [e.v, e.email]));

      const maxLabelLen = Math.max(...versions.map((v) => (v === defaultVer ? `${v} (default)` : v).length));
      const versionResult = await checkbox<string>({
        message: `Which versions of ${AGENTS[agentId].name} should receive these resources?`,
        choices: [
          { name: chalk.bold(`All versions (${versions.length})`), value: 'all', checked: false },
          ...versions.map((v) => {
            const base = v === defaultVer ? `${v} (default)` : v;
            let label = base.padEnd(maxLabelLen);
            const email = versionEmailMap.get(v);
            if (email) label += chalk.cyan(`  ${email}`);
            return { name: label, value: v, checked: v === defaultVer };
          }),
        ],
      });

      if (versionResult.includes('all')) {
        versionSelections.set(agentId, [...versions]);
      } else {
        versionSelections.set(agentId, versionResult);
      }
    }
  }

  return { selectedAgents, versionSelections };
}
