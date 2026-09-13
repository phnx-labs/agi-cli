/**
 * Native plugin marketplaces for Claude / OpenClaw — one per DotAgents repo.
 *
 * Every DotAgents repo that holds plugins synthesizes its OWN synthetic local
 * marketplace under each version's plugin directory, named after the repo:
 *
 *   <versionHome>/.{claude,openclaw}/plugins/
 *     known_marketplaces.json                    # registers each repo's marketplace
 *     marketplaces/agents-cli/                    # ~/.agents/plugins/*        (user repo)
 *     marketplaces/agents-<alias>/                # ~/.agents-<alias>/plugins/* (extra repo)
 *     marketplaces/agents-project/                # <cwd>/.agents/plugins/*    (project repo)
 *       .claude-plugin/marketplace.json           # synthesized catalog
 *       plugins/<plugin>/                         # copied plugin source
 *
 * Plus the version's settings.json gets
 *   `enabledPlugins["<plugin>@<marketplace>"] = true`.
 *
 * This produces native `/plugin:skill` slash namespacing, visibility in
 * `/plugins`, `/plugin enable|disable` support, AND honest attribution (the
 * user can see which repo each plugin came from) — matching the Claude Code
 * spec at https://code.claude.com/docs/en/plugins and /plugin-marketplaces.
 *
 * The naming policy lives in one place — marketplaceNameFor(). Source-side
 * discovery (discoverMarketplaces) and per-version synthesis (syncMarketplaceManifest
 * / registerMarketplace / syncAllMarketplaces) all key off a MarketplaceSpec so
 * the catalog name and on-disk layout are derived, never hard-coded per call.
 */

import * as fs from 'fs';
import { agentConfigDirName } from '../agents.js';
import * as path from 'path';
import type { AgentId, DiscoveredPlugin, PluginManifest, MarketplaceSpec, DiscoveredMarketplace } from '../types.js';
import { getPluginsDir, getEnabledExtraRepos, getProjectPluginsDir, getSystemPluginsDir } from '../state.js';

/**
 * Canonical name for the user-repo marketplace (~/.agents/plugins/). Kept as an
 * exported constant for callers that operate on the user repo directly and for
 * the `marketplaces/agents-cli/` on-disk path that existing installs already have.
 */
export const MARKETPLACE_NAME = 'agents-cli';
export const SYSTEM_MARKETPLACE_NAME = 'agents-system';

/** Marketplace name for <cwd>/.agents/plugins/*. */
export const PROJECT_MARKETPLACE_NAME = 'agents-project';

interface KnownMarketplaceEntry {
  source: { source: 'directory' | 'local'; path: string };
  installLocation: string;
  lastUpdated: string;
  autoUpdate?: boolean;
}

/**
 * Droid tracks INSTALLED plugins in .factory/plugins/installed_plugins.json —
 * a registry distinct from the marketplace catalog. A plugin is only visible to
 * `droid plugin list` (and loaded at runtime) when it has an entry here; the
 * marketplace copy + enabledPlugins alone are not enough. Verified against the
 * Factory CLI (droid 0.161.0): `droid plugin install` writes exactly this shape,
 * and pointing `installPath` at the marketplace install dir (no separate cache
 * copy) lists the plugin as Active.
 */
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

/**
 * GitHub Copilot CLI records plugin state across TWO files under COPILOT_HOME
 * (`~/.copilot`), both distinct from the marketplace catalog. Verified against
 * Copilot CLI 1.0.56 (`plugin marketplace add` + `plugin install`):
 *
 *   settings.json  { extraKnownMarketplaces, enabledPlugins }  (user-editable)
 *   config.json    { installedPlugins }                        (auto-managed)
 *
 * A plugin is only visible to `copilot plugin list` (and loaded at runtime) when
 * it has an installedPlugins entry in config.json; the marketplace + enabledPlugins
 * alone are not enough. `cache_path` may point at the marketplace install dir —
 * no separate copy is needed (confirmed: `plugin list` lists it and `plugin
 * marketplace list` shows the marketplace as registered).
 */
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

export interface MarketplaceManifest {
  $schema?: string;
  name: string;
  description?: string;
  owner: { name: string; email?: string };
  plugins: MarketplacePluginEntry[];
}

/** Result of synthesizing + registering one marketplace via syncAllMarketplaces. */
export interface SyncAllResult {
  spec: MarketplaceSpec;
  name: string;
  plugins: number;
}

// ─── Naming policy (single source of truth) ──────────────────────────────────

/**
 * Map a MarketplaceSpec to its catalog name. This is the ONLY place that
 * encodes the repo → name policy; every other function derives the name here.
 */
export function marketplaceNameFor(spec: MarketplaceSpec): string {
  switch (spec.kind) {
    case 'user':    return MARKETPLACE_NAME;          // "agents-cli"
    case 'extra':   return `agents-${spec.alias}`;    // e.g. "agents-extras"
    case 'project': return PROJECT_MARKETPLACE_NAME;  // "agents-project"
    case 'system':  return SYSTEM_MARKETPLACE_NAME;   // "agents-system"
  }
}

/** Resolve a spec-or-name argument to the bare marketplace name string. */
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

// ─── Source-side discovery ────────────────────────────────────────────────────

/**
 * Discover every DotAgents repo that contributes plugins, in precedence order
 * (user, then each enabled extra repo, then the project repo when cwd has one).
 * No agent / version is involved — this walks source-side plugin roots only.
 *
 * A repo is included when its plugins/ directory exists on disk. The user repo
 * is always probed; extras come from getEnabledExtraRepos() (already filtered to
 * enabled + on-disk repos); the project repo is included only when
 * <cwd>/.agents/plugins/ exists.
 */
export function discoverMarketplaces(opts: { cwd?: string } = {}): DiscoveredMarketplace[] {
  const out: DiscoveredMarketplace[] = [];

  // System repo — npm-shipped defaults (~/.agents/.system/plugins/) → the
  // "agents-system" marketplace. Listed FIRST so it has the lowest precedence:
  // consumers that dedupe by plugin name keep the LAST occurrence, letting
  // user / extra / project plugins of the same name override a system one (same
  // direction collectPluginScopes() in project-launch.ts uses). Without this,
  // `agents sync` never discovers system plugins, so cleanOrphanedPluginSkills
  // trashes whatever a project launch installed under agents-system and the
  // marketplace gets unregistered on the next sync.
  const systemRoot = getSystemPluginsDir();
  if (dirExists(systemRoot)) {
    const spec: MarketplaceSpec = { kind: 'system', root: systemRoot };
    out.push({ spec, name: marketplaceNameFor(spec), pluginsRoot: systemRoot, description: descriptionFor(spec) });
  }

  // User repo — always the canonical "agents-cli" marketplace.
  const userRoot = getPluginsDir();
  if (dirExists(userRoot)) {
    const spec: MarketplaceSpec = { kind: 'user' };
    out.push({ spec, name: marketplaceNameFor(spec), pluginsRoot: userRoot, description: descriptionFor(spec) });
  }

  // Extra repos — peer ~/.agents-<alias>/ clones (and user-owned path:-repos).
  for (const extra of getEnabledExtraRepos()) {
    const pluginsRoot = path.join(extra.dir, 'plugins');
    if (!dirExists(pluginsRoot)) continue;
    const spec: MarketplaceSpec = { kind: 'extra', alias: extra.alias, root: pluginsRoot };
    out.push({ spec, name: marketplaceNameFor(spec), pluginsRoot, description: descriptionFor(spec) });
  }

  // Project repo — <cwd>/.agents/plugins/.
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

// ─── Per-version paths ────────────────────────────────────────────────────────

function pluginsRootForVersion(agent: AgentId, versionHome: string): string {
  // Muse Code keeps its plugin store under XDG data (`~/.local/share/muse/plugins`),
  // not under the config dir. Under HOME isolation the version home is $HOME.
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
  // Copilot resolves a marketplace's catalog from `marketplace.json` at the
  // marketplace ROOT (also `.plugin/marketplace.json`, `.github/plugin/
  // marketplace.json`) — NOT `.claude-plugin/marketplace.json`. Verified against
  // GitHub Copilot CLI 1.0.56 (`plugin marketplace add`).
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

// ─── Copy plugin source into a marketplace ────────────────────────────────────

/**
 * Copy plugin source into the marketplace install dir for the given spec.
 * Source of truth remains the plugin's source dir — this is a per-version snapshot.
 *
 * Symlinks pointing OUTSIDE the plugin source root are dropped. They show up
 * when plugin authors (legitimately) link prompt-side references to sibling
 * codebases — e.g. the rush plugin's `app -> ../../../rush/app` for @app/...
 * autocomplete in user prompts. Faithfully copying those symlinks pollutes
 * the marketplace with gigabytes of node_modules / .next / brand-asset video
 * that the consumer (Claude Code, OpenClaw) then walks during plugin
 * discovery — which is the documented cause of multi-minute startup hangs.
 *
 * Internal symlinks (target stays inside the plugin root) are preserved.
 */
export function copyPluginToMarketplace(
  plugin: DiscoveredPlugin,
  spec: MarketplaceSpec | string,
  agent: AgentId,
  versionHome: string
): string {
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
        // Dangling symlink or stat failure — drop it; it can't be useful in
        // the marketplace and would error the consumer's walk anyway.
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

// ─── Manifest validation ─────────────────────────────────────────────────────

/**
 * Claude Code's plugin-manifest schema requires the resource path fields to be
 * relative paths starting with "./" — `skills`/`commands`/`agents` are
 * `union([startsWith("./"), array(startsWith("./"))])` (verified against the
 * Claude Code binary). Bare names like "loop" fail validation and Claude rejects
 * the ENTIRE plugin at load time, surfacing only in its `/plugin` > Errors tab.
 *
 * agents-cli copies plugin.json verbatim into the marketplace, so a malformed
 * manifest ships looking fully installed while loading nothing. This catches the
 * unambiguous type violation (non-"./" string entries) and returns one warning
 * per offending field so the caller can surface it loudly. `hooks`/`mcpServers`
 * are intentionally skipped — they legitimately accept inline objects, so a path
 * check would false-positive.
 */
export function validateClaudePluginManifest(manifest: unknown): string[] {
  const warnings: string[] = [];
  if (!manifest || typeof manifest !== 'object') return warnings;
  const m = manifest as Record<string, unknown>;

  for (const field of ['skills', 'commands', 'agents'] as const) {
    const value = m[field];
    if (value === undefined || value === null) continue;

    // How-to-fix written so a human OR a coding agent reading stderr can act
    // without further investigation. Deleting the field is the recommended fix:
    // Claude auto-discovers skills/commands/agents from their directories, which
    // is why every well-formed plugin omits these fields entirely.
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

/**
 * Fields safe to auto-repair by deletion. Scoped to `skills`/`commands` only —
 * NOT `agents`: agents-cli overloads `agents` in plugin.json as its own
 * `AgentId[]` targeting list (bare names like "claude"), so stripping it would
 * destroy real metadata. (`validateClaudePluginManifest` still WARNS on a bare
 * `agents` field; repairing it is a separate, deliberate non-goal here.)
 */
const REPAIRABLE_PATH_FIELDS = ['skills', 'commands'] as const;

/** True when a manifest field holds bare-name entries Claude Code rejects. */
function fieldHasBareEntries(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  const entries = Array.isArray(value) ? value : [value];
  return entries.some((e) => typeof e !== 'string' || !e.startsWith('./'));
}

/**
 * The repairable fields present-and-invalid in a parsed manifest. Drives both
 * the dry-run preview (heal/agents sync) and the actual write below.
 */
export function repairableManifestFields(manifest: unknown): string[] {
  if (!manifest || typeof manifest !== 'object') return [];
  const m = manifest as Record<string, unknown>;
  return REPAIRABLE_PATH_FIELDS.filter((f) => fieldHasBareEntries(m[f]));
}

/**
 * Auto-repair a plugin's SOURCE plugin.json in place: delete any `skills`/
 * `commands` field that holds bare names (Claude Code silently rejects the
 * ENTIRE plugin otherwise). Claude auto-discovers both from their directories,
 * so deletion is the canonical, lossless fix — exactly what the validator's
 * warning already recommends. Returns the fields it dropped (empty = no change).
 *
 * Writes to the source manifest (not the regenerated marketplace copy) so the
 * fix survives the next sync. Pass `{ dryRun }` to preview without writing.
 */
export function repairPluginManifestFile(
  manifestPath: string,
  opts: { dryRun?: boolean } = {},
): string[] {
  if (!fs.existsSync(manifestPath)) return [];
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    return []; // unparseable manifest is a different failure; don't touch it.
  }
  const dropped = repairableManifestFields(manifest);
  if (dropped.length === 0 || opts.dryRun) return dropped;
  for (const f of dropped) delete manifest[f];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  return dropped;
}

// ─── Catalog synthesis ──────────────────────────────────────────────────────

/**
 * Re-synthesize <marketplace>/.claude-plugin/marketplace.json from the plugins
 * already installed under <marketplace>/plugins/. Always run after add or remove
 * so the manifest stays in lockstep with on-disk contents. Returns the manifest
 * it wrote, or null when the marketplace has no plugins dir yet.
 */
export function syncMarketplaceManifest(spec: MarketplaceSpec, agent: AgentId, versionHome: string): MarketplaceManifest | null {
  const name = marketplaceNameFor(spec);
  const root = marketplaceRoot(spec, agent, versionHome);
  const pluginsDir = path.join(root, 'plugins');
  if (!fs.existsSync(pluginsDir)) return null;

  const entries: MarketplacePluginEntry[] = [];
  for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    // Follow symlinks: Dirent.isDirectory() is false for a symlink even when the
    // target is a directory. statSync follows the link.
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
      // Reference the plugin by name, not the marketplace-copy path: that copy is
      // regenerated from source on every sync, so editing it gets stomped. The fix
      // belongs in the plugin's SOURCE .claude-plugin/plugin.json.
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

// ─── Registration in known_marketplaces.json ──────────────────────────────────

/**
 * Register a marketplace in known_marketplaces.json so Claude Code discovers
 * it on startup. Idempotent: re-running just refreshes lastUpdated. Other
 * marketplaces' entries are preserved untouched.
 */
export function registerMarketplace(spec: MarketplaceSpec, agent: AgentId, versionHome: string): void {
  const name = marketplaceNameFor(spec);
  const root = marketplaceRoot(spec, agent, versionHome);

  // Copilot diverges from Claude's known_marketplaces.json: it reads registered
  // marketplaces from settings.json#extraKnownMarketplaces. Verified against
  // GitHub Copilot CLI 1.0.56 (`plugin marketplace add <dir>` writes exactly
  // this shape). A "directory"-source entry points at the on-disk catalog root.
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

  // Droid names the on-disk source type "local" (Claude/OpenClaw use
  // "directory") and stamps autoUpdate — verified against `droid plugin
  // marketplace add`. A "directory" entry is silently ignored by the Factory
  // CLI, so the plugin never resolves.
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

// ─── Droid installed-plugins registry ─────────────────────────────────────────

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
    } catch { /* fall through to fresh registry */ }
  }
  return { schemaVersion: 1, plugins: {} };
}

/**
 * Record a plugin in Droid's installed_plugins.json (user scope), pointing
 * installPath at the marketplace install dir so no second copy is needed. This
 * is what makes `droid plugin list` show the plugin (Active once enabledPlugins
 * is set). Idempotent: re-running refreshes lastUpdated and preserves the
 * original installedAt plus any non-user scope entries.
 */
export function registerDroidInstalledPlugin(
  pluginName: string,
  marketplaceName: string,
  installDir: string,
  version: string,
  agent: AgentId,
  versionHome: string
): void {
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

/** True when Droid's installed_plugins.json carries a user-scope entry for the plugin. */
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

/**
 * Remove a plugin's user-scope entry from Droid's installed_plugins.json.
 * Inverse of registerDroidInstalledPlugin. Drops the key when no scopes remain
 * and deletes the file when the registry is empty.
 */
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
    try { fs.unlinkSync(p); } catch { /* ignore */ }
    return;
  }
  fs.writeFileSync(p, JSON.stringify(registry, null, 2) + '\n', 'utf-8');
}

// ─── Copilot marketplace + installed-plugin registry ──────────────────────────

function copilotConfigPath(agent: AgentId, versionHome: string): string {
  return path.join(versionHome, agentConfigDirName(agent), 'config.json');
}

function readCopilotSettings(agent: AgentId, versionHome: string): Record<string, unknown> {
  const p = settingsPath(agent, versionHome);
  if (fs.existsSync(p)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* fall through */ }
  }
  return {};
}

function writeCopilotSettings(agent: AgentId, versionHome: string, settings: Record<string, unknown>): void {
  const p = settingsPath(agent, versionHome);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

/** Register a marketplace in Copilot's settings.json#extraKnownMarketplaces. */
function registerCopilotMarketplace(name: string, root: string, agent: AgentId, versionHome: string): void {
  const settings = readCopilotSettings(agent, versionHome);
  const known = (settings.extraKnownMarketplaces && typeof settings.extraKnownMarketplaces === 'object'
    ? settings.extraKnownMarketplaces
    : {}) as Record<string, CopilotExtraMarketplace>;
  known[name] = { source: { source: 'directory', path: root } };
  settings.extraKnownMarketplaces = known;
  writeCopilotSettings(agent, versionHome, settings);
}

/** Inverse of registerCopilotMarketplace: drop the entry, prune the empty key. */
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
      // config.json may carry a leading `//` comment banner written by Copilot;
      // strip line comments before parsing so we never clobber a real config.
      const raw = fs.readFileSync(p, 'utf-8').replace(/^\s*\/\/.*$/gm, '');
      const parsed = JSON.parse(raw) as Partial<CopilotConfig>;
      if (parsed && typeof parsed === 'object') {
        return { ...parsed, installedPlugins: Array.isArray(parsed.installedPlugins) ? parsed.installedPlugins : [] };
      }
    } catch { /* fall through to fresh config */ }
  }
  return { installedPlugins: [] };
}

/**
 * Record a plugin in Copilot's config.json#installedPlugins (the registry that
 * makes `copilot plugin list` see it). `cache_path` points at the marketplace
 * install dir — no separate copy. Idempotent: re-running refreshes the entry and
 * preserves the original installed_at plus every other config key.
 */
export function registerCopilotInstalledPlugin(
  pluginName: string,
  marketplaceName: string,
  installDir: string,
  version: string,
  enabled: boolean,
  agent: AgentId,
  versionHome: string
): void {
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

/**
 * Remove a plugin's entry from Copilot's config.json#installedPlugins. Inverse
 * of registerCopilotInstalledPlugin. Leaves the file (with an empty
 * installedPlugins) rather than deleting it, since config.json may hold other
 * Copilot-managed keys.
 */
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

/**
 * Drop a marketplace entry from known_marketplaces.json. Called when the last
 * plugin under it is removed. Removes only its own entry; deletes the file only
 * when no entries remain.
 */
export function unregisterMarketplace(specOrName: MarketplaceSpec | string, agent: AgentId, versionHome: string): void {
  const name = nameOf(specOrName);

  // Copilot stores registrations in settings.json#extraKnownMarketplaces, not
  // known_marketplaces.json. Mirror the branch in registerMarketplace.
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
    } catch { /* ignore */ }
  } else {
    fs.writeFileSync(knownPath, JSON.stringify(known, null, 2) + '\n', 'utf-8');
  }
}

// ─── Top-level orchestration ──────────────────────────────────────────────────

/**
 * Discover every source-side marketplace, then for each one re-synthesize its
 * catalog from the plugins already copied under the version home and register
 * it in known_marketplaces.json. Returns one result per marketplace that has at
 * least one plugin installed.
 *
 * Copying plugin source into a marketplace is the caller's responsibility
 * (copyPluginToMarketplace / syncPluginToVersion) — this reconciles catalogs +
 * registrations across all repos once the copies are in place. Marketplaces
 * whose version-home plugins dir is empty or absent are skipped, so we never
 * register a known_marketplace pointing at a directory with no catalog.
 */
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

// ─── Per-plugin settings ops ──────────────────────────────────────────────────

/**
 * Mark a plugin as enabled in <versionHome>/.{agent}/settings.json under
 * enabledPlugins["<plugin>@<marketplace>"]: true. Reads, mutates, writes —
 * preserving every other key. Trust/exec-surface gating is the caller's
 * responsibility (plugins.ts owns plugin capability inspection).
 */
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

  // Muse refuses to start without schema_version: 1.
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

/**
 * Remove the enabledPlugins key for this plugin. Inverse of addPluginToSettings.
 */
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

// ─── Marketplace teardown helpers ─────────────────────────────────────────────

/**
 * Remove a plugin's installed marketplace directory. Returns true if the dir
 * existed and was removed.
 */
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

/**
 * Return true if the marketplace has no plugins left under it.
 */
export function marketplaceIsEmpty(specOrName: MarketplaceSpec | string, agent: AgentId, versionHome: string): boolean {
  const pluginsDir = path.join(marketplaceRoot(specOrName, agent, versionHome), 'plugins');
  if (!fs.existsSync(pluginsDir)) return true;
  const remaining = fs.readdirSync(pluginsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'));
  return remaining.length === 0;
}

/**
 * Drop the entire marketplace directory. Called after the last plugin removal.
 */
export function removeEmptyMarketplaceDir(specOrName: MarketplaceSpec | string, agent: AgentId, versionHome: string): void {
  const root = marketplaceRoot(specOrName, agent, versionHome);
  if (!fs.existsSync(root)) return;
  fs.rmSync(root, { recursive: true, force: true });
}

/**
 * Detect whether a plugin is installed via the native marketplace path.
 */
export function isInstalledInMarketplace(
  pluginName: string,
  specOrName: MarketplaceSpec | string,
  agent: AgentId,
  versionHome: string
): boolean {
  const installed = path.join(marketplaceRoot(specOrName, agent, versionHome), 'plugins', pluginName);
  return fs.existsSync(path.join(installed, '.claude-plugin', 'plugin.json'));
}
