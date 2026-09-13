/**
 * Plugin management commands.
 *
 * Registers the `agents plugins` command tree for listing, viewing,
 * syncing, and removing plugin bundles (skills + hooks + permissions)
 * stored in ~/.agents/plugins/.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Command } from 'commander';
import { withAliases } from '../lib/verbs.js';
import chalk from 'chalk';
import { homeDir } from '../lib/platform/index.js';
import { input } from '@inquirer/prompts';

import { agentLabel } from '../lib/agents.js';
import { capableAgents, isCapable } from '../lib/capabilities.js';
import type { AgentId, DiscoveredPlugin, PluginManifest } from '../lib/types.js';
import {
  discoverPlugins,
  getPlugin,
  pluginSupportsAgent,
  removePluginFromVersion,
  isPluginSynced,
  installPlugin,
  updatePlugin,
  loadUserConfig,
  saveUserConfig,
  checkPluginDependencies,
  hasPluginExecSurfaces,
  inspectPluginCapabilities,
  pluginCapabilityLabels,
  parseInstallSpec,
  syncPluginToVersion,
  pluginResourceGroups,
  type PluginCapabilities,
} from '../lib/plugins/plugins.js';
import {
  listInstalledVersions,
  syncResourcesToVersion,
  getGlobalDefault,
  getVersionHomePath,
} from '../lib/installations/versions.js';
import {
  isPromptCancelled,
  isInteractiveTerminal,
  requireDestructiveArg,
  requireInteractiveSelection,
  promptRemovalTargets,
  type RemovalTarget,
} from './utils.js';
import { itemPicker } from '../lib/picker.js';
import {
  showResourceList,
  buildTargetsSection,
  type ResourceRow,
  type SyncTarget,
} from './resource-view.js';
import { getPluginsDir } from '../lib/state.js';
import { safeJoin } from '../lib/paths.js';
import { discoverMarketplaces } from '../lib/plugins/plugin-marketplace.js';

/** Replace the home directory prefix with ~ for display. */
function formatPath(p: string): string {
  const home = homeDir();
  if (home && p.startsWith(home)) {
    return '~' + p.slice(home.length);
  }
  return p;
}

export function shouldRefusePluginInstall(capabilities: PluginCapabilities, allowExecSurfaces: boolean): boolean {
  return hasPluginExecSurfaces(capabilities) && !allowExecSurfaces;
}

/** Register the `agents plugins` command tree. */
export function registerPluginsCommands(program: Command): void {
  const pluginsCmd = program
    .command('plugins')
    .description('Bundle skills, hooks, and permissions into distributable packages')
    .addHelpText('after', `
Plugins are directories in ~/.agents/plugins/ that bundle skills, hooks, and permission sets into a single installable unit. Each plugin declares which agents it supports and what resources it provides. When you sync a version, agents-cli installs the plugin's contents to that agent's home.

Examples:
  # Interactive picker (TTY) or sync-status table (piped)
  agents plugins list

  # View details for a specific plugin
  agents plugins view rush-toolkit

  # Sync a plugin to specific agents
  agents sync --plugin rush-toolkit claude

  # Remove a plugin from all agents and delete its source
  agents plugins remove rush-toolkit

When to use:
  - Distribution: package related skills, hooks, and permissions for easy sharing
  - Version control: sync plugins selectively to different agent versions
  - Team onboarding: distribute a full toolkit via a single plugin directory
`);

  // Shared list implementation — reused by `list` and the bare `agents plugins` default.
  const runList = async (options: { json?: boolean } = {}) => {
    const plugins = discoverPlugins();

    if (options.json) {
      // Structured dump (name/description + per-agent-version sync targets) — the
      // same rows the table is built from, mirroring `plugins marketplaces --json`.
      console.log(JSON.stringify(plugins.length === 0 ? [] : buildPluginRows(plugins), null, 2));
      return;
    }

    if (plugins.length === 0) {
      console.log(chalk.gray('No plugins found in ~/.agents/plugins/'));
      console.log(chalk.gray('Plugins are directories with .claude-plugin/plugin.json'));
      return;
    }

    await showResourceList({
      resourcePlural: 'plugins',
      resourceSingular: 'plugin',
      extraLabel: 'Version',
      extra2Label: 'Marketplace',
      rows: buildPluginRows(plugins),
      emptyMessage: 'No plugins in ~/.agents/plugins/.',
      centralPath: getPluginsDir(),
    });
  };

  // Bare `agents plugins` → same as `list`. (--json lives on the explicit `list`
  // subcommand only; declaring it on both parent + child makes commander bind the
  // flag to the parent for `plugins list --json`, dropping it from the subcommand.)
  pluginsCmd.action(runList);

  // agents plugins list
  withAliases(pluginsCmd
    .command('list'), 'list')
    .description('Show plugins in a table with sync status across agent versions')
    .option('--json', 'Emit machine-readable JSON')
    .action(runList);

  // agents plugins marketplaces
  const marketplacesCmd = pluginsCmd
    .command('marketplaces')
    .description('List plugin marketplaces — one per DotAgents repo with a plugins/ directory')
    .option('--json', 'Emit machine-readable JSON')
    .action((options: { json?: boolean }) => {
      const rows = collectMarketplaceRows();

      if (options.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }

      if (rows.length === 0) {
        console.log(chalk.gray('No plugin marketplaces found.'));
        console.log(chalk.gray('Add one with: agents repo add <path|gh:user/repo>'));
        return;
      }

      const nameW = Math.max(12, ...rows.map((r) => r.name.length));
      const srcW = Math.max(20, ...rows.map((r) => formatPath(r.source).length));
      console.log();
      console.log(
        `  ${chalk.bold(padCol('NAME', nameW))}  ${chalk.bold(padCol('SOURCE', srcW))}  ${chalk.bold(padCol('PLUGINS', 7))}  ${chalk.bold('ENABLED')}`
      );
      for (const r of rows) {
        console.log(
          `  ${chalk.cyan(padCol(r.name, nameW))}  ${chalk.gray(padCol(formatPath(r.source), srcW))}  ${padCol(String(r.plugins), 7)}  ${r.enabled}`
        );
      }
      console.log();
      console.log(chalk.gray(`${rows.length} marketplace(s) — manage via 'agents repo'.`));
    });

  // Redirect add/remove/etc. on marketplaces to repo commands.
  const marketplaceRedirect = (verb: string) => () => {
    console.log(
      chalk.gray(`Use 'agents repo ${verb === 'add' ? 'add' : verb} <path|gh:user/repo>' to ${verb} a marketplace (one repo = one marketplace).`)
    );
  };
  for (const verb of ['add', 'remove', 'enable', 'disable', 'install', 'rm']) {
    marketplacesCmd
      .command(`${verb} [target]`)
      .description(`Redirects to 'agents repo ${verb}' — marketplaces follow repos`)
      .action(marketplaceRedirect(verb));
  }

  // agents plugins view [name]
  withAliases(pluginsCmd
    .command('view [name]'), 'view')
    .alias('info')
    .description('Show plugin metadata, resources, and installation status across agent versions')
    .addHelpText('after', `
Examples:
  # View details for a plugin
  agents plugins view rush-toolkit

  # 'info' is kept as an alias
  agents plugins info rush-toolkit
`)
    .action(async (nameArg?: string) => {
      let name = nameArg;

      // No name → pick one from the installed plugins.
      if (!name) {
        const discovered = discoverPlugins();
        if (discovered.length === 0) {
          console.log(chalk.gray('No plugins installed in ~/.agents/plugins/'));
          return;
        }
        if (!isInteractiveTerminal()) {
          requireInteractiveSelection('Picking a plugin for `agents plugins view`', [
            'agents plugins view <name>',
            'agents plugins  # to see installed plugins',
          ]);
        }
        try {
          const picked = await itemPicker<DiscoveredPlugin>({
            message: 'Select a plugin:',
            items: discovered,
            filter: (q) => {
              const t = q.trim().toLowerCase();
              if (!t) return discovered;
              return discovered.filter((p) =>
                `${p.name} ${p.manifest.description || ''}`.toLowerCase().includes(t)
              );
            },
            labelFor: (p) => {
              const desc = p.manifest.description ? ` — ${chalk.gray(p.manifest.description)}` : '';
              return `${chalk.cyan(p.name)} ${chalk.gray(`v${p.manifest.version}`)}${desc}`;
            },
            shortIdFor: (p) => p.name,
            pageSize: 10,
            emptyMessage: 'No plugins match.',
            enterHint: 'view info',
          });
          if (!picked) return;
          name = picked.item.name;
        } catch (err) {
          if (isPromptCancelled(err)) return;
          throw err;
        }
      }

      const plugin = getPlugin(name);
      if (!plugin) {
        console.log(chalk.red(`Plugin '${name}' not found`));
        console.log(chalk.gray('Run "agents plugins" to list available plugins'));
        process.exit(1);
      }

      console.log(chalk.bold(`\n${plugin.name}`));
      console.log(`  ${plugin.manifest.description}`);
      console.log(`  ${chalk.gray(`Version: ${plugin.manifest.version}`)}`);
      console.log(`  ${chalk.gray(`Path: ${formatPath(plugin.root)}`)}`);

      const agents = capableAgents('plugins')
        .filter(a => pluginSupportsAgent(plugin, a))
        .map(a => agentLabel(a));
      console.log(`  ${chalk.gray(`Agents: ${agents.join(', ')}`)}`);

      if (plugin.skills.length > 0) {
        console.log(chalk.bold('\n  Skills'));
        for (const skill of plugin.skills) {
          console.log(`    ${chalk.cyan(`/${plugin.name}:${skill}`)}`);
        }
      }

      if (plugin.commands.length > 0) {
        console.log(chalk.bold('\n  Commands'));
        for (const cmd of plugin.commands) {
          console.log(`    ${chalk.cyan(`/${plugin.name}:${cmd}`)}`);
        }
      }

      if (plugin.agentDefs.length > 0) {
        console.log(chalk.bold('\n  Subagents'));
        for (const a of plugin.agentDefs) {
          console.log(`    ${chalk.magenta(a)}`);
        }
      }

      if (plugin.hooks.length > 0) {
        console.log(chalk.bold('\n  Hooks'));
        for (const hook of plugin.hooks) {
          console.log(`    ${chalk.yellow(hook)}`);
        }
      }

      if (plugin.mcpServers.length > 0) {
        console.log(chalk.bold('\n  MCP Servers'));
        for (const s of plugin.mcpServers) {
          console.log(`    ${chalk.green(s)}`);
        }
      }

      if (plugin.lspServers.length > 0) {
        console.log(chalk.bold('\n  LSP Servers'));
        for (const s of plugin.lspServers) {
          console.log(`    ${chalk.green(s)}`);
        }
      }

      if (plugin.monitors.length > 0) {
        console.log(chalk.bold('\n  Monitors'));
        for (const m of plugin.monitors) {
          console.log(`    ${chalk.blue(m)}`);
        }
      }

      if (plugin.bin.length > 0) {
        console.log(chalk.bold('\n  Bin'));
        for (const b of plugin.bin) {
          console.log(`    ${chalk.white(b)}`);
        }
      }

      if (plugin.scripts.length > 0) {
        console.log(chalk.bold('\n  Scripts'));
        for (const script of plugin.scripts) {
          console.log(`    ${chalk.gray(script)}`);
        }
      }

      if (plugin.hasSettings) {
        console.log(chalk.bold('\n  Settings'));
        console.log(`    ${chalk.gray('settings.json')}`);
      }

      // Show installation status per agent version
      console.log(chalk.bold('\n  Installation Status'));
      let anyInstalled = false;
      for (const agentId of capableAgents('plugins')) {
        if (!pluginSupportsAgent(plugin, agentId)) continue;
        const versions = listInstalledVersions(agentId);
        if (versions.length === 0) continue;

        for (const v of versions) {
          const versionHome = getVersionHomePath(agentId, v);
          const synced = isPluginSynced(plugin, agentId, versionHome);
          const defaultVer = getGlobalDefault(agentId);
          const label = v === defaultVer ? `${v} (active)` : v;
          const status = synced ? chalk.green('installed') : chalk.gray('not installed');
          console.log(`    ${agentLabel(agentId)}@${label}: ${status}`);
          if (synced) anyInstalled = true;
        }
      }
      if (!anyInstalled) {
        console.log(chalk.gray('    Not installed to any version'));
        console.log(chalk.gray('    Run "agents use <agent>@<version>" to sync plugins'));
      }

      console.log();
    });


  // agents plugins remove [name]
  withAliases(pluginsCmd
    .command('remove [name]'), 'remove')
    .description('Unsync a plugin from all agent versions and optionally delete its source directory')
    .option('--keep-source', 'Keep the directory at ~/.agents/plugins/<name> (only unsync from agents)')
    .addHelpText('after', `
Examples:
  # Remove plugin from agents and delete source
  agents plugins remove rush-toolkit

  # Unsync but keep source directory
  agents plugins remove rush-toolkit --keep-source
`)
    .action(async (nameArg: string | undefined, options: { keepSource?: boolean }) => {
      if (!nameArg) {
        requireDestructiveArg({
          argName: 'name',
          command: 'agents plugins remove',
          itemNoun: 'plugin',
          available: discoverPlugins().map((p) => p.name),
          emptyHint: 'No plugins installed.',
        });
      }
      const name = nameArg;
      const pluginsDir = path.join(homeDir(), '.agents', 'plugins');
      const pluginRoot = safeJoin(pluginsDir, name);

      // Use discovered plugin when present; fall back to name+root if source is already gone
      const plugin = getPlugin(name);
      const resolvedRoot = plugin?.root || pluginRoot;

      if (!plugin && !fs.existsSync(pluginRoot)) {
        console.log(chalk.red(`Plugin '${name}' not found`));
        process.exit(1);
      }

      // Build list of targets that have this plugin synced
      const availableTargets: Array<{ agent: AgentId; version: string }> = [];
      for (const agentId of capableAgents('plugins')) {
        if (plugin && !pluginSupportsAgent(plugin, agentId)) continue;
        const versions = listInstalledVersions(agentId);
        for (const version of versions) {
          const versionHome = getVersionHomePath(agentId, version);
          if (plugin && isPluginSynced(plugin, agentId, versionHome)) {
            availableTargets.push({ agent: agentId, version });
          }
        }
      }

      if (availableTargets.length === 0) {
        console.log(chalk.yellow(`Plugin '${name}' not synced to any version.`));
        if (!options.keepSource && fs.existsSync(pluginRoot)) {
          fs.rmSync(pluginRoot, { recursive: true, force: true });
          console.log(chalk.green(`Deleted ${formatPath(pluginRoot)}`));
        }
        return;
      }

      // Show multi-select picker for targets
      const removalTargets: RemovalTarget[] = availableTargets.map((t) => ({
        agent: t.agent,
        version: t.version,
        label: `${agentLabel(t.agent)}@${t.version}`,
      }));

      const selectedTargets = await promptRemovalTargets(name, removalTargets);

      if (selectedTargets.length === 0) {
        console.log(chalk.gray('Cancelled.'));
        return;
      }

      let totalSkills = 0;
      let totalCommands = 0;
      let totalAgentDefs = 0;
      let totalHooks = 0;
      let totalPerms = 0;
      let totalMcp = 0;
      let versionsTouched = 0;

      for (const target of selectedTargets) {
        const versionHome = getVersionHomePath(target.agent as AgentId, target.version);
        const r = removePluginFromVersion(name, resolvedRoot, target.agent as AgentId, versionHome);
        const anyRemoved =
          r.skills.length > 0 || r.commands.length > 0 || r.agentDefs.length > 0 ||
          r.bin.length > 0 || r.hooks.length > 0 || r.permissions > 0 || r.mcp > 0;
        if (anyRemoved) {
          versionsTouched += 1;
          totalSkills += r.skills.length;
          totalCommands += r.commands.length;
          totalAgentDefs += r.agentDefs.length;
          totalHooks += r.hooks.length;
          totalPerms += r.permissions;
          totalMcp += r.mcp;
          const parts = [
            r.skills.length > 0 ? `${r.skills.length} skill(s)` : null,
            r.commands.length > 0 ? `${r.commands.length} command(s)` : null,
            r.agentDefs.length > 0 ? `${r.agentDefs.length} agent def(s)` : null,
            r.hooks.length > 0 ? `${r.hooks.length} hook(s)` : null,
            r.permissions > 0 ? `${r.permissions} perm(s)` : null,
            r.mcp > 0 ? `${r.mcp} MCP server(s)` : null,
          ].filter(Boolean);
          console.log(`  ${chalk.red('-')} ${target.label}: ${parts.join(', ')}`);
        }
      }

      const summary = [
        totalSkills > 0 ? `${totalSkills} skills` : null,
        totalCommands > 0 ? `${totalCommands} commands` : null,
        totalAgentDefs > 0 ? `${totalAgentDefs} agent defs` : null,
        totalHooks > 0 ? `${totalHooks} hooks` : null,
        totalPerms > 0 ? `${totalPerms} permissions` : null,
        totalMcp > 0 ? `${totalMcp} MCP servers` : null,
      ].filter(Boolean).join(', ') || 'nothing';

      console.log(
        chalk.green(
          `\nUnsynced ${name} from ${versionsTouched} version(s) — ${summary}`
        )
      );

      // Only delete source if ALL targets were selected
      if (!options.keepSource && selectedTargets.length === availableTargets.length) {
        if (fs.existsSync(pluginRoot)) {
          fs.rmSync(pluginRoot, { recursive: true, force: true });
          console.log(chalk.green(`Deleted ${formatPath(pluginRoot)}`));
        }
      } else if (!options.keepSource && selectedTargets.length < availableTargets.length) {
        console.log(chalk.gray(`Source kept — plugin still synced to other versions.`));
      } else {
        console.log(chalk.gray(`Kept source at ${formatPath(pluginRoot)}`));
      }
    });

  // agents plugins add <spec>
  pluginsCmd
    .command('add <spec>')
    .alias('install')
    .description('Install a plugin from a git URL or local path (format: name@source or source)')
    .option('--allow-exec-surfaces', 'Allow installing plugins that ship executable surfaces')
    .addHelpText('after', `
Examples:
  # Install from a git URL
  agents plugins add my-plugin@https://github.com/user/my-plugin.git

  # Install from a local path
  agents plugins add /path/to/plugin

  # Named install from a local path
  agents plugins add rush-toolkit@~/Projects/rush-toolkit

  # 'install' is kept as an alias
  agents plugins install /path/to/plugin
`)
    .action(async (spec: string, options) => {
      console.log(chalk.gray(`Installing plugin from: ${spec}`));

      let name: string;
      let root: string;
      let capabilities: PluginCapabilities;
      try {
        const result = await installPlugin(spec);
        name = result.name;
        root = result.root;
        capabilities = result.capabilities;
      } catch (err) {
        console.log(chalk.red(`Install failed: ${(err as Error).message}`));
        process.exit(1);
      }

      const plugin = getPlugin(name);
      if (!plugin) {
        console.log(chalk.red(`Installed but could not load plugin '${name}'`));
        process.exit(1);
      }
      capabilities = inspectPluginCapabilities(root);

      if (shouldRefusePluginInstall(capabilities, options.allowExecSurfaces === true)) {
        const source = parseInstallSpec(spec).source;
        console.error(chalk.red('Install refused: plugin ships executable surfaces:'));
        for (const label of pluginCapabilityLabels(capabilities)) {
          console.error(`  ${label}`);
        }
        console.error(`This plugin ships executable surfaces. Re-run with --allow-exec-surfaces if you trust the source: ${source}@HEAD`);
        fs.rmSync(root, { recursive: true, force: true });
        process.exit(1);
      }

      // Check dependencies
      const missingDeps = checkPluginDependencies(plugin.manifest);
      if (missingDeps.length > 0) {
        console.log(chalk.yellow(`Warning: missing dependencies: ${missingDeps.join(', ')}`));
        console.log(chalk.gray('Install them with: agents plugins add <name>@<source>'));
      }

      // Prompt for userConfig fields
      if (plugin.manifest.userConfig && plugin.manifest.userConfig.length > 0 && isInteractiveTerminal()) {
        const existingConfig = loadUserConfig(name);
        const newConfig = await promptUserConfig(plugin.manifest, existingConfig);
        if (Object.keys(newConfig).length > 0) {
          saveUserConfig(name, { ...existingConfig, ...newConfig });
          console.log(chalk.gray('User config saved.'));
        }
      }

      // Sync to all supported installed versions
      console.log();
      let synced = 0;
      for (const agentId of capableAgents('plugins')) {
        if (!pluginSupportsAgent(plugin, agentId)) continue;
        const versions = listInstalledVersions(agentId);
        if (versions.length === 0) continue;

        const defaultVer = getGlobalDefault(agentId);
        const targetVersions = defaultVer ? [defaultVer] : [versions[versions.length - 1]];

        for (const version of targetVersions) {
          const didSync = options.allowExecSurfaces === true
            ? syncPluginToVersion(plugin, agentId, getVersionHomePath(agentId, version), { allowExecSurfaces: true }).success
            : syncResourcesToVersion(agentId, version, { plugins: [name] }).plugins.length > 0;
          if (didSync) {
            console.log(chalk.green(`  Synced to ${agentLabel(agentId)}@${version}`));
            synced++;
          }
        }
      }

      if (synced === 0) {
        console.log(chalk.gray('  No supported agent versions installed — run "agents use <agent>@<version>" to sync.'));
      }

      console.log(chalk.bold(`\nInstalled ${plugin.name} v${plugin.manifest.version} to ${formatPath(root)}`));
    });

  // agents plugins update [name]
  pluginsCmd
    .command('update [name]')
    .description('Re-pull a plugin from its original source and re-sync to all versions')
    .option('--allow-exec-surfaces', 'Consent to an update that introduces new executable surfaces (hooks/, bin/, scripts/, .mcp.json, settings.json, permissions/)')
    .addHelpText('after', `
Examples:
  # Update a specific plugin
  agents plugins update rush-toolkit

  # Update all plugins
  agents plugins update

  # Trust an update that adds new executable surfaces
  agents plugins update rush-toolkit --allow-exec-surfaces
`)
    .action(async (nameArg: string | undefined, options: { allowExecSurfaces?: boolean }) => {
      const plugins = nameArg ? [getPlugin(nameArg)].filter(Boolean) as DiscoveredPlugin[] : discoverPlugins();

      if (nameArg && plugins.length === 0) {
        console.log(chalk.red(`Plugin '${nameArg}' not found`));
        process.exit(1);
      }

      if (plugins.length === 0) {
        console.log(chalk.gray('No plugins installed.'));
        return;
      }

      const allowExec = options.allowExecSurfaces === true;

      for (const plugin of plugins) {
        process.stdout.write(`Updating ${plugin.name}... `);
        const result = await updatePlugin(plugin.name, { allowExecSurfaces: allowExec });
        if (!result.success) {
          if (result.blockedByExecSurfaces) {
            // Security (RUSH-1757): the update introduced new executable surfaces.
            // Refuse without renewed consent; the last-good content stays in place.
            console.log(chalk.yellow('skipped'));
            console.log(chalk.yellow(`  Update introduces new executable surfaces: ${(result.newExecSurfaces || []).join(', ')}`));
            console.log(chalk.gray('  Kept the currently-installed revision. Re-run with --allow-exec-surfaces if you trust the source.'));
          } else {
            console.log(chalk.red(`failed — ${result.error || 'unknown error'}`));
          }
          continue;
        }
        console.log(chalk.green('done'));

        // Reload the plugin so the re-sync reads the freshly-applied revision.
        const updated = getPlugin(plugin.name) ?? plugin;

        // Re-sync to all supported installed versions. When the applied revision
        // carries executable surfaces, only enable them if the user consented on
        // this update (--allow-exec-surfaces); otherwise the benign content syncs
        // but stays disabled, matching the install-time trust gate.
        for (const agentId of capableAgents('plugins')) {
          if (!pluginSupportsAgent(updated, agentId)) continue;
          const versions = listInstalledVersions(agentId);
          const defaultVer = getGlobalDefault(agentId);
          const targetVersions = defaultVer ? [defaultVer] : versions.slice(-1);

          for (const version of targetVersions) {
            const didSync = allowExec
              ? syncPluginToVersion(updated, agentId, getVersionHomePath(agentId, version), { allowExecSurfaces: true, version }).success
              : syncResourcesToVersion(agentId, version, { plugins: [updated.name] }).plugins.length > 0;
            if (didSync) {
              console.log(chalk.gray(`  Re-synced to ${agentLabel(agentId)}@${version}`));
            }
          }
        }
      }
    });
}

/**
 * Prompt for missing or empty userConfig fields interactively.
 * Only prompts for fields not already present in existingConfig.
 */
async function promptUserConfig(
  manifest: PluginManifest,
  existingConfig: Record<string, string> = {}
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const fields = manifest.userConfig || [];

  for (const field of fields) {
    if (existingConfig[field.key] !== undefined) continue;

    const defaultValue = field.default ?? '';
    try {
      const value = await input({
        message: field.description + (field.required ? ' (required)' : ' (optional)'),
        default: defaultValue || undefined,
        required: field.required ?? false,
      });
      if (value) {
        result[field.key] = value;
      } else if (defaultValue) {
        result[field.key] = defaultValue;
      }
    } catch (err) {
      if (isPromptCancelled(err)) break;
      throw err;
    }
  }

  return result;
}

function padCol(s: string, w: number): string {
  const raw = s.replace(/\x1b\[[0-9;]*m/g, '');
  if (raw.length >= w) return s;
  return s + ' '.repeat(w - raw.length);
}

interface MarketplaceRow {
  name: string;
  source: string;
  plugins: number;
  enabled: number;
}

/**
 * Build one row per discovered marketplace. `plugins` counts plugin manifests
 * under the marketplace's source pluginsRoot; `enabled` counts entries in the
 * default Claude version's settings.json#enabledPlugins keyed on @<marketplace>.
 */
export function collectMarketplaceRows(): MarketplaceRow[] {
  const marketplaces = discoverMarketplaces();
  const rows: MarketplaceRow[] = [];

  // Find the default Claude version (if any) and read its enabledPlugins map.
  const claudeDefault = isCapable('claude', 'plugins') ? getGlobalDefault('claude') : null;
  let enabledMap: Record<string, boolean> = {};
  if (claudeDefault) {
    const versionHome = getVersionHomePath('claude', claudeDefault);
    const settingsPath = path.join(versionHome, '.claude', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
          enabledPlugins?: Record<string, boolean>;
        };
        enabledMap = parsed.enabledPlugins ?? {};
      } catch { /* ignore parse errors */ }
    }
  }

  for (const m of marketplaces) {
    let pluginCount = 0;
    try {
      for (const entry of fs.readdirSync(m.pluginsRoot, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const root = path.join(m.pluginsRoot, entry.name);
        const manifestFile = path.join(root, '.claude-plugin', 'plugin.json');
        if (fs.existsSync(manifestFile)) pluginCount++;
      }
    } catch { /* ignore unreadable dir */ }

    const suffix = `@${m.name}`;
    const enabled = Object.entries(enabledMap)
      .filter(([key, val]) => val === true && key.endsWith(suffix))
      .length;

    rows.push({ name: m.name, source: m.pluginsRoot, plugins: pluginCount, enabled });
  }

  return rows;
}

/** Convert discovered plugins into rows suitable for the resource list view. */
function buildPluginRows(plugins: DiscoveredPlugin[]): ResourceRow[] {
  const rows: ResourceRow[] = [];

  // Cache version lists per agent once.
  const versionsByAgent = new Map<AgentId, string[]>();
  const defaultsByAgent = new Map<AgentId, string | null>();
  for (const agent of capableAgents('plugins')) {
    versionsByAgent.set(agent, listInstalledVersions(agent));
    defaultsByAgent.set(agent, getGlobalDefault(agent));
  }

  for (const plugin of plugins) {
    const targets: SyncTarget[] = [];

    for (const agent of capableAgents('plugins')) {
      if (!pluginSupportsAgent(plugin, agent)) continue;
      for (const version of versionsByAgent.get(agent) || []) {
        const versionHome = getVersionHomePath(agent, version);
        const installed = isPluginSynced(plugin, agent, versionHome);
        targets.push({
          agent,
          version,
          isDefault: defaultsByAgent.get(agent) === version,
          status: installed ? 'synced' : 'missing',
        });
      }
    }

    rows.push({
      name: plugin.name,
      description: plugin.manifest.description,
      extra: plugin.manifest.version ? `v${plugin.manifest.version}` : '-',
      extra2: plugin.marketplace ?? '-',
      targets,
      buildDetail: () => formatPluginDetail(plugin, targets),
    });
  }

  rows.sort((a, b) => {
    const aSynced = a.targets.filter((t) => t.status === 'synced').length;
    const bSynced = b.targets.filter((t) => t.status === 'synced').length;
    if (aSynced !== bSynced) return bSynced - aSynced;
    return a.name.localeCompare(b.name);
  });

  return rows;
}

/** Per-category color for a plugin resource breakdown (shared with `agents inspect`). */
export const PLUGIN_GROUP_COLORS: Record<string, (s: string) => string> = {
  skills: chalk.cyan,
  commands: chalk.cyan,
  subagents: chalk.magenta,
  hooks: chalk.yellow,
  mcp: chalk.green,
  lsp: chalk.green,
  monitors: chalk.blue,
  bin: chalk.white,
  scripts: chalk.white,
  settings: chalk.gray,
};

/** Human-readable section header per category, used by the picker detail pane. */
const PLUGIN_GROUP_TITLES: Record<string, string> = {
  skills: 'Skills',
  commands: 'Commands',
  subagents: 'Subagents',
  hooks: 'Hooks',
  mcp: 'MCP Servers',
  lsp: 'LSP Servers',
  monitors: 'Monitors',
  bin: 'Bin',
  scripts: 'Scripts',
  settings: 'Settings',
};

/** Build the multi-line detail pane shown when a plugin is selected in the picker. */
function formatPluginDetail(plugin: DiscoveredPlugin, targets: SyncTarget[]): string {
  const lines: string[] = [];

  const title = plugin.manifest.version
    ? `${chalk.bold.cyan(plugin.name)} ${chalk.gray(`v${plugin.manifest.version}`)}`
    : chalk.bold.cyan(plugin.name);
  lines.push(title);

  if (plugin.manifest.description) {
    lines.push(chalk.gray(plugin.manifest.description));
  }

  const supported = capableAgents('plugins')
    .filter((a) => pluginSupportsAgent(plugin, a))
    .map((a) => agentLabel(a));
  if (supported.length > 0) {
    lines.push('  ' + chalk.gray('Supports: ') + supported.join(chalk.gray(' · ')));
  }
  lines.push('  ' + chalk.gray(formatPath(plugin.root)));

  for (const group of pluginResourceGroups(plugin)) {
    const colorFn = PLUGIN_GROUP_COLORS[group.label] ?? chalk.white;
    lines.push('');
    lines.push(chalk.bold(`  ${PLUGIN_GROUP_TITLES[group.label] ?? group.label}`));
    lines.push('  ' + group.items.map((s) => colorFn(s)).join(chalk.gray(', ')));
  }

  if (targets.length > 0) {
    lines.push('');
    lines.push(chalk.bold('  Synced to'));
    lines.push(buildTargetsSection(targets));
  } else {
    lines.push('');
    lines.push(chalk.gray('  No supported agent versions installed.'));
  }

  return lines.join('\n');
}
