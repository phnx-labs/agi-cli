/** Slash command management: `agents commands` lists, adds, removes, syncs, prunes and views the
 * markdown files agents invoke as slash commands. Central storage is ~/.agents/commands/, synced
 * to individual version homes. */
import type { Command } from 'commander';
import { withAliases } from '../lib/verbs.js';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkbox, confirm } from '@inquirer/prompts';

import {
  AGENTS,
  getAllCliStates,
  resolveAgentName,
  formatAgentError,
  agentLabel,
} from '../lib/agents.js';
import { capableAgents } from '../lib/capabilities.js';
import type { AgentId } from '../lib/types.js';
import { cloneRepo } from '../lib/git.js';
import {
  discoverCommands,
  resolveCommandSource,
  installCommandCentrally,
  uninstallCommand,
  listCentralCommands,
  listInstalledCommandsWithScope,
  getCommandInfo,
  diffVersionCommands,
  iterCommandsCapableVersions,
  removeCommandFromVersion,
  type VersionCommandDiff,
} from '../lib/commands.js';
import { getCommandsDir } from '../lib/state.js';
import {
  showResourceList,
  buildTargetsSection,
  type ResourceRow,
  type SyncTarget,
} from './resource-view.js';
import {
  listInstalledVersions,
  getGlobalDefault,
  syncResourcesToVersion,
  promptAgentVersionSelection,
  getVersionHomePath,
  resolveAgentVersionTargets,
  resolveInstalledAgentTargets,
} from '../lib/installations/versions.js';
import { recordVersionResources } from '../lib/state.js';
import {
  isPromptCancelled,
  formatPath,
  isInteractiveTerminal,
  parseCommaSeparatedList,
  printWithPager,
  requireInteractiveSelection,
  promptRemovalTargets,
  resolveAgentTargetsAutoInstalling,
  type RemovalTarget,
  resolveListFilterOrExit,
} from './utils.js';

export function registerCommandsCommands(program: Command): void {
  const commandsCmd = program
    .command('commands')
    .description('Extend agents with custom slash commands that ship behavior in markdown files')
    .addHelpText('after', `
Slash commands are markdown files that agents can invoke mid-session. They add capabilities without modifying the agent CLI itself — perfect for team workflows, project patterns, or personal shortcuts.

Examples:
  # See what commands are available
  agents commands list

  # Check commands installed for a specific version
  agents commands list claude@2.1.112

  # Install a command from GitHub to multiple agents
  agents commands add gh:anthropics/commands --agents claude,codex

  # Pick commands from ~/.agents/commands/ interactively
  agents commands add

  # Install specific commands by name
  agents commands add --names plan,debug --agents codex@0.116.0

When to use:
  - Project setup: 'agents commands add gh:team/commands' to sync everyone's workflow
  - New version: 'agents commands add --agents claude@2.1.112' to carry commands forward
  - Custom tooling: write a command markdown file, test it, then share via 'agents commands add ~/my-cmd.md'
`);

  withAliases(commandsCmd
    .command('list [agent]'), 'list')
    .option('--json', 'Emit machine-readable JSON instead of the table/picker')
    .description('Show which slash commands are installed and which agent versions they are synced to')
    .option('-a, --agent <agent>', 'Filter to a specific agent (alternative to positional arg)')
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
          console.log(chalk.red(formatAgentError(parts[0])));
          process.exit(1);
        }
        filterAgent = resolved;
        filterVersion = resolveListFilterOrExit(resolved, parts[1]);
      }

      const rows = buildCommandRows({ filterAgent, filterVersion });

      spinner.stop();

      await showResourceList({
        resourcePlural: 'commands',
        resourceSingular: 'command',
        rows,
        emptyMessage: filterAgent
          ? `No commands in central storage for ${agentLabel(filterAgent)}.`
          : 'No commands in ~/.agents/commands/. Add one with: agents commands add gh:user/repo',
        centralPath: getCommandsDir(),
        filterAgent,
        filterVersion,
        json: options.json,
      });
    });

  commandsCmd
    .command('add [source]')
    .description('Install commands from a source (GitHub, local) or pick from central storage')
    .option('-a, --agents <list>', 'Targets: claude, codex@0.116.0, or cursor@default')
    .option('--names <list>', 'Command names from ~/.agents/commands/ (comma-separated)')
    .option('-y, --yes', 'Skip all prompts')
    .addHelpText('after', `
Examples:
  # Interactive picker from ~/.agents/commands/
  agents commands add

  # Install specific commands to a single version
  agents commands add --names plan,debug --agents codex@0.116.0

  # Pull commands from GitHub and sync to all installed agents
  agents commands add gh:user/repo --agents claude,codex,cursor

  # Add a local command directory
  agents commands add ~/my-commands --agents claude@default
`)
    .action(async (source: string | undefined, options) => {
      try {
        let commands: { name: string; description: string; sourcePath?: string }[];
        let fromCentral = false;

        if (!source) {
          const centralCommands = listCentralCommands();
          if (centralCommands.length === 0) {
            console.log(chalk.yellow('No commands in ~/.agents/commands/'));
            console.log(chalk.gray('\nTo add commands from a repo:'));
            console.log(chalk.cyan('  agents commands add gh:user/repo'));
            return;
          }

          const requestedNames = parseCommaSeparatedList(options.names);
          let selectedNames: string[];

          if (requestedNames.length > 0) {
            const missing = requestedNames.filter((name) => !centralCommands.includes(name));
            if (missing.length > 0) {
              console.log(chalk.red(`Unknown command(s): ${missing.join(', ')}`));
              console.log(chalk.gray(`Available: ${centralCommands.join(', ')}`));
              process.exit(1);
            }
            selectedNames = requestedNames;
          } else {
            if (!isInteractiveTerminal()) {
              requireInteractiveSelection('Selecting commands from ~/.agents/commands/', [
                'agents commands add --names plan,debug --agents codex',
                'agents commands add gh:user/repo --agents codex',
              ]);
            }

            const choices = centralCommands.map((name) => {
              const cmdPath = path.join(getCommandsDir(), `${name}.md`);
              let description = '';
              if (fs.existsSync(cmdPath)) {
                const content = fs.readFileSync(cmdPath, 'utf-8');
                const match = content.match(/description:\s*(.+)/i) || content.match(/description\s*=\s*"([^"]+)"/);
                if (match) description = match[1].trim();
              }
              return {
                value: name,
                name: description ? `${name}  ${chalk.gray(description.slice(0, 50))}` : name,
              };
            });

            const selected = await checkbox({
              message: 'Select commands to install',
              choices: [
                { value: '__all__', name: chalk.bold('Select All') },
                ...choices,
              ],
            });

            if (selected.length === 0) {
              console.log(chalk.gray('No commands selected.'));
              return;
            }

            selectedNames = selected.includes('__all__')
              ? centralCommands
              : selected.filter((s) => s !== '__all__');
          }

          commands = selectedNames.map((name) => ({ name, description: '' }));
          fromCentral = true;
        } else {
          const spinner = ora('Fetching commands...').start();

          const isGitRepo = source.startsWith('gh:') || source.startsWith('git:') ||
                            source.startsWith('ssh:') || source.startsWith('https://') ||
                            source.startsWith('http://');

          let localPath: string;
          if (isGitRepo) {
            const result = await cloneRepo(source);
            localPath = result.localPath;
            spinner.succeed('Repository cloned');
          } else {
            localPath = source.startsWith('~')
              ? path.join(os.homedir(), source.slice(1))
              : path.resolve(source);

            if (!fs.existsSync(localPath)) {
              spinner.fail(`Path not found: ${localPath}`);
              return;
            }
            spinner.succeed('Using local path');
          }

          const discovered = discoverCommands(localPath);
          console.log(chalk.bold(`\nFound ${discovered.length} command(s):`));

          if (discovered.length === 0) {
            console.log(chalk.yellow('No commands found'));
            return;
          }

          for (const command of discovered) {
            console.log(`\n  ${chalk.cyan(command.name)}: ${command.description}`);
          }

          commands = discovered;

          const installSpinner = ora('Installing commands to central storage...').start();
          let installed = 0;

          for (const command of discovered) {
            const sourcePath = resolveCommandSource(localPath, command.name);
            if (sourcePath) {
              const result = installCommandCentrally(sourcePath, command.name);
              if (result.error) {
                installSpinner.stop();
                console.log(chalk.yellow(`\n  Warning: ${command.name}: ${result.error}`));
                installSpinner.start();
              } else {
                installed++;
              }
            }
          }

          installSpinner.succeed(`Installed ${installed} commands to ~/.agents/commands/`);
        }

        let selectedAgents: AgentId[];
        let versionSelections: Map<AgentId, string[]>;

        if (options.agents) {
          const result = await resolveAgentTargetsAutoInstalling(options.agents, capableAgents('commands'), { yes: options.yes });
          if (!result) {
            console.log(chalk.gray('Cancelled.'));
            return;
          }
          selectedAgents = result.selectedAgents;
          versionSelections = result.versionSelections;
        } else {
          const result = await promptAgentVersionSelection(capableAgents('commands'), {
            skipPrompts: options.yes,
          });
          selectedAgents = result.selectedAgents;
          versionSelections = result.versionSelections;
        }

        if (selectedAgents.length === 0) {
          console.log(chalk.yellow('\nNo agents selected.'));
          return;
        }

        const syncSpinner = ora('Syncing to agent versions...').start();
        let synced = 0;
        const commandNames = commands.map((c) => c.name);

        for (const [agentId, versions] of versionSelections) {
          for (const version of versions) {
            syncResourcesToVersion(agentId, version);
            recordVersionResources(agentId, version, 'commands', commandNames);
            synced++;
          }
        }

        if (synced > 0) {
          syncSpinner.succeed(`Synced to ${synced} agent version(s)`);
        } else {
          syncSpinner.info('No version-managed agents to sync');
        }

        console.log(chalk.green('\nCommands installed.'));
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.gray('\nCancelled'));
          return;
        }
        console.error(chalk.red('Failed to add commands'));
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  withAliases(commandsCmd
    .command('remove [name]'), 'remove')
    .description('Delete a command from agents (interactive picker if no name given)')
    .option('-a, --agents <list>', 'Limit removal to specific agents (e.g., claude,codex)')
    .addHelpText('after', `
Examples:
  # Remove a command by name
  agents commands remove plan

  # Interactive: pick commands to remove
  agents commands remove
`)
    .action(async (name?: string, options?: { agents?: string }) => {
      type CmdTargetInfo = { name: string; targets: Array<{ agent: AgentId; version: string }> };
      const cmdTargetMap = new Map<string, CmdTargetInfo>();

      for (const { agent, version } of iterCommandsCapableVersions()) {
        const home = getVersionHomePath(agent, version);
        const commands = listInstalledCommandsWithScope(agent, process.cwd(), { home });
        for (const cmd of commands) {
          if (cmd.scope !== 'user') continue;
          const existing = cmdTargetMap.get(cmd.name);
          if (existing) {
            existing.targets.push({ agent, version });
          } else {
            cmdTargetMap.set(cmd.name, { name: cmd.name, targets: [{ agent, version }] });
          }
        }
      }

      let commandsToRemove: string[];

      if (name) {
        commandsToRemove = [name];
      } else {
        if (cmdTargetMap.size === 0) {
          console.log(chalk.yellow('No commands installed in any version.'));
          return;
        }

        if (!isInteractiveTerminal()) {
          requireInteractiveSelection('Selecting commands to remove', [
            'agents commands remove plan',
          ]);
        }

        try {
          const choices = Array.from(cmdTargetMap.values()).map((cmd) => {
            const agents = [...new Set(cmd.targets.map((t) => AGENTS[t.agent].name))];
            return {
              value: cmd.name,
              name: `${cmd.name} (${agents.join(', ')})`,
            };
          });

          const selected = await checkbox({
            message: 'Select commands to remove',
            choices,
          });

          if (selected.length === 0) {
            console.log(chalk.gray('No commands selected.'));
            return;
          }

          commandsToRemove = selected;
        } catch (err) {
          if (isPromptCancelled(err)) {
            console.log(chalk.gray('Cancelled'));
            return;
          }
          throw err;
        }
      }

      let removed = 0;
      for (const cmdName of commandsToRemove) {
        const cmdInfo = cmdTargetMap.get(cmdName);
        if (!cmdInfo || cmdInfo.targets.length === 0) {
          console.log(chalk.yellow(`  Command '${cmdName}' not found in any version.`));
          continue;
        }

        let availableTargets = cmdInfo.targets;
        if (options?.agents) {
          const requestedTargets = resolveInstalledAgentTargets(options.agents, capableAgents('commands'));
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
          availableTargets = availableTargets.filter((t) => requested.has(`${t.agent}@${t.version}`));
        }

        if (availableTargets.length === 0) {
          console.log(chalk.yellow(`  Command '${cmdName}' not found in specified agents.`));
          continue;
        }

        const removalTargets: RemovalTarget[] = availableTargets.map((t) => ({
          agent: t.agent,
          version: t.version,
          label: `${agentLabel(t.agent)}@${t.version}`,
        }));

        const selectedTargets = await promptRemovalTargets(cmdName, removalTargets, {
          skipPrompt: !!options?.agents,
        });

        if (selectedTargets.length === 0) {
          console.log(chalk.gray(`  Skipped '${cmdName}'.`));
          continue;
        }

        for (const target of selectedTargets) {
          const result = removeCommandFromVersion(target.agent as AgentId, target.version, cmdName);
          if (result.success) {
            console.log(`  ${chalk.red('-')} ${target.label}: ${cmdName}`);
            removed++;
          } else if (result.error) {
            console.log(`  ${chalk.yellow('!')} ${target.label}: ${result.error}`);
          }
        }
      }

      if (removed === 0) {
        console.log(chalk.yellow('No commands removed.'));
      } else {
        console.log(chalk.green(`\nRemoved ${removed} command(s) from version homes.`));
        console.log(chalk.gray("Central source unchanged. Restore any target with 'agents sync <agent>@<version> --yes'."));
      }
    });

  commandsCmd
    .command('prune', { hidden: true })
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      console.error(chalk.red('"agents commands prune" moved.'));
      console.error(chalk.gray('Use:  agents prune cleanup commands   (or `agents prune cleanup` for everything)'));
      process.exit(1);
    });

  withAliases(commandsCmd
    .command('view [name]'), 'view')
    .description('Read the full content of a command file with markdown rendering')
    .addHelpText('after', `
Examples:
  # View a specific command
  agents commands view plan

  # Interactive picker
  agents commands view
`)
    .action(async (name?: string) => {
      if (!name) {
        const centralCommands = listCentralCommands();
        if (centralCommands.length === 0) {
          console.log(chalk.yellow('No commands installed'));
          return;
        }

        if (!isInteractiveTerminal()) {
          requireInteractiveSelection('Selecting a command to view', [
            'agents commands view plan',
          ]);
        }

        try {
          const { select } = await import('@inquirer/prompts');
          name = await select({
            message: 'Select a command to view',
            choices: centralCommands.map((cmd) => ({
              value: cmd,
              name: cmd,
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

      const command = getCommandInfo(name);
      if (!command) {
        console.log(chalk.yellow(`Command '${name}' not found`));
        return;
      }

      const { renderMarkdown } = await import('../lib/markdown.js');

      console.log(chalk.bold(`\n${command.name}`));
      if (command.description) {
        console.log(`${command.description}`);
      }
      console.log(chalk.gray(`Path: ${command.path}\n`));

      if (command.content) {
        const rendered = renderMarkdown(command.content);
        const contentLines = command.content.split('\n');
        printWithPager(rendered, contentLines.length);
      }
    });
}

/** Build the row data for `agents commands list`: one row per central command, with a sync-status
 * target per (agent, version) in scope. */
function buildCommandRows(opts: {
  filterAgent?: AgentId;
  filterVersion?: string;
}): ResourceRow[] {
  const names = listCentralCommands();
  if (names.length === 0) return [];

  const targetPairs = iterCommandsCapableVersions({
    agent: opts.filterAgent,
    version: opts.filterVersion,
  });

  const diffByTarget = new Map<string, VersionCommandDiff>();
  const defaultByAgent = new Map<AgentId, string | null>();
  for (const { agent, version } of targetPairs) {
    if (!defaultByAgent.has(agent)) defaultByAgent.set(agent, getGlobalDefault(agent));
    diffByTarget.set(`${agent}@${version}`, diffVersionCommands(agent, version));
  }

  const rows: ResourceRow[] = [];
  for (const name of names) {
    const info = getCommandInfo(name);
    const description = info?.description || '';

    const targets: SyncTarget[] = [];
    for (const { agent, version } of targetPairs) {
      const diff = diffByTarget.get(`${agent}@${version}`)!;
      let status: SyncTarget['status'];
      if (diff.matched.includes(name)) status = 'synced';
      else if (diff.toUpdate.includes(name)) status = 'stale';
      else if (diff.toRemove.includes(name)) status = 'stale';
      else status = 'missing';
      targets.push({
        agent,
        version,
        isDefault: defaultByAgent.get(agent) === version,
        status,
      });
    }

    rows.push({
      name,
      description,
      targets,
      buildDetail: () => formatCommandDetail(name, info, targets),
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

function formatCommandDetail(
  name: string,
  info: { description: string; path: string; content: string } | null,
  targets: SyncTarget[]
): string {
  const lines: string[] = [];
  lines.push(chalk.bold.cyan(name));
  if (info?.description) {
    lines.push(chalk.gray(info.description));
  }
  if (info?.path) {
    lines.push('  ' + chalk.gray(info.path));
  }

  lines.push('');
  lines.push(chalk.bold('  Synced to'));
  lines.push(buildTargetsSection(targets));

  return lines.join('\n');
}
