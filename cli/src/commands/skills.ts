/**
 * Skill management commands for adding domain-specific capabilities to agents.
 *
 * Implements `agents skills` -- list, add, remove, sync, prune, and view
 * packaged SKILL.md bundles (with optional rules/ directories). Central
 * storage lives in ~/.agents/skills/ and skills are synced to individual
 * version homes via copy or symlink.
 */
import type { Command } from 'commander';
import { withAliases } from '../lib/verbs.js';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { select, checkbox, confirm } from '@inquirer/prompts';

import {
  AGENTS,
  resolveAgentName,
  getAllCliStates,
  formatAgentError,
  agentLabel,
} from '../lib/agents.js';
import { capableAgents } from '../lib/capabilities.js';
import type { AgentId } from '../lib/types.js';
import { cloneRepo } from '../lib/git.js';
import {
  discoverSkillsFromRepo,
  installSkillCentrally,
  uninstallSkill,
  listInstalledSkills,
  listInstalledSkillsWithScope,
  getSkillInfo,
  getSkillRules,
  getSkillsDir,
  countSkillFiles,
  tryParseSkillMetadata,
  diffVersionSkills,
  iterSkillsCapableVersions,
  removeSkillFromVersion,
  type SkillParseError,
  type VersionSkillDiff,
} from '../lib/plugins/skills.js';
import {
  listInstalledVersions,
  getGlobalDefault,
  syncResourcesToVersion,
  promptAgentVersionSelection,
  getVersionHomePath,
  resolveAgentVersionTargets,
} from '../lib/installations/versions.js';
import { recordVersionResources } from '../lib/state.js';
import {
  isPromptCancelled,
  isInteractiveTerminal,
  parseCommaSeparatedList,
  printWithPager,
  requireInteractiveSelection,
  resolveAgentTargetsAutoInstalling,
  promptRemovalTargets,
  type RemovalTarget,
  resolveListFilterOrExit,
} from './utils.js';
import {
  showResourceList,
  buildTargetsSection,
  type ResourceRow,
  type SyncTarget,
} from './resource-view.js';

/** Register the `agents skills` command tree (list, add, remove, sync, prune, view). */
export function registerSkillsCommands(program: Command): void {
  const skillsCmd = program
    .command('skills')
    .description('Add domain-specific capabilities to agents via packaged SKILL.md files')
    .addHelpText('after', `
Skills are structured bundles (SKILL.md + rules/) that teach agents specialized domains: API conventions, testing patterns, code review checklists. Each skill can ship with its own rules that only apply when the skill is invoked.

Examples:
  # See what skills are installed
  agents skills list

  # Check skills for a specific agent version
  agents skills list claude@2.1.112

  # Install a skill from GitHub
  agents skills add gh:anthropics/skills --agents codex,claude

  # Interactive: pick from ~/.agents/skills/
  agents skills add

  # Install a specific skill by name
  agents skills add --names api-testing --agents codex@0.116.0

When to use:
  - Onboarding: 'agents skills add gh:team/skills' to share expertise across the team
  - Specialization: install domain skills (rush-product-knowledge, rdev) per project
  - Version isolation: install different skills to different versions for experimentation
`);

  withAliases(skillsCmd
    .command('list [agent]'), 'list')
    .description('Show which skills are installed and which agent versions they are synced to')
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
          console.log(chalk.red(formatAgentError(parts[0], capableAgents('skills'))));
          process.exit(1);
        }
        filterAgent = resolved;
        filterVersion = resolveListFilterOrExit(resolved, parts[1]);
      }

      const rows = await buildSkillRows({ filterAgent, filterVersion });

      spinner.stop();

      await showResourceList({
        resourcePlural: 'skills',
        resourceSingular: 'skill',
        extraLabel: 'Files',
        rows,
        emptyMessage: filterAgent
          ? `No skills in central storage for ${agentLabel(filterAgent)}.`
          : 'No skills in ~/.agents/skills/. Add one with: agents skills add gh:user/repo',
        centralPath: getSkillsDir(),
        filterAgent,
        filterVersion,
        json: options.json,
      });
    });

  skillsCmd
    .command('add [source]')
    .description('Install skills from a source (GitHub, local) or pick from central storage')
    .option('-a, --agents <list>', 'Targets: claude, codex@0.116.0, or antigravity@default')
    .option('--names <list>', 'Skill names from ~/.agents/skills/ (comma-separated)')
    .option('-y, --yes', 'Skip all prompts')
    .addHelpText('after', `
Examples:
  # Interactive picker from ~/.agents/skills/
  agents skills add

  # Install a specific skill to one version
  agents skills add --names api-testing --agents codex@0.116.0

  # Clone and install skills from GitHub
  agents skills add gh:anthropics/skills --agents claude,codex

  # Add a local skill directory (must contain SKILL.md)
  agents skills add ~/my-skill --agents claude@default
`)
    .action(async (source: string | undefined, options) => {
      try {
        let skills: { name: string; path?: string; metadata: { description?: string }; ruleCount?: number }[];

        if (!source) {
          // Interactive mode: pick from central storage
          const installedSkills = listInstalledSkills();
          if (installedSkills.size === 0) {
            console.log(chalk.yellow('No skills in ~/.agents/skills/'));
            console.log(chalk.gray('\nTo add skills from a repo:'));
            console.log(chalk.cyan('  agents skills add gh:user/repo'));
            return;
          }

          const availableSkills = Array.from(installedSkills.keys());
          const requestedNames = parseCommaSeparatedList(options.names);
          let selectedNames: string[];

          if (requestedNames.length > 0) {
            const missing = requestedNames.filter((name) => !installedSkills.has(name));
            if (missing.length > 0) {
              console.log(chalk.red(`Unknown skill(s): ${missing.join(', ')}`));
              console.log(chalk.gray(`Available: ${availableSkills.join(', ')}`));
              process.exit(1);
            }
            selectedNames = requestedNames;
          } else {
            if (!isInteractiveTerminal()) {
              requireInteractiveSelection('Selecting skills from ~/.agents/skills/', [
                'agents skills add --names agents-cli --agents codex',
                'agents skills add gh:user/repo --agents codex',
              ]);
            }

            const choices = Array.from(installedSkills.entries()).map(([name, skill]) => ({
              value: name,
              name: skill.metadata.description
                ? `${name}  ${chalk.gray(skill.metadata.description.slice(0, 50))}`
                : name,
            }));

            const selected = await checkbox({
              message: 'Select skills to install',
              choices: [
                { value: '__all__', name: chalk.bold('Select All') },
                ...choices,
              ],
            });

            if (selected.length === 0) {
              console.log(chalk.gray('No skills selected.'));
              return;
            }

            selectedNames = selected.includes('__all__')
              ? availableSkills
              : selected.filter((s) => s !== '__all__');
          }

          skills = selectedNames.map((name) => {
            const skill = installedSkills.get(name);
            return { name, metadata: skill?.metadata || {} };
          });
        } else {
          // Source provided: fetch from repo or local path
          const spinner = ora('Fetching skills...').start();

          const isGitRepo = source.startsWith('gh:') || source.startsWith('git:') ||
                            source.startsWith('ssh:') || source.startsWith('https://') ||
                            source.startsWith('http://');

          let localPath: string;
          let discoveredSkills: ReturnType<typeof discoverSkillsFromRepo>;

          if (isGitRepo) {
            const result = await cloneRepo(source);
            localPath = result.localPath;
            discoveredSkills = discoverSkillsFromRepo(localPath);
            spinner.succeed('Repository cloned');
          } else {
            localPath = source.startsWith('~')
              ? path.join(os.homedir(), source.slice(1))
              : path.resolve(source);

            if (!fs.existsSync(localPath)) {
              spinner.fail(`Path not found: ${localPath}`);
              return;
            }

            const skillMdPath = path.join(localPath, 'SKILL.md');
            if (fs.existsSync(skillMdPath)) {
              const skillName = path.basename(localPath);
              const { validateSkillMetadata, countSkillRules } = await import('../lib/plugins/skills.js');
              const parseResult = tryParseSkillMetadata(localPath);
              const validation = validateSkillMetadata(parseResult.metadata, skillName);

              // Warn if YAML is invalid
              if (parseResult.error) {
                spinner.warn(`Skill '${skillName}' has invalid SKILL.md`);
                console.log(chalk.yellow(`  ${parseResult.error}`));
                console.log(chalk.gray('  The skill will be installed but may not appear in listings.\n'));
              } else {
                spinner.succeed('Using skill directory');
              }

              discoveredSkills = [{
                name: skillName,
                path: localPath,
                metadata: parseResult.metadata || { name: skillName, description: '' },
                ruleCount: countSkillRules(localPath),
                validation,
              }];
            } else {
              discoveredSkills = discoverSkillsFromRepo(localPath);
              spinner.succeed('Using local path');
            }
          }

          if (discoveredSkills.length === 0) {
            console.log(chalk.yellow('No skills found (looking for SKILL.md files)'));
            return;
          }

          // Filter by --names if provided. Mirrors the no-source path's behavior
          // so users can pluck specific skills from a multi-skill repo.
          const requestedNames = parseCommaSeparatedList(options.names);
          if (requestedNames.length > 0) {
            const discoveredNames = new Set(discoveredSkills.map((s) => s.name));
            const missing = requestedNames.filter((n) => !discoveredNames.has(n));
            if (missing.length > 0) {
              console.log(chalk.red(`\nSkill(s) not found in source: ${missing.join(', ')}`));
              console.log(chalk.gray(`Available: ${[...discoveredNames].join(', ')}`));
              process.exit(1);
            }
            discoveredSkills = discoveredSkills.filter((s) => requestedNames.includes(s.name));
          }

          console.log(chalk.bold(`\nFound ${discoveredSkills.length} skill(s):`));

          for (const skill of discoveredSkills) {
            const nameColor = skill.parseError ? chalk.yellow : chalk.cyan;
            console.log(`\n  ${nameColor(skill.name)}: ${skill.metadata.description || 'no description'}`);
            if (skill.ruleCount > 0) {
              console.log(`    ${chalk.gray(`${skill.ruleCount} rules`)}`);
            }
            if (skill.parseError) {
              console.log(`    ${chalk.yellow('Warning:')} ${chalk.gray(skill.parseError)}`);
            }
          }

          // Install to central storage first
          const installSpinner = ora('Installing skills to central storage...').start();
          let installed = 0;

          for (const skill of discoveredSkills) {
            const result = installSkillCentrally(skill.path, skill.name);
            if (result.success) {
              installed++;
            } else {
              installSpinner.stop();
              console.log(chalk.red(`\n  Failed to install ${skill.name}: ${result.error}`));
              installSpinner.start();
            }
          }

          installSpinner.succeed(`Installed ${installed} skills to ~/.agents/skills/`);
          skills = discoveredSkills;
        }

        // Get agent and version selection
        let selectedAgents: AgentId[];
        let versionSelections: Map<AgentId, string[]>;

        if (options.agents) {
          const result = await resolveAgentTargetsAutoInstalling(options.agents, capableAgents('skills'), { yes: options.yes });
          if (!result) {
            console.log(chalk.gray('Cancelled.'));
            return;
          }
          selectedAgents = result.selectedAgents;
          versionSelections = result.versionSelections;
        } else {
          const result = await promptAgentVersionSelection(capableAgents('skills'), {
            skipPrompts: options.yes,
          });
          selectedAgents = result.selectedAgents;
          versionSelections = result.versionSelections;
        }

        if (selectedAgents.length === 0) {
          console.log(chalk.yellow('\nNo agents selected.'));
          return;
        }

        // Sync to selected versions
        const syncSpinner = ora('Syncing to agent versions...').start();
        let synced = 0;
        const skillNames = skills.map((s) => s.name);

        for (const [agentId, versions] of versionSelections) {
          for (const version of versions) {
            syncResourcesToVersion(agentId, version);
            recordVersionResources(agentId, version, 'skills', skillNames);
            synced++;
          }
        }

        if (synced > 0) {
          syncSpinner.succeed(`Synced to ${synced} agent version(s)`);
        } else {
          syncSpinner.info('No version-managed agents to sync');
        }

        console.log(chalk.green('\nSkills installed.'));
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.gray('\nCancelled'));
          return;
        }
        console.error(chalk.red('Failed to add skills'));
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  withAliases(skillsCmd
    .command('remove [name]'), 'remove')
    .description('Delete a skill from central storage (interactive picker if no name given)')
    .addHelpText('after', `
Examples:
  # Remove a skill by name
  agents skills remove api-testing

  # Interactive: pick skills to remove
  agents skills remove
`)
    .action(async (name?: string) => {
      // Build map of skill -> targets for all installed versions
      type SkillTargetInfo = { name: string; targets: Array<{ agent: AgentId; version: string }> };
      const skillTargetMap = new Map<string, SkillTargetInfo>();

      for (const { agent, version } of iterSkillsCapableVersions()) {
        const home = getVersionHomePath(agent, version);
        const skills = listInstalledSkillsWithScope(agent, process.cwd(), { home });
        for (const skill of skills) {
          if (skill.scope !== 'user') continue;
          const existing = skillTargetMap.get(skill.name);
          if (existing) {
            existing.targets.push({ agent, version });
          } else {
            skillTargetMap.set(skill.name, { name: skill.name, targets: [{ agent, version }] });
          }
        }
      }

      let skillsToRemove: string[];

      if (name) {
        skillsToRemove = [name];
      } else {
        if (skillTargetMap.size === 0) {
          console.log(chalk.yellow('No skills installed in any version.'));
          return;
        }

        if (!isInteractiveTerminal()) {
          requireInteractiveSelection('Selecting skills to remove', [
            'agents skills remove agents-cli',
          ]);
        }

        try {
          const choices = Array.from(skillTargetMap.values()).map((skill) => {
            const agents = [...new Set(skill.targets.map((t) => AGENTS[t.agent].name))];
            return {
              value: skill.name,
              name: `${skill.name} (${agents.join(', ')})`,
            };
          });

          const selected = await checkbox({
            message: 'Select skills to remove',
            choices,
          });

          if (selected.length === 0) {
            console.log(chalk.gray('No skills selected.'));
            return;
          }

          skillsToRemove = selected;
        } catch (err) {
          if (isPromptCancelled(err)) {
            console.log(chalk.gray('Cancelled'));
            return;
          }
          throw err;
        }
      }

      let removed = 0;
      for (const skillName of skillsToRemove) {
        const skillInfo = skillTargetMap.get(skillName);
        if (!skillInfo || skillInfo.targets.length === 0) {
          console.log(chalk.yellow(`  Skill '${skillName}' not found in any version.`));
          continue;
        }

        const removalTargets: RemovalTarget[] = skillInfo.targets.map((t) => ({
          agent: t.agent,
          version: t.version,
          label: `${agentLabel(t.agent)}@${t.version}`,
        }));

        const selectedTargets = await promptRemovalTargets(skillName, removalTargets);

        if (selectedTargets.length === 0) {
          console.log(chalk.gray(`  Skipped '${skillName}'.`));
          continue;
        }

        for (const target of selectedTargets) {
          const result = removeSkillFromVersion(target.agent as AgentId, target.version, skillName);
          if (result.success) {
            console.log(`  ${chalk.red('-')} ${target.label}: ${skillName}`);
            removed++;
          } else if (result.error) {
            console.log(`  ${chalk.yellow('!')} ${target.label}: ${result.error}`);
          }
        }
      }

      if (removed === 0) {
        console.log(chalk.yellow('No skills removed.'));
      } else {
        console.log(chalk.green(`\nRemoved ${removed} skill(s) from version homes.`));
        console.log(chalk.gray("Central source unchanged. Restore any target with 'agents sync <agent>@<version> --yes'."));
      }
    });

  // `skills prune` moved to the top-level `agents prune cleanup` command.
  skillsCmd
    .command('prune', { hidden: true })
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      console.error(chalk.red('"agents skills prune" moved.'));
      console.error(chalk.gray('Use:  agents prune cleanup skills   (or `agents prune cleanup` for everything)'));
      process.exit(1);
    });

  withAliases(skillsCmd
    .command('view [name]'), 'view')
    .description('Read skill metadata (name, description, rules count)')
    .addHelpText('after', `
Examples:
  # View details for a specific skill
  agents skills view api-testing

  # Interactive picker
  agents skills view
`)
    .action(async (name?: string) => {
      // If no name provided, show interactive select
      if (!name) {
        const cwd = process.cwd();
        const allSkills: Array<{ name: string; description: string }> = [];
        const seenNames = new Set<string>();

        for (const agentId of capableAgents('skills')) {
          const skills = listInstalledSkillsWithScope(agentId, cwd);
          for (const skill of skills) {
            if (!seenNames.has(skill.name)) {
              seenNames.add(skill.name);
              allSkills.push({
                name: skill.name,
                description: skill.metadata.description || '',
              });
            }
          }
        }

        if (allSkills.length === 0) {
          console.log(chalk.yellow('No skills installed'));
          return;
        }

        if (!isInteractiveTerminal()) {
          requireInteractiveSelection('Selecting a skill to view', [
            'agents skills view agents-cli',
          ]);
        }

        try {
          name = await select({
            message: 'Select a skill to view',
            choices: allSkills.map((s) => {
              const maxDescLen = Math.max(0, 70 - s.name.length);
              const desc = s.description.length > maxDescLen
                ? s.description.slice(0, maxDescLen - 3) + '...'
                : s.description;
              return {
                value: s.name,
                name: desc ? `${s.name} - ${desc}` : s.name,
              };
            }),
          });
        } catch (err) {
          if (isPromptCancelled(err)) {
            console.log(chalk.gray('Cancelled'));
            return;
          }
          throw err;
        }
      }

      const skill = getSkillInfo(name);
      if (!skill) {
        console.log(chalk.yellow(`Skill '${name}' not found`));
        return;
      }

      // Build output
      const lines: string[] = [];
      lines.push(chalk.bold(`\n${skill.metadata.name}\n`));
      if (skill.metadata.description) {
        lines.push(`  ${skill.metadata.description}`);
      }
      lines.push('');
      if (skill.metadata.author) {
        lines.push(`  Author: ${skill.metadata.author}`);
      }
      if (skill.metadata.version) {
        lines.push(`  Version: ${skill.metadata.version}`);
      }
      if (skill.metadata.license) {
        lines.push(`  License: ${skill.metadata.license}`);
      }
      lines.push(`  Path: ${skill.path}`);

      const rules = getSkillRules(name);
      if (rules.length > 0) {
        lines.push(chalk.bold(`\n  Rules (${rules.length}):\n`));
        for (const rule of rules) {
          lines.push(`    ${chalk.cyan(rule)}`);
        }
      }
      lines.push('');

      const output = lines.join('\n');
      printWithPager(output, lines.length);
    });

}

/**
 * Build the row data for `agents skills list`. Each row = one central skill
 * with a sync-status target per (agent, version) in scope.
 */
async function buildSkillRows(opts: {
  filterAgent?: AgentId;
  filterVersion?: string;
}): Promise<ResourceRow[]> {
  const central = listInstalledSkills(); // Map<name, DiscoveredSkill>
  if (central.size === 0) return [];

  const targetPairs = iterSkillsCapableVersions({
    agent: opts.filterAgent,
    version: opts.filterVersion,
  });

  // Precompute per-(agent, version) diffs so we can look up each skill's
  // status without re-diffing 16 times per skill.
  const diffByTarget = new Map<string, VersionSkillDiff>();
  const defaultByAgent = new Map<AgentId, string | null>();
  for (const { agent, version } of targetPairs) {
    if (!defaultByAgent.has(agent)) defaultByAgent.set(agent, getGlobalDefault(agent));
    diffByTarget.set(`${agent}@${version}`, diffVersionSkills(agent, version));
  }

  const rows: ResourceRow[] = [];
  for (const [name, skill] of central) {
    const targets: SyncTarget[] = [];
    for (const { agent, version } of targetPairs) {
      const diff = diffByTarget.get(`${agent}@${version}`)!;
      let status: SyncTarget['status'];
      if (diff.matched.includes(name)) status = 'synced';
      else if (diff.toUpdate.includes(name)) status = 'stale';
      else status = 'missing';
      targets.push({
        agent,
        version,
        isDefault: defaultByAgent.get(agent) === version,
        status,
      });
    }

    const fileCount = countSkillFiles(skill.path);
    // Append repo source when a skill comes from a registered extra so users
    // can see which DotAgent repo owns it at a glance.
    const description = skill.source
      ? `${skill.metadata.description || ''}${skill.metadata.description ? ' ' : ''}${chalk.gray(`[${skill.source}]`)}`
      : skill.metadata.description;
    rows.push({
      name,
      description,
      extra: fileCount > 0 ? `${fileCount}` : '-',
      targets,
      buildDetail: () => formatSkillDetail(name, skill, targets, fileCount),
    });
  }

  // Sort: fully-synced first, then partial, then missing — stable by name within each tier.
  rows.sort((a, b) => {
    const aSynced = a.targets.filter((t) => t.status === 'synced').length;
    const bSynced = b.targets.filter((t) => t.status === 'synced').length;
    if (aSynced !== bSynced) return bSynced - aSynced;
    return a.name.localeCompare(b.name);
  });

  return rows;
}

function formatSkillDetail(
  name: string,
  skill: { metadata: { description?: string; author?: string; version?: string; license?: string }; ruleCount: number; path: string },
  targets: SyncTarget[],
  fileCount: number
): string {
  const lines: string[] = [];
  lines.push(chalk.bold.cyan(name));
  if (skill.metadata.description) {
    lines.push(chalk.gray(skill.metadata.description));
  }
  lines.push('');

  const meta: string[] = [];
  if (skill.metadata.author) meta.push(`author ${chalk.white(skill.metadata.author)}`);
  if (skill.metadata.version) meta.push(`v${chalk.white(skill.metadata.version)}`);
  if (skill.metadata.license) meta.push(`license ${chalk.white(skill.metadata.license)}`);
  meta.push(`${chalk.white(fileCount)} file${fileCount === 1 ? '' : 's'}`);
  if (skill.ruleCount > 0) {
    meta.push(`${chalk.white(skill.ruleCount)} rule${skill.ruleCount === 1 ? '' : 's'}`);
  }
  lines.push('  ' + meta.join(chalk.gray(' · ')));
  lines.push('  ' + chalk.gray(skill.path));

  const rules = getSkillRules(name);
  if (rules.length > 0) {
    lines.push('');
    lines.push(chalk.bold('  Rules'));
    lines.push('  ' + rules.map((r) => chalk.gray(r)).join(', '));
  }

  lines.push('');
  lines.push(chalk.bold('  Synced to'));
  lines.push(buildTargetsSection(targets));

  return lines.join('\n');
}
