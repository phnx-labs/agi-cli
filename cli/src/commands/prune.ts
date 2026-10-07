import * as fs from 'fs';
import type { Command } from 'commander';
import chalk from 'chalk';
import { formatBytes } from '../lib/format.js';
import { confirm } from '@inquirer/prompts';
import type { AgentId } from '../lib/types.js';
import {
  diffVersionCommands,
  iterCommandsCapableVersions,
  removeCommandFromVersion,
} from '../lib/commands.js';
import {
  diffVersionSkills,
  iterSkillsCapableVersions,
  removeSkillFromVersion,
} from '../lib/plugins/skills.js';
import {
  listUnmanagedHooksInVersionHome,
  iterHooksCapableVersions,
  removeHookFromVersion,
} from '../lib/hooks/install.js';
import {
  diffVersionPlugins,
  iterPluginsCapableVersions,
  removePluginSkillFromVersion,
} from '../lib/plugins/plugins.js';
import {
  diffVersionSubagents,
  iterSubagentsCapableVersions,
  removeSubagentFromVersion,
} from '../lib/subagents.js';
import { getGlobalDefault } from '../lib/installations/versions.js';
import { resolveAgentName, formatAgentError } from '../lib/agents.js';
import { pruneDuplicates } from './view.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';
import { previewRunsPrune, pruneRuns, countAllRuns } from '../lib/scheduling/routines.js';

type ResourceType = 'commands' | 'skills' | 'hooks' | 'plugins' | 'subagents';
type StateType = 'sessions' | 'runs';
type PruneType = ResourceType | 'versions' | StateType;

const RESOURCE_TYPES: ResourceType[] = ['commands', 'skills', 'hooks', 'plugins', 'subagents'];
const STATE_TYPES: StateType[] = ['sessions', 'runs'];
const ALL_TYPES: PruneType[] = [...RESOURCE_TYPES, 'versions', ...STATE_TYPES];

interface PruneOptions {
  all?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  olderThan?: string;
  keep?: string;
}

interface OrphanGroup {
  type: ResourceType;
  agent: AgentId;
  version: string;
  orphans: string[];
}

function scopePairs(
  pairs: Array<{ agent: AgentId; version: string }>,
  all: boolean,
): Array<{ agent: AgentId; version: string }> {
  if (all) return pairs;
  return pairs.filter((p) => p.version === getGlobalDefault(p.agent));
}

function collectOrphans(types: ResourceType[], all: boolean): OrphanGroup[] {
  const groups: OrphanGroup[] = [];

  if (types.includes('commands')) {
    for (const { agent, version } of scopePairs(iterCommandsCapableVersions(), all)) {
      const diff = diffVersionCommands(agent, version);
      const removable = [...diff.orphans, ...diff.toRemove];
      if (removable.length > 0) {
        groups.push({ type: 'commands', agent, version, orphans: removable });
      }
    }
  }

  if (types.includes('skills')) {
    for (const { agent, version } of scopePairs(iterSkillsCapableVersions(), all)) {
      const diff = diffVersionSkills(agent, version);
      if (diff.orphans.length > 0) {
        groups.push({ type: 'skills', agent, version, orphans: diff.orphans });
      }
    }
  }

  if (types.includes('hooks')) {
    for (const { agent, version } of scopePairs(iterHooksCapableVersions(), all)) {
      const orphans = listUnmanagedHooksInVersionHome(agent, version);
      if (orphans.length > 0) {
        groups.push({ type: 'hooks', agent, version, orphans });
      }
    }
  }

  if (types.includes('plugins')) {
    for (const { agent, version } of scopePairs(iterPluginsCapableVersions(), all)) {
      const diff = diffVersionPlugins(agent, version);
      if (diff.orphans.length > 0) {
        groups.push({ type: 'plugins', agent, version, orphans: diff.orphans });
      }
    }
  }

  if (types.includes('subagents')) {
    for (const { agent, version } of scopePairs(iterSubagentsCapableVersions(), all)) {
      const diff = diffVersionSubagents(agent, version);
      if (diff.orphans.length > 0) {
        groups.push({ type: 'subagents', agent, version, orphans: diff.orphans });
      }
    }
  }

  return groups;
}

function removeOne(group: OrphanGroup, name: string): { success: boolean; error?: string } {
  switch (group.type) {
    case 'commands':
      return removeCommandFromVersion(group.agent, group.version, name);
    case 'skills':
      return removeSkillFromVersion(group.agent, group.version, name);
    case 'hooks':
      return removeHookFromVersion(group.agent, group.version, name);
    case 'plugins':
      return removePluginSkillFromVersion(group.agent, group.version, name);
    case 'subagents':
      return removeSubagentFromVersion(group.agent, group.version, name);
  }
}

interface ParsedTarget {
  resourceTypes: ResourceType[];
  includeVersions: boolean;
  stateType?: StateType;
  versionAgent?: AgentId;
}

function parseTarget(arg: string | undefined): ParsedTarget {
  if (!arg) {
    return { resourceTypes: RESOURCE_TYPES, includeVersions: true };
  }
  if (RESOURCE_TYPES.includes(arg as ResourceType)) {
    return { resourceTypes: [arg as ResourceType], includeVersions: false };
  }
  if (STATE_TYPES.includes(arg as StateType)) {
    return { resourceTypes: [], includeVersions: false, stateType: arg as StateType };
  }
  if (arg === 'versions') {
    return { resourceTypes: [], includeVersions: true };
  }
  const agentId = resolveAgentName(arg);
  if (agentId) {
    return { resourceTypes: [], includeVersions: true, versionAgent: agentId };
  }
  console.log(chalk.red(`Unknown prune target: ${arg}`));
  console.log(chalk.gray(`Available types: ${ALL_TYPES.join(', ')}`));
  console.log(chalk.gray(formatAgentError(arg)));
  process.exit(1);
}

async function runSessionsPrune(options: PruneOptions): Promise<void> {
  if (options.olderThan || options.yes || options.dryRun) {
    console.log(chalk.gray('Session prune flags are accepted for compatibility but do not delete data.'));
  }
  console.log(chalk.yellow('Session history is durable. agents-cli does not hard-delete session records.'));
  console.log(chalk.gray('Browse sessions with: agents sessions'));
}

async function runRunsPrune(options: PruneOptions): Promise<void> {
  const keep = options.keep ? parseInt(options.keep, 10) : 10;
  if (isNaN(keep) || keep < 0) {
    console.log(chalk.red('--keep must be a non-negative integer'));
    process.exit(1);
  }

  const preview = previewRunsPrune(keep);
  const total = countAllRuns();

  if (preview.length === 0) {
    console.log(chalk.green(`All jobs have ${keep} or fewer runs. Nothing to prune.`));
    return;
  }

  console.log(chalk.bold(`Routine runs to prune (keeping last ${keep} per job)\n`));
  const byJob = new Map<string, number>();
  for (const run of preview) {
    byJob.set(run.jobName, (byJob.get(run.jobName) || 0) + 1);
  }
  for (const [job, count] of byJob) {
    console.log(`  ${chalk.cyan(job)}: ${count} old runs`);
  }
  console.log();

  if (options.dryRun) {
    console.log(chalk.gray(`${preview.length} of ${total} runs would be deleted. Run without --dry-run to delete.`));
    return;
  }

  if (!options.yes) {
    if (!isInteractiveTerminal()) {
      console.log(chalk.yellow('Non-interactive shell: pass -y to confirm, or --dry-run to preview.'));
      process.exit(1);
    }
    let ok = false;
    try {
      ok = await confirm({ message: `Delete ${preview.length} old runs?`, default: false });
    } catch (err) {
      if (isPromptCancelled(err)) { console.log(chalk.gray('Cancelled')); return; }
      throw err;
    }
    if (!ok) { console.log(chalk.gray('Cancelled')); return; }
  }

  const { deleted, bytesFreed } = pruneRuns(keep);
  console.log(chalk.green(`Pruned ${deleted} runs (${formatBytes(bytesFreed)}).`));
}

async function runOrphanPrune(
  resourceTypes: ResourceType[],
  options: PruneOptions,
): Promise<void> {
  const groups = collectOrphans(resourceTypes, options.all === true);

  if (groups.length === 0) {
    console.log(chalk.green('No orphans.'));
    return;
  }

  const total = groups.reduce((n, g) => n + g.orphans.length, 0);

  console.log(chalk.bold('Orphans (in version home, unmanaged by any source)\n'));
  for (const g of groups) {
    const label = `${g.type} · ${g.agent}@${g.version}`;
    console.log(`  ${chalk.cyan(label)}  ${g.orphans.join(', ')}`);
  }
  console.log();

  if (options.dryRun) {
    console.log(chalk.gray(`${total} orphan(s). Run without --dry-run to delete.`));
    return;
  }

  if (!options.yes) {
    if (!isInteractiveTerminal()) {
      console.log(chalk.yellow('Non-interactive shell: pass -y to confirm, or --dry-run to preview.'));
      process.exit(1);
    }
    let ok = false;
    try {
      ok = await confirm({
        message: `Delete ${total} orphan${total === 1 ? '' : 's'}?`,
        default: false,
      });
    } catch (err) {
      if (isPromptCancelled(err)) {
        console.log(chalk.gray('Cancelled'));
        return;
      }
      throw err;
    }
    if (!ok) {
      console.log(chalk.gray('Cancelled'));
      return;
    }
  }

  let removed = 0;
  let failures = 0;
  for (const g of groups) {
    for (const name of g.orphans) {
      const r = removeOne(g, name);
      if (r.success) {
        removed++;
      } else {
        failures++;
        console.log(chalk.red(`  ! ${g.type} ${g.agent}@${g.version} ${name}: ${r.error}`));
      }
    }
  }

  const summary = `Pruned ${removed} orphan${removed === 1 ? '' : 's'}`;
  console.log(chalk.green(summary) + (failures > 0 ? chalk.red(`, ${failures} failed`) : '') + '.');
}

export function registerPruneCommand(program: Command): void {
  const pruneCmd = program.commands.find((cmd) => cmd.name() === 'prune') ?? program
    .command('prune <specs...>')
    .description('Uninstall agent CLI versions. Moves version data to trash for recovery.');

  pruneCmd
    .command('cleanup [target]')
    .description('Remove orphan resources, old versions, or routine runs')
    .option('--all', 'For orphan cleanup: sweep every installed version (default: current default version per agent)')
    .option('--dry-run', 'Show what would be removed without deleting (default for state targets)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--older-than <days>', 'Deprecated for sessions; accepted but no data is deleted')
    .option('--keep <n>', 'For runs: keep the last N runs per job (default: 10)')
    .addHelpText('after', `
Targets:
  (none)     Orphans across commands, skills, hooks + duplicate versions
  commands   Orphan command files only
  skills     Orphan skill directories only
  hooks      Orphan hook scripts only
  versions   Older duplicate version installs only
  <agent>    Older duplicate versions for one agent (e.g. 'claude')
  sessions   No-op compatibility target; session history is durable
  runs       Routine execution logs, keeping only --keep per job (default 10)

Examples:
  # Full sweep: orphan resources + duplicate versions for current defaults
  agents prune cleanup

  # Preview what a full sweep would remove
  agents prune cleanup --dry-run

  # Just orphan skills
  agents prune cleanup skills

  # Just version dedup
  agents prune cleanup versions

  # Deduplicate versions for one agent only
  agents prune cleanup claude

  # Sweep every installed version's orphans, not only the defaults
  agents prune cleanup --all

  # Show the durable-session notice
  agents prune cleanup sessions --dry-run

  # Preview runs cleanup (keeping last 10)
  agents prune cleanup runs --dry-run

  # Keep only the last 5 runs per job
  agents prune cleanup runs --keep 5 -y

What's an orphan?
  A command, skill, or hook present inside a version home but missing from every
  configured source (project .agents/, central ~/.agents/, and any enabled extra
  repos). Usually leftovers from a resource that was deleted or moved but never
  reconciled into the version install.

Durability:
  Version prune and cleanup move version directories to
  ~/.agents/.history/trash/versions/<agent>/<version>/<timestamp>/. Nothing is
  hard-deleted until you run \`agents trash empty\`. Session records are durable;
  the sessions target remains only as a no-op compatibility shim.
`)
    .action(async (target: string | undefined, options: PruneOptions) => {
      const parsed = parseTarget(target);

      if (parsed.stateType) {
        switch (parsed.stateType) {
          case 'sessions':
            await runSessionsPrune(options);
            break;
          case 'runs':
            await runRunsPrune(options);
            break;
        }
        return;
      }

      if (parsed.resourceTypes.length > 0) {
        await runOrphanPrune(parsed.resourceTypes, options);
        if (parsed.includeVersions) console.log();
      }

      if (parsed.includeVersions) {
        const versionLabel = parsed.versionAgent ? ` for ${parsed.versionAgent}` : '';
        console.log(chalk.bold(`Duplicate versions${versionLabel}`));
        await pruneDuplicates(parsed.versionAgent, options.yes === true, options.dryRun === true);
      }
    });
}
