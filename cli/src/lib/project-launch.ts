/** Launch-time project compile run by the shim via `agents sync --launch`: compiles project rules
 * into AGENTS.md, copies project resources under an ownership manifest (`.agents-managed.json`),
 * and synthesizes plugin marketplaces. Project/extras plugins never auto-enable exec surfaces. */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentId, MarketplaceSpec } from './types.js';
import { supports } from './capabilities.js';
import {
  getEnabledExtraRepos,
  getExtraPluginsDir,
  getPluginsDir,
  getProjectAgentsDir,
  getProjectPluginsDir,
  getSystemPluginsDir,
} from './state.js';
import { getVersionHomePath } from './installations/versions.js';
import { toPortableKey } from './platform/index.js';
import { compileRulesForProject } from './rules/compile.js';
import { syncProjectResourcesToAgent } from './project-resources.js';
import { discoverPluginsInDir, hasPluginExecSurfaces, inspectPluginCapabilities } from './plugins/plugins.js';
import type { DiscoveredPlugin } from './types.js';
import {
  MARKETPLACE_NAME,
  PROJECT_MARKETPLACE_NAME,
  SYSTEM_MARKETPLACE_NAME,
  addPluginToSettings,
  copyPluginToMarketplace,
  marketplaceNameFor,
  marketplaceRoot,
  pluginInstallDir,
  registerMarketplace,
  removePluginFromSettings,
  syncMarketplaceManifest,
} from './plugins/plugin-marketplace.js';

interface LaunchSyncOptions {
  agent: AgentId;
  version: string;
  cwd: string;
}

interface LaunchSyncResult {
  /** Project rules were re-compiled into cwd/AGENTS.md (+ per-agent symlinks). */
  rulesCompiled: boolean;
  /** Number of workspace resource symlinks created or refreshed. */
  workspaceLinks: number;
  /** Workspace resource paths we left alone because they exist and aren't ours. */
  workspaceSkipped: string[];
  /** Map of marketplace name → plugin names installed under it. */
  marketplaces: Record<string, string[]>;
}

/** Run the launch-time compile; safe every launch (idempotent). On success touches the shim's
 * skip-fast sentinel in `~/.agents/.cache/launch-sync/` so the shim can skip the node spawn when
 * nothing changed. */
export function runLaunchSync(opts: LaunchSyncOptions): LaunchSyncResult {
  const result: LaunchSyncResult = {
    rulesCompiled: false,
    workspaceLinks: 0,
    workspaceSkipped: [],
    marketplaces: {},
  };

  // Step 1: project rules
  try {
    const r = compileRulesForProject(opts.cwd);
    result.rulesCompiled = r.compiled;
  } catch {
    // Don't fail launch on a malformed project rules.yaml.
  }

  // Step 2: workspace resource mirror
  const projectAgentsDir = getProjectAgentsDir(opts.cwd);
  if (projectAgentsDir) {
    const projectResources = syncProjectResourcesToAgent(opts.agent, opts.version, projectAgentsDir);
    result.workspaceLinks = projectResources.synced.length;
    result.workspaceSkipped = projectResources.skipped;
  }

  // Step 3: scoped plugin marketplaces
  result.marketplaces = synthesizeScopedMarketplaces(opts.agent, opts.version, opts.cwd);

  // Touch the shim's skip-fast sentinel. Best-effort — if this fails the
  // shim just won't skip on the next launch, which is correct fallback.
  touchLaunchSentinel(opts.agent, opts.version, opts.cwd);

  return result;
}

/** Path of the shim's skip-fast sentinel for (agent, version, cwd); must match the shim's
 * PROJECT_SLUG (`toPortableKey`: drop the drive colon, fold `\`, `/`, space to `_`). One zero-byte
 * file per tuple accumulates; GC belongs in `agents prune`. */
function launchSentinelPath(agent: AgentId, version: string, cwd: string): string {
  const slug = toPortableKey(cwd);
  // Prefer $HOME (respects test overrides + matches bash's $HOME expansion in
  // the shim), fall back to os.homedir() so the lookup never resolves to '/'
  // if HOME is somehow unset.
  const home = process.env.HOME || os.homedir();
  return path.join(home, '.agents', '.cache', 'launch-sync', `${agent}@${version}@${slug}`);
}

function touchLaunchSentinel(agent: AgentId, version: string, cwd: string): void {
  try {
    const sentinel = launchSentinelPath(agent, version, cwd);
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    // Empty content — purely an mtime carrier for the shim's `[ -nt ]` compare.
    fs.writeFileSync(sentinel, '');
  } catch {
    // best-effort
  }
}

// ─── Step 3: scoped plugin marketplaces ───────────────────────────────────────

interface PluginScope {
  spec: MarketplaceSpec;
  marketplaceName: string;
  pluginsDir: string;
  /** When false, plugins with exec surfaces (.mcp.json, hooks, bin/, scripts/, non-trivial
   * settings.json) are copied but not auto-enabled; the user must run `agents plugins enable`.
   * Protects against a hostile `git clone` registering an attacker MCP server via project plugins. */
  autoEnableExecSurfaces: boolean;
  /** Precedence rank used to resolve cross-scope plugin name collisions. Higher wins. */
  precedence: number;
}

function makeScope(
  spec: MarketplaceSpec,
  pluginsDir: string,
  autoEnableExecSurfaces: boolean,
  precedence: number,
): PluginScope {
  return { spec, marketplaceName: marketplaceNameFor(spec), pluginsDir, autoEnableExecSurfaces, precedence };
}

function collectPluginScopes(cwd: string): PluginScope[] {
  const scopes: PluginScope[] = [];

  // Precedence: project > extras > user > system. Same direction the rules
  // composition uses (project layer shadows base layers).
  scopes.push(makeScope({ kind: 'system', root: getSystemPluginsDir() }, getSystemPluginsDir(), true, 0));
  scopes.push(makeScope({ kind: 'user' }, getPluginsDir(), true, 1));

  for (const extra of getEnabledExtraRepos()) {
    const root = getExtraPluginsDir(extra.alias);
    scopes.push(makeScope({ kind: 'extra', alias: extra.alias, root }, root, false, 2));
  }

  const projectPluginsDir = getProjectPluginsDir(cwd);
  if (projectPluginsDir) {
    scopes.push(makeScope({ kind: 'project', root: projectPluginsDir }, projectPluginsDir, false, 3));
  }

  return scopes;
}

function synthesizeScopedMarketplaces(agent: AgentId, version: string, cwd: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};

  if (!supports(agent, 'plugins', version).ok) return result;

  let versionHome: string;
  try {
    versionHome = getVersionHomePath(agent, version);
  } catch {
    return result;
  }
  if (!fs.existsSync(versionHome)) return result;

  // First pass: resolve cross-scope plugin name collisions by precedence.
  // For each plugin name, the scope with the highest precedence wins; the
  // plugin is installed only into that scope's marketplace.
  const winner = new Map<string, { scope: PluginScope; plugin: DiscoveredPlugin }>();
  for (const scope of collectPluginScopes(cwd)) {
    if (!fs.existsSync(scope.pluginsDir)) continue;
    for (const plugin of discoverPluginsInDir(scope.pluginsDir)) {
      const existing = winner.get(plugin.name);
      if (!existing || scope.precedence > existing.scope.precedence) {
        winner.set(plugin.name, { scope, plugin });
      }
    }
  }
  if (winner.size === 0) return result;

  // Group winners by their winning scope and synthesize one marketplace per
  // scope. Skip-fast: scope hash sentinel short-circuits unchanged scopes.
  const byScope = new Map<string, { scope: PluginScope; plugins: DiscoveredPlugin[] }>();
  for (const { scope, plugin } of winner.values()) {
    let bucket = byScope.get(scope.marketplaceName);
    if (!bucket) {
      bucket = { scope, plugins: [] };
      byScope.set(scope.marketplaceName, bucket);
    }
    bucket.plugins.push(plugin);
  }

  for (const { scope, plugins } of byScope.values()) {
    plugins.sort((a, b) => a.name.localeCompare(b.name));
    const installed = installScope(agent, versionHome, scope, plugins);
    if (installed.length > 0) result[scope.marketplaceName] = installed;
  }

  // Sweep any orphaned `<plugin>@*` keys whose plugin name is now owned by a
  // different scope (e.g. plugin moved from user to project). Without this,
  // the OLD scope's enabledPlugins key stays set forever, double-enabling.
  pruneLosingScopeEnables(agent, versionHome, winner);

  return result;
}

function installScope(
  agent: AgentId,
  versionHome: string,
  scope: PluginScope,
  plugins: DiscoveredPlugin[],
): string[] {
  const newHash = computeScopeHash(plugins);
  const sentinelPath = path.join(marketplaceRoot(scope.spec, agent, versionHome), '.agents-launch-sync');
  const existingHash = readScopeHash(sentinelPath);

  if (existingHash === newHash) {
    // Nothing changed since last launch — fast path. Verify the manifest
    // dir still exists; if a user blew it away, force a re-sync.
    if (fs.existsSync(path.dirname(sentinelPath))) {
      return plugins.map((p) => p.name);
    }
  }

  const installed: string[] = [];
  for (const plugin of plugins) {
    try {
      copyPluginToMarketplace(plugin, scope.spec, agent, versionHome);
      installed.push(plugin.name);
    } catch {
      // Individual plugin copy failure — keep going on the others.
    }
  }
  if (installed.length === 0) return [];

  syncMarketplaceManifest(scope.spec, agent, versionHome);
  registerMarketplace(scope.spec, agent, versionHome);

  // Enable each plugin in settings unless the scope withholds auto-enable for
  // exec surfaces (project + extras) AND the plugin actually ships any.
  for (const plugin of plugins) {
    if (!installed.includes(plugin.name)) continue;
    if (!scope.autoEnableExecSurfaces && hasPluginExecSurfaces(inspectPluginCapabilities(plugin.root))) continue;
    addPluginToSettings(plugin.name, scope.marketplaceName, agent, versionHome);
  }

  writeScopeHash(sentinelPath, newHash);
  return installed;
}

function pruneLosingScopeEnables(
  agent: AgentId,
  versionHome: string,
  winner: Map<string, { scope: PluginScope; plugin: DiscoveredPlugin }>,
): void {
  const ourScopeNames = new Set([
    SYSTEM_MARKETPLACE_NAME,
    MARKETPLACE_NAME,
    PROJECT_MARKETPLACE_NAME,
    ...getEnabledExtraRepos().map((e) => marketplaceNameFor({ kind: 'extra', alias: e.alias, root: getExtraPluginsDir(e.alias) })),
  ]);

  for (const [name, { scope: winningScope }] of winner) {
    for (const candidateScope of ourScopeNames) {
      if (candidateScope === winningScope.marketplaceName) continue;
      removePluginFromSettings(name, candidateScope, agent, versionHome);
    }
  }
}

/** Hash the plugin set to skip fast when nothing changed: source path (moves), plugin.json content
 * (metadata edits), and per-file mtime+size (code edits). */
function computeScopeHash(plugins: DiscoveredPlugin[]): string {
  const hash = crypto.createHash('sha256');
  for (const plugin of [...plugins].sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(`${plugin.name}\0${plugin.root}\0`);
    fingerprintDir(plugin.root, hash);
    hash.update('\0SEP\0');
  }
  return hash.digest('hex');
}

function fingerprintDir(dir: string, hash: crypto.Hash): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      hash.update(`D ${entry.name}\n`);
      fingerprintDir(abs, hash);
    } else {
      try {
        const stat = fs.lstatSync(abs);
        hash.update(`F ${entry.name} ${stat.size} ${stat.mtimeMs}\n`);
      } catch { /* race during launch — skip */ }
    }
  }
}

function readScopeHash(sentinelPath: string): string | null {
  try { return fs.readFileSync(sentinelPath, 'utf-8').trim(); }
  catch { return null; }
}

function writeScopeHash(sentinelPath: string, hash: string): void {
  try {
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, hash + '\n');
  } catch { /* best-effort; missing sentinel just means next launch does full work */ }
}

// Re-export for the test's structural assertions; not used internally.
export { pluginInstallDir };
