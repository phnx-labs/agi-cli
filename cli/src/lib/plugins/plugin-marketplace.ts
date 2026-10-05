
import * as fs from 'fs';
import { agentConfigDirName } from '../agents.js';
import * as path from 'path';
import type { AgentId, DiscoveredPlugin, PluginManifest, MarketplaceSpec, DiscoveredMarketplace } from '../types.js';
import { getPluginsDir, getEnabledExtraRepos, getProjectPluginsDir, getSystemPluginsDir } from '../state.js';

export const MARKETPLACE_NAME = 'agents-cli';
export const SYSTEM_MARKETPLACE_NAME = 'agents-system';

export const PROJECT_MARKETPLACE_NAME = 'agents-project';

interface KnownMarketplaceEntry {
  source: { source: 'directory' | 'local'; path: string };
  installLocation: string;
  lastUpdated: string;
  autoUpdate?: boolean;
}

interface DroidInstalledEntry {
  scope: string;
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
  source: string;
}

interface DroidInstalledPlugins {
  schemaVersion: number;
  plugins: Record<string, DroidInstalledEntry[]>;
}

interface CopilotExtraMarketplace {
  source: { source: 'directory'; path: string };
}

interface CopilotInstalledPluginEntry {
  name: string;
  marketplace: string;
  version: string;
  installed_at: string;
  enabled: boolean;
  cache_path: string;
}

interface CopilotConfig {
  installedPlugins: CopilotInstalledPluginEntry[];
  [key: string]: unknown;
}

interface MarketplacePluginEntry {
  name: string;
  source: string;
  description?: string;
  version?: string;
  author?: { name: string; email?: string };
}

interface MarketplaceManifest {
  $schema?: string;
  name: string;
  description?: string;
  owner: { name: string; email?: string };
  plugins: MarketplacePluginEntry[];
}

export interface SyncAllResult {
  spec: MarketplaceSpec;
  name: string;
  plugins: number;
}


export function marketplaceNameFor(spec: MarketplaceSpec): string {
  switch (spec.kind) {
    case 'user':    return MARKETPLACE_NAME;
    case 'extra':   return `agents-${spec.alias}`;
    case 'project': return PROJECT_MARKETPLACE_NAME;
    case 'system':  return SYSTEM_MARKETPLACE_NAME;
  }
}

function nameOf(specOrName: MarketplaceSpec | string): string {
  return typeof specOrName === 'string' ? specOrName : marketplaceNameFor(specOrName);
}

function descriptionFor(spec: MarketplaceSpec): string {
  switch (spec.kind) {
    case 'user':    return 'Plugins from the user repo (~/.agents/plugins/)';
    case 'extra':   return `Plugins from extra repo "${spec.alias}" (~/.agents-${spec.alias}/plugins/)`;
    case 'project': return 'Project-scoped plugins from <cwd>/.agents/plugins/';
    case 'system':  return 'Plugins from the system repo (~/.agents/.system/plugins/)';
  }
}


export function discoverMarketplaces(opts: { cwd?: string } = {}): DiscoveredMarketplace[] {
  const out: DiscoveredMarketplace[] = [];

  const systemRoot = getSystemPluginsDir();
  if (dirExists(systemRoot)) {
    const spec: MarketplaceSpec = { kind: 'system', root: systemRoot };
    out.push({ spec, name: marketplaceNameFor(spec), pluginsRoot: systemRoot, description: descriptionFor(spec) });
  }

  const userRoot = getPluginsDir();
  if (dirExists(userRoot)) {
    const spec: MarketplaceSpec = { kind: 'user' };
    out.push({ spec, name: marketplaceNameFor(spec), pluginsRoot: userRoot, description: descriptionFor(spec) });
  }

  for (const extra of getEnabledExtraRepos()) {
    const pluginsRoot = path.join(extra.dir, 'plugins');
    if (!dirExists(pluginsRoot)) continue;
    const spec: MarketplaceSpec = { kind: 'extra', alias: extra.alias, root: pluginsRoot };
    out.push({ spec, name: marketplaceNameFor(spec), pluginsRoot, description: descriptionFor(spec) });
  }

  const projectRoot = getProjectPluginsDir(opts.cwd ?? process.cwd());
  if (projectRoot && dirExists(projectRoot)) {
    const spec: MarketplaceSpec = { kind: 'project', root: projectRoot };
    out.push({ spec, name: marketplaceNameFor(spec), pluginsRoot: projectRoot, description: descriptionFor(spec) });
  }

  return out;
}

function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}


function pluginsRootForVersion(agent: AgentId, versionHome: string): string {
  if (agent === 'muse') {
    return path.join(versionHome, '.local', 'share', 'muse', 'plugins');
  }
  return path.join(versionHome, agentConfigDirName(agent), 'plugins');
}

export function marketplaceRoot(specOrName: MarketplaceSpec | string, agent: AgentId, versionHome: string): string {
  return path.join(pluginsRootForVersion(agent, versionHome), 'marketplaces', nameOf(specOrName));
}

export function marketplaceManifestPath(specOrName: MarketplaceSpec | string, agent: AgentId, versionHome: string): string {
  const root = marketplaceRoot(specOrName, agent, versionHome);
  if (agent === 'copilot') return path.join(root, 'marketplace.json');
  return path.join(root, '.claude-plugin', 'marketplace.json');
}

export function pluginInstallDir(plugin: DiscoveredPlugin, specOrName: MarketplaceSpec | string, agent: AgentId, versionHome: string): string {
  return path.join(marketplaceRoot(specOrName, agent, versionHome), 'plugins', plugin.name);
}

export function knownMarketplacesPath(agent: AgentId, versionHome: string): string {
  return path.join(pluginsRootForVersion(agent, versionHome), 'known_marketplaces.json');
}

function settingsPath(agent: AgentId, versionHome: string): string {
  return path.join(versionHome, agentConfigDirName(agent), 'settings.json');
}


export function copyPluginToMarketplace(
  plugin: DiscoveredPlugin,
  spec: MarketplaceSpec | string,
  agent: AgentId,
  versionHome: string
): string {
  // Preserve internal links, but never copy a symlink that escapes the plugin source root.
  const dest = pluginInstallDir(plugin, spec, agent, versionHome);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }

  const sourceRealRoot = (() => {
    try { return fs.realpathSync(plugin.root); }
    catch { return plugin.root; }
  })();
  const skipped: string[] = [];

  fs.cpSync(plugin.root, dest, {
    recursive: true,
    dereference: false,
    filter: (src) => {
      try {
        const stat = fs.lstatSync(src);
        if (!stat.isSymbolicLink()) return true;
        const target = fs.realpathSync(src);
        if (target === sourceRealRoot || target.startsWith(sourceRealRoot + path.sep)) {
          return true;
        }
        skipped.push(path.relative(plugin.root, src) || path.basename(src));
        return false;
      } catch {
        skipped.push(path.relative(plugin.root, src) || path.basename(src));
        return false;
      }
    },
  });

  if (skipped.length > 0) {
    process.stderr.write(
      `agents-cli: plugin '${plugin.name}' has ${skipped.length} symlink(s) ` +
      `pointing outside its source root; not copied to marketplace ` +
      `(would bloat consumer startup): ${skipped.join(', ')}\n`
    );
  }

  return dest;
}


export function validateClaudePluginManifest(manifest: unknown): string[] {
  const warnings: string[] = [];
  if (!manifest || typeof manifest !== 'object') return warnings;
  const m = manifest as Record<string, unknown>;

  for (const field of ['skills', 'commands', 'agents'] as const) {
    const value = m[field];
    if (value === undefined || value === null) continue;

    const fix =
      `Fix: delete the "${field}" field from plugin.json (recommended — Claude ` +
      `auto-discovers from the ${field}/ directory), or rewrite every entry as a ` +
      `"./"-relative path (e.g. "./${field}/<name>").`;

    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries) {
      if (typeof entry !== 'string') {
        warnings.push(
          `field "${field}" must be a "./"-relative path string or an array of them; ` +
          `found a non-string entry. Claude Code silently rejects the ENTIRE plugin. ${fix}`
        );
        break;
      }
      if (!entry.startsWith('./')) {
        warnings.push(
          `field "${field}" entry "${entry}" must be a relative path starting with "./" ` +
          `(e.g. "./${field}/${entry}"), not a bare name. Claude Code silently rejects the ` +
          `ENTIRE plugin — no commands or skills load. ${fix}`
        );
        break;
      }
    }
  }

  return warnings;
}

const REPAIRABLE_PATH_FIELDS = ['skills', 'commands'] as const;

function fieldHasBareEntries(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  const entries = Array.isArray(value) ? value : [value];
  return entries.some((e) => typeof e !== 'string' || !e.startsWith('./'));
}

export function repairableManifestFields(manifest: unknown): string[] {
  if (!manifest || typeof manifest !== 'object') return [];
  const m = manifest as Record<string, unknown>;
  return REPAIRABLE_PATH_FIELDS.filter((f) => fieldHasBareEntries(m[f]));
}

export function repairPluginManifestFile(
  manifestPath: string,
  opts: { dryRun?: boolean } = {},
): string[] {
  if (!fs.existsSync(manifestPath)) return [];
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    return [];
  }
  const dropped = repairableManifestFields(manifest);
  if (dropped.length === 0 || opts.dryRun) return dropped;
  for (const f of dropped) delete manifest[f];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  return dropped;
}


export function syncMarketplaceManifest(spec: MarketplaceSpec, agent: AgentId, versionHome: string): MarketplaceManifest | null {
  const name = marketplaceNameFor(spec);
  const root = marketplaceRoot(spec, agent, versionHome);
  const pluginsDir = path.join(root, 'plugins');
  if (!fs.existsSync(pluginsDir)) return null;

  const entries: MarketplacePluginEntry[] = [];
  for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const entryPath = path.join(pluginsDir, entry.name);
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      try { isDir = fs.statSync(entryPath).isDirectory(); } catch { isDir = false; }
    }
    if (!isDir) continue;

    const manifestFile = path.join(entryPath, '.claude-plugin', 'plugin.json');
    if (!fs.existsSync(manifestFile)) continue;

    let manifest: PluginManifest & { author?: { name: string; email?: string } };
    try {
      manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));
    } catch {
      continue;
    }

    for (const warning of validateClaudePluginManifest(manifest)) {
      process.stderr.write(
        `agents-cli: plugin '${manifest.name ?? entry.name}' has a Claude-invalid manifest — ${warning}\n`
      );
    }

    entries.push({
      name: manifest.name,
      source: `./plugins/${manifest.name}`,
      description: manifest.description,
      version: manifest.version,
      ...(manifest.author ? { author: manifest.author } : {}),
    });
  }

  const manifest: MarketplaceManifest = {
    $schema: 'https://anthropic.com/claude-code/marketplace.schema.json',
    name,
    description: descriptionFor(spec),
    owner: { name: 'agents-cli' },
    plugins: entries.sort((a, b) => a.name.localeCompare(b.name)),
  };

  const manifestPath = marketplaceManifestPath(spec, agent, versionHome);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  return manifest;
}


export function registerMarketplace(spec: MarketplaceSpec, agent: AgentId, versionHome: string): void {
  // Native marketplace registries are harness-owned records; update only our named entry.
  const name = marketplaceNameFor(spec);
  const root = marketplaceRoot(spec, agent, versionHome);

  if (agent === 'copilot') {
    registerCopilotMarketplace(name, root, agent, versionHome);
    return;
  }

  const knownPath = knownMarketplacesPath(agent, versionHome);

  let known: Record<string, KnownMarketplaceEntry> = {};
  if (fs.existsSync(knownPath)) {
    try {
      known = JSON.parse(fs.readFileSync(knownPath, 'utf-8'));
    } catch {
      known = {};
    }
  }

  const isDroid = agent === 'droid';
  known[name] = {
    source: { source: isDroid ? 'local' : 'directory', path: root },
    installLocation: root,
    lastUpdated: new Date().toISOString(),
    ...(isDroid ? { autoUpdate: true } : {}),
  };

  fs.mkdirSync(path.dirname(knownPath), { recursive: true });
  fs.writeFileSync(knownPath, JSON.stringify(known, null, 2) + '\n', 'utf-8');
}


function installedPluginsPath(agent: AgentId, versionHome: string): string {
  return path.join(pluginsRootForVersion(agent, versionHome), 'installed_plugins.json');
}

function readInstalledPlugins(agent: AgentId, versionHome: string): DroidInstalledPlugins {
  const p = installedPluginsPath(agent, versionHome);
  if (fs.existsSync(p)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as Partial<DroidInstalledPlugins>;
      if (parsed && typeof parsed === 'object' && parsed.plugins && typeof parsed.plugins === 'object') {
        return { schemaVersion: parsed.schemaVersion ?? 1, plugins: parsed.plugins };
      }
    } catch {  }
  }
  return { schemaVersion: 1, plugins: {} };
}

export function registerDroidInstalledPlugin(
  pluginName: string,
  marketplaceName: string,
  installDir: string,
  version: string,
  agent: AgentId,
  versionHome: string
): void {
  // Replace our user-scope record while retaining other scopes and unrelated registry keys.
  const registry = readInstalledPlugins(agent, versionHome);
  const key = `${pluginName}@${marketplaceName}`;
  const now = new Date().toISOString();
  const existing = registry.plugins[key] ?? [];
  const priorUser = existing.find(e => e.scope === 'user');
  const others = existing.filter(e => e.scope !== 'user');
  registry.plugins[key] = [
    ...others,
    {
      scope: 'user',
      installPath: installDir,
      version,
      installedAt: priorUser?.installedAt ?? now,
      lastUpdated: now,
      source: marketplaceName,
    },
  ];

  const p = installedPluginsPath(agent, versionHome);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(registry, null, 2) + '\n', 'utf-8');
}

export function isDroidPluginInstalled(
  pluginName: string,
  marketplaceName: string,
  agent: AgentId,
  versionHome: string
): boolean {
  const registry = readInstalledPlugins(agent, versionHome);
  const entries = registry.plugins[`${pluginName}@${marketplaceName}`];
  return Array.isArray(entries) && entries.some(e => e.scope === 'user');
}

export function unregisterDroidInstalledPlugin(
  pluginName: string,
  marketplaceName: string,
  agent: AgentId,
  versionHome: string
): void {
  const p = installedPluginsPath(agent, versionHome);
  if (!fs.existsSync(p)) return;
  const registry = readInstalledPlugins(agent, versionHome);
  const key = `${pluginName}@${marketplaceName}`;
  const entries = registry.plugins[key];
  if (!Array.isArray(entries)) return;

  const kept = entries.filter(e => e.scope !== 'user');
  if (kept.length > 0) {
    registry.plugins[key] = kept;
  } else {
    delete registry.plugins[key];
  }

  if (Object.keys(registry.plugins).length === 0) {
    try { fs.unlinkSync(p); } catch {  }
    return;
  }
  fs.writeFileSync(p, JSON.stringify(registry, null, 2) + '\n', 'utf-8');
}


function copilotConfigPath(agent: AgentId, versionHome: string): string {
  return path.join(versionHome, agentConfigDirName(agent), 'config.json');
}

function readCopilotSettings(agent: AgentId, versionHome: string): Record<string, unknown> {
  const p = settingsPath(agent, versionHome);
  if (fs.existsSync(p)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {  }
  }
  return {};
}

function writeCopilotSettings(agent: AgentId, versionHome: string, settings: Record<string, unknown>): void {
  const p = settingsPath(agent, versionHome);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

function registerCopilotMarketplace(name: string, root: string, agent: AgentId, versionHome: string): void {
  // Copilot stores marketplace ownership in settings; preserve every unrelated setting/key.
  const settings = readCopilotSettings(agent, versionHome);
  const known = (settings.extraKnownMarketplaces && typeof settings.extraKnownMarketplaces === 'object'
    ? settings.extraKnownMarketplaces
    : {}) as Record<string, CopilotExtraMarketplace>;
  known[name] = { source: { source: 'directory', path: root } };
  settings.extraKnownMarketplaces = known;
  writeCopilotSettings(agent, versionHome, settings);
}

function unregisterCopilotMarketplace(name: string, agent: AgentId, versionHome: string): void {
  const p = settingsPath(agent, versionHome);
  if (!fs.existsSync(p)) return;
  const settings = readCopilotSettings(agent, versionHome);
  const known = settings.extraKnownMarketplaces as Record<string, CopilotExtraMarketplace> | undefined;
  if (!known || !(name in known)) return;
  delete known[name];
  if (Object.keys(known).length === 0) delete settings.extraKnownMarketplaces;
  writeCopilotSettings(agent, versionHome, settings);
}

function readCopilotConfig(agent: AgentId, versionHome: string): CopilotConfig {
  const p = copilotConfigPath(agent, versionHome);
  if (fs.existsSync(p)) {
    try {
      const raw = fs.readFileSync(p, 'utf-8').replace(/^\s*\/\/.*$/gm, '');
      const parsed = JSON.parse(raw) as Partial<CopilotConfig>;
      if (parsed && typeof parsed === 'object') {
        return { ...parsed, installedPlugins: Array.isArray(parsed.installedPlugins) ? parsed.installedPlugins : [] };
      }
    } catch {  }
  }
  return { installedPlugins: [] };
}

export function registerCopilotInstalledPlugin(
  pluginName: string,
  marketplaceName: string,
  installDir: string,
  version: string,
  enabled: boolean,
  agent: AgentId,
  versionHome: string
): void {
  // Replace only the matching marketplace identity and preserve all unrelated installations.
  const config = readCopilotConfig(agent, versionHome);
  const now = new Date().toISOString();
  const prior = config.installedPlugins.find(e => e.name === pluginName && e.marketplace === marketplaceName);
  const others = config.installedPlugins.filter(e => !(e.name === pluginName && e.marketplace === marketplaceName));
  config.installedPlugins = [
    ...others,
    {
      name: pluginName,
      marketplace: marketplaceName,
      version,
      installed_at: prior?.installed_at ?? now,
      enabled,
      cache_path: installDir,
    },
  ];

  const p = copilotConfigPath(agent, versionHome);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

export function unregisterCopilotInstalledPlugin(
  pluginName: string,
  marketplaceName: string,
  agent: AgentId,
  versionHome: string
): void {
  const p = copilotConfigPath(agent, versionHome);
  if (!fs.existsSync(p)) return;
  const config = readCopilotConfig(agent, versionHome);
  const kept = config.installedPlugins.filter(e => !(e.name === pluginName && e.marketplace === marketplaceName));
  if (kept.length === config.installedPlugins.length) return;
  config.installedPlugins = kept;
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

export function unregisterMarketplace(specOrName: MarketplaceSpec | string, agent: AgentId, versionHome: string): void {
  const name = nameOf(specOrName);

  if (agent === 'copilot') {
    unregisterCopilotMarketplace(name, agent, versionHome);
    return;
  }

  const knownPath = knownMarketplacesPath(agent, versionHome);
  if (!fs.existsSync(knownPath)) return;

  let known: Record<string, KnownMarketplaceEntry>;
  try {
    known = JSON.parse(fs.readFileSync(knownPath, 'utf-8'));
  } catch {
    return;
  }

  if (!(name in known)) return;
  delete known[name];

  if (Object.keys(known).length === 0) {
    try {
      fs.unlinkSync(knownPath);
    } catch {  }
  } else {
    fs.writeFileSync(knownPath, JSON.stringify(known, null, 2) + '\n', 'utf-8');
  }
}


export function syncAllMarketplaces(agent: AgentId, versionHome: string, opts: { cwd?: string } = {}): SyncAllResult[] {
  const results: SyncAllResult[] = [];
  for (const dm of discoverMarketplaces(opts)) {
    const manifest = syncMarketplaceManifest(dm.spec, agent, versionHome);
    if (!manifest || manifest.plugins.length === 0) continue;
    registerMarketplace(dm.spec, agent, versionHome);
    results.push({ spec: dm.spec, name: dm.name, plugins: manifest.plugins.length });
  }
  return results;
}


export function addPluginToSettings(pluginName: string, marketplaceName: string, agent: AgentId, versionHome: string): void {
  const sPath = settingsPath(agent, versionHome);
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(sPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(sPath, 'utf-8'));
    } catch {
      settings = {};
    }
  }

  if (agent === 'muse' && settings.schema_version === undefined) {
    settings.schema_version = 1;
  }

  if (!settings.enabledPlugins || typeof settings.enabledPlugins !== 'object') {
    settings.enabledPlugins = {};
  }
  const enabled = settings.enabledPlugins as Record<string, boolean>;
  const key = `${pluginName}@${marketplaceName}`;
  if (enabled[key] === true) return;
  enabled[key] = true;

  fs.mkdirSync(path.dirname(sPath), { recursive: true });
  fs.writeFileSync(sPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

export function removePluginFromSettings(pluginName: string, marketplaceName: string, agent: AgentId, versionHome: string): void {
  const sPath = settingsPath(agent, versionHome);
  if (!fs.existsSync(sPath)) return;

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(fs.readFileSync(sPath, 'utf-8'));
  } catch {
    return;
  }

  const enabled = settings.enabledPlugins as Record<string, boolean> | undefined;
  if (!enabled) return;

  const key = `${pluginName}@${marketplaceName}`;
  if (!(key in enabled)) return;
  delete enabled[key];

  if (Object.keys(enabled).length === 0) {
    delete settings.enabledPlugins;
  }

  fs.writeFileSync(sPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}


export function removePluginFromMarketplace(
  pluginName: string,
  specOrName: MarketplaceSpec | string,
  agent: AgentId,
  versionHome: string
): boolean {
  const installed = path.join(marketplaceRoot(specOrName, agent, versionHome), 'plugins', pluginName);
  if (!fs.existsSync(installed)) return false;
  fs.rmSync(installed, { recursive: true, force: true });
  return true;
}

export function marketplaceIsEmpty(specOrName: MarketplaceSpec | string, agent: AgentId, versionHome: string): boolean {
  const pluginsDir = path.join(marketplaceRoot(specOrName, agent, versionHome), 'plugins');
  if (!fs.existsSync(pluginsDir)) return true;
  const remaining = fs.readdirSync(pluginsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'));
  return remaining.length === 0;
}

export function removeEmptyMarketplaceDir(specOrName: MarketplaceSpec | string, agent: AgentId, versionHome: string): void {
  const root = marketplaceRoot(specOrName, agent, versionHome);
  if (!fs.existsSync(root)) return;
  fs.rmSync(root, { recursive: true, force: true });
}

export function isInstalledInMarketplace(
  pluginName: string,
  specOrName: MarketplaceSpec | string,
  agent: AgentId,
  versionHome: string
): boolean {
  const installed = path.join(marketplaceRoot(specOrName, agent, versionHome), 'plugins', pluginName);
  return fs.existsSync(path.join(installed, '.claude-plugin', 'plugin.json'));
}
