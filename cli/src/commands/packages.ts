/** Registers `agents registry`, `search`, `install` and `packages materialize`: discover and
 * install MCP servers, skills, commands and hooks from registries or GitHub, and materialize a
 * schema-v3 agent.yaml package into an ephemeral harness home (PHNX-3838). */

import * as fs from 'fs';
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';

import {
  AGENTS,
  getAllCliStates,
  agentLabel,
} from '../lib/agents.js';
import { capableAgents, isCapable } from '../lib/capabilities.js';
import type { AgentId, McpPackage, RegistryType } from '../lib/types.js';
import { DEFAULT_REGISTRIES } from '../lib/types.js';
import {
  getRegistries,
  setRegistry,
  removeRegistry,
  search as searchRegistries,
  resolvePackage,
  validatedNpmSpec,
  validatedPyPISpec,
  verifySkillIntegrity,
} from '../lib/registry.js';
import { cloneRepo } from '../lib/git.js';
import {
  discoverCommands,
  resolveCommandSource,
  installCommand,
  installCommandCentrally,
} from '../lib/commands.js';
import {
  discoverSkillsFromRepo,
  installSkill,
  installSkillCentrally,
} from '../lib/plugins/skills.js';
import {
  discoverHooksFromRepo,
  installHooks,
  installHooksCentrally,
} from '../lib/hooks/install.js';
import {
  discoverWorkflowsFromRepo,
  installWorkflowCentrally,
} from '../lib/workflows.js';
import {
  discoverSubagentsFromRepo,
  installSubagentCentrally,
} from '../lib/subagents.js';
import {
  discoverPermissionsFromRepo,
  installPermissionSet,
} from '../lib/permissions.js';
import {
  listInstalledVersions,
  resolveInstalledAgentTargets,
  resolveConfiguredAgentTargets,
  syncResourcesToVersion,
} from '../lib/installations/versions.js';
import {
  formatPath,
  isInteractiveTerminal,
  isPromptCancelled,
  parseCommaSeparatedList,
  requireDestructiveArg,
  requireInteractiveSelection,
  resolveInstalledAgentTargetsAutoInstalling,
} from './utils.js';
import { itemPicker } from '../lib/picker.js';
import {
  registerMcpCommandToTargets,
  discoverMcpConfigsFromRepo,
  installMcpConfigCentrally,
  type McpCommandSpec,
} from '../lib/mcp.js';
import { registerPortablePackageCommands } from './packages-materialize.js';

export function buildMcpPackageCommand(pkg: McpPackage): McpCommandSpec {
  const packageName = pkg.name || pkg.registry_name;
  if (pkg.runtime === 'node') {
    return { command: 'npx', args: ['-y', validatedNpmSpec(packageName)] };
  }
  if (pkg.runtime === 'python') {
    return { command: 'uvx', args: [validatedPyPISpec(packageName)] };
  }
  throw new Error(`Unsupported MCP runtime: ${pkg.runtime}. Supported: node, python.`);
}

/** Picker fallback for `registry enable/config [name]`: returns the picked name, or null on cancel;
 * non-TTY shells hard-fail with a reminder of the positional form. */
async function pickRegistryName(
  type: RegistryType,
  verb: string,
  pred?: (cfg: { enabled: boolean; url: string }) => boolean
): Promise<string | null> {
  const registries = getRegistries(type);
  const entries = Object.entries(registries).filter(([, cfg]) => (pred ? pred(cfg) : true));
  if (entries.length === 0) {
    console.log(chalk.gray(`No ${type} registries to ${verb}.`));
    return null;
  }
  if (!isInteractiveTerminal()) {
    requireInteractiveSelection(`Picking a ${type} registry to ${verb}`, [
      `agents registry ${verb} ${type} <name>`,
      `agents registry list --type ${type}`,
    ]);
  }
  const nameW = Math.max(8, ...entries.map(([n]) => n.length));
  type Entry = [string, { enabled: boolean; url: string }];
  try {
    const picked = await itemPicker<Entry>({
      message: `Select a ${type} registry to ${verb}:`,
      items: entries,
      filter: (q) => {
        const t = q.trim().toLowerCase();
        if (!t) return entries;
        return entries.filter(([n, cfg]) => `${n} ${cfg.url}`.toLowerCase().includes(t));
      },
      labelFor: ([n, cfg]) => {
        const status = cfg.enabled ? chalk.green('enabled') : chalk.gray('disabled');
        const isDefault = DEFAULT_REGISTRIES[type]?.[n] ? chalk.gray(' (default)') : '';
        return `${chalk.cyan(n.padEnd(nameW))}${isDefault}  ${status}  ${chalk.gray(cfg.url)}`;
      },
      shortIdFor: ([n]) => n,
      pageSize: 10,
      emptyMessage: 'No registries match.',
      enterHint: verb,
    });
    return picked?.item[0] ?? null;
  } catch (err) {
    if (isPromptCancelled(err)) return null;
    throw err;
  }
}

export function registerPackagesCommands(program: Command): void {
  registerPortablePackageCommands(program);


  const registryCmd = program
    .command('registry')
    .description('Manage package registries');

  registryCmd
    .command('list')
    .description('List configured registries')
    .option('-t, --type <type>', 'Filter by type: mcp or skill')
    .action((options) => {
      const types: RegistryType[] = options.type ? [options.type] : ['mcp', 'skill'];

      console.log(chalk.bold('Configured Registries\n'));

      for (const type of types) {
        console.log(chalk.bold(`  ${type.toUpperCase()}`));

        const registries = getRegistries(type);
        const entries = Object.entries(registries);

        if (entries.length === 0) {
          console.log(chalk.gray('    No registries configured'));
        } else {
          for (const [name, config] of entries) {
            const status = config.enabled ? chalk.green('enabled') : chalk.gray('disabled');
            const isDefault = DEFAULT_REGISTRIES[type]?.[name] ? chalk.gray(' (default)') : '';
            console.log(`    ${name}${isDefault}: ${status}`);
            console.log(chalk.gray(`      ${config.url}`));
          }
        }
        console.log();
      }

      console.log(
        chalk.gray("  See also: agents plugins marketplaces — plugin marketplaces (managed via 'agents repo')")
      );
    });

  registryCmd
    .command('add <type> <name> <url>')
    .description('Add a registry (type: mcp or skill)')
    .option('--api-key <key>', 'API key for authentication')
    .action((type: string, name: string, url: string, options) => {
      if (type !== 'mcp' && type !== 'skill') {
        console.log(chalk.red(`Invalid type '${type}'. Use 'mcp' or 'skill'.`));
        process.exit(1);
      }

      setRegistry(type as RegistryType, name, {
        url,
        enabled: true,
        apiKey: options.apiKey,
      });

      console.log(chalk.green(`Added ${type} registry '${name}'`));
    });

  registryCmd
    .command('remove <type> [name]')
    .description('Remove a registry')
    .action((type: string, nameArg: string | undefined) => {
      if (type !== 'mcp' && type !== 'skill') {
        console.log(chalk.red(`Invalid type '${type}'. Use 'mcp' or 'skill'.`));
        process.exit(1);
      }

      if (!nameArg) {
        const registries = getRegistries(type as RegistryType);
        const removable = Object.keys(registries).filter(
          (n) => !DEFAULT_REGISTRIES[type as RegistryType]?.[n]
        );
        requireDestructiveArg({
          argName: 'name',
          command: `agents registry remove ${type}`,
          itemNoun: `${type} registry`,
          available: removable,
          emptyHint: `No user-added ${type} registries to remove. (Defaults can't be removed — disable them instead.)`,
        });
      }
      const name = nameArg;

      if (DEFAULT_REGISTRIES[type as RegistryType]?.[name]) {
        console.log(chalk.yellow(`Cannot remove default registry '${name}'. Use 'agents registry disable' instead.`));
        process.exit(1);
      }

      if (removeRegistry(type as RegistryType, name)) {
        console.log(chalk.green(`Removed ${type} registry '${name}'`));
      } else {
        console.log(chalk.yellow(`Registry '${name}' not found`));
      }
    });

  registryCmd
    .command('enable <type> [name]')
    .description('Enable a registry')
    .action(async (type: string, nameArg: string | undefined) => {
      if (type !== 'mcp' && type !== 'skill') {
        console.log(chalk.red(`Invalid type '${type}'. Use 'mcp' or 'skill'.`));
        process.exit(1);
      }

      let name = nameArg;
      if (!name) {
        const picked = await pickRegistryName(type as RegistryType, 'enable', (cfg) => !cfg.enabled);
        if (!picked) return;
        name = picked;
      }

      const registries = getRegistries(type as RegistryType);
      if (!registries[name]) {
        console.log(chalk.yellow(`Registry '${name}' not found`));
        process.exit(1);
      }

      setRegistry(type as RegistryType, name, { enabled: true });
      console.log(chalk.green(`Enabled ${type} registry '${name}'`));
    });

  registryCmd
    .command('disable <type> [name]')
    .description('Disable a registry')
    .action((type: string, nameArg: string | undefined) => {
      if (type !== 'mcp' && type !== 'skill') {
        console.log(chalk.red(`Invalid type '${type}'. Use 'mcp' or 'skill'.`));
        process.exit(1);
      }

      if (!nameArg) {
        const registries = getRegistries(type as RegistryType);
        const candidates = Object.entries(registries)
          .filter(([, cfg]) => cfg.enabled)
          .map(([n]) => n);
        requireDestructiveArg({
          argName: 'name',
          command: `agents registry disable ${type}`,
          itemNoun: `${type} registry`,
          available: candidates,
          emptyHint: `No enabled ${type} registries to disable.`,
        });
      }
      const name = nameArg;

      const registries = getRegistries(type as RegistryType);
      if (!registries[name]) {
        console.log(chalk.yellow(`Registry '${name}' not found`));
        process.exit(1);
      }

      setRegistry(type as RegistryType, name, { enabled: false });
      console.log(chalk.green(`Disabled ${type} registry '${name}'`));
    });

  registryCmd
    .command('config <type> [name]')
    .description('Configure a registry')
    .option('--api-key <key>', 'Set API key')
    .option('--url <url>', 'Update URL')
    .action(async (type: string, nameArg: string | undefined, options) => {
      if (type !== 'mcp' && type !== 'skill') {
        console.log(chalk.red(`Invalid type '${type}'. Use 'mcp' or 'skill'.`));
        process.exit(1);
      }

      let name = nameArg;
      if (!name) {
        const picked = await pickRegistryName(type as RegistryType, 'configure');
        if (!picked) return;
        name = picked;
      }

      const registries = getRegistries(type as RegistryType);
      if (!registries[name]) {
        console.log(chalk.yellow(`Registry '${name}' not found`));
        process.exit(1);
      }

      const updates: Record<string, unknown> = {};
      if (options.apiKey) updates.apiKey = options.apiKey;
      if (options.url) updates.url = options.url;

      if (Object.keys(updates).length === 0) {
        console.log(chalk.yellow('No options provided. Use --api-key or --url.'));
        process.exit(1);
      }

      setRegistry(type as RegistryType, name, updates);
      console.log(chalk.green(`Updated ${type} registry '${name}'`));
    });


  program
    .command('search <query>')
    .description('Find packages (MCP servers, skills) across configured registries')
    .option('-t, --type <type>', 'Limit to mcp or skill packages')
    .option('-r, --registry <name>', 'Search only this registry')
    .option('-l, --limit <n>', 'Max results to show', '20')
    .addHelpText('after', `
Search finds MCP servers and skills published to registries. Results show the package name, description, and install command.

Examples:
  # Search for MCP servers related to notion
  agents search notion

  # Search only skill packages
  agents search testing --type skill

  # Limit results to the first 10
  agents search api --limit 10

  # Search a specific registry
  agents search postgres --registry smithery

When to use:
  - Finding MCP servers: 'agents search <keyword>' then 'agents install mcp:<name>'
  - Discovering skills: 'agents search <domain> --type skill'
  - Exploring registries: 'agents search <term> --registry <name>'
`)
    .action(async (query: string, options) => {
      const spinner = ora('Searching registries...').start();

      try {
        const results = await searchRegistries(query, {
          type: options.type as RegistryType | undefined,
          registry: options.registry,
          limit: parseInt(options.limit, 10),
        });

        spinner.stop();

        if (results.length === 0) {
          console.log(chalk.yellow('\nNo packages found.'));
          return;
        }

        console.log(chalk.bold(`Found ${results.length} packages`));

        const mcpResults = results.filter((r) => r.type === 'mcp');
        const skillResults = results.filter((r) => r.type === 'skill');

        if (mcpResults.length > 0) {
          console.log(chalk.bold('\n  MCP Servers'));
          for (const result of mcpResults) {
            const desc = result.description
              ? chalk.gray(` - ${result.description.slice(0, 50)}${result.description.length > 50 ? '...' : ''}`)
              : '';
            console.log(`    ${chalk.cyan(result.name)}${desc}`);
            console.log(chalk.gray(`      Registry: ${result.registry}  Install: agents add mcp:${result.name}`));
          }
        }

        if (skillResults.length > 0) {
          console.log(chalk.bold('\n  Skills'));
          for (const result of skillResults) {
            const desc = result.description
              ? chalk.gray(` - ${result.description.slice(0, 50)}${result.description.length > 50 ? '...' : ''}`)
              : '';
            console.log(`    ${chalk.cyan(result.name)}${desc}`);
            console.log(chalk.gray(`      Registry: ${result.registry}  Install: agents add skill:${result.name}`));
          }
        }
      } catch (err) {
        spinner.fail('Search failed');
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });


  program
    .command('install <identifier>')
    .description('Install a package: mcp:, skill:, plugin:, or GitHub (gh:user/repo) — one install path (Phase 5)')
    .option('-a, --agents <list>', 'Targets: claude, codex@0.116.0, or cursor@default')
    .option(
      '--types <list>',
      'When source is a repo: comma-separated resource types to install (skills,workflows,commands,hooks,permissions,subagents,mcp)'
    )
    .option(
      '--names <list>',
      'When source is a repo: comma-separated resource names within the selected types'
    )
    .option('-y, --yes', 'Auto-install any missing agent versions without prompting')
    .option('--allow-exec-surfaces', 'With plugin: allow plugins that ship hooks/mcp/bin (same as agents plugins install)')
    .addHelpText('after', `
Install is the unified add path (Phase 5 packaging). Prefix the identifier:

  mcp:<name>       MCP server from a registry
  skill:<name>     skill from a registry (or gh: fallback)
  plugin:<spec>    plugin — same grammar as agents plugins install (name@url or path)
  gh:user/repo     clone a DotAgents / multi-resource repo and install selected types

Examples:
  agents install mcp:notion --agents claude
  agents install skill:animator --agents claude,codex
  agents install plugin:my-plugin@https://github.com/user/my-plugin.git
  agents install plugin:~/Projects/rush-toolkit
  agents install gh:anthropics/skills --agents codex,claude
  agents install gh:phnx-labs/.agents-system --types skills,workflows --agents claude@all

Specialized verbs still work (agents plugins install, agents skills add) and
delegate to the same underlying installers.
`)
    .action(async (identifier: string, options) => {
      const spinner = ora('Resolving package...').start();

      try {
        const resolved = await resolvePackage(identifier);

        if (!resolved) {
          spinner.fail('Package not found');
          console.log(chalk.gray('\nTip: Use explicit prefix (mcp:, skill:, plugin:, gh:) or check the identifier.'));
          process.exit(1);
        }

        spinner.succeed(`Found ${resolved.type} package`);

        if (resolved.type === 'plugin') {
          spinner.stop();
          const spec = resolved.pluginSpec ?? resolved.source;
          console.log(chalk.gray(`Installing plugin from: ${spec}`));
          const {
            installPlugin,
            getPlugin,
            inspectPluginCapabilities,
            pluginCapabilityLabels,
            parseInstallSpec,
            checkPluginDependencies,
            hasPluginExecSurfaces,
            pluginSupportsAgent,
            syncPluginToVersion,
            pluginResourceGroups,
          } = await import('../lib/plugins/plugins.js');
          const { listInstalledVersions, getGlobalDefault, getVersionHomePath, syncResourcesToVersion } =
            await import('../lib/installations/versions.js');
          const { agentLabel } = await import('../lib/agents.js');

          let name: string;
          let root: string;
          try {
            const result = await installPlugin(spec);
            name = result.name;
            root = result.root;
          } catch (err) {
            console.log(chalk.red(`Install failed: ${(err as Error).message}`));
            process.exit(1);
          }

          const plugin = getPlugin(name);
          if (!plugin) {
            console.log(chalk.red(`Installed but could not load plugin '${name}'`));
            process.exit(1);
          }
          const capabilities = inspectPluginCapabilities(root);
          const allowExec = options.allowExecSurfaces === true;
          if (hasPluginExecSurfaces(capabilities) && !allowExec) {
            const source = parseInstallSpec(spec).source;
            console.error(chalk.red('Install refused: plugin ships executable surfaces:'));
            for (const label of pluginCapabilityLabels(capabilities)) {
              console.error(`  ${label}`);
            }
            console.error(
              `Re-run with --allow-exec-surfaces if you trust the source: ${source}@HEAD`,
            );
            fs.rmSync(root, { recursive: true, force: true });
            process.exit(1);
          }

          const missingDeps = checkPluginDependencies(plugin.manifest);
          if (missingDeps.length > 0) {
            console.log(chalk.yellow(`Warning: missing dependencies: ${missingDeps.join(', ')}`));
            console.log(chalk.gray('Install them with: agents install plugin:<name>@<source>'));
          }

          console.log();
          let synced = 0;
          for (const agentId of capableAgents('plugins')) {
            if (!pluginSupportsAgent(plugin, agentId)) continue;
            const versions = listInstalledVersions(agentId);
            if (versions.length === 0) continue;
            const defaultVer = getGlobalDefault(agentId);
            const targetVersions = defaultVer ? [defaultVer] : [versions[versions.length - 1]];
            for (const version of targetVersions) {
              const didSync = allowExec
                ? syncPluginToVersion(plugin, agentId, getVersionHomePath(agentId, version), {
                    allowExecSurfaces: true,
                  }).success
                : syncResourcesToVersion(agentId, version, { plugins: [name] }).plugins.length > 0;
              if (didSync) {
                console.log(chalk.green(`  Synced to ${agentLabel(agentId)}@${version}`));
                synced++;
              }
            }
          }
          if (synced === 0) {
            console.log(
              chalk.gray('  No supported agent versions installed — run "agents use <agent>@<version>" to sync.'),
            );
          }

          console.log(chalk.bold(`\nInstalled ${plugin.name} v${plugin.manifest.version} to ${formatPath(root)}`));
          const groups = pluginResourceGroups(plugin);
          if (groups.length > 0) {
            for (const g of groups) {
              console.log(chalk.gray(`  ${g.label}: ${g.items.slice(0, 8).join(', ')}${g.items.length > 8 ? '…' : ''}`));
            }
          }
          return;
        }

        if (resolved.type === 'mcp') {
          const entry = resolved.mcpEntry;
          if (!entry) {
            console.log(chalk.red('Failed to get MCP server details'));
            process.exit(1);
          }

          console.log(chalk.bold(`\n${entry.name}`));
          if (entry.description) {
            console.log(chalk.gray(`  ${entry.description}`));
          }
          if (entry.repository?.url) {
            console.log(chalk.gray(`  ${entry.repository.url}`));
          }

          const pkg = entry.packages?.[0];
          if (!pkg) {
            console.log(chalk.yellow('\nNo installable package found for this server.'));
            console.log(chalk.gray('You may need to install it manually.'));
            process.exit(1);
          }

          console.log(chalk.bold('\nPackage:'));
          console.log(`  Name: ${pkg.name || pkg.registry_name}`);
          console.log(`  Runtime: ${pkg.runtime || 'unknown'}`);
          console.log(`  Transport: ${pkg.transport || 'stdio'}`);

          if (pkg.packageArguments && pkg.packageArguments.length > 0) {
            console.log(chalk.bold('\nRequired arguments:'));
            for (const arg of pkg.packageArguments) {
              const req = arg.required ? chalk.red('*') : '';
              console.log(`  ${arg.name}${req}: ${arg.description || ''}`);
            }
          }

          let commandSpec: McpCommandSpec;
          try {
            commandSpec = buildMcpPackageCommand(pkg);
          } catch (err) {
            console.log(chalk.red((err as Error).message));
            process.exit(1);
          }

          const cliStates = await getAllCliStates();
          const installedAgents = capableAgents('mcp').filter(
            (id) => cliStates[id]?.installed || listInstalledVersions(id).length > 0
          );
          let targets;
          if (options.agents) {
            const resolved = await resolveInstalledAgentTargetsAutoInstalling(options.agents, capableAgents('mcp'), { yes: options.yes });
            if (!resolved) {
              console.log(chalk.gray('Cancelled.'));
              return;
            }
            targets = resolved;
          } else {
            targets = resolveConfiguredAgentTargets(installedAgents, undefined, capableAgents('mcp'));
          }

          if (targets.selectedAgents.length === 0) {
            console.log(chalk.yellow('\nNo MCP-capable agents installed.'));
            process.exit(1);
          }

          console.log(chalk.bold('\nInstalling to agents...'));
          const results = await registerMcpCommandToTargets(targets, entry.name, commandSpec, 'user');
          for (const result of results) {
            const label = result.version ? `${agentLabel(result.agentId)}@${result.version}` : agentLabel(result.agentId);
            if (result.success) {
              console.log(`  ${chalk.green('+')} ${label}`);
            } else {
              console.log(`  ${chalk.red('x')} ${label}: ${result.error}`);
            }
          }

          console.log(chalk.green('\nMCP server installed.'));
        } else if (resolved.type === 'git' || resolved.type === 'skill') {
          console.log(chalk.bold(`\nInstalling from ${resolved.source}`));

          const { localPath } = await cloneRepo(resolved.source);

          // Integrity: a published skill entry carries the sha256 of its SKILL.md; verify the
          // cloned file before installing anything, and abort on mismatch rather than trust a
          // tampered artifact.
          if (resolved.type === 'skill' && resolved.skillEntry) {
            const check = verifySkillIntegrity(localPath, resolved.skillEntry);
            if (!check.ok) {
              console.log(chalk.red(`\n${check.error}`));
              process.exit(1);
            }
            if (resolved.skillEntry.sha256) {
              console.log(chalk.gray(`  Integrity verified (sha256) for ${resolved.skillEntry.name}`));
            }
          }

          const requestedTypes = new Set(parseCommaSeparatedList(options.types));
          const includeType = (type: string): boolean =>
            requestedTypes.size === 0 || requestedTypes.has(type);

          const requestedNames = new Set(parseCommaSeparatedList(options.names));
          const nameFilter = <T extends { name: string }>(items: T[]): T[] => {
            if (requestedNames.size === 0) return items;
            return items.filter((item) => requestedNames.has(item.name));
          };

          let commands = includeType('commands') ? discoverCommands(localPath) : [];
          let skills = includeType('skills') ? discoverSkillsFromRepo(localPath) : [];
          let hooks = includeType('hooks') ? discoverHooksFromRepo(localPath) : [];
          let workflows = includeType('workflows') ? discoverWorkflowsFromRepo(localPath) : [];
          let subagents = includeType('subagents') ? discoverSubagentsFromRepo(localPath) : [];
          let permissions = includeType('permissions') ? discoverPermissionsFromRepo(localPath) : [];
          let mcpServers = includeType('mcp') ? discoverMcpConfigsFromRepo(localPath) : [];

          if (requestedNames.size > 0) {
            const allNames = new Set<string>([
              ...commands.map((c) => c.name),
              ...skills.map((s) => s.name),
              ...hooks,
              ...workflows.map((w) => w.name),
              ...subagents.map((s) => s.name),
              ...permissions.map((p) => p.name),
              ...mcpServers.map((s) => s.name),
            ]);
            const missing = [...requestedNames].filter((n) => !allNames.has(n));
            if (missing.length > 0) {
              console.log(chalk.red(`\nResource(s) not found in repo: ${missing.join(', ')}`));
              console.log(chalk.gray(`Available: ${[...allNames].sort().join(', ')}`));
              process.exit(1);
            }
            commands = nameFilter(commands);
            skills = nameFilter(skills);
            hooks = hooks.filter((h) => requestedNames.has(h));
            workflows = nameFilter(workflows);
            subagents = nameFilter(subagents);
            permissions = nameFilter(permissions);
            mcpServers = nameFilter(mcpServers);
          }

          const summary: Array<{ kind: string; count: number }> = [
            { kind: 'commands', count: commands.length },
            { kind: 'skills', count: skills.length },
            { kind: 'hooks', count: hooks.length },
            { kind: 'workflows', count: workflows.length },
            { kind: 'subagents', count: subagents.length },
            { kind: 'permissions', count: permissions.length },
            { kind: 'mcp', count: mcpServers.length },
          ].filter((s) => s.count > 0);

          if (summary.length === 0) {
            console.log(chalk.yellow('No installable content found in repository.'));
            if (requestedTypes.size > 0 || requestedNames.size > 0) {
              console.log(chalk.gray('Try removing --types/--names to see everything the repo offers.'));
            }
            process.exit(1);
          }

          console.log(chalk.bold('\nFound:'));
          for (const { kind, count } of summary) {
            console.log(`  ${count} ${kind}`);
          }

          const gitCliStates = await getAllCliStates();
          const installedAgents = capableAgents('commands').filter(
            (id) => gitCliStates[id]?.installed || listInstalledVersions(id).length > 0
          );
          let targets;
          if (options.agents) {
            const resolved = await resolveInstalledAgentTargetsAutoInstalling(options.agents, capableAgents('commands'), { yes: options.yes });
            if (!resolved) {
              console.log(chalk.gray('Cancelled.'));
              return;
            }
            targets = resolved;
          } else {
            targets = resolveConfiguredAgentTargets(installedAgents, undefined, capableAgents('commands'));
          }

          if (targets.selectedAgents.length === 0) {
            console.log(chalk.yellow('\nNo agents selected.'));
            return;
          }

          if (commands.length > 0) {
            console.log(chalk.bold('\nInstalling commands...'));
            let directInstalled = 0;
            let syncedVersions = 0;
            let failed = 0;
            for (const command of commands) {
              const sourcePath = resolveCommandSource(localPath, command.name);
              if (!sourcePath) continue;

              const centralResult = installCommandCentrally(sourcePath, command.name);
              if (!centralResult.success) {
                failed++;
                continue;
              }

              for (const agentId of targets.directAgents) {
                if (!AGENTS[agentId].capabilities.commands) continue;
                if (!gitCliStates[agentId]?.installed && listInstalledVersions(agentId).length === 0) continue;
                const result = installCommand(sourcePath, agentId, command.name, 'symlink');
                if (result.error) {
                  failed++;
                } else {
                  directInstalled++;
                }
              }
            }

            const commandNames = commands.map((command) => command.name);
            for (const [agentId, versions] of targets.versionSelections) {
              for (const version of versions) {
                const result = syncResourcesToVersion(agentId, version, { commands: commandNames });
                if (result.commands) {
                  syncedVersions++;
                }
              }
            }

            console.log(`  Installed ${directInstalled} direct command instance(s)`);
            console.log(`  Synced commands to ${syncedVersions} managed version(s)`);
            if (failed > 0) {
              console.log(`  ${failed} command installation(s) failed`);
            }
          }

          if (skills.length > 0) {
            console.log(chalk.bold('\nInstalling skills...'));
            const directAgents = targets.directAgents.filter(
              (agentId) => AGENTS[agentId].capabilities.skills && gitCliStates[agentId]?.installed
            );
            let syncedVersions = 0;
            for (const skill of skills) {
              const centralResult = installSkillCentrally(skill.path, skill.name);
              if (!centralResult.success) {
                console.log(`  ${chalk.red('x')} ${skill.name}: ${centralResult.error}`);
                continue;
              }
              const result = installSkill(skill.path, skill.name, directAgents);
              const status = result.success ? chalk.green('+') : chalk.red('x');
              const detail = result.success ? skill.name : `${skill.name}: ${result.error}`;
              console.log(`  ${status} ${detail}`);
            }

            const skillNames = skills.map((skill) => skill.name);
            for (const [agentId, versions] of targets.versionSelections) {
              for (const version of versions) {
                const result = syncResourcesToVersion(agentId, version, { skills: skillNames });
                if (result.skills) {
                  syncedVersions++;
                }
              }
            }
            console.log(`  Synced skills to ${syncedVersions} managed version(s)`);
          }

          if (hooks.length > 0) {
            console.log(chalk.bold('\nInstalling hooks...'));
            let syncedVersions = 0;
            const directHookAgents = targets.directAgents.filter(
              (id) => AGENTS[id].supportsHooks && gitCliStates[id]?.installed
            ) as AgentId[];
            const centralResult = await installHooksCentrally(localPath);
            const result = await installHooks(localPath, directHookAgents, { scope: 'user' });
            console.log(`  Installed ${result.installed.length} direct hook instance(s)`);
            if (centralResult.errors.length > 0) {
              console.log(`  ${centralResult.errors.length} hook installation(s) failed in central storage`);
            }

            const hookNames = hooks;
            for (const [agentId, versions] of targets.versionSelections) {
              for (const version of versions) {
                const syncResult = syncResourcesToVersion(agentId, version, { hooks: hookNames });
                if (syncResult.hooks) {
                  syncedVersions++;
                }
              }
            }
            console.log(`  Synced hooks to ${syncedVersions} managed version(s)`);
          }

          if (workflows.length > 0) {
            console.log(chalk.bold('\nInstalling workflows...'));
            let installed = 0;
            for (const w of workflows) {
              const result = installWorkflowCentrally(w.path, w.name);
              if (result.success) {
                installed++;
              } else {
                console.log(`  ${chalk.red('x')} ${w.name}: ${result.error}`);
              }
            }
            const workflowNames = workflows.map((w) => w.name);
            let syncedVersions = 0;
            for (const [agentId, versions] of targets.versionSelections) {
              for (const version of versions) {
                const result = syncResourcesToVersion(agentId, version, { workflows: workflowNames });
                if (result.workflows.length > 0) syncedVersions++;
              }
            }
            console.log(`  Installed ${installed} workflow(s) to ~/.agents/workflows/`);
            console.log(`  Synced workflows to ${syncedVersions} managed version(s)`);
          }

          if (subagents.length > 0) {
            console.log(chalk.bold('\nInstalling subagents...'));
            let installed = 0;
            for (const s of subagents) {
              const result = installSubagentCentrally(s.path, s.name);
              if (result.success) {
                installed++;
              } else {
                console.log(`  ${chalk.red('x')} ${s.name}: ${result.error}`);
              }
            }
            const subagentNames = subagents.map((s) => s.name);
            let syncedVersions = 0;
            for (const [agentId, versions] of targets.versionSelections) {
              for (const version of versions) {
                const result = syncResourcesToVersion(agentId, version, { subagents: subagentNames });
                if (result.subagents.length > 0) syncedVersions++;
              }
            }
            console.log(`  Installed ${installed} subagent(s) to ~/.agents/subagents/`);
            console.log(`  Synced subagents to ${syncedVersions} managed version(s)`);
          }

          if (permissions.length > 0) {
            console.log(chalk.bold('\nInstalling permission sets...'));
            let installed = 0;
            for (const p of permissions) {
              const result = installPermissionSet(p.path, p.name);
              if (result.success) {
                installed++;
              } else {
                console.log(`  ${chalk.red('x')} ${p.name}: ${result.error}`);
              }
            }
            console.log(`  Installed ${installed} permission set(s) to ~/.agents/permissions/`);
            console.log(chalk.gray('  Apply with: agents permissions apply <name> --agents <selector>'));
          }

          if (mcpServers.length > 0) {
            console.log(chalk.bold('\nInstalling MCP server configs...'));
            let installed = 0;
            for (const s of mcpServers) {
              const result = installMcpConfigCentrally(s.path);
              if (result.success) {
                installed++;
              } else {
                console.log(`  ${chalk.red('x')} ${s.name}: ${result.error}`);
              }
            }
            const mcpNames = mcpServers.map((s) => s.name);
            let syncedVersions = 0;
            for (const [agentId, versions] of targets.versionSelections) {
              for (const version of versions) {
                const result = syncResourcesToVersion(agentId, version, { mcp: mcpNames });
                if (result.mcp.length > 0) syncedVersions++;
              }
            }
            console.log(`  Installed ${installed} MCP config(s) to ~/.agents/mcp/`);
            console.log(`  Synced MCP configs to ${syncedVersions} managed version(s)`);
          }

          console.log(chalk.green('\nPackage installed.'));
        }
      } catch (err) {
        spinner.fail('Installation failed');
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}
