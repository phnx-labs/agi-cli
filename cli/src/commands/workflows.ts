import type { Command } from 'commander';
import { withAliases } from '../lib/verbs.js';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { select, checkbox } from '@inquirer/prompts';

import { resolveAgentName, agentLabel } from '../lib/agents.js';
import { capableAgents } from '../lib/capabilities.js';
import type { AgentId } from '../lib/types.js';
import { cloneRepo } from '../lib/git.js';
import {
  discoverWorkflowsFromRepo,
  installWorkflowCentrally,
  removeWorkflow,
  listInstalledWorkflows,
  iterWorkflowsCapableVersions,
  type WorkflowFrontmatter,
  type InstalledWorkflow,
} from '../lib/workflows.js';
import { listWorkflowsForAgent, removeWorkflowFromVersion } from '../lib/workflows-registry.js';
import {
  getVersionHomePath,
  getGlobalDefault,
  syncResourcesToVersion,
  promptAgentVersionSelection,
  resolveAgentVersionTargets,
} from '../lib/installations/versions.js';
import { recordVersionResources, getUserWorkflowsDir } from '../lib/state.js';
import {
  isPromptCancelled,
  isInteractiveTerminal,
  requireInteractiveSelection,
  printWithPager,
  promptRemovalTargets,
  parseCommaSeparatedList,
  resolveAgentTargetsAutoInstalling,
  type RemovalTarget,
  resolveListFilterOrExit,
} from './utils.js';
import {
  showResourceList,
  buildTargetsSection,
  type ResourceRow,
  type SyncTarget,
} from './resource-view.js';

export function registerWorkflowsCommands(program: Command): void {
  const workflowsCmd = program
    .command('workflows')
    .description('Manage multi-agent pipeline workflows (WORKFLOW.md bundles)')
    .addHelpText('after', `
Workflows are directory bundles that define reusable named agent pipelines.
Run a workflow with:
  agents run <workflow-name> [prompt]

Structure:
  ~/.agents/workflows/<name>/
    WORKFLOW.md        required: YAML frontmatter + orchestrator system prompt
    subagents/*.md     optional: subagents the orchestrator can dispatch to
    skills/            optional: knowledge packs scoped to this workflow
    plugins/           optional: plugin bundles scoped to this workflow

Resolution: project > user > plugin (plugins/*/workflows/) > extra > system.
Pin a source with name@plugin or name@extra-alias (optional workflow: prefix).

Note: agents run defaults to --mode plan (read-only). For workflows that
write files, post comments, or otherwise mutate state, pass --mode edit or
--mode full or the run will deadlock at ExitPlanMode.

Examples:
  # See what workflows are available
  agents workflows list

  # Install from GitHub or a local directory
  agents workflows add gh:user/workflows
  agents workflows add ./code-review

  # Inspect a workflow's frontmatter and subagents
  agents workflows view code-review

  # Run it (workflow name goes in the agent slot)
  agents run code-review "review PR #42"

  # Run a workflow that posts comments / edits files
  agents run code-review --mode full "review PR #42 and post the review"

  # Remove from version homes (and central storage on second run)
  agents workflows remove code-review
`);

  withAliases(workflowsCmd
    .command('list [agent]'), 'list')
    .description('Show installed workflows and which agent versions they are synced to')
    .option('-a, --agent <agent>', 'Filter to a specific agent')
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
          console.log(chalk.red(`Unknown agent: ${parts[0]}`));
          process.exit(1);
        }
        filterAgent = resolved;
        filterVersion = resolveListFilterOrExit(resolved, parts[1]);
      }

      const rows = buildWorkflowRows({ filterAgent, filterVersion });
      spinner.stop();

      await showResourceList({
        resourcePlural: 'workflows',
        resourceSingular: 'workflow',
        extraLabel: 'Agents',
        rows,
        emptyMessage: filterAgent
          ? `No workflows in central storage for ${agentLabel(filterAgent)}.`
          : 'No workflows in ~/.agents/workflows/. Add one with: agents workflows add gh:user/repo',
        centralPath: getUserWorkflowsDir(),
        filterAgent,
        filterVersion,
      });
    });

  workflowsCmd
    .command('add [source]')
    .description('Install workflows from a source (GitHub, local) or pick from central storage')
    .option('-a, --agents <list>', 'Targets: claude, claude@2.1.138, claude@all, all')
    .option('--names <list>', 'Workflow names from the source (comma-separated)')
    .option('-y, --yes', 'Skip confirmation prompts')
    .addHelpText('after', `
Examples:
  # Install from GitHub
  agents workflows add gh:user/workflows

  # Pluck specific workflows from a multi-workflow repo
  agents workflows add gh:user/workflows --names rdev,plan

  # Install a local workflow directory (must contain WORKFLOW.md)
  agents workflows add ./rdev

  # Install and sync to a specific version
  agents workflows add gh:user/workflows --agents claude@2.1.138

  # Install across every installed Claude version
  agents workflows add gh:user/workflows --agents claude@all
`)
    .action(async (source: string | undefined, options) => {
      try {
        type WorkflowRef = { name: string; path: string };
        let workflows: WorkflowRef[];

        if (!source) {
          const installed = listInstalledWorkflows();
          if (installed.size === 0) {
            console.log(chalk.yellow('No workflows in ~/.agents/workflows/'));
            console.log(chalk.gray('\nTo add workflows from a repo:'));
            console.log(chalk.cyan('  agents workflows add gh:user/repo'));
            return;
          }

          if (!isInteractiveTerminal()) {
            requireInteractiveSelection('Selecting workflows', [
              'agents workflows add gh:user/repo',
            ]);
          }

          const choices = Array.from(installed.values()).map(w => ({
            value: w.name,
            name: w.frontmatter.description
              ? `${w.name}  ${chalk.gray(w.frontmatter.description.slice(0, 50))}`
              : w.name,
          }));

          const selected = await checkbox({ message: 'Select workflows to sync', choices });
          if (selected.length === 0) {
            console.log(chalk.gray('No workflows selected.'));
            return;
          }
          workflows = selected.map(name => ({ name, path: installed.get(name)!.path }));
        } else {
          const spinner = ora('Fetching workflows...').start();
          const isGitRepo = source.startsWith('gh:') || source.startsWith('git:') ||
                            source.startsWith('https://') || source.startsWith('http://');
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

          let discovered = discoverWorkflowsFromRepo(localPath);
          if (discovered.length === 0) {
            console.log(chalk.yellow('No workflows found (looking for WORKFLOW.md files)'));
            return;
          }

          const requestedNames = parseCommaSeparatedList(options.names);
          if (requestedNames.length > 0) {
            const discoveredNames = new Set(discovered.map((w) => w.name));
            const missing = requestedNames.filter((n) => !discoveredNames.has(n));
            if (missing.length > 0) {
              console.log(chalk.red(`\nWorkflow(s) not found in source: ${missing.join(', ')}`));
              console.log(chalk.gray(`Available: ${[...discoveredNames].join(', ')}`));
              process.exit(1);
            }
            discovered = discovered.filter((w) => requestedNames.includes(w.name));
          }

          console.log(chalk.bold(`\nFound ${discovered.length} workflow(s):`));
          for (const w of discovered) {
            console.log(`\n  ${chalk.cyan(w.name)}: ${w.frontmatter.description || 'no description'}`);
            if (w.subagentCount > 0) {
              console.log(`    ${chalk.gray(`${w.subagentCount} subagent${w.subagentCount === 1 ? '' : 's'}`)}`);
            }
          }

          const installSpinner = ora('Installing to central storage...').start();
          let installed = 0;
          for (const w of discovered) {
            const result = installWorkflowCentrally(w.path, w.name);
            if (result.success) {
              installed++;
            } else {
              installSpinner.stop();
              console.log(chalk.red(`\n  Failed to install ${w.name}: ${result.error}`));
              installSpinner.start();
            }
          }
          installSpinner.succeed(`Installed ${installed} workflow(s) to ~/.agents/workflows/`);
          workflows = discovered.map(w => ({
            name: w.name,
            path: path.join(getUserWorkflowsDir(), w.name),
          }));
        }

        let selectedAgents: AgentId[];
        let versionSelections: Map<AgentId, string[]>;

        if (options.agents) {
          const result = await resolveAgentTargetsAutoInstalling(options.agents, capableAgents('workflows'), { yes: options.yes });
          if (!result) {
            console.log(chalk.gray('Cancelled.'));
            return;
          }
          selectedAgents = result.selectedAgents;
          versionSelections = result.versionSelections;
        } else {
          const result = await promptAgentVersionSelection(capableAgents('workflows'), {
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
        const workflowNames = workflows.map(w => w.name);

        for (const [agentId, versions] of versionSelections) {
          for (const version of versions) {
            syncResourcesToVersion(agentId, version);
            recordVersionResources(agentId, version, 'workflows', workflowNames);
            synced++;
          }
        }

        if (synced > 0) {
          syncSpinner.succeed(`Synced to ${synced} agent version(s)`);
        } else {
          syncSpinner.info('No version-managed agents to sync');
        }

        console.log(chalk.green('\nWorkflows installed.'));
        console.log(chalk.gray('Run with: agents run <workflow-name>'));
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.gray('\nCancelled'));
          return;
        }
        console.error(chalk.red('Failed to add workflows'));
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  withAliases(workflowsCmd
    .command('remove [name]'), 'remove')
    .description('Remove a workflow from version homes (interactive picker if no name given)')
    .addHelpText('after', `
Examples:
  # Remove a workflow by name
  agents workflows remove rdev

  # Interactive picker
  agents workflows remove
`)
    .action(async (name?: string) => {
      type WorkflowTargetInfo = { name: string; targets: Array<{ agent: AgentId; version: string }> };
      const workflowTargetMap = new Map<string, WorkflowTargetInfo>();

      for (const { agent, version } of iterWorkflowsCapableVersions()) {
        const home = getVersionHomePath(agent, version);
        for (const n of listWorkflowsForAgent(agent, home)) {
          const existing = workflowTargetMap.get(n);
          if (existing) {
            existing.targets.push({ agent, version });
          } else {
            workflowTargetMap.set(n, { name: n, targets: [{ agent, version }] });
          }
        }
      }

      let toRemove: string[];

      if (name) {
        toRemove = [name];
      } else {
        if (workflowTargetMap.size === 0) {
          console.log(chalk.yellow('No workflows synced to any version.'));
          return;
        }
        if (!isInteractiveTerminal()) {
          requireInteractiveSelection('Selecting workflows to remove', [
            'agents workflows remove rdev',
          ]);
        }
        try {
          const selected = await checkbox({
            message: 'Select workflows to remove',
            choices: Array.from(workflowTargetMap.values()).map(w => ({
              value: w.name,
              name: w.name,
            })),
          });
          if (selected.length === 0) {
            console.log(chalk.gray('No workflows selected.'));
            return;
          }
          toRemove = selected;
        } catch (err) {
          if (isPromptCancelled(err)) {
            console.log(chalk.gray('Cancelled'));
            return;
          }
          throw err;
        }
      }

      let removed = 0;
      for (const workflowName of toRemove) {
        const info = workflowTargetMap.get(workflowName);

        if (!info || info.targets.length === 0) {
          const result = removeWorkflow(workflowName);
          if (result.success) {
            console.log(`  ${chalk.red('-')} ${workflowName}: removed from central storage`);
            removed++;
          } else {
            console.log(chalk.yellow(`  Workflow '${workflowName}' not found.`));
          }
          continue;
        }

        const removalTargets: RemovalTarget[] = info.targets.map(t => ({
          agent: t.agent,
          version: t.version,
          label: `${agentLabel(t.agent)}@${t.version}`,
        }));

        const selectedTargets = await promptRemovalTargets(workflowName, removalTargets);
        if (selectedTargets.length === 0) {
          console.log(chalk.gray(`  Skipped '${workflowName}'.`));
          continue;
        }

        for (const target of selectedTargets) {
          const result = removeWorkflowFromVersion(target.agent as AgentId, target.version, workflowName);
          if (result.success) {
            console.log(`  ${chalk.red('-')} ${target.label}: ${workflowName}`);
            removed++;
          } else if (result.error) {
            console.log(`  ${chalk.yellow('!')} ${target.label}: ${result.error}`);
          }
        }
      }

      if (removed === 0) {
        console.log(chalk.yellow('No workflows removed.'));
      } else {
        console.log(chalk.green(`\nRemoved ${removed} workflow(s) from version homes.`));
        console.log(chalk.gray('Central source unchanged. Use "agents workflows remove <name>" again to remove from ~/.agents/workflows/.'));
      }
    });

  withAliases(workflowsCmd
    .command('view [name]'), 'view')
    .description('Read workflow details (description, subagents, model, MCP)')
    .addHelpText('after', `
Examples:
  # View a specific workflow
  agents workflows view rdev

  # Interactive picker
  agents workflows view
`)
    .action(async (name?: string) => {
      const installed = listInstalledWorkflows();

      if (!name) {
        if (installed.size === 0) {
          console.log(chalk.yellow('No workflows installed'));
          return;
        }
        if (!isInteractiveTerminal()) {
          requireInteractiveSelection('Selecting a workflow to view', [
            'agents workflows view rdev',
          ]);
        }
        try {
          name = await select({
            message: 'Select a workflow to view',
            choices: Array.from(installed.values()).map(w => ({
              value: w.name,
              name: w.frontmatter.description
                ? `${w.name} - ${w.frontmatter.description}`
                : w.name,
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

      const workflow = installed.get(name!);
      if (!workflow) {
        console.log(chalk.yellow(`Workflow '${name}' not found`));
        return;
      }

      const lines: string[] = [];
      const fm = workflow.frontmatter;
      lines.push(chalk.bold(`\n${fm.name || workflow.name}\n`));
      if (fm.description) lines.push(`  ${fm.description}`);
      lines.push('');
      if (fm.model) lines.push(`  Model:   ${fm.model}`);
      if (fm.tools?.length) lines.push(`  Tools:   ${fm.tools.join(', ')}`);
      if (fm.mcpServers?.length) lines.push(`  MCP:     ${fm.mcpServers.join(', ')}`);
      if (fm.skills?.length) lines.push(`  Skills:  ${fm.skills.join(', ')}`);
      if (fm.secrets?.length) lines.push(`  Secrets: ${fm.secrets.join(', ')}  ${chalk.gray('(auto-injected at run time — pass --no-auto-secrets to skip)')}`);
      lines.push(`  Path:    ${workflow.path}`);

      if (fm.allowedAgents?.length) {
        lines.push(chalk.bold(`\n  Subagents (${workflow.subagentCount}):`));
        for (const a of fm.allowedAgents) {
          lines.push(`    ${chalk.cyan(a)}`);
        }
      }
      lines.push('');

      printWithPager(lines.join('\n'), lines.length);
    });
}

function buildWorkflowRows(opts: {
  filterAgent?: AgentId;
  filterVersion?: string;
}): ResourceRow[] {
  const central = listInstalledWorkflows();
  if (central.size === 0) return [];

  const targetPairs = iterWorkflowsCapableVersions({
    agent: opts.filterAgent,
    version: opts.filterVersion,
  });

  const syncedByTarget = new Map<string, Set<string>>();
  const defaultByAgent = new Map<AgentId, string | null>();

  for (const { agent, version } of targetPairs) {
    if (!defaultByAgent.has(agent)) defaultByAgent.set(agent, getGlobalDefault(agent));
    const home = getVersionHomePath(agent, version);
    syncedByTarget.set(`${agent}@${version}`, new Set(listWorkflowsForAgent(agent, home)));
  }

  const rows: ResourceRow[] = [];
  for (const [name, workflow] of central) {
    const targets: SyncTarget[] = targetPairs.map(({ agent, version }) => ({
      agent,
      version,
      isDefault: defaultByAgent.get(agent) === version,
      status: syncedByTarget.get(`${agent}@${version}`)?.has(name) ? 'synced' : 'missing',
    }));

    rows.push({
      name,
      description: workflow.frontmatter.description,
      extra: workflow.subagentCount > 0 ? `${workflow.subagentCount}` : '-',
      targets,
      buildDetail: () => formatWorkflowDetail(workflow, targets),
    });
  }

  rows.sort((a, b) => {
    const aSynced = a.targets.filter(t => t.status === 'synced').length;
    const bSynced = b.targets.filter(t => t.status === 'synced').length;
    if (aSynced !== bSynced) return bSynced - aSynced;
    return a.name.localeCompare(b.name);
  });

  return rows;
}

function formatWorkflowDetail(
  workflow: InstalledWorkflow,
  targets: SyncTarget[],
): string {
  const lines: string[] = [];
  const fm: WorkflowFrontmatter = workflow.frontmatter;
  lines.push(chalk.bold.cyan(workflow.name));
  if (fm.description) lines.push(chalk.gray(fm.description));
  lines.push('');

  const meta: string[] = [];
  if (fm.model) meta.push(`model ${chalk.white(fm.model)}`);
  if (fm.mcpServers?.length) meta.push(`${chalk.white(fm.mcpServers.length)} MCP`);
  if (fm.skills?.length) meta.push(`${chalk.white(fm.skills.length)} skill${fm.skills.length === 1 ? '' : 's'}`);
  meta.push(`${chalk.white(workflow.subagentCount)} subagent${workflow.subagentCount === 1 ? '' : 's'}`);
  if (meta.length) lines.push('  ' + meta.join(chalk.gray(' · ')));
  lines.push('  ' + chalk.gray(workflow.path));

  lines.push('');
  lines.push(chalk.bold('  Synced to'));
  lines.push(buildTargetsSection(targets));

  return lines.join('\n');
}
