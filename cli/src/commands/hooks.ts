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
  resolveAgentName,
  formatAgentError,
  agentLabel,
} from '../lib/agents.js';
import { supports, capableAgents } from '../lib/capabilities.js';
import type { AgentId } from '../lib/types.js';
import { cloneRepo } from '../lib/git.js';
import {
  discoverHooksFromRepo,
  installHooksCentrally,
  listCentralHooks,
  listInstalledHooksWithScope,
  removeHook,
  getHookInfo,
  parseHookManifest,
  diffVersionHooks,
  iterHooksCapableVersions,
  removeHookFromVersion,
} from '../lib/hooks/install.js';
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
  isInteractiveTerminal,
  parseCommaSeparatedList,
  printWithPager,
  requireInteractiveSelection,
  promptRemovalTargets,
  resolveAgentTargetsAutoInstalling,
  type RemovalTarget,
  resolveListFilterOrExit,
} from './utils.js';

export function registerHooksCommands(program: Command): void {
  const hooksCmd = program.command('hooks')
    .description('Automate workflows by running shell scripts in response to agent events')
    .addHelpText('after', `
Hooks are shell scripts that fire on agent events: when a session starts, when files are edited, when a task completes. Use them to trigger builds, sync logs, notify Slack, or integrate agents into existing tooling.

Examples:
  # List registered hooks
  agents hooks list

  # Check hooks for a specific agent
  agents hooks list claude@2.1.112

  # Install hooks from GitHub
  agents hooks add gh:team/hooks --agents claude,codex

  # Interactive: pick from ~/.agents/hooks/
  agents hooks add

  # Install a specific hook by name
  agents hooks add --names post-edit --agents claude

When to use:
  - CI integration: hook into pre-commit events to block unsafe operations
  - Logging: capture session transcripts with a post-session hook
  - Notifications: ping Slack when agents complete long tasks
  - Team workflows: sync hooks via 'agents hooks add gh:team/hooks'
`);

  withAliases(hooksCmd
    .command('list [agent]'), 'list')
    .description('Show which hooks are installed and which events they respond to')
    .option('-a, --agent <agent>', 'Filter to a specific agent (alternative to positional arg)')
    .option('-s, --scope <scope>', 'user (global), project (repo), or all', 'all')
    .action(async (agentArg, options) => {
      const spinner = ora({ text: 'Loading...', isSilent: !process.stdout.isTTY }).start();
      const cwd = process.cwd();

      const agentInput = agentArg || options.agent;
      let agentId: AgentId | null = null;
      let requestedVersion: string | null = null;

      if (agentInput) {
        const parts = agentInput.split('@');
        const agentName = parts[0];

        agentId = resolveAgentName(agentName);
        if (!agentId) {
          spinner.stop();
          console.log(chalk.red(formatAgentError(agentName, [...capableAgents('hooks')])));
          process.exit(1);
        }
        requestedVersion = resolveListFilterOrExit(agentId, parts[1]) ?? null;
      }

      const hookManifest = parseHookManifest();

      const getHookEvents = (hookName: string): string[] => {
        for (const [, def] of Object.entries(hookManifest)) {
          const scriptBase = def.script.replace(/\.[^.]+$/, '');
          if (def.script === hookName || scriptBase === hookName || hookName.replace(/\.[^.]+$/, '') === scriptBase) {
            return def.events || [];
          }
        }
        return [];
      };

      const renderVersionHooks = (
        agentId: AgentId,
        version: string,
        isDefault: boolean,
        home: string
      ) => {
        const agent = AGENTS[agentId];
        const defaultLabel = isDefault ? ' default' : '';
        const versionStr = chalk.gray(` (${version}${defaultLabel})`);

        const gate = supports(agentId, 'hooks', version);
        if (!gate.ok) {
          const detail = gate.reason === 'unsupported'
            ? 'hooks not supported'
            : `unsupported (${agentId}@${version} requires ${gate.need})`;
          console.log(`  ${chalk.bold(agentLabel(agent.id))}${versionStr}: ${chalk.gray(detail)}`);
          console.log();
          return;
        }

        const hooks = listInstalledHooksWithScope(agentId, cwd, { home }).filter(
          (h) => options.scope === 'all' || h.scope === options.scope
        );

        if (hooks.length === 0) {
          console.log(`  ${chalk.bold(agentLabel(agent.id))}${versionStr}: ${chalk.gray('none')}`);
        } else {
          console.log(`  ${chalk.bold(agentLabel(agent.id))}${versionStr}:`);

          const userHooks = hooks.filter((h) => h.scope === 'user');
          const projectHooks = hooks.filter((h) => h.scope === 'project');

          if (userHooks.length > 0 && (options.scope === 'all' || options.scope === 'user')) {
            console.log(`    ${chalk.gray('User:')}`);
            for (const hook of userHooks) {
              const events = getHookEvents(hook.name);
              const eventStr = events.length > 0
                ? chalk.gray(` [${events.join(', ')}]`)
                : '';
              console.log(`      ${chalk.cyan(hook.name.padEnd(28))}${eventStr}`);
            }
          }

          if (projectHooks.length > 0 && (options.scope === 'all' || options.scope === 'project')) {
            console.log(`    ${chalk.gray('Project:')}`);
            for (const hook of projectHooks) {
              const events = getHookEvents(hook.name);
              const eventStr = events.length > 0
                ? chalk.gray(` [${events.join(', ')}]`)
                : '';
              console.log(`      ${chalk.yellow(hook.name.padEnd(28))}${eventStr}`);
            }
          }
        }
        console.log();
      };

      spinner.stop();

      if (agentId) {
        const agent = AGENTS[agentId];
        const installedVersions = listInstalledVersions(agentId);
        const defaultVer = getGlobalDefault(agentId);

        if (installedVersions.length === 0) {
          console.log(chalk.bold(`Installed Hooks for ${agentLabel(agent.id)}\n`));
          if (!agent.supportsHooks) {
            console.log(`  ${chalk.bold(agentLabel(agent.id))}: ${chalk.gray('hooks not supported')}`);
          } else {
            const hooks = listInstalledHooksWithScope(agentId, cwd).filter(
              (h) => options.scope === 'all' || h.scope === options.scope
            );
            if (hooks.length === 0) {
              console.log(`  ${chalk.bold(agentLabel(agent.id))}: ${chalk.gray('none')}`);
            } else {
              console.log(`  ${chalk.bold(agentLabel(agent.id))}:`);
              const userHooks = hooks.filter((h) => h.scope === 'user');
              if (userHooks.length > 0) {
                console.log(`    ${chalk.gray('User:')}`);
                for (const hook of userHooks) {
                  console.log(`      ${chalk.cyan(hook.name.padEnd(20))}`);
                }
              }
            }
          }
          return;
        }

        console.log(chalk.bold(`Installed Hooks for ${agentLabel(agent.id)}\n`));

        let versionsToShow: string[];
        if (requestedVersion === 'default') {
          if (!defaultVer) {
            console.log(chalk.yellow(`  No default version set for ${agentLabel(agent.id)}. Run: agents use ${agentId}@<version>`));
            return;
          }
          versionsToShow = [defaultVer];
        } else if (requestedVersion) {
          if (!installedVersions.includes(requestedVersion)) {
            console.log(chalk.red(`  Version ${requestedVersion} not installed for ${agentLabel(agent.id)}.`));
            console.log(chalk.gray(`  Installed versions: ${installedVersions.join(', ')}`));
            return;
          }
          versionsToShow = [requestedVersion];
        } else {
          versionsToShow = [...installedVersions].sort((a, b) => {
            if (a === defaultVer) return -1;
            if (b === defaultVer) return 1;
            return 0;
          });
        }

        for (const version of versionsToShow) {
          const home = getVersionHomePath(agentId, version);
          renderVersionHooks(agentId, version, version === defaultVer, home);
        }
        return;
      }

      console.log(chalk.bold('Installed Hooks\n'));

      for (const aid of capableAgents('hooks')) {
        const agent = AGENTS[aid];
        const installedVersions = listInstalledVersions(aid);
        const defaultVer = getGlobalDefault(aid);

        if (installedVersions.length > 0 && defaultVer) {
          const home = getVersionHomePath(aid, defaultVer);
          renderVersionHooks(aid, defaultVer, true, home);
        } else {
          if (!agent.supportsHooks) {
            console.log(`  ${chalk.bold(agentLabel(aid))}: ${chalk.gray('hooks not supported')}`);
          } else {
            const hooks = listInstalledHooksWithScope(aid, cwd).filter(
              (h) => options.scope === 'all' || h.scope === options.scope
            );
            if (hooks.length === 0) {
              console.log(`  ${chalk.bold(agentLabel(aid))}: ${chalk.gray('none')}`);
            } else {
              console.log(`  ${chalk.bold(agentLabel(aid))}:`);
              const userHooks = hooks.filter((h) => h.scope === 'user');
              if (userHooks.length > 0) {
                console.log(`    ${chalk.gray('User:')}`);
                for (const hook of userHooks) {
                  console.log(`      ${chalk.cyan(hook.name.padEnd(20))}`);
                }
              }
            }
          }
          console.log();
        }
      }
    });

  hooksCmd
    .command('add [source]')
    .description('Install hooks from a source (GitHub, local) or pick from central storage')
    .option('-a, --agents <list>', 'Targets: claude, codex@0.116.0, or antigravity@default')
    .option('--names <list>', 'Hook names from ~/.agents/hooks/ (comma-separated)')
    .option('-y, --yes', 'Skip all prompts')
    .addHelpText('after', `
Examples:
  # Interactive picker from ~/.agents/hooks/
  agents hooks add

  # Install specific hooks by name
  agents hooks add --names post-edit --agents claude@2.1.112

  # Clone and install from GitHub
  agents hooks add gh:user/repo --agents claude,codex

  # Add from local directory
  agents hooks add ~/my-hooks --agents claude@default
`)
    .action(async (source: string | undefined, options) => {
      try {
        let hooks: string[];

        if (!source) {
          const centralHooks = listCentralHooks();
          if (centralHooks.length === 0) {
            console.log(chalk.yellow('No hooks in ~/.agents/hooks/'));
            console.log(chalk.gray('\nTo add hooks from a repo:'));
            console.log(chalk.cyan('  agents hooks add gh:user/repo'));
            return;
          }

          const availableHooks = centralHooks.map((hook) => hook.name);
          const requestedNames = parseCommaSeparatedList(options.names);
          if (requestedNames.length > 0) {
            const missing = requestedNames.filter((name) => !availableHooks.includes(name));
            if (missing.length > 0) {
              console.log(chalk.red(`Unknown hook(s): ${missing.join(', ')}`));
              console.log(chalk.gray(`Available: ${availableHooks.join(', ')}`));
              process.exit(1);
            }
            hooks = requestedNames;
          } else {
            if (!isInteractiveTerminal()) {
              requireInteractiveSelection('Selecting hooks from ~/.agents/hooks/', [
                'agents hooks add --names post-edit --agents claude',
                'agents hooks add gh:user/repo --agents claude',
              ]);
            }

            const choices = centralHooks.map((hook) => ({
              value: hook.name,
              name: hook.name,
            }));

            const selected = await checkbox({
              message: 'Select hooks to install',
              choices: [
                { value: '__all__', name: chalk.bold('Select All') },
                ...choices,
              ],
            });

            if (selected.length === 0) {
              console.log(chalk.gray('No hooks selected.'));
              return;
            }

            hooks = selected.includes('__all__')
              ? availableHooks
              : selected.filter((s) => s !== '__all__');
          }
        } else {
          const spinner = ora('Fetching hooks...').start();

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

          hooks = discoverHooksFromRepo(localPath);
          console.log(chalk.bold(`\nFound ${hooks.length} hook(s):`));

          if (hooks.length === 0) {
            console.log(chalk.yellow('No hooks found'));
            return;
          }

          for (const name of hooks) {
            console.log(`  ${chalk.cyan(name)}`);
          }

          const installSpinner = ora('Installing hooks to central storage...').start();
          const centralResult = await installHooksCentrally(localPath);

          if (centralResult.installed.length > 0) {
            installSpinner.succeed(`Installed ${centralResult.installed.length} hooks to ~/.agents/hooks/`);
          } else {
            installSpinner.info('No hooks to install');
          }

          if (centralResult.errors.length > 0) {
            console.log(chalk.red('\nErrors:'));
            for (const error of centralResult.errors) {
              console.log(chalk.red(`  ${error}`));
            }
          }
        }

        let selectedAgents: AgentId[];
        let versionSelections: Map<AgentId, string[]>;

        const hooksCapableAgents = Array.from(capableAgents('hooks')) as AgentId[];

        if (options.agents) {
          const result = await resolveAgentTargetsAutoInstalling(options.agents, hooksCapableAgents, { yes: options.yes });
          if (!result) {
            console.log(chalk.gray('Cancelled.'));
            return;
          }
          selectedAgents = result.selectedAgents;
          versionSelections = result.versionSelections;
        } else {
          const result = await promptAgentVersionSelection(hooksCapableAgents, {
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

        for (const [agentId, versions] of versionSelections) {
          for (const version of versions) {
            syncResourcesToVersion(agentId, version);
            recordVersionResources(agentId, version, 'hooks', hooks);
            synced++;
          }
        }

        if (synced > 0) {
          syncSpinner.succeed(`Synced to ${synced} agent version(s)`);
        } else {
          syncSpinner.info('No version-managed agents to sync');
        }

        console.log(chalk.green('\nHooks installed.'));
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.gray('\nCancelled'));
          return;
        }
        console.error(chalk.red('Failed to add hooks'));
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  withAliases(hooksCmd
    .command('remove [name]'), 'remove')
    .description('Delete a hook from agents (interactive picker if no name given)')
    .option('-a, --agents <list>', 'Limit removal to specific agents')
    .addHelpText('after', `
Examples:
  # Remove a hook by name
  agents hooks remove post-edit

  # Interactive picker
  agents hooks remove
`)
    .action(async (name?: string, options?: { agents?: string }) => {
      type HookTargetInfo = { name: string; targets: Array<{ agent: AgentId; version: string }> };
      const hookTargetMap = new Map<string, HookTargetInfo>();

      for (const { agent, version } of iterHooksCapableVersions()) {
        const home = getVersionHomePath(agent, version);
        const hooks = listInstalledHooksWithScope(agent, process.cwd(), { home });
        for (const hook of hooks) {
          if (hook.scope !== 'user') continue;
          const existing = hookTargetMap.get(hook.name);
          if (existing) {
            existing.targets.push({ agent, version });
          } else {
            hookTargetMap.set(hook.name, { name: hook.name, targets: [{ agent, version }] });
          }
        }
      }

      let hooksToRemove: string[];

      if (name) {
        hooksToRemove = [name];
      } else {
        if (hookTargetMap.size === 0) {
          console.log(chalk.yellow('No hooks installed in any version.'));
          return;
        }

        if (!isInteractiveTerminal()) {
          requireInteractiveSelection('Selecting hooks to remove', [
            'agents hooks remove post-edit',
          ]);
        }

        try {
          const choices = Array.from(hookTargetMap.values()).map((hook) => {
            const agents = [...new Set(hook.targets.map((t) => AGENTS[t.agent].name))];
            return {
              value: hook.name,
              name: `${hook.name} (${agents.join(', ')})`,
            };
          });

          const selected = await checkbox({
            message: 'Select hooks to remove',
            choices,
          });

          if (selected.length === 0) {
            console.log(chalk.gray('No hooks selected.'));
            return;
          }

          hooksToRemove = selected;
        } catch (err) {
          if (isPromptCancelled(err)) {
            console.log(chalk.gray('Cancelled'));
            return;
          }
          throw err;
        }
      }

      let removed = 0;
      for (const hookName of hooksToRemove) {
        const hookInfo = hookTargetMap.get(hookName);
        if (!hookInfo || hookInfo.targets.length === 0) {
          console.log(chalk.yellow(`  Hook '${hookName}' not found in any version.`));
          continue;
        }

        let availableTargets = hookInfo.targets;
        if (options?.agents) {
          const requestedTargets = resolveInstalledAgentTargets(options.agents, [...capableAgents('hooks')]);
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
          console.log(chalk.yellow(`  Hook '${hookName}' not found in specified agents.`));
          continue;
        }

        const removalTargets: RemovalTarget[] = availableTargets.map((t) => ({
          agent: t.agent,
          version: t.version,
          label: `${agentLabel(t.agent)}@${t.version}`,
        }));

        const selectedTargets = await promptRemovalTargets(hookName, removalTargets, {
          skipPrompt: !!options?.agents,
        });

        if (selectedTargets.length === 0) {
          console.log(chalk.gray(`  Skipped '${hookName}'.`));
          continue;
        }

        for (const target of selectedTargets) {
          const result = removeHookFromVersion(target.agent as AgentId, target.version, hookName);
          if (result.success) {
            console.log(`  ${chalk.red('-')} ${target.label}: ${hookName}`);
            removed++;
          } else if (result.error) {
            console.log(`  ${chalk.yellow('!')} ${target.label}: ${result.error}`);
          }
        }
      }

      if (removed === 0) {
        console.log(chalk.yellow('No hooks removed.'));
      } else {
        console.log(chalk.green(`\nRemoved ${removed} hook(s) from version homes.`));
        console.log(chalk.gray("Central source unchanged. Restore any target with 'agents sync <agent>@<version> --yes'."));
      }
    });

  hooksCmd
    .command('prune', { hidden: true })
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      console.error(chalk.red('"agents hooks prune" moved.'));
      console.error(chalk.gray('Use:  agents prune cleanup hooks   (or `agents prune cleanup` for everything)'));
      process.exit(1);
    });

  withAliases(hooksCmd
    .command('view [name]'), 'view')
    .description('Read the shell script content for a hook')
    .addHelpText('after', `
Examples:
  # View a specific hook
  agents hooks view post-edit

  # Interactive picker
  agents hooks view
`)
    .action(async (name?: string) => {
      const centralHooks = listCentralHooks();
      if (centralHooks.length === 0) {
        console.log(chalk.yellow('No hooks installed'));
        return;
      }

      if (!name) {
        if (!isInteractiveTerminal()) {
          requireInteractiveSelection('Selecting a hook to view', [
            'agents hooks view post-edit',
          ]);
        }
        try {
          const { select } = await import('@inquirer/prompts');
          name = await select({
            message: 'Select a hook to view',
            choices: centralHooks.map((hook) => ({
              value: hook.name,
              name: hook.name,
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

      const hook = getHookInfo(name);
      if (!hook) {
        console.log(chalk.yellow(`Hook '${name}' not found`));
        return;
      }

      console.log(chalk.bold(`\n${hook.name}`));
      console.log(chalk.gray(`Path: ${hook.path}\n`));

      if (hook.content) {
        const contentLines = hook.content.split('\n');

        const output = contentLines.map((line, i) => `  ${chalk.gray(String(i + 1).padStart(3))}  ${line}`).join('\n');
        printWithPager(output, contentLines.length);
      }
    });

  hooksCmd
    .command('profile')
    .description('Per-hook timing + cache stats from recent invocations')
    .option('--days <n>', 'Number of days of logs to read', '7')
    .option('--warn-ms <n>', 'p99 threshold above which a hook is flagged as slow', '2000')
    .option('--json', 'Emit raw JSON rows instead of the table')
    .addHelpText('after', `
Shows aggregated stats for every hook that fired through a generated shim.
Primary source: disposable SQLite warehouse ~/.agents/.cache/perf/perf.db
(same data as \`agents insights perf hooks\`). Falls back to the legacy daily JSONL under
~/.agents/.cache/logs/ when the warehouse is empty.

Examples:
  agents hooks profile                # last 7 days, table form
  agents hooks profile --days 30      # roll up the full month
  agents hooks profile --json | jq    # pipe somewhere
  agents insights perf hooks                   # same rollup under the perf surface

A hook whose p99 exceeds --warn-ms gets flagged in the cache column. Add
'cache: 5m' or 'cache: 5m-bg' to its hooks.yaml entry to fix it.
`)
    .option('--project <key>', 'Scope to one project (see agents insights perf --help)')
    .action(async (options: { days: string; warnMs: string; json?: boolean; project?: string }) => {
      const { DEFAULT_SLOW_HOOK_WARN_MS } = await import('../lib/hooks/profile.js');
      const { loadHookProfile, renderHookTable } = await import('./perf.js');
      const days = Math.max(1, parseInt(options.days, 10) || 7);
      const warnMs = Math.max(0, parseInt(options.warnMs, 10) || DEFAULT_SLOW_HOOK_WARN_MS);
      const rows = loadHookProfile(days, options.project);

      if (options.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }

      if (rows.length === 0) {
        console.log(chalk.gray(`No hook.fire samples in the last ${days} day${days === 1 ? '' : 's'}.`));
        console.log(chalk.gray('Every hook now instruments via a generated shim (cache:, matches:, or a bare matcher:) — resync hooks if this is unexpectedly empty.'));
        return;
      }

      renderHookTable(rows, warnMs);
    });
}
