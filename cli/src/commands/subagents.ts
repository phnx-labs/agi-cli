/**
 * Subagent management commands.
 *
 * Registers the `agents subagents` command tree for listing, viewing,
 * installing, and removing lightweight agent definitions (AGENT.md files)
 * that parent agents can spawn for focused subtasks.
 */

import type { Command } from 'commander';
import { withAliases } from '../lib/verbs.js';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import { checkbox } from '@inquirer/prompts';

import { AGENTS, agentLabel } from '../lib/agents.js';
import { homeDir } from '../lib/platform/index.js';
import { capableAgents } from '../lib/capabilities.js';
import type { AgentId } from '../lib/types.js';
import { cloneRepo } from '../lib/git.js';
import {
  discoverSubagentsFromRepo,
  installSubagentCentrally,
  removeSubagent,
  listInstalledSubagents,
  getInstalledSubagent,
  listSubagentsForAgent,
  iterSubagentsCapableVersions,
  removeSubagentFromVersion,
} from '../lib/subagents.js';
import {
  listInstalledVersions,
  syncResourcesToVersion,
  getGlobalDefault,
  getVersionHomePath,
  resolveAgentVersionTargets,
  promptAgentVersionSelection,
} from '../lib/installations/versions.js';
import { getSubagentsDir, recordVersionResources } from '../lib/state.js';
import {
  isInteractiveTerminal,
  isPromptCancelled,
  requireInteractiveSelection,
  requireDestructiveArg,
  promptRemovalTargets,
  parseCommaSeparatedList,
  resolveAgentTargetsAutoInstalling,
  type RemovalTarget,
} from './utils.js';
import {
  showResourceList,
  buildTargetsSection,
  type ResourceRow,
  type SyncTarget,
} from './resource-view.js';

/** Replace the home directory prefix with ~ for display. */
function formatPath(p: string): string {
  const home = homeDir();
  if (home && p.startsWith(home)) {
    return '~' + p.slice(home.length);
  }
  return p;
}

/** Register the `agents subagents` command tree. */
export function registerSubagentsCommands(program: Command): void {
  const subagentsCmd = program
    .command('subagents')
    .description('Install specialized agent definitions that parent agents can spawn for focused tasks')
    .addHelpText('after', `
Subagents are lightweight agent definitions (AGENT.md files) that a parent agent can spawn for specific subtasks. Each subagent has its own model, mode, and instruction set, stored in ~/.agents/subagents/ and synced to agent homes on install.

Examples:
  # Interactive picker (TTY) or sync-status table (piped)
  agents subagents list

  # View details for a specific subagent
  agents subagents view code-reviewer

  # Install subagents from GitHub
  agents subagents add gh:team/subagents --agents claude,openclaw

  # Add from a local directory
  agents subagents add ~/my-subagent --agents claude

When to use:
  - Multi-agent workflows: install subagents that parent agents spawn for specialized work
  - Version isolation: sync different subagent sets to different agent versions
  - Team sharing: distribute subagent definitions via GitHub repos
`);

  // Shared list implementation, registered as `list` and hidden `view` alias.
  const runList = async (opts?: { json?: boolean }) => {
    const rows = buildSubagentRows();
    await showResourceList({
      resourcePlural: 'subagents',
      resourceSingular: 'subagent',
      extraLabel: 'Files',
      rows,
      emptyMessage: 'No subagents in ~/.agents/subagents/. Add one with: agents subagents add gh:user/repo',
      centralPath: getSubagentsDir(),
      json: opts?.json,
    });
  };

  // agents subagents list
  withAliases(subagentsCmd
    .command('list'), 'list')
    .description('Show subagents in a table with sync status across agent versions')
    .option('--json', 'Emit machine-readable JSON instead of the table/picker')
    .addHelpText('after', `
Examples:
  # Interactive picker (TTY) or sync-status table (piped)
  agents subagents list
`)
    .action(runList);

  // agents subagents view <name>
  withAliases(subagentsCmd
    .command('view [name]'), 'view')
    .description('Show details for a specific subagent (use "list" to see all)')
    .addHelpText('after', `
Examples:
  # View a specific subagent's details
  agents subagents view code-reviewer

  # No name → same as "agents subagents list"
  agents subagents view
`)
    .action(async (name?: string) => {
      if (!name) {
        await runList();
        return;
      }

      const subagent = getInstalledSubagent(name);
      if (!subagent) {
        console.log(chalk.red(`Subagent '${name}' not found`));
        console.log(chalk.gray(`Run 'agents subagents list' to list all installed subagents`));
        process.exit(1);
      }

      console.log(formatSubagentDetail(subagent, buildSubagentTargets(subagent.name)));
    });

  // agents subagents add <source>
  subagentsCmd
    .command('add <source>')
    .description('Install subagents from a source (GitHub, local path) and sync to agent versions')
    .option('-a, --agents <list>', 'Targets: claude, openclaw, claude@2.1.141, claude@all, all')
    .option('--names <list>', 'Subagent names from the source (comma-separated)')
    .option('-y, --yes', 'Skip all prompts and confirmations')
    .addHelpText('after', `
Examples:
  # Install from GitHub
  agents subagents add gh:team/subagents --agents claude,openclaw

  # Pluck specific subagents from a multi-subagent repo
  agents subagents add gh:team/subagents --names code-reviewer,planner

  # Install across every installed Claude version
  agents subagents add gh:team/subagents --agents claude@all

  # Install from local directory (must contain subagents/*/AGENT.md)
  agents subagents add ~/my-subagent --agents claude

  # Install non-interactively
  agents subagents add gh:user/repo --yes
`)
    .action(async (source, options) => {
      const spinner = ora({ text: 'Fetching source...', isSilent: !process.stdout.isTTY }).start();

      // Clone or use local source. Accept any git-like scheme to match the
      // other <resource> add commands (skills, workflows, commands, hooks).
      let sourcePath: string;
      const isGitRepo = source.startsWith('gh:') || source.startsWith('git:') ||
                        source.startsWith('ssh:') || source.startsWith('https://') ||
                        source.startsWith('http://');
      if (isGitRepo) {
        try {
          const cloneResult = await cloneRepo(source);
          sourcePath = cloneResult.localPath;
        } catch (err) {
          spinner.fail(`Failed to clone: ${(err as Error).message}`);
          process.exit(1);
        }
      } else if (fs.existsSync(source)) {
        sourcePath = path.resolve(source);
      } else {
        spinner.fail(`Source not found: ${source}`);
        process.exit(1);
      }

      // Discover subagents
      spinner.text = 'Discovering subagents...';
      let discovered = discoverSubagentsFromRepo(sourcePath);

      if (discovered.length === 0) {
        spinner.fail('No subagents found in source');
        console.log(chalk.gray(`Expected: subagents/*/AGENT.md`));
        process.exit(1);
      }

      // --names filter: pluck specific subagents from a multi-subagent source.
      const requestedNames = parseCommaSeparatedList(options.names);
      if (requestedNames.length > 0) {
        const discoveredNames = new Set(discovered.map((s) => s.name));
        const missing = requestedNames.filter((n) => !discoveredNames.has(n));
        if (missing.length > 0) {
          spinner.fail(`Subagent(s) not found in source: ${missing.join(', ')}`);
          console.log(chalk.gray(`Available: ${[...discoveredNames].join(', ')}`));
          process.exit(1);
        }
        discovered = discovered.filter((s) => requestedNames.includes(s.name));
      }

      spinner.succeed(`Found ${discovered.length} subagent(s)`);

      // Show what we found
      console.log();
      for (const sub of discovered) {
        console.log(`  ${chalk.cyan(sub.name)}: ${chalk.gray(sub.frontmatter.description)}`);
      }
      console.log();

      // Determine target agent versions, using the same path skills/workflows use.
      // Back-compat: commander's old `--agents <agents...>` shape arrives as an array;
      // join it with commas so resolveAgentVersionTargets can parse it.
      const agentsArg: string | undefined = Array.isArray(options.agents)
        ? options.agents.join(',')
        : options.agents;

      let selectedAgents: AgentId[];
      let versionSelections: Map<AgentId, string[]>;

      if (agentsArg) {
        const result = await resolveAgentTargetsAutoInstalling(agentsArg, capableAgents('subagents'), { yes: options.yes });
        if (!result) {
          console.log(chalk.gray('Cancelled.'));
          return;
        }
        selectedAgents = result.selectedAgents;
        versionSelections = result.versionSelections;
      } else {
        const result = await promptAgentVersionSelection(capableAgents('subagents'), {
          skipPrompts: options.yes,
        });
        selectedAgents = result.selectedAgents;
        versionSelections = result.versionSelections;
      }

      // Install centrally
      const installSpinner = ora({ text: 'Installing subagents...', isSilent: !process.stdout.isTTY }).start();

      for (const sub of discovered) {
        const result = installSubagentCentrally(sub.path, sub.name);
        if (!result.success) {
          installSpinner.fail(`Failed to install ${sub.name}: ${result.error}`);
          process.exit(1);
        }
      }

      installSpinner.succeed(`Installed ${discovered.length} subagent(s) to ${formatPath(getSubagentsDir())}`);

      // Sync to selected versions
      if (versionSelections.size > 0) {
        const syncSpinner = ora({ text: 'Syncing to agents...', isSilent: !process.stdout.isTTY }).start();
        const subagentNames = discovered.map((s) => s.name);
        let synced = 0;
        for (const [agentId, versions] of versionSelections) {
          for (const version of versions) {
            syncResourcesToVersion(agentId, version);
            recordVersionResources(agentId, version, 'subagents', subagentNames);
            synced++;
          }
        }
        if (synced > 0) {
          syncSpinner.succeed(`Synced to ${synced} agent version(s) across ${selectedAgents.map((id) => agentLabel(id)).join(', ')}`);
        } else {
          syncSpinner.info('No version-managed agents to sync');
        }
      } else {
        console.log(chalk.gray('Stored centrally; no agent versions selected for sync.'));
      }

      console.log();
    });

  // agents subagents remove [name]
  withAliases(subagentsCmd
    .command('remove [name]'), 'remove')
    .description('Delete a subagent from central storage and unsync from all agent versions')
    .option('-y, --yes', 'Skip confirmation prompt')
    .addHelpText('after', `
Examples:
  # Remove a subagent by name
  agents subagents remove code-reviewer

  # Remove without confirmation
  agents subagents remove code-reviewer --yes
`)
    .action(async (nameArg, options) => {
      if (!nameArg) {
        requireDestructiveArg({
          argName: 'name',
          command: 'agents subagents remove',
          itemNoun: 'subagent',
          available: listInstalledSubagents().map((s) => s.name),
          emptyHint: 'No subagents installed.',
        });
      }
      const name = nameArg;
      const subagent = getInstalledSubagent(name);
      if (!subagent) {
        console.log(chalk.red(`Subagent '${name}' not found`));
        process.exit(1);
      }

      // Build list of targets that have this subagent synced
      const availableTargets: Array<{ agent: AgentId; version: string }> = [];
      for (const { agent, version } of iterSubagentsCapableVersions()) {
        const home = getVersionHomePath(agent, version);
        const installed = listSubagentsForAgent(agent, home).some((s) => s.name === name);
        if (installed) {
          availableTargets.push({ agent, version });
        }
      }

      if (availableTargets.length === 0) {
        console.log(chalk.yellow(`Subagent '${name}' not synced to any version.`));
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

      let removed = 0;
      for (const target of selectedTargets) {
        const result = removeSubagentFromVersion(target.agent as AgentId, target.version, name);
        if (result.success) {
          console.log(`  ${chalk.red('-')} ${target.label}: ${name}`);
          removed++;
        } else if (result.error) {
          console.log(`  ${chalk.yellow('!')} ${target.label}: ${result.error}`);
        }
      }

      if (removed === 0) {
        console.log(chalk.yellow('No subagents removed.'));
      } else {
        console.log(chalk.green(`\nRemoved ${removed} subagent(s) from version homes.`));
        console.log(chalk.gray("Central source unchanged. Restore any target with 'agents sync <agent>@<version> --yes'."));
      }
    });
}

import type { InstalledSubagent } from '../lib/types.js';

/** Every (agent, version) that supports subagents and is installed. */
function iterSubagentCapableVersions(): Array<{ agent: AgentId; version: string; home: string }> {
  const out: Array<{ agent: AgentId; version: string; home: string }> = [];
  for (const agent of capableAgents('subagents')) {
    for (const version of listInstalledVersions(agent)) {
      out.push({ agent, version, home: getVersionHomePath(agent, version) });
    }
  }
  return out;
}

/** Compute sync targets for a single subagent by name across all capable versions. */
function buildSubagentTargets(name: string): SyncTarget[] {
  const targets: SyncTarget[] = [];
  for (const { agent, version, home } of iterSubagentCapableVersions()) {
    const installed = listSubagentsForAgent(agent, home).some((s) => s.name === name);
    targets.push({
      agent,
      version,
      isDefault: getGlobalDefault(agent) === version,
      status: installed ? 'synced' : 'missing',
    });
  }
  return targets;
}

/** Build resource rows for all centrally-installed subagents with sync status. */
function buildSubagentRows(): ResourceRow[] {
  const central = listInstalledSubagents();
  if (central.length === 0) return [];

  const pairs = iterSubagentCapableVersions();

  // Read each target's installed subagents once; lookup by name per row.
  const installedByTarget = new Map<string, Set<string>>();
  for (const { agent, version, home } of pairs) {
    const names = new Set(listSubagentsForAgent(agent, home).map((s) => s.name));
    installedByTarget.set(`${agent}@${version}`, names);
  }

  const rows: ResourceRow[] = [];
  for (const sub of central) {
    const targets: SyncTarget[] = [];
    for (const { agent, version } of pairs) {
      const set = installedByTarget.get(`${agent}@${version}`)!;
      targets.push({
        agent,
        version,
        isDefault: getGlobalDefault(agent) === version,
        status: set.has(sub.name) ? 'synced' : 'missing',
      });
    }

    rows.push({
      name: sub.name,
      description: sub.frontmatter.description,
      extra: String(sub.files.length),
      targets,
      buildDetail: () => formatSubagentDetail(sub, targets),
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

/** Build the multi-line detail pane shown when a subagent is selected in the picker. */
function formatSubagentDetail(sub: InstalledSubagent, targets: SyncTarget[]): string {
  const lines: string[] = [];
  lines.push(chalk.bold.cyan(sub.name));
  if (sub.frontmatter.description) {
    lines.push(chalk.gray(sub.frontmatter.description));
  }

  const meta: string[] = [];
  if (sub.frontmatter.model) meta.push(`model ${chalk.white(sub.frontmatter.model)}`);
  if (sub.frontmatter.color) meta.push(`color ${chalk.white(sub.frontmatter.color)}`);
  meta.push(`${chalk.white(sub.files.length)} file${sub.files.length === 1 ? '' : 's'}`);
  lines.push('  ' + meta.join(chalk.gray(' · ')));
  lines.push('  ' + chalk.gray(formatPath(sub.path)));

  if (sub.files.length > 0) {
    lines.push('');
    lines.push(chalk.bold('  Files'));
    for (const file of sub.files) {
      const filePath = path.join(sub.path, file);
      try {
        const stat = fs.statSync(filePath);
        const size = stat.size < 1024 ? `${stat.size}B` : `${(stat.size / 1024).toFixed(1)}KB`;
        lines.push(`    ${chalk.cyan(file)} ${chalk.gray(`(${size})`)}`);
      } catch {
        lines.push(`    ${chalk.cyan(file)}`);
      }
    }
  }

  if (targets.length > 0) {
    lines.push('');
    lines.push(chalk.bold('  Synced to'));
    lines.push(buildTargetsSection(targets));
  }

  return lines.join('\n');
}
