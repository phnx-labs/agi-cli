/**
 * MCP (Model Context Protocol) server management commands.
 *
 * Implements `agents mcp` -- list, add, remove, view, and register MCP
 * servers that give agents runtime access to databases, APIs, and external
 * services. Servers are declared in ~/.agents/mcp/ YAML files or the
 * agents.yaml manifest, then registered into each agent version's config.
 */
import type { Command } from 'commander';
import { withAliases } from '../lib/verbs.js';
import chalk from 'chalk';
import { truncate } from '../lib/format.js';
import ora from 'ora';
import { checkbox } from '@inquirer/prompts';

import { capableAgents, isCapable } from '../lib/capabilities.js';
import { emit } from '../lib/feed/events.js';
import {
  AGENTS,
  getAllCliStates,
  resolveAgentName,
  formatAgentError,
  unregisterMcpFromTargets,
  listInstalledMcpsWithScope,
  parseMcpConfig,
  getMcpConfigPathForHome,
  agentLabel,
} from '../lib/agents.js';
import type { AgentId, McpServerConfig } from '../lib/types.js';
import { readManifest, writeManifest, createDefaultManifest } from '../lib/manifest.js';
import {
  listMcpServerConfigs,
  discoverMcpConfigsFromRepo,
  installMcpConfigCentrally,
  isProjectMcpTrusted,
  trustProjectMcp,
  untrustProjectMcp,
  getMcpTrustStorePath,
  type InstalledMcpServer,
} from '../lib/mcp.js';
import { cloneRepo } from '../lib/git.js';
import { getMcpDir, getProjectAgentsDir } from '../lib/state.js';
import {
  getEffectiveHome,
  getGlobalDefault,
  listInstalledVersions,
  getVersionHomePath,
  resolveInstalledAgentTargets,
  syncResourcesToVersion,
} from '../lib/installations/versions.js';
import { getUserAgentsDir } from '../lib/state.js';
import {
  isPromptCancelled,
  isInteractiveTerminal,
  requireInteractiveSelection,
  promptRemovalTargets,
  parseCommaSeparatedList,
  ensureAgentVersionsInstalled,
  resolveAgentTargetsAutoInstalling,
  VersionNotInstalledError,
  type RemovalTarget,
  resolveListFilterOrExit,
} from './utils.js';
import {
  showResourceList,
  buildTargetsSection,
  type ResourceRow,
  type SyncTarget,
} from './resource-view.js';

/**
 * Parse a comma-separated --agents string into validated agent IDs and
 * optional version targets in the manifest shape.
 *
 * Supports the same selector syntax as resolveAgentVersionTargets:
 *   - bare `agent`        → manifest agents:[agent] (no version pin)
 *   - `agent@default`     → manifest agents:[agent] (no version pin)
 *   - `agent@x.y.z`       → manifest agentVersions[agent] = ['x.y.z']
 *   - `agent@all`         → manifest agentVersions[agent] = every installed version
 *   - literal `all`       → expand to all MCP-capable agents (each as `@all`)
 *
 * Throws VersionNotInstalledError for unknown specific versions so callers
 * can prompt-and-install before retrying.
 */
function parseMcpAgentTargets(value: string): {
  agents: AgentId[];
  agentVersions?: Partial<Record<AgentId, string[]>>;
} {
  const agents: AgentId[] = [];
  const agentVersions: Partial<Record<AgentId, string[]>> = {};
  const rawTargets = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  // Expand literal `all` / `all@all` into per-agent @all. Skip agents with no
  // installed versions so `all` is lenient — mirrors resolveAgentVersionTargets.
  const targets: string[] = [];
  for (const t of rawTargets) {
    if (t === 'all' || t === 'all@all') {
      for (const a of capableAgents('mcp')) {
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
    if (!agentId || !isCapable(agentId, 'mcp')) {
      throw new Error(formatAgentError(agentToken, capableAgents('mcp')));
    }

    if (!versionToken) {
      if (!agents.includes(agentId)) {
        agents.push(agentId);
      }
      continue;
    }

    if (versionToken === 'default') {
      if (!getGlobalDefault(agentId)) {
        throw new Error(`No default version set for ${AGENTS[agentId].name}. Run: agents use ${agentId}@<version>`);
      }
      if (!agents.includes(agentId)) {
        agents.push(agentId);
      }
      continue;
    }

    const installedVersions = listInstalledVersions(agentId);
    if (installedVersions.length === 0) {
      throw new Error(`No managed versions are installed for ${AGENTS[agentId].name}. Run: agents add ${agentId}@latest`);
    }

    if (versionToken === 'all') {
      const versions = agentVersions[agentId] || [];
      for (const ver of installedVersions) {
        if (!versions.includes(ver)) versions.push(ver);
      }
      agentVersions[agentId] = versions;
      if (!agents.includes(agentId)) {
        agents.push(agentId);
      }
      continue;
    }

    const resolvedVersion =
      versionToken === 'latest' ? installedVersions[installedVersions.length - 1]
      : versionToken === 'oldest' ? installedVersions[0]
      : versionToken;

    if (!installedVersions.includes(resolvedVersion)) {
      throw new VersionNotInstalledError(agentId, resolvedVersion, installedVersions);
    }

    const versions = agentVersions[agentId] || [];
    if (!versions.includes(resolvedVersion)) {
      versions.push(resolvedVersion);
      agentVersions[agentId] = versions;
    }
  }

  return {
    agents,
    ...(Object.keys(agentVersions).length > 0 ? { agentVersions } : {}),
  };
}

function formatTargetLabel(agentId: AgentId, version?: string): string {
  return version ? `${agentLabel(agentId)}@${version}` : agentLabel(agentId);
}

/** Register the `agents mcp` command tree (list, add, remove, view, register). */
export function registerMcpCommands(program: Command): void {
  const mcpCmd = program
    .command('mcp')
    .description('Connect agents to external tools via Model Context Protocol servers')
    .addHelpText('after', `
MCP servers give agents runtime access to databases, APIs, filesystems, and services. Add a server once, invoke its tools from any agent session. Agents-cli handles registration and configuration across versions.

Examples:
  # List all registered MCP servers
  agents mcp list

  # Check what servers are available for a specific agent
  agents mcp list claude@2.1.112

  # Register a Node-based MCP server
  agents mcp add notion uvx notion-mcp --agents claude,codex

  # Register an HTTP MCP server
  agents mcp add my-api https://api.example.com --transport http --agents claude

  # Apply servers from manifest to specific agents
  agents sync --mcp codex@0.116.0

When to use:
  - After install: 'agents mcp add <server>' to connect a new service
  - Version upgrade: 'agents sync --mcp' to sync servers to the new version
  - Team setup: commit mcp config to .agents and run 'agents sync --mcp'
`);

  withAliases(mcpCmd
    .command('list [agent]'), 'list')
    .description('Show which MCP servers are registered and which agent versions they are synced to')
    .option('-a, --agent <agent>', 'Filter to a specific agent (alternative to positional arg)')
    .option('--json', 'Emit machine-readable JSON instead of the table/picker')
    .action(async (agentArg, options) => {
      const spinner = ora({ text: 'Loading...', isSilent: !process.stdout.isTTY }).start();

      const agentInput = agentArg || options.agent;
      let filterAgent: AgentId | undefined;
      let filterVersion: string | undefined;

      if (agentInput) {
        const parts = agentInput.split('@');
        const resolved = resolveAgentName(parts[0]);
        if (!resolved) {
          spinner.stop();
          console.log(chalk.red(formatAgentError(parts[0], capableAgents('mcp'))));
          process.exit(1);
        }
        filterAgent = resolved;
        filterVersion = resolveListFilterOrExit(resolved, parts[1]);
      }

      const rows = buildMcpRows({ filterAgent, filterVersion });

      spinner.stop();

      await showResourceList({
        resourcePlural: 'MCP servers',
        resourceSingular: 'MCP server',
        extraLabel: 'Source',
        rows,
        emptyMessage: filterAgent
          ? `No MCP servers registered for ${agentLabel(filterAgent)}.`
          : 'No MCP servers registered. Add one with: agents mcp add <name> -- <command>',
        centralPath: getMcpDir(),
        filterAgent,
        filterVersion,
        json: options.json,
      });
    });

  mcpCmd
    .command('trust')
    .description('Trust this project so its .agents/mcp/ servers may be registered and spawned')
    .action(() => {
      const projectAgentsDir = getProjectAgentsDir();
      if (!projectAgentsDir) {
        console.log(chalk.red('Not inside a project (no .agents/ directory found) — nothing to trust.'));
        process.exit(1);
      }
      const servers = listMcpServerConfigs().filter((s) => s.scope === 'project');
      if (servers.length > 0) {
        console.log(chalk.bold('Project-scoped MCP servers that will be trusted to run:'));
        for (const s of servers) {
          console.log('  ' + chalk.cyan(s.name) + '  ' + chalk.white(formatCentralCommand(s)));
        }
      }
      const trusted = trustProjectMcp();
      console.log(chalk.green(`Trusted project MCP servers for: ${trusted}`));
      console.log(chalk.gray(`Recorded in ${getMcpTrustStorePath()} — revoke with: agents mcp untrust`));
    });

  mcpCmd
    .command('untrust')
    .description('Revoke MCP trust for this project (its .agents/mcp/ servers stop auto-applying)')
    .action(() => {
      const projectAgentsDir = getProjectAgentsDir();
      if (!projectAgentsDir) {
        console.log(chalk.red('Not inside a project (no .agents/ directory found).'));
        process.exit(1);
      }
      const removed = untrustProjectMcp();
      if (removed) {
        console.log(chalk.green('Revoked MCP trust for this project.'));
      } else {
        console.log(chalk.gray('This project was not trusted — nothing to revoke.'));
      }
    });

  mcpCmd
    .command('add <name> [command_or_url...]')
    .description('Add an MCP server to the manifest (run "agents sync --mcp" afterward to apply)')
    .option('-a, --agents <list>', 'Targets: claude, codex@0.116.0', capableAgents('mcp').join(','))
    .option('-s, --scope <scope>', 'user (global) or project (repo-specific)', 'user')
    .option('-t, --transport <type>', 'stdio (default) or http', 'stdio')
    .option('--names <list>', 'When source is a repo: MCP server names to install (comma-separated)')
    .option('-y, --yes', 'Auto-install any missing agent versions without prompting')
    .option('-H, --header <header>', 'HTTP header as name:value (repeatable)', (val, acc: string[]) => {
      acc.push(val);
      return acc;
    }, [])
    .addHelpText('after', `
Examples:
  # Add a stdio MCP server (Node-based)
  agents mcp add notion uvx notion-mcp --agents claude,codex

  # Add an HTTP MCP server with auth header
  agents mcp add my-api https://api.example.com --transport http --header "Authorization: Bearer token" --agents claude

  # Add to manifest only (register later)
  agents mcp add db-server -- uvx postgres-mcp

  # Install all MCP server configs from a repo's mcp/*.yaml
  agents mcp add gh:user/repo --agents claude@all

  # Install specific servers by name
  agents mcp add gh:phnx-labs/.agents-system --names notion,figma --agents claude
`)
    .action(async (name: string, commandOrUrl: string[], options) => {
      // Repo-source form: `agents mcp add gh:user/repo [--names a,b] [--agents …]`
      // Mirrors `agents skills add gh:…`. Discovers <repoPath>/mcp/*.yaml,
      // copies to ~/.agents/mcp/, and syncs to selected agent versions.
      const isRepoSource = /^(gh:|git:|ssh:|https?:\/\/)/.test(name);
      if (isRepoSource && commandOrUrl.length === 0) {
        await installMcpsFromRepoSource(name, options);
        return;
      }

      // Registry resolution: if the user just typed `agents mcp add <name>`,
      // try looking up `<name>` in any configured MCP registry (by default the
      // official MCP Registry at registry.modelcontextprotocol.io) and derive
      // the install spec automatically.
      if (commandOrUrl.length === 0) {
        const { getMcpServerInfo, mcpEntryToInstallSpec } = await import('../lib/registry.js');
        const spinner = ora(`Looking up '${name}' in MCP registries…`).start();
        try {
          const entry = await getMcpServerInfo(name);
          if (entry) {
            const spec = mcpEntryToInstallSpec(entry);
            if (spec?.command) {
              commandOrUrl = spec.command.split(' ');
              options.transport = spec.transport;
              spinner.succeed(`Resolved '${name}' → ${chalk.gray(spec.command)}`);
            } else {
              spinner.warn(
                `Found '${name}' in registry but could not derive an install command (likely a remote-only server).`
              );
            }
          } else {
            spinner.fail(`'${name}' not found in any configured MCP registry.`);
          }
        } catch (err) {
          spinner.fail(`Registry lookup failed: ${(err as Error).message}`);
        }
      }

      const transport = options.transport as 'stdio' | 'http';

      if (commandOrUrl.length === 0) {
        console.error(chalk.red('Error: Command or URL required'));
        console.log(chalk.gray('Stdio: agents mcp add <name> -- <command...>'));
        console.log(chalk.gray('HTTP:  agents mcp add <name> <url> --transport http'));
        console.log(chalk.gray("Or list what's discoverable: agents mcp list --available"));
        process.exit(1);
      }

      const localPath = getUserAgentsDir();
      const manifest = readManifest(localPath) || createDefaultManifest();

      manifest.mcp = manifest.mcp || {};

      // Pre-flight: prompt-and-install any requested agent@version that isn't
      // installed yet, before parseMcpAgentTargets validates the selector.
      const okInstall = await ensureAgentVersionsInstalled(options.agents, capableAgents('mcp'), { yes: options.yes });
      if (!okInstall) {
        console.log(chalk.gray('Cancelled.'));
        return;
      }

      const targetConfig = parseMcpAgentTargets(options.agents);

      if (transport === 'http') {
        const url = commandOrUrl[0];
        const headers: Record<string, string> = {};

        if (options.header && options.header.length > 0) {
          for (const h of options.header) {
            const [key, ...valueParts] = h.split(':');
            if (key && valueParts.length > 0) {
              headers[key.trim()] = valueParts.join(':').trim();
            }
          }
        }

        manifest.mcp[name] = {
          url,
          transport: 'http',
          scope: options.scope as 'user' | 'project',
          agents: targetConfig.agents,
          ...(targetConfig.agentVersions ? { agentVersions: targetConfig.agentVersions } : {}),
          ...(Object.keys(headers).length > 0 && { headers }),
        };
      } else {
        const command = commandOrUrl.join(' ');
        manifest.mcp[name] = {
          command,
          transport: 'stdio',
          scope: options.scope as 'user' | 'project',
          agents: targetConfig.agents,
          ...(targetConfig.agentVersions ? { agentVersions: targetConfig.agentVersions } : {}),
        };
      }

      writeManifest(localPath, manifest);
      emit('mcp.add', { module: 'mcp', server: name });
      console.log(chalk.green(`Added MCP server '${name}' to manifest`));
      console.log(chalk.gray('Run: agents sync --mcp to apply'));
    });

  withAliases(mcpCmd
    .command('remove [name]'), 'remove')
    .description('Unregister an MCP server from agents (interactive picker if no name given)')
    .option('-a, --agents <list>', 'Limit removal to specific agents')
    .addHelpText('after', `
Examples:
  # Remove a server by name
  agents mcp remove notion

  # Remove from specific agents only
  agents mcp remove notion --agents codex,claude

  # Interactive picker
  agents mcp remove
`)
    .action(async (name?: string, options?: { agents?: string }) => {
      const cwd = process.cwd();
      const cliStates = await getAllCliStates();

      // Build map of MCP -> targets for all installed agents
      type McpTargetInfo = { name: string; targets: Array<{ agentId: AgentId; version: string; home: string }> };
      const mcpTargetMap = new Map<string, McpTargetInfo>();

      for (const agentId of capableAgents('mcp')) {
        if (!cliStates[agentId]?.installed && listInstalledVersions(agentId).length === 0) continue;
        for (const version of listInstalledVersions(agentId)) {
          const home = getVersionHomePath(agentId, version);
          const configPath = getMcpConfigPathForHome(agentId, home);
          const mcps = parseMcpConfig(agentId, configPath);
          for (const mcpName of Object.keys(mcps)) {
            const existing = mcpTargetMap.get(mcpName);
            if (existing) {
              existing.targets.push({ agentId, version, home });
            } else {
              mcpTargetMap.set(mcpName, { name: mcpName, targets: [{ agentId, version, home }] });
            }
          }
        }
      }

      let mcpsToRemove: string[];

      if (name) {
        mcpsToRemove = [name];
      } else {
        // Interactive picker for MCP selection
        if (mcpTargetMap.size === 0) {
          console.log(chalk.yellow('No MCP servers configured.'));
          return;
        }

        if (!isInteractiveTerminal()) {
          requireInteractiveSelection('Selecting MCP servers to remove', [
            'agents mcp remove my-server',
            'agents mcp remove my-server --agents codex,claude',
          ]);
        }

        try {
          const selected = await checkbox({
            message: 'Select MCP servers to remove',
            choices: Array.from(mcpTargetMap.values()).map((mcp) => {
              const agents = [...new Set(mcp.targets.map((t) => AGENTS[t.agentId].name))];
              return {
                value: mcp.name,
                name: `${mcp.name} (${agents.join(', ')})`,
              };
            }),
          });

          if (selected.length === 0) {
            console.log(chalk.gray('No MCPs selected.'));
            return;
          }

          mcpsToRemove = selected;
        } catch (err) {
          if (isPromptCancelled(err)) {
            console.log(chalk.gray('Cancelled'));
            return;
          }
          throw err;
        }
      }

      // Execute removals with target selection
      let removed = 0;
      for (const mcpName of mcpsToRemove) {
        const mcpInfo = mcpTargetMap.get(mcpName);
        if (!mcpInfo || mcpInfo.targets.length === 0) {
          console.log(chalk.yellow(`  MCP '${mcpName}' not found in any agent.`));
          continue;
        }

        // If --agents was specified, filter targets
        let availableTargets = mcpInfo.targets;
        if (options?.agents) {
          const requestedTargets = resolveInstalledAgentTargets(options.agents, capableAgents('mcp'));
          const requested = new Set<string>();
          for (const aid of requestedTargets.directAgents) {
            for (const ver of listInstalledVersions(aid)) {
              requested.add(`${aid}@${ver}`);
            }
          }
          for (const [aid, versions] of requestedTargets.versionSelections) {
            for (const ver of versions) {
              requested.add(`${aid}@${ver}`);
            }
          }
          availableTargets = availableTargets.filter((t) => requested.has(`${t.agentId}@${t.version}`));
        }

        if (availableTargets.length === 0) {
          console.log(chalk.yellow(`  MCP '${mcpName}' not found in specified agents.`));
          continue;
        }

        // Show target picker if multiple targets and no --agents flag
        const removalTargets: RemovalTarget[] = availableTargets.map((t) => ({
          agent: t.agentId,
          version: t.version,
          label: formatTargetLabel(t.agentId as AgentId, t.version),
        }));

        const selectedTargets = await promptRemovalTargets(mcpName, removalTargets, {
          skipPrompt: !!options?.agents,
        });

        if (selectedTargets.length === 0) {
          console.log(chalk.gray(`  Skipped '${mcpName}'.`));
          continue;
        }

        // Build targets structure for unregister
        const versionSelections = new Map<AgentId, string[]>();
        for (const t of selectedTargets) {
          const versions = versionSelections.get(t.agent as AgentId) || [];
          if (!versions.includes(t.version)) {
            versions.push(t.version);
            versionSelections.set(t.agent as AgentId, versions);
          }
        }

        const targetsToRemove = { directAgents: [] as AgentId[], versionSelections };
        const results = await unregisterMcpFromTargets(targetsToRemove, mcpName);
        for (const result of results) {
          if (result.success) {
            console.log(`  ${chalk.red('-')} ${formatTargetLabel(result.agentId, result.version)}: ${mcpName}`);
            removed++;
          } else if (result.error && !result.error.includes('CLI not installed')) {
            console.log(`  ${chalk.yellow('!')} ${formatTargetLabel(result.agentId, result.version)}: ${result.error}`);
          }
        }
      }

      if (removed === 0) {
        console.log(chalk.yellow('No MCP servers removed.'));
      } else {
        for (const n of mcpsToRemove) emit('mcp.remove', { module: 'mcp', server: n });
        console.log(chalk.green(`\nRemoved ${removed} MCP server(s).`));
      }
    });

  withAliases(mcpCmd
    .command('view [name]'), 'view')
    .description('Show MCP server configuration (command, scope, registered agents)')
    .addHelpText('after', `
Examples:
  # View details for a specific server
  agents mcp view notion

  # Interactive picker
  agents mcp view
`)
    .action(async (name?: string) => {
      const cwd = process.cwd();
      const cliStates = await getAllCliStates();

      // Gather all unique MCPs across agents
      const mcpMap = new Map<string, { name: string; agents: string[]; command?: string; scope: string }>();
      for (const agentId of capableAgents('mcp')) {
        if (!cliStates[agentId]?.installed) continue;
        const mcps = listInstalledMcpsWithScope(agentId, cwd, { home: getEffectiveHome(agentId) });
        for (const mcp of mcps) {
          const existing = mcpMap.get(mcp.name);
          if (existing) {
            existing.agents.push(AGENTS[agentId].name);
          } else {
            mcpMap.set(mcp.name, {
              name: mcp.name,
              agents: [AGENTS[agentId].name],
              command: mcp.command,
              scope: mcp.scope,
            });
          }
        }
      }

      if (mcpMap.size === 0) {
        console.log(chalk.yellow('No MCP servers configured'));
        return;
      }

      // If no name provided, show interactive select
      if (!name) {
        if (!isInteractiveTerminal()) {
          requireInteractiveSelection('Selecting an MCP server to view', [
            'agents mcp view my-server',
          ]);
        }
        try {
          const { select } = await import('@inquirer/prompts');
          name = await select({
            message: 'Select an MCP server to view',
            choices: Array.from(mcpMap.values()).map((mcp) => ({
              value: mcp.name,
              name: `${mcp.name} (${mcp.agents.join(', ')})`,
            })),
          });
        } catch (err) {
          if (isPromptCancelled(err)) {
            console.log(chalk.gray('Cancelled'));
            return;
          }
          throw err;
        }
      }

      const mcp = mcpMap.get(name);
      if (!mcp) {
        console.log(chalk.yellow(`MCP server '${name}' not found`));
        return;
      }

      console.log(chalk.bold(`\n${mcp.name}\n`));
      console.log(`  Scope: ${mcp.scope}`);
      console.log(`  Agents: ${mcp.agents.join(', ')}`);
      if (mcp.command) {
        console.log(`  Command: ${chalk.cyan(mcp.command)}`);
      }
      console.log();
    });

}

async function installMcpsFromRepoSource(
  source: string,
  options: { names?: string; agents?: string; yes?: boolean }
): Promise<void> {
  const spinner = ora('Cloning repository...').start();
  let localPath: string;
  try {
    const cloneResult = await cloneRepo(source);
    localPath = cloneResult.localPath;
  } catch (err) {
    spinner.fail(`Failed to clone: ${(err as Error).message}`);
    process.exit(1);
  }
  spinner.succeed('Repository cloned');

  let discovered = discoverMcpConfigsFromRepo(localPath);
  if (discovered.length === 0) {
    console.log(chalk.yellow('No MCP server configs found (looking for mcp/*.yaml)'));
    return;
  }

  const requestedNames = parseCommaSeparatedList(options.names);
  if (requestedNames.length > 0) {
    const discoveredNames = new Set(discovered.map((s) => s.name));
    const missing = requestedNames.filter((n) => !discoveredNames.has(n));
    if (missing.length > 0) {
      console.log(chalk.red(`\nMCP server(s) not found in source: ${missing.join(', ')}`));
      console.log(chalk.gray(`Available: ${[...discoveredNames].join(', ')}`));
      process.exit(1);
    }
    discovered = discovered.filter((s) => requestedNames.includes(s.name));
  }

  console.log(chalk.bold(`\nFound ${discovered.length} MCP server config(s):`));
  for (const s of discovered) {
    const summary = s.config.transport === 'stdio'
      ? `${s.config.command}${s.config.args?.length ? ' ' + s.config.args.join(' ') : ''}`
      : s.config.url ?? '';
    console.log(`  ${chalk.cyan(s.name)}: ${chalk.gray(summary)}`);
  }

  const installSpinner = ora('Installing MCP configs to ~/.agents/mcp/...').start();
  let installed = 0;
  for (const s of discovered) {
    const result = installMcpConfigCentrally(s.path);
    if (result.success) {
      installed++;
    } else {
      installSpinner.stop();
      console.log(chalk.red(`  Failed to install ${s.name}: ${result.error}`));
      installSpinner.start();
    }
  }
  installSpinner.succeed(`Installed ${installed} MCP config(s) to ~/.agents/mcp/`);

  // Agent/version selection — same default as the non-repo form: every
  // MCP-capable agent. Routes through resolveAgentTargetsAutoInstalling so
  // a typo'd `claude@2.1.999` prompts to install (and --yes auto-installs).
  const agentsValue = options.agents ?? capableAgents('mcp').join(',');
  let targets;
  try {
    const resolved = await resolveAgentTargetsAutoInstalling(agentsValue, capableAgents('mcp'), { yes: options.yes });
    if (!resolved) {
      console.log(chalk.gray('\nCancelled.'));
      return;
    }
    targets = resolved;
  } catch (err) {
    console.log(chalk.red((err as Error).message));
    process.exit(1);
  }

  if (targets.versionSelections.size === 0) {
    console.log(chalk.gray('\nStored centrally; no agent versions selected for sync.'));
    return;
  }

  const syncSpinner = ora('Syncing to agent versions...').start();
  const mcpNames = discovered.map((s) => s.name);
  let synced = 0;
  for (const [agentId, versions] of targets.versionSelections) {
    for (const version of versions) {
      const result = syncResourcesToVersion(agentId, version, { mcp: mcpNames });
      if (result.mcp.length > 0) synced++;
    }
  }
  syncSpinner.succeed(`Synced MCP configs to ${synced} agent version(s).`);
}

interface McpTargetPair {
  agent: AgentId;
  version: string;
  home: string;
}

/** Enumerate (agent, version) pairs that support MCP and have a version home. */
function iterMcpCapableVersions(filter?: { agent?: AgentId; version?: string }): McpTargetPair[] {
  const out: McpTargetPair[] = [];
  const agents = filter?.agent ? [filter.agent] : capableAgents('mcp');
  for (const agent of agents) {
    if (!isCapable(agent, 'mcp')) continue;
    const versions = listInstalledVersions(agent);
    for (const version of versions) {
      if (filter?.version && filter.version !== version) continue;
      out.push({ agent, version, home: getVersionHomePath(agent, version) });
    }
  }
  return out;
}

type McpSource = 'central' | 'manifest' | 'unmanaged';

/**
 * Build the row data for `agents mcp list`. Rows come from three sources,
 * in priority order:
 *   1. central  — ~/.agents/mcp/*.yaml (primary source of truth)
 *   2. manifest — agents.yaml#mcp (legacy/alternate declaration)
 *   3. unmanaged — found only in an agent's own config file
 *
 * Sync targets reflect the physical state: whether the server is actually
 * registered in each (agent, version) config.
 */
function buildMcpRows(opts: {
  filterAgent?: AgentId;
  filterVersion?: string;
}): ResourceRow[] {
  const centralServers = new Map<string, InstalledMcpServer>();
  for (const s of listMcpServerConfigs()) centralServers.set(s.name, s);

  const manifest = readManifest(getUserAgentsDir());
  const manifestEntries = manifest?.mcp || {};

  const targetPairs = iterMcpCapableVersions({
    agent: opts.filterAgent,
    version: opts.filterVersion,
  });

  // Read each target's config once.
  const installedByTarget = new Map<string, Record<string, { command?: string; url?: string }>>();
  for (const { agent, version, home } of targetPairs) {
    const configPath = getMcpConfigPathForHome(agent, home);
    const parsed = parseMcpConfig(agent, configPath);
    const normalized: Record<string, { command?: string; url?: string }> = {};
    for (const [name, entry] of Object.entries(parsed)) {
      const command = entry.command && entry.args?.length
        ? `${entry.command} ${entry.args.join(' ')}`
        : entry.command || (entry.args ? entry.args.join(' ') : undefined);
      normalized[name] = { command, url: (entry as any).url };
    }
    installedByTarget.set(`${agent}@${version}`, normalized);
  }

  // Union: central + manifest + anything found in a target config.
  const allNames = new Set<string>();
  for (const name of centralServers.keys()) allNames.add(name);
  for (const name of Object.keys(manifestEntries)) allNames.add(name);
  for (const entries of installedByTarget.values()) {
    for (const name of Object.keys(entries)) allNames.add(name);
  }

  if (allNames.size === 0) return [];

  const defaultByAgent = new Map<AgentId, string | null>();
  for (const { agent } of targetPairs) {
    if (!defaultByAgent.has(agent)) defaultByAgent.set(agent, getGlobalDefault(agent));
  }

  const rows: ResourceRow[] = [];
  for (const name of allNames) {
    const centralConfig = centralServers.get(name);
    const manifestConfig = manifestEntries[name];
    const source: McpSource = centralConfig ? 'central' : manifestConfig ? 'manifest' : 'unmanaged';

    const targets: SyncTarget[] = [];
    let firstCommand: string | undefined;
    for (const { agent, version } of targetPairs) {
      const installed = installedByTarget.get(`${agent}@${version}`)![name];
      const status: SyncTarget['status'] = installed ? 'synced' : 'missing';
      if (installed && !firstCommand) firstCommand = installed.command || installed.url;
      targets.push({
        agent,
        version,
        isDefault: defaultByAgent.get(agent) === version,
        status,
      });
    }

    // Prefer the declared command/url from central or manifest over whatever
    // happened to land in some version's config.
    const declaredCommand = centralConfig
      ? formatCentralCommand(centralConfig)
      : manifestConfig?.command || manifestConfig?.url;
    const displayCommand = declaredCommand || firstCommand;

    rows.push({
      name,
      description: displayCommand ? truncate(displayCommand, 60) : '',
      extra: source,
      targets,
      buildDetail: () => formatMcpDetail(name, source, centralConfig, manifestConfig, displayCommand, targets),
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

function formatCentralCommand(server: InstalledMcpServer): string {
  if (server.config.transport === 'http') return server.config.url || '';
  const cmd = server.config.command || '';
  const args = server.config.args?.join(' ') || '';
  return args ? `${cmd} ${args}` : cmd;
}

function formatMcpDetail(
  name: string,
  source: McpSource,
  centralConfig: InstalledMcpServer | undefined,
  manifestConfig: McpServerConfig | undefined,
  command: string | undefined,
  targets: SyncTarget[]
): string {
  const lines: string[] = [];
  lines.push(chalk.bold.cyan(name));

  const isUntrustedProject = centralConfig?.scope === 'project'
    && !isProjectMcpTrusted(getProjectAgentsDir() ?? '');

  const tag =
    centralConfig?.scope === 'project'
      ? (isUntrustedProject
          ? chalk.yellow('declared in <repo>/.agents/mcp/ (untrusted project — will NOT auto-apply)')
          : chalk.green('declared in <repo>/.agents/mcp/ (trusted project)')) :
    source === 'central' ? chalk.green('declared in ~/.agents/mcp/') :
    source === 'manifest' ? chalk.gray('declared in agents.yaml') :
    chalk.yellow('unmanaged (not in central or manifest)');
  lines.push('  ' + tag);
  lines.push('');

  if (centralConfig) {
    lines.push(`  transport: ${chalk.white(centralConfig.config.transport)}`);
    lines.push('  ' + chalk.gray(centralConfig.path));
  } else if (manifestConfig) {
    const transport = manifestConfig.transport || 'stdio';
    const scope = manifestConfig.scope || 'user';
    lines.push(`  transport: ${chalk.white(transport)}   scope: ${chalk.white(scope)}`);
  }

  if (command) {
    lines.push(`  ${chalk.gray('command:')} ${chalk.white(command)}`);
  }

  // A project-scoped server is an arbitrary command from a (possibly cloned)
  // repo. Show exactly what would run and how to opt in (RUSH-1776).
  if (isUntrustedProject) {
    lines.push('');
    lines.push('  ' + chalk.yellow('This project is untrusted — its MCP servers are skipped on sync and workflow runs.'));
    lines.push('  ' + chalk.gray('Review the command above, then opt in with: ') + chalk.white('agents mcp trust'));
  }

  lines.push('');
  lines.push(chalk.bold('  Synced to'));
  lines.push(buildTargetsSection(targets));

  return lines.join('\n');
}

