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

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const RULES_DOC_FILENAME = 'README.md';


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
          } catch {  }
        }
        if (scripts.length > 0) {
          for (const s of scripts) hookNames.add(s);
        } else {
          hookNames.add(name);
        }
      } catch {  }
    }
  }
  result.hooks = filterNamesForActiveResourceProfile('hooks', Array.from(hookNames), sourceMapFromResources('hooks', cwd));

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

  result.promptcuts = fs.existsSync(getUserPromptcutsPath()) || fs.existsSync(getPromptcutsPath());

  return result;
}

const SKILL_COPY_IGNORE = new Set(['.DS_Store', '.git', '.gitignore', '.venv', '__pycache__', 'node_modules']);

function shouldSkillEntryBeSkipped(name: string): boolean {
  return SKILL_COPY_IGNORE.has(name);
}

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
      let srcStat: fs.Stats;
      let destStat: fs.Stats;
      try {
        srcStat = fs.statSync(srcPath);
        destStat = fs.statSync(destPath);
      } catch {
        return false;
      }
      if (srcStat.size !== destStat.size) return false;
      if (!fs.readFileSync(srcPath).equals(fs.readFileSync(destPath))) return false;
    }
  }
  return true;
}

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

export interface ProjectOnlyResources {
  commands: Set<string>;
  skills: Set<string>;
  hooks: Set<string>;
  subagents: Set<string>;
  plugins: Set<string>;
  workflows: Set<string>;
}

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
      } catch {  }
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
    memory: actuallySynced.memory.length > 0
      ? []
      : available.memory.filter(m => !actuallySynced.memory.includes(m)),
    mcp: available.mcp.filter(m => !actuallySynced.mcp.includes(m)),
    permissions: available.permissions.filter(p => !actuallySynced.permissions.includes(p)),
    subagents: available.subagents.filter(s => !actuallySynced.subagents.includes(s) && !exclude.subagents.has(s)),
    plugins: available.plugins.filter(p => !actuallySynced.plugins.includes(p) && !exclude.plugins.has(p)),
    workflows: available.workflows.filter(w => !actuallySynced.workflows.includes(w) && !exclude.workflows.has(w)),
    promptcuts: false,
  };
}

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

function buildNewResourcesSummary(newResources: AvailableResources, agent: AgentId, version?: string): string {
  const agentConfig = AGENTS[agent];
  const parts: string[] = [];

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

export async function promptNewResourceSelection(
  agent: AgentId,
  newResources: AvailableResources,
  version?: string
): Promise<ResourceSelection | null> {
  const agentConfig = AGENTS[agent];
  const selection: ResourceSelection = {};

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

export async function promptResourceSelection(agent: AgentId): Promise<ResourceSelection | null> {
  const available = getAvailableResources();
  const agentConfig = AGENTS[agent];
  const selection: ResourceSelection = {};

  const permissionGroups = discoverPermissionGroups();
  const totalPermissionRules = permissionGroups.reduce((sum, g) => sum + g.ruleCount, 0);

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
        checked: true,
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
  }

  return selection;
}

export interface AgentSpec {
  agent: AgentId;
  version: string;
}

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
    const versions: string[] = Array.isArray(parsed) ? parsed : [parsed];
    const sorted = versions.filter((v) => VERSION_RE.test(v)).sort(compareVersions);
    return sorted[0] ?? null;
  } catch {
    return null;
  }
}

export async function isLatestInstalled(agent: AgentId): Promise<{ installed: boolean; version: string | null }> {
  const latestVersion = await getLatestNpmVersion(agent);
  if (!latestVersion) {
    return { installed: false, version: null };
  }
  return { installed: isVersionInstalled(agent, latestVersion), version: latestVersion };
}

export async function isOldestInstalled(agent: AgentId): Promise<{ installed: boolean; version: string | null }> {
  const oldestVersion = await getOldestNpmVersion(agent);
  if (!oldestVersion) {
    return { installed: false, version: null };
  }
  return { installed: isVersionInstalled(agent, oldestVersion), version: oldestVersion };
}


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


export function setGlobalDefault(agent: AgentId, version: string | undefined): void {
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
    }
  }

  return true;
}

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
    if (path.resolve(candidate) === path.resolve(sourceDownloads)) continue;
    if (transferGrokDownloads(candidate, targetDownloads, copyExisting)) return;
  }
}

async function checkGrokAccountCollision(installedVersion: string): Promise<void> {
  const targetHome = getVersionHomePath('grok', installedVersion);
  if (!fs.existsSync(targetHome)) return;

  const sourceVersion = getGlobalDefault('grok');
  if (!sourceVersion || sourceVersion === installedVersion) return;

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

  if (!VERSION_RE.test(version)) {
    throw new Error(`Invalid version: ${JSON.stringify(version)}`);
  }

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
        await reconcileStaleLatestDir(agent, releaseVersion);
      }

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

    if (agent === 'grok') {
      relocateGrokBinaryToVersionHome(installationLabel, !runInstaller);
    }

    if (agent !== 'grok' && agent !== 'droid' && agent !== 'muse' && agent !== 'warp') {
      const installedBinary = findInPath(agentConfig.cliCommand);
      if (installedBinary) {
        importInstallScriptBinary(
          { agentId: agent, npmPackage: agentConfig.npmPackage, cliCommand: agentConfig.cliCommand },
          installationLabel,
          installedBinary,
          versionDir
        );
      }
    }

    createVersionedAlias(agent, installationLabel);
    createInstallation(agent, installationLabel, releaseVersion, initialUpdatePolicy);
    const trackerInstall = await installSessionTrackerHook(agent, installationLabel);
    if (!trackerInstall.installed && trackerInstall.error) {
      console.warn(`agents: SessionStart hook not installed for ${agent}@${installationLabel}: ${trackerInstall.error}`);
    }
    invalidateLiveVersionCache(agent);
    emit('version.install', { agent, version: installationLabel });
    return { success: true, installedVersion: installationLabel };
  }

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

  const releaseVersion = version;
  const label = opts?.installationLabel ?? releaseVersion;

  ensureAgentsDir();
  const versionDir = getVersionDir(agent, label);

  return withFileLockAsync(installationLockTarget(agent, label), async () => {
  if (await isInstallationLikelyActive({ agent, label })) {
    return { success: false, installedVersion: label, error: `${agent} account home ${label} is in use. Retry after its sessions finish.` };
  }

  if (opts?.clean && fs.existsSync(versionDir)) {
    removeInstallArtifacts(versionDir);
  }

  fs.mkdirSync(versionDir, { recursive: true });
  fs.mkdirSync(path.join(versionDir, 'home'), { recursive: true });

  const packageJson = {
    name: `agents-${agent}-${version}`,
    version: '1.0.0',
    private: true,
  };
  fs.writeFileSync(path.join(versionDir, 'package.json'), JSON.stringify(packageJson, null, 2));

  const packageSpec = `${agentConfig.npmPackage}@${version}`;

  let healthyVersion: string;

  try {
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

    const installedVersion = label;

    createVersionedAlias(agent, installedVersion);

    if (agent === 'claude') {
      try {
        ensureClaudeInsideSymlink(installedVersion);
      } catch {
      }
    }

    if (agentConfig.npmPackage) {
      const pkgRoot = path.join(versionDir, 'node_modules', agentConfig.npmPackage);
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf-8'));
        const postinstall = pkg?.scripts?.postinstall;
        if (typeof postinstall === 'string' && postinstall.trim()) {
          onProgress?.(`Running ${agentConfig.name} postinstall...`);
          await execFileAsync(postinstall, [], { cwd: pkgRoot, shell: true });
        }
      } catch {
      }
    }

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

    healthyVersion = installedVersion;
  } catch (err) {
    if (fs.existsSync(versionDir)) {
      removeInstallArtifacts(versionDir);
    }
    emit('version.install', { agent, version, error: (err as Error).message });
    return { success: false, installedVersion: version, error: (err as Error).message };
  }

  createInstallation(agent, healthyVersion, releaseVersion, initialUpdatePolicy);
  const trackerInstall = await installSessionTrackerHook(agent, healthyVersion);
  if (!trackerInstall.installed && trackerInstall.error) {
    console.warn(`agents: SessionStart hook not installed for ${agent}@${healthyVersion}: ${trackerInstall.error}`);
  }
  emit('version.install', { agent, version: healthyVersion });
  return { success: true, installedVersion: healthyVersion };
  }, { ...INSTALLATION_LOCK_OPTIONS, realpath: false });
}

const PRESERVED_ON_CLEAN_REINSTALL = new Set(['home', '.isolated', '.launch-leases', INSTALLATION_RECORD_FILE, `${INSTALLATION_RECORD_FILE}.lock`]);

function removeInstallArtifacts(versionDir: string): void {
  for (const entry of fs.readdirSync(versionDir)) {
    if (PRESERVED_ON_CLEAN_REINSTALL.has(entry) || entry.startsWith('.rollback-')) continue;
    fs.rmSync(path.join(versionDir, entry), { recursive: true, force: true });
  }
}

export async function reconcileStaleLatestForAgent(agent: AgentId): Promise<void> {
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

async function reconcileGlobalBinaryVersions(agent: AgentId): Promise<void> {
  if (fs.existsSync(getVersionDir(agent, 'latest')) && getConfigSymlinkVersion(agent) !== 'latest') {
    const concrete = await getCliVersionFromPath(agent);
    if (concrete && concrete !== 'latest') {
      await reconcileStaleLatestDir(agent, concrete);
    }
  }

  const agentVersionsDir = path.join(getVersionsDir(), agent);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agentVersionsDir, { withFileTypes: true });
  } catch {
    return;
  }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort(compareVersions);
  if (dirs.length <= 1) return;

  await getLiveVersion(agent);
  const survivor = pickCanonicalGlobalBinaryVersion(agent, dirs);
  const symlinkVersion = getConfigSymlinkVersion(agent);

  let foldedAny = false;
  for (const version of dirs) {
    if (version === survivor) continue;
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

  const trashPath = softDeleteVersionDir(agent, 'latest');
  if (trashPath) {
    const { updateSessionFilePaths } = await import('../session/db.js');
    updateSessionFilePaths(staleLatestDir, trashPath);
  }
  return 'trashed';
}

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
      if ((renameErr as NodeJS.ErrnoException).code !== 'EPERM' && (renameErr as NodeJS.ErrnoException).code !== 'EACCES') throw renameErr;
      fs.cpSync(versionDir, trashDest, { recursive: true });
      fs.rmSync(versionDir, { recursive: true, force: true });
    }
    return trashDest;
  } catch {
    return null;
  }
}

export function removeVersion(agent: AgentId, version: string): boolean {
  const versionDir = getVersionDir(agent, version);

  if (!fs.existsSync(versionDir)) {
    return false;
  }

  const trashPath = softDeleteVersionDir(agent, version);
  if (!trashPath) {
    return false;
  }

  removeVersionedAlias(agent, version);

  if (getGlobalDefault(agent) === version) {
    const remaining = listInstalledVersions(agent);
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

  if (getIsolatedDefault(agent) === version) {
    const survivors = listInstalledVersions(agent).filter((v) => isVersionIsolated(agent, v));
    setIsolatedDefault(agent, survivors.length > 0 ? survivors[survivors.length - 1] : undefined);
  }

  const symlinkVersion = getConfigSymlinkVersion(agent);
  if (symlinkVersion === version) {
    const configPath = path.join(getHomeDir(), agentConfigDirName(agent));
    try {
      fs.unlinkSync(configPath);
    } catch {
    }
  }

  if (agent === 'claude' || agent === 'droid') {
    const configDir = agentConfigDirName(agent);
    for (const remaining of listInstalledVersions(agent)) {
      const settingsPath = path.join(getVersionHomePath(agent, remaining), configDir, 'settings.json');
      pruneVersionHomeHookEntriesFromSettings(settingsPath, agent, version);
    }
  }

  try {
    repairManagedHookRuntimeArtifacts();
  } catch (err) {
    console.warn(`hook shim repair after removing ${agent}@${version} failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  emit('version.remove', { agent, version });
  return true;
}

export function printTrashFooter(moved: Array<{ agent: AgentId; version: string }>): void {
  if (moved.length === 0) return;
  console.log();
  console.log(chalk.gray('Sessions remain accessible via `agents sessions`.'));
  if (moved.length === 1) {
    const { agent, version } = moved[0];
    console.log(chalk.gray(`Restore with: agents trash restore ${agent}@${version}`));
  } else {
    console.log(chalk.gray('Restore with: agents trash restore <agent>@<version>  (run `agents trash list` to see)'));
  }
}

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
  globalDefault?: { from: string; to: string | null };
  isolatedDefault?: { from: string; to: string | null };
  configSymlink?: { from: string; to: string };
}

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

export function resolveVersionAliasLoose(agent: AgentId, raw: string | undefined | null): string | undefined {
  if (!raw || raw === 'default' || raw === 'pinned' || raw === 'any') return undefined;
  if (raw === 'latest' || raw === 'oldest') {
    const installed = listInstalledVersions(agent);
    if (installed.length === 0) return undefined;
    return raw === 'oldest' ? installed[0] : installed[installed.length - 1];
  }
  return raw;
}


export { compareVersions };

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

export function isMissingBinarySignature(output: string): boolean {
  return /\bENOENT\b|no such file|cannot find|command not found|is not recognized|native binary not installed|postinstall did not run|optional dependency was not downloaded/i.test(output);
}

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

export async function verifyBinaryLaunches(
  posixBinary: string,
  home: string,
): Promise<{ ok: boolean; detail?: string }> {
  const isWin = process.platform === 'win32';
  const binary = isWin ? posixBinary + '.cmd' : posixBinary;
  if (!fs.existsSync(binary)) {
    return isWin ? { ok: true } : { ok: false, detail: `binary not found at ${binary}` };
  }
  try {
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
    return { ok: true };
  }
}

export async function ensureAgentRunnable(
  agent: AgentId,
  version: string,
  log?: (message: string) => void,
  opts?: { allowDefaultSwitch?: boolean },
): Promise<string | null> {
  const allowDefaultSwitch = opts?.allowDefaultSwitch ?? true;
  const cfg = AGENTS[agent];
  if (!cfg?.npmPackage) return version;

  if ((await verifyInstalledBinaryLaunches(agent, version)).ok) return version;

  const targetIsolated = isVersionIsolated(agent, version);

  log?.(`${cfg.name}@${version} is broken (platform binary missing) — repairing…`);
  const record = readInstallation(agent, version);
  const repair = await installVersion(agent, record?.releaseVersion ?? version, undefined, { clean: true, installationLabel: version });
  if (repair.success && (await verifyInstalledBinaryLaunches(agent, version)).ok) {
    log?.(`repaired ${cfg.name}@${version}.`);
    return version;
  }

  if (targetIsolated || (record && record.label !== record.releaseVersion)) {
    log?.(`${cfg.name}@${version} is an isolated install and could not be repaired — leaving your default ${cfg.name} untouched.`);
    return null;
  }

  if (!allowDefaultSwitch) {
    log?.(`${cfg.name}@${version} won't launch and could not be repaired in place — NOT repointing your default ${cfg.name} unattended. Run \`agents use ${agent} <version>\` or \`agents add ${agent}@latest\` to choose one.`);
    return null;
  }

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

  const latestVersion = await getLatestNpmVersion(agent);
  if (latestVersion && isVersionIsolated(agent, latestVersion)) {
    log?.(`no runnable ${cfg.name} version installed — ${cfg.name}@${latestVersion} is the latest, but you hold it as an isolated copy, so it can't become your default.`);
    log?.(`install one explicitly: agents add ${agent}@latest`);
    return null;
  }

  log?.(`no runnable ${cfg.name} version installed — installing ${cfg.name}@latest…`);
  const latest = await installVersion(agent, 'latest', undefined, { clean: true });
  if (latest.success) {
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

const failedRepairAt = new Map<string, number>();
const REPAIR_COOLDOWN_MS = 24 * 60 * 60_000;

export async function healBrokenDefaultLaunches(
  log?: (m: string) => void,
  opts?: { allowDefaultSwitch?: boolean },
): Promise<{ repaired: string[]; unhealed: string[] }> {
  const repaired: string[] = [];
  const unhealed: string[] = [];
  for (const agent of Object.keys(AGENTS) as AgentId[]) {
    if (!AGENTS[agent].npmPackage) continue;
    const version = getGlobalDefault(agent);
    if (!version) continue;
    if ((await verifyInstalledBinaryLaunches(agent, version)).ok) continue;
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
  projectSkipped: string[];
  pruned: Record<PrunableKind, string[]>;
  declined: string[];
}

export function listRepoNames(): string[] {
  return ['project', 'user', 'system', ...getEnabledExtraRepos().map(e => e.alias)];
}

type SelectableKind = 'commands' | 'skills' | 'hooks' | 'subagents' | 'permissions' | 'mcp' | 'plugins' | 'workflows';

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

export function buildSelection(
  patterns: string[],
  kindFilter?: ResourceSelection,
  cwd: string = process.cwd(),
): ResourceSelection {
  const hasPatterns = patterns.length > 0;
  const hasKindFilter = kindFilter !== undefined;

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

    if (hasKindFilter && filterVal === undefined) continue;

    if (hasPatterns) {
      const sourceMap = resourceSourceMap(kind, cwd, available!);
      const patternNames = expandPatterns(patterns, sourceMap);
      if (patternNames.length === 0) continue;

      if (!filterVal || filterVal === 'all') {
        selection[kind] = patternNames;
      } else {
        const filterSet = new Set(filterVal as string[]);
        const intersected = patternNames.filter(n => filterSet.has(n));
        if (intersected.length > 0) selection[kind] = intersected;
      }
    } else {
      selection[kind] = filterVal === 'all' || !filterVal ? 'all' : (filterVal as string[]);
    }
  }

  const memoryRequested = hasPatterns || kindFilter?.memory !== undefined || !hasKindFilter;
  if (memoryRequested) selection.memory = 'all';

  return selection;
}

export function buildRepoScopedSelection(repo: string, cwd: string = process.cwd()): ResourceSelection {
  return buildSelection([`${repo}:*`], undefined, cwd);
}

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

export function mergeRepoScopedSelections(repos: string[], cwd: string = process.cwd()): ResourceSelection {
  const includeMemory = repos.includes('user') || repos.includes('system');
  return unionResourceSelections(repos.map((r) => buildRepoScopedSelection(r, cwd)), includeMemory);
}

export function resolveHookSelection(sel: string[] | 'all' | undefined, available: string[]): string[] {
  if (sel === 'all') return available;
  if (!Array.isArray(sel)) return [];
  const stripExt = (n: string): string => n.replace(/\.[^./\\]+$/, '');
  const exact = new Set(available);
  const byBase = new Map<string, string>();
  for (const a of available) {
    const base = stripExt(a);
    if (!byBase.has(base)) byBase.set(base, a);
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
  const userPassedSelection = selection !== undefined;

  const result: SyncResult = { commands: false, skills: false, hooks: false, memory: [], permissions: false, mcp: [], subagents: [], plugins: [], workflows: [], projectSkipped: [], pruned: { commands: [], skills: [] }, declined: [] };
  const cwd = options.cwd || process.cwd();
  const projectAgentsDir = options.projectDir || getProjectAgentsDir(cwd);
  const userAgentsDir = getUserAgentsDir();
  const extraRepos = getEnabledExtraRepos();

  if (projectAgentsDir) {
    result.projectSkipped = syncProjectResourcesToAgent(agent, version, projectAgentsDir).skipped;
  }

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

  if (!userPassedSelection && !options.force) {
    const manifest = loadManifest(agent, version);
    if (manifest && !isStale(manifest, agent, version, cwd)) {
      return { ...result };
    }
  }

  const available = options.available ?? getAvailableResources(cwd);

  {
    const extraAliases = extraRepos.map(e => e.alias);
    const noProject = defaultPatterns(extraAliases, false);
    ensureVersionResourcePatterns(agent, version, {
      commands:    noProject,
      skills:      noProject,
      hooks:       noProject,
      subagents:   noProject,
      plugins:     noProject,
      workflows:   noProject,
      permissions: ['system:*'],
      mcp:         ['user:*'],
    });
  }

  if (!selection) {
    const vr = getVersionResources(agent, version);
    if (vr) {
      const patternSelection: ResourceSelection = {};

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

      patternSelection.memory = 'all';

      if (Object.keys(patternSelection).length > 0) {
        selection = patternSelection;
      }
    }
  }

  const removePath = (p: string) => {
    try {
      const stat = fs.lstatSync(p);
      if (stat.isSymbolicLink() || stat.isFile()) {
        fs.unlinkSync(p);
      } else if (stat.isDirectory()) {
        fs.rmSync(p, { recursive: true, force: true });
      }
    } catch {  }
  };

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

  const resolveSelection = (sel: string[] | 'all' | undefined, available: string[]): string[] => {
    if (sel === 'all') return available;
    if (Array.isArray(sel)) {
      const availableSet = new Set(available);
      return sel.filter((item) => availableSet.has(item));
    }
    return [];
  };

  const trustedCommandNames = (names: string[]): string[] => names.filter((name) => resolveCommandSource(name) !== null);

  const commandsWriter = getWriter('commands', agent);
  const commandsToSync = selection
    ? trustedCommandNames(resolveSelection(selection.commands, available.commands))
    : trustedCommandNames(available.commands);
  const commandsAsSkills = shouldInstallCommandAsSkill(agent, version);
  const commandsAlsoAsSkills = shouldAlsoInstallCommandAsSkill(agent, version);
  const commandsInstallAsSkills = commandsAsSkills || commandsAlsoAsSkills;
  let writtenCommands: string[] = [];
  const writtenTargets: string[] = [];

  if (commandsToSync.length > 0 && commandsWriter) {
    if (commandsAsSkills && agentConfig.commandsSubdir) {
      removePath(path.join(agentDir, agentConfig.commandsSubdir));
    }

    const r = commandsWriter.write({ version, versionHome, selection: commandsToSync, cwd });
    writtenCommands = r.synced;
    if (r.paths) writtenTargets.push(...r.paths);
    result.commands = r.synced.length > 0;
  }

  if (!userPassedSelection && commandsWriter && !shouldInstallCommandAsSkill(agent, version)) {
    const commandsTargetSweep = path.join(agentDir, agentConfig.commandsSubdir);
    if (fs.existsSync(commandsTargetSweep)) {
      const ext = agentConfig.format === 'toml' ? '.toml' : '.md';
      const trustedCommands = new Set(commandsToSync);
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

    const skillsTargetSweep = path.join(agentDir, 'skills');
    if (!userPassedSelection && fs.existsSync(skillsTargetSweep) && !fs.lstatSync(skillsTargetSweep).isSymbolicLink()) {
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

  const hooksGate = supports(agent, 'hooks', version);
  const hooksWriter = getWriter('hooks', agent);
  if (agentConfig.supportsHooks && hooksWriter) {
    if (!hooksGate.ok) {
      console.warn(explainSkip(agent, 'hooks', hooksGate, version) + ' -- skipped');
    } else {
      const hooksToSync = selection
        ? resolveHookSelection(selection.hooks, available.hooks)
        : available.hooks;

      let hookManifest: ReturnType<typeof parseHookManifest> = {};
      if (hooksToSync.length > 0) {
        const r = hooksWriter.write({ version, versionHome, selection: hooksToSync, cwd });
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

  const skipMemory = selection && Array.isArray(selection.memory) && selection.memory.length === 0;
  const rulesWriter = getWriter('rules', agent);
  if (!skipMemory && rulesWriter) {
    try {
      const overridePreset = Array.isArray(selection?.memory) && selection!.memory.length === 1 && selection!.memory[0] !== 'AGENTS'
        ? selection!.memory[0]
        : null;
      const preset = overridePreset || activeRulesPreset() || getActiveRulesPreset(agent, version);
      const r = rulesWriter.write({ version, versionHome, selection: { preset }, cwd });
      if (r.paths) writtenTargets.push(...r.paths);
      result.memory.push(...r.synced);
    } catch (err) {
      console.warn(`Skipping rules sync for ${agent}@${version}: ${(err as Error).message}`);
    }
  }

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
  }

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
  }

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

  if (pluginsToSync.length > 0 && pluginsWriter) {
    if (options.allowExecSurfaces) {
      const allPlugins = discoverPlugins();
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

  if (supports(agent, 'memory', version).ok) {
    syncMemoryToVersionHome(agent, versionHome, cwd);
  }

  if (agent === 'claude') {
    syncClaudeProjectMemoryDir(versionHome, cwd);
  }

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

  if (!userPassedSelection) {
    const previous = loadManifest(agent, version);
    const manifest = buildSyncManifest(agent, version, cwd, previous);
    manifest.writtenCommands = writtenCommands;
    manifest.writtenTargets = Array.from(new Set(writtenTargets)).sort();
    saveManifest(agent, version, manifest);
  }

  return result;
}


export interface VersionSelectionResult {
  selectedAgents: AgentId[];
  versionSelections: Map<AgentId, string[]>;
}

export interface InstalledAgentTargetResult {
  selectedAgents: AgentId[];
  directAgents: AgentId[];
  versionSelections: Map<AgentId, string[]>;
}

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

export async function promptAgentVersionSelection(
  availableAgents: AgentId[],
  options: { skipPrompts?: boolean } = {}
): Promise<VersionSelectionResult> {
  const versionSelections = new Map<AgentId, string[]>();

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
    const detail = versions.length > 1
      ? (defaultVer
        ? `active: ${defaultVer}, ${versions.length} versions installed`
        : `${versions.length} versions installed`)
      : (defaultVer ?? versions[0]);
    return `${AGENTS[agentId].name}  ${chalk.gray(`(${detail})`)}`;
  };

  let selectedAgents: AgentId[];

  if (options.skipPrompts) {
    selectedAgents = [...installedAgents];
    for (const agentId of selectedAgents) {
      const versions = listInstalledVersions(agentId);
      if (versions.length > 0) {
        const defaultVer = getGlobalDefault(agentId);
        versionSelections.set(agentId, defaultVer ? [defaultVer] : [versions[versions.length - 1]]);
      }
    }
  } else {
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
