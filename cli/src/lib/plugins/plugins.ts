
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { execFileSync } from 'child_process';
import type { AgentId, DiscoveredPlugin, PluginManifest, MarketplaceSpec } from '../types.js';
import { getPluginsDir, getTrashPluginsDir, getExtraPluginsDir, getProjectPluginsDir, getSystemPluginsDir } from '../state.js';
import { IS_WINDOWS, isWindowsAbsolutePath, homeDir } from '../platform/index.js';
import { assertSafeGitTransport, resolveSnapshotSha } from '../git.js';
import { listInstalledVersions, getVersionHomePath } from '../installations/store.js';
import { AGENTS, agentConfigDirName } from '../agents.js';
import { capableAgents, isCapable } from '../capabilities.js';
import { shouldInstallCommandAsSkill, installCommandSkillToVersion } from '../command-skills.js';
import {
  copyPluginToMarketplace,
  syncMarketplaceManifest,
  registerMarketplace,
  unregisterMarketplace,
  addPluginToSettings,
  removePluginFromSettings,
  removePluginFromMarketplace,
  registerDroidInstalledPlugin,
  unregisterDroidInstalledPlugin,
  isDroidPluginInstalled,
  registerCopilotInstalledPlugin,
  unregisterCopilotInstalledPlugin,
  marketplaceIsEmpty,
  removeEmptyMarketplaceDir,
  isInstalledInMarketplace,
  marketplaceRoot,
  discoverMarketplaces,
  marketplaceNameFor,
  MARKETPLACE_NAME,
  PROJECT_MARKETPLACE_NAME,
  SYSTEM_MARKETPLACE_NAME,
} from './plugin-marketplace.js';

const PLUGIN_MANIFEST_DIR = '.claude-plugin';
const PLUGIN_MANIFEST_FILE = 'plugin.json';
const HERMES_PLUGIN_MANIFEST_FILE = 'plugin.yaml';
const USER_CONFIG_FILE = '.user-config.json';
const SOURCE_FILE = '.source';

export interface PluginCapabilities {
  hasHooks: boolean;
  hasMcp: boolean;
  hasBin: boolean;
  hasScripts: boolean;
  hasSettings: boolean;
  hasPermissions: boolean;
}

export const PLUGIN_EXEC_SURFACE_LABELS: Record<keyof PluginCapabilities, string> = {
  hasHooks: 'hooks/',
  hasMcp: '.mcp.json',
  hasBin: 'bin/',
  hasScripts: 'scripts/',
  hasSettings: 'settings.json',
  hasPermissions: 'permissions/',
};

function isPluginRootEntry(pluginsDir: string, entry: fs.Dirent): boolean {
  if (entry.name.startsWith('.')) return false;
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;

  try {
    return fs.statSync(path.join(pluginsDir, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

export function discoverPluginsInDir(pluginsDir: string, spec: MarketplaceSpec = { kind: 'user' }): DiscoveredPlugin[] {
  if (!fs.existsSync(pluginsDir)) {
    return [];
  }

  const plugins: DiscoveredPlugin[] = [];
  const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!isPluginRootEntry(pluginsDir, entry)) continue;

    const pluginRoot = path.join(pluginsDir, entry.name);
    const manifest = loadPluginManifest(pluginRoot);
    if (!manifest) {
      const manifestPath = path.join(entry.name, PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE);
      process.stderr.write(
        `agents-cli: '${entry.name}' in ${pluginsDir} has no valid ${manifestPath} ` +
        `(missing, malformed JSON, or missing name/version) — skipped, not discovered as a plugin.\n`
      );
      continue;
    }

    plugins.push(buildDiscoveredPlugin(pluginRoot, manifest, spec));
  }

  return plugins;
}

export function discoverPlugins(opts: { cwd?: string } = {}): DiscoveredPlugin[] {
  const out: DiscoveredPlugin[] = [];
  for (const dm of discoverMarketplaces(opts)) {
    out.push(...discoverPluginsInDir(dm.pluginsRoot, dm.spec));
  }
  return out;
}

export function buildDiscoveredPlugin(
  pluginRoot: string,
  manifest: PluginManifest,
  spec: MarketplaceSpec = { kind: 'user' }
): DiscoveredPlugin {
  const repoRoot = path.dirname(path.dirname(pluginRoot));
  return {
    name: manifest.name,
    root: pluginRoot,
    manifest,
    marketplace: marketplaceNameFor(spec),
    skills: discoverPluginSkills(pluginRoot),
    hooks: discoverPluginHooks(pluginRoot),
    scripts: discoverPluginScripts(pluginRoot),
    commands: discoverPluginCommands(pluginRoot),
    agentDefs: discoverPluginAgentDefs(pluginRoot),
    workflows: discoverPluginWorkflows(pluginRoot),
    memory: discoverPluginMemory(pluginRoot),
    bin: discoverPluginBin(pluginRoot),
    mcpServers: discoverPluginMcpServers(pluginRoot),
    lspServers: discoverPluginLspServers(pluginRoot),
    monitors: discoverPluginMonitors(pluginRoot),
    hasMcp: fs.existsSync(path.join(pluginRoot, '.mcp.json')),
    hasSettings: pluginHasNonPermissionSettings(pluginRoot),
    repoRoot,
    get snapshotSha() {
      return resolveSnapshotSha(repoRoot);
    },
  };
}

export interface PluginResourceGroup {
  label: string;
  items: string[];
}

export function pluginResourceGroups(plugin: DiscoveredPlugin): PluginResourceGroup[] {
  const groups: PluginResourceGroup[] = [
    { label: 'skills', items: plugin.skills.map((s) => `/${plugin.name}:${s}`) },
    { label: 'commands', items: plugin.commands.map((c) => `/${plugin.name}:${c}`) },
    { label: 'subagents', items: plugin.agentDefs },
    { label: 'workflows', items: plugin.workflows },
    { label: 'hooks', items: plugin.hooks },
    { label: 'memory', items: plugin.memory },
    { label: 'mcp', items: plugin.mcpServers },
    { label: 'lsp', items: plugin.lspServers },
    { label: 'monitors', items: plugin.monitors },
    { label: 'bin', items: plugin.bin },
    { label: 'scripts', items: plugin.scripts },
  ];
  const out = groups.filter((g) => g.items.length > 0);
  if (plugin.hasSettings) out.push({ label: 'settings', items: ['settings.json'] });
  return out;
}

function manifestDeclaresExecSurface(value: unknown): boolean {

  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return false;
}

export function inspectPluginCapabilities(pluginRoot: string): PluginCapabilities {
  const manifest = loadPluginManifest(pluginRoot);
  const plugin = manifest ? buildDiscoveredPlugin(pluginRoot, manifest) : null;
  return {
    hasHooks:
      (plugin?.hooks.length || 0) > 0 ||
      pluginHasDirectoryEntries(pluginRoot, 'hooks') ||
      manifestDeclaresExecSurface(manifest?.hooks),
    hasMcp:
      fs.existsSync(path.join(pluginRoot, '.mcp.json')) ||
      manifestDeclaresExecSurface(manifest?.mcpServers),
    hasBin: (plugin?.bin.length || 0) > 0,
    hasScripts: (plugin?.scripts.length || 0) > 0,
    hasSettings: pluginHasNonPermissionSettings(pluginRoot),
    hasPermissions: pluginHasPermissionsPath(pluginRoot),
  };
}

export function hasPluginExecSurfaces(capabilities: PluginCapabilities): boolean {
  return Object.values(capabilities).some(Boolean);
}

export function pluginCapabilityLabels(capabilities: PluginCapabilities): string[] {
  return (Object.keys(PLUGIN_EXEC_SURFACE_LABELS) as Array<keyof PluginCapabilities>)
    .filter((key) => capabilities[key])
    .map((key) => PLUGIN_EXEC_SURFACE_LABELS[key]);
}

export function loadPluginManifest(pluginRoot: string): PluginManifest | null {
  const manifestPath = path.join(pluginRoot, PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(manifestPath, 'utf-8');
    const parsed = JSON.parse(content) as PluginManifest;
    if (!parsed.name || !parsed.version) return null;
    if (!validatePluginName(parsed.name)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function validatePluginName(name: string): boolean {
  if (!name || name.length === 0 || name === '.' || name === '..') {
    return false;
  }
  const normalized = path.normalize(name);
  if (normalized === '.' || normalized === '' || normalized === '..') {
    return false;
  }
  if (/[/\\]/.test(name) || name.includes('\0')) {
    return false;
  }
  if (path.basename(normalized) !== name) {
    return false;
  }
  return true;
}

export function assertPluginTargetContained(targetRoot: string, pluginsDir: string): void {
  const resolvedPluginsDir = path.resolve(pluginsDir);
  const resolvedTargetRoot = path.resolve(targetRoot);
  if (
    resolvedTargetRoot === resolvedPluginsDir
    || !resolvedTargetRoot.startsWith(`${resolvedPluginsDir}${path.sep}`)
  ) {
    throw new Error(`Plugin install target escapes plugins directory: ${targetRoot}`);
  }
}

export function getPlugin(name: string): DiscoveredPlugin | null {

  const plugins = discoverPlugins();
  for (let i = plugins.length - 1; i >= 0; i--) {
    if (plugins[i].name === name) return plugins[i];
  }
  return null;
}

export function pluginSupportsAgent(plugin: DiscoveredPlugin, agent: AgentId): boolean {
  if (!isCapable(agent, 'plugins')) return false;
  if (plugin.manifest.agents && plugin.manifest.agents.length > 0) {
    return plugin.manifest.agents.includes(agent);
  }
  return true;
}


export function discoverPluginMemory(pluginRoot: string): string[] {
  const dir = path.join(pluginRoot, 'memory');
  if (!fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'memory.md')
      .map((f) => f.replace(/\.md$/i, ''))
      .sort();
  } catch {
    return [];
  }
}

function discoverPluginSkills(pluginRoot: string): string[] {
  const skillsDir = path.join(pluginRoot, 'skills');
  if (!fs.existsSync(skillsDir)) return [];

  return fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => d.name);
}

export function discoverPluginHooks(pluginRoot: string): string[] {
  const hooksFile = path.join(pluginRoot, 'hooks', 'hooks.json');
  if (!fs.existsSync(hooksFile)) return [];

  try {
    const content = JSON.parse(fs.readFileSync(hooksFile, 'utf-8')) as Record<string, unknown>;
    const eventMap = content.hooks && typeof content.hooks === 'object' && !Array.isArray(content.hooks)
      ? content.hooks as Record<string, unknown>
      : content;
    return Object.keys(eventMap);
  } catch {
    return [];
  }
}

function discoverPluginScripts(pluginRoot: string): string[] {
  const scriptsDir = path.join(pluginRoot, 'scripts');
  if (!fs.existsSync(scriptsDir)) return [];

  return fs.readdirSync(scriptsDir).filter(f => !f.startsWith('.'));
}

export function discoverPluginCommands(pluginRoot: string): string[] {
  const commandsDir = path.join(pluginRoot, 'commands');
  if (!fs.existsSync(commandsDir)) return [];

  return fs.readdirSync(commandsDir)
    .filter(f => f.endsWith('.md') && !f.startsWith('.'))
    .map(f => f.slice(0, -3));
}

export function discoverPluginAgentDefs(pluginRoot: string): string[] {
  const agentsDir = path.join(pluginRoot, 'agents');
  if (!fs.existsSync(agentsDir)) return [];

  return fs.readdirSync(agentsDir)
    .filter(f => f.endsWith('.md') && !f.startsWith('.'))
    .map(f => f.slice(0, -3));
}

export function discoverPluginWorkflows(pluginRoot: string): string[] {
  const workflowsDir = path.join(pluginRoot, 'workflows');
  if (!fs.existsSync(workflowsDir)) return [];
  try {
    return fs.readdirSync(workflowsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') &&
        fs.existsSync(path.join(workflowsDir, e.name, 'WORKFLOW.md')))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export function discoverPluginBin(pluginRoot: string): string[] {
  const binDir = path.join(pluginRoot, 'bin');
  if (!fs.existsSync(binDir)) return [];

  return fs.readdirSync(binDir).filter(f => !f.startsWith('.'));
}

export function discoverPluginMcpServers(pluginRoot: string): string[] {
  const mcpFile = path.join(pluginRoot, '.mcp.json');
  if (!fs.existsSync(mcpFile)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(mcpFile, 'utf-8')) as { mcpServers?: Record<string, unknown> };
    return parsed.mcpServers ? Object.keys(parsed.mcpServers) : [];
  } catch {
    return [];
  }
}

export function discoverPluginLspServers(pluginRoot: string): string[] {
  const lspFile = path.join(pluginRoot, '.lsp.json');
  if (!fs.existsSync(lspFile)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(lspFile, 'utf-8')) as Record<string, unknown>;
    return Object.keys(parsed);
  } catch {
    return [];
  }
}

export function discoverPluginMonitors(pluginRoot: string): string[] {
  const monitorsFile = path.join(pluginRoot, 'monitors', 'monitors.json');
  if (!fs.existsSync(monitorsFile)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(monitorsFile, 'utf-8')) as Array<{ name?: string }>;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(m => m.name).filter((n): n is string => typeof n === 'string');
  } catch {
    return [];
  }
}

function pluginHasNonPermissionSettings(pluginRoot: string): boolean {
  const settingsPath = path.join(pluginRoot, 'settings.json');
  if (!fs.existsSync(settingsPath)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    return Object.keys(parsed).some(k => k !== 'permissions');
  } catch {
    return false;
  }
}


export function expandPluginVars(
  str: string,
  pluginRoot: string,
  pluginName: string,
  agentId: AgentId,
  versionHome: string,
  userConfig?: Record<string, string>
): string {
  const dataDir = path.join(versionHome, agentConfigDirName(agentId), 'plugin-data', pluginName);
  let result = str
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot)
    .replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, dataDir);

  if (userConfig && Object.keys(userConfig).length > 0) {
    result = result.replace(/\$\{user_config\.([^}]+)\}/g, (_, key) => {
      return userConfig[key] ?? '';
    });
  }

  return result;
}


export function loadUserConfig(pluginName: string): Record<string, string> {
  const configPath = path.join(getPluginsDir(), pluginName, USER_CONFIG_FILE);
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, string>;
  } catch {
    return {};
  }
}

export function saveUserConfig(pluginName: string, config: Record<string, string>): void {
  const configPath = path.join(getPluginsDir(), pluginName, USER_CONFIG_FILE);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}


export function checkPluginDependencies(manifest: PluginManifest): string[] {
  if (!manifest.dependencies || manifest.dependencies.length === 0) return [];
  const installed = new Set(discoverPlugins().map(p => p.name));
  return manifest.dependencies.filter(dep => !installed.has(dep));
}


export function marketplaceSpecForName(name: string | undefined, cwd: string = process.cwd()): MarketplaceSpec {
  if (!name || name === MARKETPLACE_NAME) return { kind: 'user' };
  if (name === SYSTEM_MARKETPLACE_NAME) {
    return { kind: 'system', root: getSystemPluginsDir() };
  }
  if (name === PROJECT_MARKETPLACE_NAME) {
    return { kind: 'project', root: getProjectPluginsDir(cwd) ?? '' };
  }
  const alias = name.slice('agents-'.length);
  return { kind: 'extra', alias, root: getExtraPluginsDir(alias) };
}

function listVersionMarketplaceNames(agent: AgentId, versionHome: string): string[] {
  const dir = path.join(versionHome, agentConfigDirName(agent), 'plugins', 'marketplaces');
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name);
  } catch {
    return [];
  }
}


export function syncPluginToVersion(
  plugin: DiscoveredPlugin,
  agent: AgentId,
  versionHome: string,
  options: { allowExecSurfaces?: boolean; version?: string } = {}
): {
  success: boolean;
  skills: string[];
  commands: string[];
  agentDefs: string[];
  bin: string[];
  hooks: string[];
  permissions: boolean;
  mcp: boolean;
  settings: boolean;
} {
  const result = {
    success: false,
    skills: [] as string[],
    commands: [] as string[],
    agentDefs: [] as string[],
    bin: [] as string[],
    hooks: [] as string[],
    permissions: false,
    mcp: false,
    settings: false,
  };

  if (!pluginSupportsAgent(plugin, agent)) {
    return result;
  }
  if (!isCapable(agent, 'plugins')) {
    return result;
  }

  if (agent === 'opencode') {
    const enablePlugin = options.allowExecSurfaces === true || !hasPluginExecSurfaces(inspectPluginCapabilities(plugin.root));
    if (!enablePlugin) {
      return result;
    }
    const ok = installOpenCodePlugin(plugin, versionHome);
    result.success = ok;
    if (ok) result.skills.push(plugin.name);
    return result;
  }

  if (agent === 'goose') {
    const ok = installGoosePlugin(plugin, versionHome);
    result.success = ok;
    if (ok) result.skills.push(plugin.name);
    return result;
  }

  if (agent === 'hermes') {
    const enablePlugin = options.allowExecSurfaces === true || !hasPluginExecSurfaces(inspectPluginCapabilities(plugin.root));
    const ok = installHermesPlugin(plugin, versionHome, enablePlugin);
    result.success = ok;
    if (ok) result.skills.push(plugin.name);
    return result;
  }

  const userConfig = loadUserConfig(plugin.name);

  const spec = marketplaceSpecForName(plugin.marketplace);
  const marketplaceName = marketplaceNameFor(spec);

  const installDir = copyPluginToMarketplace(plugin, spec, agent, versionHome);

  if (Object.keys(userConfig).length > 0) {
    expandUserConfigInDir(installDir, userConfig);
  }

  const agentManifestDir = AGENTS[agent].pluginManifestDir;
  if (agentManifestDir && agentManifestDir !== PLUGIN_MANIFEST_DIR) {
    const srcManifest = path.join(installDir, PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE);
    if (fs.existsSync(srcManifest)) {
      const destManifestDir = path.join(installDir, agentManifestDir);
      fs.mkdirSync(destManifestDir, { recursive: true });
      fs.copyFileSync(srcManifest, path.join(destManifestDir, PLUGIN_MANIFEST_FILE));
    }
  }

  syncMarketplaceManifest(spec, agent, versionHome);
  registerMarketplace(spec, agent, versionHome);
  const enablePlugin = options.allowExecSurfaces === true || !hasPluginExecSurfaces(inspectPluginCapabilities(plugin.root));
  if (enablePlugin) {
    addPluginToSettings(plugin.name, marketplaceName, agent, versionHome);
  }

  if (agent === 'droid') {
    registerDroidInstalledPlugin(
      plugin.name,
      marketplaceName,
      installDir,
      plugin.manifest.version,
      agent,
      versionHome
    );
  }

  if (agent === 'copilot') {
    registerCopilotInstalledPlugin(
      plugin.name,
      marketplaceName,
      installDir,
      plugin.manifest.version,
      enablePlugin,
      agent,
      versionHome
    );
  }

  if (options.version && shouldInstallCommandAsSkill(agent, options.version) && plugin.commands.length > 0) {
    const agentDir = path.join(versionHome, agentConfigDirName(agent));
    const skillSourceDirs = [path.join(agentDir, 'skills')];
    for (const cmd of plugin.commands) {
      const srcPath = path.join(plugin.root, 'commands', `${cmd}.md`);
      if (fs.existsSync(srcPath)) {
        installCommandSkillToVersion(agentDir, `${plugin.name}-${cmd}`, srcPath, skillSourceDirs);
      }
    }
  }

  migrateLegacyFlatLayout(plugin, agent, versionHome);

  result.skills = plugin.skills.map(s => `${plugin.name}:${s}`);
  result.commands = plugin.commands.map(c => `${plugin.name}:${c}`);
  result.agentDefs = plugin.agentDefs.map(a => `${plugin.name}:${a}`);
  result.bin = plugin.bin;
  result.hooks = plugin.hooks;
  result.mcp = plugin.hasMcp;
  result.settings = plugin.hasSettings;
  result.permissions = pluginHasPermissions(plugin);
  result.success = true;

  return result;
}

function pluginHasPermissions(plugin: DiscoveredPlugin): boolean {
  return pluginHasPermissionsPath(plugin.root);
}

function pluginHasPermissionsPath(pluginRoot: string): boolean {
  const permissionsDir = path.join(pluginRoot, 'permissions');
  if (fs.existsSync(permissionsDir)) return true;
  const settingsPath = path.join(pluginRoot, 'settings.json');
  if (!fs.existsSync(settingsPath)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      permissions?: { allow?: string[]; deny?: string[] };
    };
    return !!(parsed.permissions?.allow?.length || parsed.permissions?.deny?.length);
  } catch {
    return false;
  }
}

function pluginHasDirectoryEntries(pluginRoot: string, dirName: string): boolean {
  const dir = path.join(pluginRoot, dirName);
  if (!fs.existsSync(dir)) return false;
  try {
    return fs.readdirSync(dir).some((entry) => !entry.startsWith('.'));
  } catch {
    return false;
  }
}

function expandUserConfigInDir(dir: string, userConfig: Record<string, string>): void {
  const textExtensions = new Set(['.md', '.json', '.sh', '.py', '.js', '.ts', '.yaml', '.yml', '.toml', '.txt']);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      expandUserConfigInDir(full, userConfig);
      continue;
    }
    if (!textExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    try {
      const content = fs.readFileSync(full, 'utf-8');
      if (!content.includes('${user_config.')) continue;
      const expanded = content.replace(/\$\{user_config\.([^}]+)\}/g, (_, key) => userConfig[key] ?? '');
      if (expanded !== content) {
        fs.writeFileSync(full, expanded, 'utf-8');
      }
    } catch {  }
  }
}

function migrateLegacyFlatLayout(
  plugin: DiscoveredPlugin,
  agent: AgentId,
  versionHome: string
): void {
  const prefix = `${plugin.name}--`;
  const agentRoot = path.join(versionHome, agentConfigDirName(agent));

  const skillsDir = path.join(agentRoot, 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(prefix)) {
        try { fs.rmSync(path.join(skillsDir, entry.name), { recursive: true, force: true }); } catch {  }
      }
    }
  }

  if (agent === 'claude' || agent === 'openclaw') {
    const cmdsDir = path.join(agentRoot, AGENTS[agent]?.commandsSubdir ?? 'commands');
    if (fs.existsSync(cmdsDir)) {
      for (const entry of fs.readdirSync(cmdsDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.md')) {
          try { fs.unlinkSync(path.join(cmdsDir, entry.name)); } catch {  }
        }
      }
    }
  }

  const agentsDir = path.join(agentRoot, 'agents');
  if (fs.existsSync(agentsDir)) {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.md')) {
        try { fs.unlinkSync(path.join(agentsDir, entry.name)); } catch {  }
      }
    }
  }

  const binDir = path.join(agentRoot, 'plugin-bin', plugin.name);
  if (fs.existsSync(binDir)) {
    try { fs.rmSync(binDir, { recursive: true, force: true }); } catch {  }
  }

  const settingsPath = path.join(agentRoot, 'settings.json');
  if (!fs.existsSync(settingsPath)) return;

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch { return; }

  let changed = false;
  const pluginRoot = plugin.root;

  const hooksCfg = settings.hooks as Record<string, unknown> | undefined;
  if (hooksCfg && typeof hooksCfg === 'object') {
    for (const [event, entries] of Object.entries(hooksCfg)) {
      if (!Array.isArray(entries)) continue;
      const groups = entries as Array<{ matcher?: string; hooks?: Array<{ command: string }> }>;
      for (const group of groups) {
        if (!Array.isArray(group.hooks)) continue;
        const orig = group.hooks.length;
        group.hooks = group.hooks.filter(h => !(typeof h.command === 'string' && h.command.includes(pluginRoot)));
        if (group.hooks.length !== orig) changed = true;
      }
      const kept = groups.filter(g => Array.isArray(g.hooks) && g.hooks.length > 0);
      if (kept.length !== groups.length) {
        hooksCfg[event] = kept;
        changed = true;
      }
      if (Array.isArray(hooksCfg[event]) && (hooksCfg[event] as unknown[]).length === 0) {
        delete hooksCfg[event];
        changed = true;
      }
    }
  }

  const perms = settings.permissions as { allow?: string[]; deny?: string[] } | undefined;
  if (perms && typeof perms === 'object') {
    for (const key of ['allow', 'deny'] as const) {
      const list = perms[key];
      if (!Array.isArray(list)) continue;
      const kept = list.filter(r => !(typeof r === 'string' && r.includes(pluginRoot)));
      if (kept.length !== list.length) {
        perms[key] = kept;
        changed = true;
      }
    }
  }

  const mcp = settings.mcpServers as Record<string, unknown> | undefined;
  if (mcp && typeof mcp === 'object') {
    for (const key of Object.keys(mcp)) {
      if (key.startsWith(prefix)) {
        delete mcp[key];
        changed = true;
      }
    }
  }

  if (Array.isArray(settings.pluginBinPaths)) {
    const targetBinDir = path.join(agentRoot, 'plugin-bin', plugin.name);
    const before = (settings.pluginBinPaths as string[]).length;
    settings.pluginBinPaths = (settings.pluginBinPaths as string[]).filter(p => p !== targetBinDir);
    if ((settings.pluginBinPaths as string[]).length !== before) changed = true;
    if ((settings.pluginBinPaths as string[]).length === 0) {
      delete settings.pluginBinPaths;
      changed = true;
    }
  }

  if (changed) {
    try { fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8'); } catch {  }
  }
}



export function openCodePluginsDir(versionHome: string): string {
  return path.join(versionHome, '.config', 'opencode', 'plugins');
}

const OPENCODE_MODULE_RE = /\.(ts|js)$/i;
const OPENCODE_TEST_RE = /\.(test|spec)\./i;

function listOpenCodeModules(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && OPENCODE_MODULE_RE.test(e.name) && !OPENCODE_TEST_RE.test(e.name) && !e.name.startsWith('.'))
    .map((e) => e.name);
}

export function resolveOpenCodePluginSources(pluginRoot: string): string[] {
  for (const sub of ['opencode', 'plugins']) {
    const dir = path.join(pluginRoot, sub);
    const files = listOpenCodeModules(dir);
    if (files.length > 0) return files.map((f) => path.join(dir, f));
  }
  return listOpenCodeModules(pluginRoot).map((f) => path.join(pluginRoot, f));
}

export function installOpenCodePlugin(plugin: DiscoveredPlugin, versionHome: string): boolean {
  const destDir = openCodePluginsDir(versionHome);
  fs.mkdirSync(destDir, { recursive: true });

  const sources = resolveOpenCodePluginSources(plugin.root);
  const destPluginDir = path.join(destDir, plugin.name);

  const bareTs = path.join(destDir, `${plugin.name}.ts`);
  const bareJs = path.join(destDir, `${plugin.name}.js`);
  for (const p of [bareTs, bareJs, destPluginDir]) {
    try {
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    } catch {  }
  }

  if (sources.length === 0) {
    fs.mkdirSync(destPluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(destPluginDir, '.agents-cli-managed'),
      `plugin=${plugin.name}\n# no opencode modules found under ${plugin.root}\n`,
      'utf-8'
    );
    return true;
  }

  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    const ext = path.extname(src);
    const stem = path.basename(src, ext);
    const destName = sources.length === 1
      ? `${plugin.name}${ext}`
      : (stem === 'index' || stem === plugin.name
          ? `${plugin.name}${ext}`
          : `${plugin.name}-${stem}${ext}`);
    fs.copyFileSync(src, path.join(destDir, destName));
  }
  fs.mkdirSync(destPluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(destPluginDir, '.agents-cli-managed'),
    `plugin=${plugin.name}\nfiles=${sources.map((s) => path.basename(s)).join(',')}\n`,
    'utf-8'
  );
  return true;
}

export function isOpenCodePluginInstalled(pluginName: string, versionHome: string): boolean {
  const destDir = openCodePluginsDir(versionHome);
  if (!fs.existsSync(destDir)) return false;
  for (const candidate of [
    path.join(destDir, `${pluginName}.ts`),
    path.join(destDir, `${pluginName}.js`),
    path.join(destDir, `${pluginName}.mjs`),
    path.join(destDir, `${pluginName}.cjs`),
    path.join(destDir, pluginName),
  ]) {
    if (fs.existsSync(candidate)) return true;
  }
  return false;
}

export function removeOpenCodePlugin(pluginName: string, versionHome: string): boolean {
  const destDir = openCodePluginsDir(versionHome);
  let removed = false;
  for (const candidate of [
    path.join(destDir, `${pluginName}.ts`),
    path.join(destDir, `${pluginName}.js`),
    path.join(destDir, pluginName),
  ]) {
    if (fs.existsSync(candidate)) {
      fs.rmSync(candidate, { recursive: true, force: true });
      removed = true;
    }
  }
  if (fs.existsSync(destDir)) {
    for (const entry of fs.readdirSync(destDir)) {
      if (entry.startsWith(`${pluginName}-`) && /\.(ts|js)$/i.test(entry)) {
        try {
          fs.rmSync(path.join(destDir, entry), { force: true });
          removed = true;
        } catch {  }
      }
    }
  }
  return removed;
}


function stripEscapingSymlinks(destRoot: string, sourceRoot: string): string[] {

  const realRoots = [destRoot, sourceRoot].map((r) => {
    try { return fs.realpathSync(r); }
    catch { return r; }
  });
  const within = (target: string): boolean =>
    realRoots.some((root) => target === root || target.startsWith(root + path.sep));
  const removed: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let escapes: boolean;
        try {
          escapes = !within(fs.realpathSync(full));
        } catch {
          escapes = true;
        }
        if (escapes) {
          try {
            fs.rmSync(full, { force: true });
            removed.push(path.relative(destRoot, full) || entry.name);
          } catch {  }
        }
      } else if (entry.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(destRoot);
  return removed;
}


export function goosePluginsDir(versionHome: string): string {
  return path.join(versionHome, '.agents', 'plugins');
}

export function installGoosePlugin(plugin: DiscoveredPlugin, versionHome: string): boolean {
  const destRoot = path.join(goosePluginsDir(versionHome), plugin.name);
  try {
    if (fs.existsSync(destRoot)) {
      fs.rmSync(destRoot, { recursive: true, force: true });
    }
    fs.cpSync(plugin.root, destRoot, { recursive: true });
    stripEscapingSymlinks(destRoot, plugin.root);
    fs.writeFileSync(
      path.join(destRoot, '.agents-cli-managed'),
      `plugin=${plugin.name}\n`,
      'utf-8'
    );
    return true;
  } catch {
    return false;
  }
}

export function isGoosePluginInstalled(pluginName: string, versionHome: string): boolean {
  return fs.existsSync(path.join(goosePluginsDir(versionHome), pluginName));
}

export function removeGoosePlugin(pluginName: string, versionHome: string): boolean {
  const destRoot = path.join(goosePluginsDir(versionHome), pluginName);
  if (!fs.existsSync(destRoot)) return false;
  fs.rmSync(destRoot, { recursive: true, force: true });
  return true;
}


export function hermesPluginsDir(versionHome: string): string {
  return path.join(versionHome, '.hermes', 'plugins');
}

function hermesConfigPath(versionHome: string): string {
  return path.join(versionHome, '.hermes', 'config.yaml');
}

function writeHermesPluginManifest(plugin: DiscoveredPlugin, destRoot: string): void {
  const manifest: Record<string, unknown> = {
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    description: plugin.manifest.description,
  };
  fs.writeFileSync(
    path.join(destRoot, HERMES_PLUGIN_MANIFEST_FILE),
    yaml.stringify(manifest),
    'utf-8'
  );
}

export function setHermesPluginEnabled(pluginName: string, versionHome: string, enabled: boolean): void {
  const configPath = hermesConfigPath(versionHome);

  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    const parsed = yaml.parse(fs.readFileSync(configPath, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>;
    }
  }

  if (!config.plugins || typeof config.plugins !== 'object' || Array.isArray(config.plugins)) {
    config.plugins = {};
  }
  const plugins = config.plugins as Record<string, unknown>;
  const current = Array.isArray(plugins.enabled) ? (plugins.enabled as unknown[]).filter((n): n is string => typeof n === 'string') : [];
  const has = current.includes(pluginName);

  if (enabled && !has) {
    plugins.enabled = [...current, pluginName];
  } else if (!enabled && has) {
    plugins.enabled = current.filter((n) => n !== pluginName);
  } else {
    return;
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, yaml.stringify(config), 'utf-8');
}

export function installHermesPlugin(plugin: DiscoveredPlugin, versionHome: string, enable: boolean): boolean {
  const destRoot = path.join(hermesPluginsDir(versionHome), plugin.name);
  try {
    if (fs.existsSync(destRoot)) {
      fs.rmSync(destRoot, { recursive: true, force: true });
    }
    fs.cpSync(plugin.root, destRoot, { recursive: true });
    stripEscapingSymlinks(destRoot, plugin.root);
    const userConfig = loadUserConfig(plugin.name);
    if (Object.keys(userConfig).length > 0) {
      expandUserConfigInDir(destRoot, userConfig);
    }
    writeHermesPluginManifest(plugin, destRoot);
    fs.writeFileSync(
      path.join(destRoot, '.agents-cli-managed'),
      `plugin=${plugin.name}\n`,
      'utf-8'
    );
    if (enable) {
      setHermesPluginEnabled(plugin.name, versionHome, true);
    }
    return true;
  } catch {
    return false;
  }
}

export function isHermesPluginInstalled(pluginName: string, versionHome: string): boolean {
  return fs.existsSync(path.join(hermesPluginsDir(versionHome), pluginName, HERMES_PLUGIN_MANIFEST_FILE));
}

export function removeHermesPlugin(pluginName: string, versionHome: string): boolean {
  const destRoot = path.join(hermesPluginsDir(versionHome), pluginName);
  const existed = fs.existsSync(destRoot);
  if (existed) fs.rmSync(destRoot, { recursive: true, force: true });
  setHermesPluginEnabled(pluginName, versionHome, false);
  return existed;
}


export function isPluginSynced(
  plugin: DiscoveredPlugin,
  agent: AgentId,
  versionHome: string
): boolean {
  if (!isCapable(agent, 'plugins')) return false;
  if (agent === 'opencode') {
    return isOpenCodePluginInstalled(plugin.name, versionHome);
  }
  if (agent === 'goose') {
    return isGoosePluginInstalled(plugin.name, versionHome);
  }
  if (agent === 'hermes') {
    return isHermesPluginInstalled(plugin.name, versionHome);
  }
  const spec = marketplaceSpecForName(plugin.marketplace);
  if (!isInstalledInMarketplace(plugin.name, spec, agent, versionHome)) return false;
  if (agent === 'droid') {
    return isDroidPluginInstalled(plugin.name, marketplaceNameFor(spec), agent, versionHome);
  }
  return true;
}


export function removePluginFromVersion(
  pluginName: string,
  pluginRoot: string,
  agent: AgentId,
  versionHome: string
): {
  skills: string[];
  commands: string[];
  agentDefs: string[];
  bin: string[];
  hooks: string[];
  permissions: number;
  mcp: number;
} {
  const result = {
    skills: [] as string[],
    commands: [] as string[],
    agentDefs: [] as string[],
    bin: [] as string[],
    hooks: [] as string[],
    permissions: 0,
    mcp: 0,
  };

  if (agent === 'opencode') {
    if (removeOpenCodePlugin(pluginName, versionHome)) {
      result.skills.push(pluginName);
    }
    return result;
  }

  if (agent === 'goose') {
    if (removeGoosePlugin(pluginName, versionHome)) {
      result.skills.push(pluginName);
    }
    return result;
  }

  if (agent === 'hermes') {
    if (removeHermesPlugin(pluginName, versionHome)) {
      result.skills.push(pluginName);
    }
    return result;
  }

  let removedAny = false;
  for (const name of listVersionMarketplaceNames(agent, versionHome)) {
    const spec = marketplaceSpecForName(name);
    if (removePluginFromMarketplace(pluginName, name, agent, versionHome)) {
      removedAny = true;
    }
    removePluginFromSettings(pluginName, name, agent, versionHome);
    if (agent === 'droid') {
      unregisterDroidInstalledPlugin(pluginName, name, agent, versionHome);
    }
    if (agent === 'copilot') {
      unregisterCopilotInstalledPlugin(pluginName, name, agent, versionHome);
    }

    syncMarketplaceManifest(spec, agent, versionHome);

    if (marketplaceIsEmpty(name, agent, versionHome)) {
      removeEmptyMarketplaceDir(name, agent, versionHome);
      unregisterMarketplace(name, agent, versionHome);
    }
  }
  if (removedAny) {
    result.skills.push(pluginName);
  }

  cleanLegacyFlatLayout(pluginName, pluginRoot, agent, versionHome, result);

  return result;
}

function cleanLegacyFlatLayout(
  pluginName: string,
  pluginRoot: string,
  agent: AgentId,
  versionHome: string,
  result: { skills: string[]; commands: string[]; agentDefs: string[]; bin: string[]; hooks: string[]; permissions: number; mcp: number }
): void {
  const prefix = `${pluginName}--`;
  const agentRoot = path.join(versionHome, agentConfigDirName(agent));

  const skillsDir = path.join(agentRoot, 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      try {
        fs.rmSync(path.join(skillsDir, entry.name), { recursive: true, force: true });
        result.skills.push(entry.name);
      } catch {  }
    }
  }

  if (agent === 'claude' || agent === 'openclaw') {
    const commandsDir = path.join(agentRoot, AGENTS[agent]?.commandsSubdir ?? 'commands');
    if (fs.existsSync(commandsDir)) {
      for (const entry of fs.readdirSync(commandsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.md')) continue;
        try {
          fs.unlinkSync(path.join(commandsDir, entry.name));
          result.commands.push(entry.name);
        } catch {  }
      }
    }
  }

  const agentsDir = path.join(agentRoot, 'agents');
  if (fs.existsSync(agentsDir)) {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.md')) continue;
      try {
        fs.unlinkSync(path.join(agentsDir, entry.name));
        result.agentDefs.push(entry.name);
      } catch {  }
    }
  }

  const binDir = path.join(agentRoot, 'plugin-bin', pluginName);
  if (fs.existsSync(binDir)) {
    try {
      fs.rmSync(binDir, { recursive: true, force: true });
      result.bin.push(binDir);
    } catch {  }
  }

  const settingsPath = path.join(agentRoot, 'settings.json');
  if (!fs.existsSync(settingsPath)) return;

  let settings: Record<string, unknown>;
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch { return; }

  let changed = false;

  const hooksConfig = settings.hooks as Record<string, unknown> | undefined;
  if (hooksConfig && typeof hooksConfig === 'object') {
    for (const [event, entries] of Object.entries(hooksConfig)) {
      if (!Array.isArray(entries)) continue;
      const groups = entries as Array<{ matcher?: string; hooks?: Array<{ command: string }> }>;
      for (const group of groups) {
        if (!Array.isArray(group.hooks)) continue;
        const orig = group.hooks.length;
        group.hooks = group.hooks.filter(h => {
          const matches = typeof h.command === 'string' && h.command.includes(pluginRoot);
          if (matches) result.hooks.push(`${event}: ${h.command}`);
          return !matches;
        });
        if (group.hooks.length !== orig) changed = true;
      }
      const kept = groups.filter(g => Array.isArray(g.hooks) && g.hooks.length > 0);
      if (kept.length !== groups.length) {
        hooksConfig[event] = kept;
        changed = true;
      }
      if (Array.isArray(hooksConfig[event]) && (hooksConfig[event] as unknown[]).length === 0) {
        delete hooksConfig[event];
        changed = true;
      }
    }
  }

  const perms = settings.permissions as { allow?: string[]; deny?: string[] } | undefined;
  if (perms && typeof perms === 'object') {
    for (const key of ['allow', 'deny'] as const) {
      const list = perms[key];
      if (!Array.isArray(list)) continue;
      const kept = list.filter(r => {
        const matches = typeof r === 'string' && r.includes(pluginRoot);
        if (matches) result.permissions += 1;
        return !matches;
      });
      if (kept.length !== list.length) {
        perms[key] = kept;
        changed = true;
      }
    }
  }

  const mcp = settings.mcpServers as Record<string, unknown> | undefined;
  if (mcp && typeof mcp === 'object') {
    for (const key of Object.keys(mcp)) {
      if (key.startsWith(prefix)) {
        delete mcp[key];
        result.mcp += 1;
        changed = true;
      }
    }
  }

  if (Array.isArray(settings.pluginBinPaths)) {
    const targetBin = path.join(agentRoot, 'plugin-bin', pluginName);
    const before = (settings.pluginBinPaths as string[]).length;
    settings.pluginBinPaths = (settings.pluginBinPaths as string[]).filter(p => p !== targetBin);
    if ((settings.pluginBinPaths as string[]).length !== before) changed = true;
    if ((settings.pluginBinPaths as string[]).length === 0) {
      delete settings.pluginBinPaths;
      changed = true;
    }
  }

  if (changed) {
    try { fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8'); } catch {  }
  }
}


export type ActivePluginsInput = Set<string> | Array<{ name: string; marketplace?: string }>;

interface ActivePluginIndex {
  names: Set<string>;
  pairs: Set<string> | null;
}

function pairKey(marketplace: string, name: string): string {
  return `${marketplace} ${name}`;
}

function indexActivePlugins(input: ActivePluginsInput): ActivePluginIndex {
  if (input instanceof Set) return { names: input, pairs: null };
  const names = new Set<string>();
  const pairs = new Set<string>();
  for (const p of input) {
    names.add(p.name);
    pairs.add(pairKey(p.marketplace ?? MARKETPLACE_NAME, p.name));
  }
  return { names, pairs };
}

function marketplaceSourceRepoExists(marketplaceName: string, cwd: string): boolean {
  const spec = marketplaceSpecForName(marketplaceName, cwd);
  switch (spec.kind) {
    case 'user': return fs.existsSync(path.dirname(getPluginsDir()));
    case 'system': return fs.existsSync(path.dirname(getSystemPluginsDir()));
    case 'extra': return fs.existsSync(path.dirname(getExtraPluginsDir(spec.alias)));
    case 'project': {
      const root = getProjectPluginsDir(cwd);
      return root != null && fs.existsSync(path.dirname(root));
    }
  }
}

function isOrphanMarketplacePlugin(
  marketplaceName: string,
  pluginName: string,
  active: ActivePluginIndex,
  cwd: string,
): boolean {
  if (active.pairs === null) return !active.names.has(pluginName);
  if (active.pairs.has(pairKey(marketplaceName, pluginName))) return false;
  if (marketplaceSourceRepoExists(marketplaceName, cwd)) return true;
  return !active.names.has(pluginName);
}

export function cleanOrphanedPluginSkills(
  agent: AgentId,
  versionHome: string,
  activePlugins: ActivePluginsInput,
  version?: string
): string[] {
  const active = indexActivePlugins(activePlugins);
  const cwd = process.cwd();
  const removed: string[] = [];

  for (const name of listVersionMarketplaceNames(agent, versionHome)) {
    const spec = marketplaceSpecForName(name);
    const mktPluginsDir = path.join(marketplaceRoot(name, agent, versionHome), 'plugins');
    if (!fs.existsSync(mktPluginsDir)) continue;
    let trashedHere = false;
    for (const entry of fs.readdirSync(mktPluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (!isOrphanMarketplacePlugin(name, entry.name, active, cwd)) continue;
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const trashDir = path.join(getTrashPluginsDir(), agent, version || 'unknown', entry.name);
        const trashDest = path.join(trashDir, stamp);
        fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
        fs.renameSync(path.join(mktPluginsDir, entry.name), trashDest);
        removePluginFromSettings(entry.name, name, agent, versionHome);
        if (agent === 'droid') {
          unregisterDroidInstalledPlugin(entry.name, name, agent, versionHome);
        }
        if (agent === 'copilot') {
          unregisterCopilotInstalledPlugin(entry.name, name, agent, versionHome);
        }
        removed.push(entry.name);
        trashedHere = true;
      } catch {  }
    }
    if (trashedHere) {
      syncMarketplaceManifest(spec, agent, versionHome);
      if (marketplaceIsEmpty(name, agent, versionHome)) {
        removeEmptyMarketplaceDir(name, agent, versionHome);
        unregisterMarketplace(name, agent, versionHome);
      }
    }
  }

  const skillsDir = path.join(versionHome, agentConfigDirName(agent), 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dashIdx = entry.name.indexOf('--');
      if (dashIdx === -1) continue;
      const pluginName = entry.name.slice(0, dashIdx);
      if (active.names.has(pluginName)) continue;
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const trashDir = path.join(getTrashPluginsDir(), agent, version || 'unknown', entry.name);
        const trashDest = path.join(trashDir, stamp);
        fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
        fs.renameSync(path.join(skillsDir, entry.name), trashDest);
        removed.push(entry.name);
      } catch {  }
    }
  }

  return removed;
}


export interface VersionPluginDiff {
  agent: AgentId;
  version: string;
  orphans: string[];
}

export function diffVersionPlugins(agent: AgentId, version: string): VersionPluginDiff {
  const versionHome = getVersionHomePath(agent, version);
  const active = indexActivePlugins(discoverPlugins());
  const cwd = process.cwd();
  const orphans: string[] = [];

  for (const name of listVersionMarketplaceNames(agent, versionHome)) {
    const mktPluginsDir = path.join(marketplaceRoot(name, agent, versionHome), 'plugins');
    if (!fs.existsSync(mktPluginsDir)) continue;
    for (const entry of fs.readdirSync(mktPluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (isOrphanMarketplacePlugin(name, entry.name, active, cwd)) {
        orphans.push(entry.name);
      }
    }
  }

  const skillsDir = path.join(versionHome, agentConfigDirName(agent), 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dashIdx = entry.name.indexOf('--');
      if (dashIdx === -1) continue;
      const pluginName = entry.name.slice(0, dashIdx);
      if (!active.names.has(pluginName)) {
        orphans.push(entry.name);
      }
    }
  }

  return { agent, version, orphans: Array.from(new Set(orphans)).sort() };
}

export function iterPluginsCapableVersions(filter?: { agent?: AgentId; version?: string }): Array<{ agent: AgentId; version: string }> {
  const pairs: Array<{ agent: AgentId; version: string }> = [];
  const agents = filter?.agent ? [filter.agent] : capableAgents('plugins');
  for (const agent of agents) {
    if (!isCapable(agent, 'plugins')) continue;
    const versions = listInstalledVersions(agent);
    for (const version of versions) {
      if (filter?.version && filter.version !== version) continue;
      pairs.push({ agent, version });
    }
  }
  return pairs;
}

export function removePluginSkillFromVersion(
  agent: AgentId,
  version: string,
  skillName: string
): { success: boolean; error?: string } {
  const versionHome = getVersionHomePath(agent, version);
  const skillPath = path.join(versionHome, agentConfigDirName(agent), 'skills', skillName);

  if (!fs.existsSync(skillPath)) {
    return { success: true };
  }

  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const trashDir = path.join(getTrashPluginsDir(), agent, version, skillName);
    const trashDest = path.join(trashDir, stamp);
    fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
    fs.renameSync(skillPath, trashDest);
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
  return { success: true };
}


export function parseInstallSpec(spec: string): { name: string | null; source: string } {
  const atIdx = spec.indexOf('@');
  if (atIdx > 0) {
    const name = spec.slice(0, atIdx);
    const source = spec.slice(atIdx + 1);
    return { name, source };
  }
  return { name: null, source: spec };
}

export async function installPlugin(spec: string): Promise<{ name: string; root: string; isNew: boolean; capabilities: PluginCapabilities }> {
  const { name: specName, source } = parseInstallSpec(spec);

  const isLocalPath = source.startsWith('/') || source.startsWith('./') || source.startsWith('../') || source.startsWith('~')
    || (IS_WINDOWS && isWindowsAbsolutePath(source));
  const resolvedSource = isLocalPath
    ? source.replace(/^~/, homeDir())
    : source;

  const pluginsDir = getPluginsDir();
  fs.mkdirSync(pluginsDir, { recursive: true });

  let targetName = specName;
  if (!targetName) {
    if (isLocalPath) {
      const manifest = loadPluginManifest(resolvedSource);
      if (!manifest) throw new Error(`No valid plugin.json found at ${resolvedSource}`);
      targetName = manifest.name;
    } else {
      targetName = path.basename(resolvedSource).replace(/\.git$/, '');
    }
  }
  if (!validatePluginName(targetName)) {
    throw new Error(`Invalid plugin name: ${targetName}`);
  }

  const targetRoot = path.join(pluginsDir, targetName);
  assertPluginTargetContained(targetRoot, pluginsDir);
  const isNew = !fs.existsSync(targetRoot);

  if (isLocalPath) {
    if (fs.existsSync(targetRoot)) {
      fs.rmSync(targetRoot, { recursive: true, force: true });
    }
    fs.cpSync(resolvedSource, targetRoot, { recursive: true });
  } else {
    assertSafeGitTransport(resolvedSource);
    if (fs.existsSync(targetRoot)) {
      fs.rmSync(targetRoot, { recursive: true, force: true });
    }
    execFileSync('git', ['clone', '--depth', '1', '--', resolvedSource, targetRoot], {
      stdio: 'pipe',
    });
  }

  const manifest = loadPluginManifest(targetRoot);
  if (!manifest) {
    fs.rmSync(targetRoot, { recursive: true, force: true });
    throw new Error(`Installed source has no valid .claude-plugin/plugin.json`);
  }
  const capabilities = inspectPluginCapabilities(targetRoot);

  fs.writeFileSync(
    path.join(targetRoot, SOURCE_FILE),
    JSON.stringify({ source, isGit: !isLocalPath, version: manifest.version }),
    'utf-8',
  );

  return { name: manifest.name, root: targetRoot, isNew, capabilities };
}

export interface PluginSourceInfo {
  source: string;
  isGit: boolean;
  version?: string;
}

export function readPluginSourceInfo(root: string): PluginSourceInfo | null {
  const f = path.join(root, SOURCE_FILE);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf-8')) as PluginSourceInfo;
  } catch {
    return null;
  }
}

export function getUpstreamManifestVersion(info: PluginSourceInfo): string | null {
  if (info.isGit) return null;
  const resolved = info.source.replace(/^~/, homeDir());
  const m = loadPluginManifest(resolved);
  return m?.version ?? null;
}

export function newExecSurfaceLabels(
  before: PluginCapabilities,
  after: PluginCapabilities,
): string[] {
  return (Object.keys(PLUGIN_EXEC_SURFACE_LABELS) as Array<keyof PluginCapabilities>)
    .filter((key) => after[key] && !before[key])
    .map((key) => PLUGIN_EXEC_SURFACE_LABELS[key]);
}

export async function updatePlugin(
  name: string,
  options: { allowExecSurfaces?: boolean } = {},
): Promise<{
  success: boolean;
  error?: string;
  blockedByExecSurfaces?: boolean;
  newExecSurfaces?: string[];
  hasExecSurfaces?: boolean;
}> {
  const plugin = getPlugin(name);
  if (!plugin) {
    return { success: false, error: `Plugin '${name}' not found` };
  }

  const sourceFile = path.join(plugin.root, SOURCE_FILE);
  if (!fs.existsSync(sourceFile)) {
    return { success: false, error: `No source recorded for '${name}' — was it installed with 'agents plugins install'?` };
  }

  let sourceInfo: { source: string; isGit: boolean };
  try {
    sourceInfo = JSON.parse(fs.readFileSync(sourceFile, 'utf-8')) as { source: string; isGit: boolean };
  } catch {
    return { success: false, error: `Could not read source info for '${name}'` };
  }

  const before = inspectPluginCapabilities(plugin.root);

  const quarantine = path.join(
    path.dirname(plugin.root),
    `.${path.basename(plugin.root)}.update-quarantine`,
  );
  const cleanupQuarantine = () => {
    try { fs.rmSync(quarantine, { recursive: true, force: true }); } catch {  }
  };
  cleanupQuarantine();

  try {
    if (sourceInfo.isGit) {
      fs.cpSync(plugin.root, quarantine, { recursive: true });
      execFileSync('git', ['-C', quarantine, 'pull', '--ff-only'], { stdio: 'pipe' });
    } else {
      const resolvedSource = sourceInfo.source.replace(/^~/, homeDir());
      if (!fs.existsSync(resolvedSource)) {
        cleanupQuarantine();
        return { success: false, error: `Source path no longer exists: ${resolvedSource}` };
      }
      fs.cpSync(resolvedSource, quarantine, { recursive: true });
    }

    const after = inspectPluginCapabilities(quarantine);
    const newSurfaces = newExecSurfaceLabels(before, after);

    if (newSurfaces.length > 0 && options.allowExecSurfaces !== true) {
      cleanupQuarantine();
      return {
        success: false,
        blockedByExecSurfaces: true,
        newExecSurfaces: newSurfaces,
        error:
          `Update refused: '${name}' introduces new executable surfaces (${newSurfaces.join(', ')}). ` +
          `Re-run with --allow-exec-surfaces if you trust the source.`,
      };
    }

    const userConfigPath = path.join(plugin.root, USER_CONFIG_FILE);
    const userConfigBackup = fs.existsSync(userConfigPath)
      ? fs.readFileSync(userConfigPath, 'utf-8')
      : null;
    fs.rmSync(plugin.root, { recursive: true, force: true });
    fs.renameSync(quarantine, plugin.root);
    if (userConfigBackup !== null) {
      fs.writeFileSync(userConfigPath, userConfigBackup, 'utf-8');
    }

    const freshVersion = loadPluginManifest(plugin.root)?.version;
    fs.writeFileSync(
      path.join(plugin.root, SOURCE_FILE),
      JSON.stringify({ ...sourceInfo, version: freshVersion }),
      'utf-8',
    );

    return { success: true, newExecSurfaces: newSurfaces, hasExecSurfaces: hasPluginExecSurfaces(after) };
  } catch (err) {
    cleanupQuarantine();
    return { success: false, error: (err as Error).message };
  }
}
