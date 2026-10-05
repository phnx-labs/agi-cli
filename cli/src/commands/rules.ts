/** `agents rules`: list, add, view and remove markdown rule files (AGENTS.md, CLAUDE.md,
 * .cursorrules, ...) that guide agents across sessions. Central storage is `~/.agents/rules/`,
 * synced to version homes. */
import type { Command } from 'commander';
import { withAliases } from '../lib/verbs.js';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { select, checkbox } from '@inquirer/prompts';

import {
  AGENTS,
  agentConfigDirName,
  MANAGED_AGENT_IDS,
  resolveAgentName,
  formatAgentError,
  agentLabel,
} from '../lib/agents.js';
import { capableAgents } from '../lib/capabilities.js';
import type { AgentId } from '../lib/types.js';
import { cloneRepo } from '../lib/git.js';
import {
  discoverInstructionsFromRepo,
  discoverRuleFilesFromRepo,
  installInstructionsCentrally,
  uninstallInstructions,
  listInstalledInstructionsWithScope,
  instructionsExists,
  getInstructionsContent,
  listCentralRules,
} from '../lib/rules/rules.js';
import {
  listInstalledVersions,
  getGlobalDefault,
  resolveVersionAlias,
  syncResourcesToVersion,
  promptAgentVersionSelection,
  getVersionHomePath,
  resolveAgentVersionTargets,
} from '../lib/installations/versions.js';
import { recordVersionResources, getActiveRulesPreset, setActiveRulesPreset } from '../lib/state.js';
import { discoverRulesLayers } from '../lib/rules/compose.js';
import * as yaml from 'yaml';
import {
  isPromptCancelled,
  formatPath,
  isInteractiveTerminal,
  parseCommaSeparatedList,
  printWithPager,
  requireInteractiveSelection,
  requireDestructiveArg,
  resolveAgentTargetsAutoInstalling,
  resolveListFilterOrExit,
} from './utils.js';

/** Register the `agents rules` command tree (list, add, view, remove). */
export function registerRulesCommands(program: Command): void {
  const rulesCmd = program
    .command('rules')
    .description('Control agent behavior by installing persistent instructions and rules')
    .addHelpText('after', `
Rules are markdown files (AGENTS.md, CLAUDE.md, .cursorrules) that define how an agent operates. They persist across sessions and guide the agent's approach to tasks.

Examples:
  # List all rule files across agents
  agents rules list

  # Check rules for a specific agent and version
  agents rules list claude@2.1.112

  # Install rules from your .agents repo to multiple agents
  agents rules add --agents claude,codex,cursor

  # Install a shared rule file from GitHub
  agents rules add gh:anthropics/agent-rules --agents codex@0.116.0

  # View the content of your claude rules
  agents rules view claude --scope user

When to use:
  - New agent install: sync your standard rules with 'agents rules add --agents claude'
  - Team onboarding: share rules via 'agents rules add gh:team/standards'
  - Project setup: add project-specific rules with '--scope project'
  - Version testing: install different rule sets per version to A/B test approaches

Project rules & @-imports:
  Project rules live in <repo>/.agents/rules/. On every agent launch, the shim compiles
  them into <repo>/AGENTS.md (with CLAUDE.md and .cursorrules symlinked to it).
  A hand-authored AGENTS.md is preserved — the compile pipeline only overwrites files
  it owns (those starting with the auto-compile header). Delete the file to migrate.

  @path imports inside AGENTS.md/CLAUDE.md are resolved at session start by the agent
  itself, not by agents-cli. Support is per-agent:
    Inlined natively:  claude
    Literal text:      codex, cursor, opencode, copilot, amp, goose

  For rules that need to work across all agents, inline the content rather than using
  @-imports — the second group will load '@path/to/file.md' as a literal string.
`);

  withAliases(rulesCmd
    .command('list [agent]'), 'list')
    .description('Show which rule files are installed. Pass agent@version to see a specific version.')
    .option('-a, --agent <agent>', 'Filter to a specific agent (alternative to positional arg)')
    .action(async (agentArg, options) => {
      const cwd = process.cwd();

      const agentInput = agentArg || options.agent;
      let agentId: AgentId | null = null;
      let requestedVersion: string | null = null;

      if (agentInput) {
        const parts = agentInput.split('@');
        const agentName = parts[0];

        agentId = resolveAgentName(agentName);
        if (!agentId) {
          console.log(chalk.red(formatAgentError(agentName)));
          process.exit(1);
        }
        requestedVersion = resolveListFilterOrExit(agentId, parts[1]) ?? null;
      }

      const renderVersionRules = (
        agentId: AgentId,
        version: string,
        isDefault: boolean,
        home: string
      ) => {
        const agent = AGENTS[agentId];
        const installed = listInstalledInstructionsWithScope(agentId, cwd, { home });
        const userInstr = installed.find((i) => i.scope === 'user');
        const projectInstr = installed.find((i) => i.scope === 'project');

        const hasUser = userInstr?.exists;
        const hasProject = projectInstr?.exists;

        const defaultLabel = isDefault ? ' default' : '';
        const versionStr = chalk.gray(` (${version}${defaultLabel})`);

        console.log(`  ${chalk.bold(agentLabel(agent.id))}${versionStr}:`);

        if (hasUser) {
          console.log(`    ${chalk.gray('User:')}`);
          console.log(`      ${chalk.cyan(agent.instructionsFile.padEnd(20))} ${chalk.gray(formatPath(userInstr.path, cwd))}`);
        } else {
          console.log(`    ${chalk.gray('User:')} ${chalk.gray('none')}`);
        }

        if (hasProject) {
          console.log(`    ${chalk.gray('Project:')}`);
          console.log(`      ${chalk.yellow(agent.instructionsFile.padEnd(20))} ${chalk.gray(formatPath(projectInstr.path, cwd))}`);
        } else {
          console.log(`    ${chalk.gray('Project:')} ${chalk.gray('none')}`);
        }
        console.log();
      };

      if (agentId) {
        const agent = AGENTS[agentId];
        console.log(chalk.bold(`Installed Rules for ${agentLabel(agent.id)}\n`));
        const installedVersions = listInstalledVersions(agentId);
        const defaultVer = getGlobalDefault(agentId);

        if (installedVersions.length === 0) {
          const installed = listInstalledInstructionsWithScope(agentId, cwd);
          const userInstr = installed.find((i) => i.scope === 'user');
          const projectInstr = installed.find((i) => i.scope === 'project');
          const hasUser = userInstr?.exists;
          const hasProject = projectInstr?.exists;

          console.log(`  ${chalk.bold(agentLabel(agent.id))}:`);
          if (hasUser) {
            console.log(`    ${chalk.gray('User:')}`);
            console.log(`      ${chalk.cyan(agent.instructionsFile.padEnd(20))} ${chalk.gray(formatPath(userInstr.path, cwd))}`);
          } else {
            console.log(`    ${chalk.gray('User:')} ${chalk.gray('none')}`);
          }
          if (hasProject) {
            console.log(`    ${chalk.gray('Project:')}`);
            console.log(`      ${chalk.yellow(agent.instructionsFile.padEnd(20))} ${chalk.gray(formatPath(projectInstr.path, cwd))}`);
          } else {
            console.log(`    ${chalk.gray('Project:')} ${chalk.gray('none')}`);
          }
          return;
        }

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
          renderVersionRules(agentId, version, version === defaultVer, home);
        }
        return;
      }

      console.log(chalk.bold('Installed Rules\n'));
      for (const aid of MANAGED_AGENT_IDS) {
        const agent = AGENTS[aid];
        const installedVersions = listInstalledVersions(aid);
        const defaultVer = getGlobalDefault(aid);

        if (installedVersions.length > 0 && defaultVer) {
          const home = getVersionHomePath(aid, defaultVer);
          renderVersionRules(aid, defaultVer, true, home);
        } else {
          const installed = listInstalledInstructionsWithScope(aid, cwd);
          const userInstr = installed.find((i) => i.scope === 'user');
          const projectInstr = installed.find((i) => i.scope === 'project');
          const hasUser = userInstr?.exists;
          const hasProject = projectInstr?.exists;

          // Skip agents with nothing to show
          if (!hasUser && !hasProject) continue;

          console.log(`  ${chalk.bold(agentLabel(aid))}:`);
          if (hasUser) {
            console.log(`    ${chalk.gray('User:')}`);
            console.log(`      ${chalk.cyan(agent.instructionsFile.padEnd(20))} ${chalk.gray(formatPath(userInstr.path, cwd))}`);
          } else {
            console.log(`    ${chalk.gray('User:')} ${chalk.gray('none')}`);
          }
          if (hasProject) {
            console.log(`    ${chalk.gray('Project:')}`);
            console.log(`      ${chalk.yellow(agent.instructionsFile.padEnd(20))} ${chalk.gray(formatPath(projectInstr.path, cwd))}`);
          } else {
            console.log(`    ${chalk.gray('Project:')} ${chalk.gray('none')}`);
          }
          console.log();
        }
      }
    });

  rulesCmd
    .command('add [source]')
    .description('Install rule files from a source (GitHub, local path) or pick from central storage')
    .option('-a, --agents <list>', 'Targets: claude, codex@0.116.0, or cursor@default')
    .option('--names <list>', 'Rule file names from ~/.agents/rules/ (comma-separated)')
    .option('-y, --yes', 'Skip all prompts and use defaults')
    .addHelpText('after', `
Examples:
  # Interactive: pick from ~/.agents/rules/ and select agents
  agents rules add

  # Install AGENTS.md to codex version 0.116.0
  agents rules add --names AGENTS.md --agents codex@0.116.0

  # Install all rules from a GitHub repo to multiple agents
  agents rules add gh:team/agent-rules --agents claude,codex

  # Sync a local rules directory to your active agents
  agents rules add ~/projects/my-rules --agents claude@default
`)
    .action(async (source: string | undefined, options) => {
      try {
        let ruleNames: string[];

        if (!source) {
          const centralRules = listCentralRules();
          if (centralRules.length === 0) {
            console.log(chalk.yellow('No rule files in ~/.agents/rules/'));
            console.log(chalk.gray('\nTo add rule files from a repo:'));
            console.log(chalk.cyan('  agents rules add gh:user/repo'));
            return;
          }

          const requestedNames = parseCommaSeparatedList(options.names);
          if (requestedNames.length > 0) {
            const missing = requestedNames.filter((name) => !centralRules.includes(name));
            if (missing.length > 0) {
              console.log(chalk.red(`Unknown rule file(s): ${missing.join(', ')}`));
              console.log(chalk.gray(`Available: ${centralRules.join(', ')}`));
              process.exit(1);
            }
            ruleNames = requestedNames;
          } else {
            if (!isInteractiveTerminal()) {
              requireInteractiveSelection('Selecting rule files from ~/.agents/rules/', [
                'agents rules add --names AGENTS.md --agents codex',
                'agents rules add gh:team/rules --agents codex',
              ]);
            }

            const choices = centralRules.map((name) => ({
              value: name,
              name,
            }));

            const selected = await checkbox({
              message: 'Select rule files to install',
              choices: [
                { value: '__all__', name: chalk.bold('Select All') },
                ...choices,
              ],
            });

            if (selected.length === 0) {
              console.log(chalk.gray('No rule files selected.'));
              return;
            }

            ruleNames = selected.includes('__all__')
              ? centralRules
              : selected.filter((s) => s !== '__all__');
          }
        } else {
          const spinner = ora('Fetching rule files...').start();

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

          const agentInstructions = discoverInstructionsFromRepo(localPath);
          const ruleFiles = discoverRuleFilesFromRepo(localPath);

          const totalFiles = agentInstructions.length + ruleFiles.length;
          console.log(chalk.bold(`\nFound ${totalFiles} rule file(s):`));

          if (totalFiles === 0) {
            console.log(chalk.yellow('No rule files found'));
            return;
          }

          for (const instr of agentInstructions) {
            console.log(`  ${chalk.cyan(AGENTS[instr.agentId].instructionsFile)} (${agentLabel(instr.agentId)})`);
          }
          for (const file of ruleFiles) {
            console.log(`  ${chalk.cyan(file)} (shared)`);
          }

          const installSpinner = ora('Installing rule files to central storage...').start();
          const centralResult = installInstructionsCentrally(localPath);

          if (centralResult.errors.length > 0) {
            installSpinner.stop();
            for (const error of centralResult.errors) {
              console.log(chalk.yellow(`\n  Warning: ${error}`));
            }
            installSpinner.start();
          }

          installSpinner.succeed(`Installed ${centralResult.installed.length} rule file(s) to ~/.agents/rules/`);
          ruleNames = centralResult.installed
            .filter((p) => path.dirname(p) === '.')
            .map((p) => path.basename(p));
        }

        let selectedAgents: AgentId[];
        let versionSelections: Map<AgentId, string[]>;

        if (options.agents) {
          const result = await resolveAgentTargetsAutoInstalling(options.agents, capableAgents('rules'), { yes: options.yes });
          if (!result) {
            console.log(chalk.gray('Cancelled.'));
            return;
          }
          selectedAgents = result.selectedAgents;
          versionSelections = result.versionSelections;
        } else {
          const result = await promptAgentVersionSelection(capableAgents('rules'), {
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
            recordVersionResources(agentId, version, 'memory', ruleNames);
            synced++;
          }
        }

        if (synced > 0) {
          syncSpinner.succeed(`Synced to ${synced} agent version(s)`);
        } else {
          syncSpinner.info('No version-managed agents to sync');
        }

        console.log(chalk.green('\nRule files installed.'));
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.gray('\nCancelled'));
          return;
        }
        console.error(chalk.red('Failed to add rule files'));
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  withAliases(rulesCmd
    .command('view [agent]'), 'view')
    .description('Read the full content of a rule file with markdown rendering')
    .option('-s, --scope <scope>', 'user (global) or project (repo-specific)', 'user')
    .addHelpText('after', `
Examples:
  # Read the user-level rules for claude
  agents rules view claude

  # Check project-specific rules for codex
  agents rules view codex --scope project

  # View rules for a specific installed version
  agents rules view codex@0.116.0
`)
    .action(async (agentArg?: string, options?: { scope?: string }) => {
      const cwd = process.cwd();
      let agentId: AgentId | undefined;
      let requestedVersion: string | null = null;

      if (agentArg) {
        const parts = agentArg.split('@');
        const agentName = parts[0];

        agentId = resolveAgentName(agentName) || undefined;
        if (!agentId) {
          console.log(chalk.red(formatAgentError(agentName)));
          process.exit(1);
        }
        requestedVersion = resolveVersionAlias(agentId, parts[1]) ?? null;
      } else {
        const choices = MANAGED_AGENT_IDS.filter((id) => instructionsExists(id, 'user', cwd) || instructionsExists(id, 'project', cwd));
        if (choices.length === 0) {
          console.log(chalk.yellow('No rule files found.'));
          return;
        }
        if (!isInteractiveTerminal()) {
          requireInteractiveSelection('Selecting an agent rule file to view', [
            'agents rules view claude',
            'agents rules view codex@0.113.0 --scope user',
          ]);
        }
        agentId = await select({
          message: 'Select agent:',
          choices: choices.map((id) => ({ name: agentLabel(id), value: id })),
        });
      }

      const scope = (options?.scope || 'user') as 'user' | 'project';

      const displayContent = async (content: string, title: string, filePath: string) => {
        const { renderMarkdown } = await import('../lib/markdown.js');

        console.log(chalk.bold(`\n${title}`));
        console.log(chalk.gray(`Path: ${filePath}\n`));

        const rendered = renderMarkdown(content);
        const contentLines = content.split('\n');
        printWithPager(rendered, contentLines.length);
      };

      if (requestedVersion && scope === 'user') {
        const installedVersions = listInstalledVersions(agentId);
        if (!installedVersions.includes(requestedVersion)) {
          console.log(chalk.red(`Version ${requestedVersion} not installed for ${agentLabel(agentId)}`));
          console.log(chalk.gray(`Installed versions: ${installedVersions.join(', ') || 'none'}`));
          return;
        }
        const home = getVersionHomePath(agentId, requestedVersion);
        const filePath = path.join(home, agentConfigDirName(agentId), AGENTS[agentId].instructionsFile);
        if (!fs.existsSync(filePath)) {
          console.log(chalk.yellow(`No user rules found for ${agentLabel(agentId)}@${requestedVersion}`));
          return;
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        await displayContent(content, `${agentLabel(agentId)}@${requestedVersion} Rules (${scope})`, filePath);
        return;
      }

      const content = getInstructionsContent(agentId, scope, cwd);

      if (!content) {
        console.log(chalk.yellow(`No ${scope} rules found for ${agentLabel(agentId)}`));
        return;
      }

      const installed = listInstalledInstructionsWithScope(agentId, cwd);
      const instr = installed.find((i) => i.scope === scope);
      const filePath = instr?.path || '';

      await displayContent(content, `${agentLabel(agentId)} Rules (${scope})`, filePath);
    });

  withAliases(rulesCmd
    .command('remove [agent]'), 'remove')
    .description('Delete user-level rule files for an agent or version')
    .addHelpText('after', `
Examples:
  # Remove user rules for claude (all versions)
  agents rules remove claude

  # Remove rules only from a specific version
  agents rules remove codex@0.116.0
`)
    .action((agentArg: string | undefined) => {
      if (!agentArg) {
        // Only list agents that actually have a rules file installed — avoids
        // suggesting agents the user hasn't touched.
        const candidates = MANAGED_AGENT_IDS.filter((id) => instructionsExists(id));
        requireDestructiveArg({
          argName: 'agent',
          command: 'agents rules remove',
          itemNoun: 'agent',
          available: candidates,
          emptyHint: 'No rule files installed for any agent.',
        });
      }
      const parts = agentArg.split('@');
      const agentName = parts[0];

      const agentId = resolveAgentName(agentName);
      if (!agentId) {
        console.log(chalk.red(formatAgentError(agentName)));
        process.exit(1);
      }
      const requestedVersion = resolveVersionAlias(agentId, parts[1]) ?? null;

      if (requestedVersion) {
        const installedVersions = listInstalledVersions(agentId);
        if (!installedVersions.includes(requestedVersion)) {
          console.log(chalk.red(`Version ${requestedVersion} not installed for ${agentLabel(agentId)}`));
          console.log(chalk.gray(`Installed versions: ${installedVersions.join(', ') || 'none'}`));
          process.exit(1);
        }
        const home = getVersionHomePath(agentId, requestedVersion);
        const agent = AGENTS[agentId];
        const filePath = path.join(home, agentConfigDirName(agentId), agent.instructionsFile);

        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log(chalk.green(`Removed ${agent.instructionsFile} from ${agentLabel(agent.id)}@${requestedVersion}`));
        } else {
          console.log(chalk.yellow(`No rule file found for ${agentLabel(agent.id)}@${requestedVersion}`));
        }
        return;
      }

      const result = uninstallInstructions(agentId);
      if (result) {
        console.log(chalk.green(`Removed ${AGENTS[agentId].instructionsFile}`));
      } else {
        console.log(chalk.yellow(`No rule file found for ${agentLabel(agentId)}`));
      }
    });

  rulesCmd
    .command('switch <target>')
    .description('Choose the active rule preset for an agent version (persists in agents.yaml)')
    .option('-p, --preset <name>', 'Preset to activate; omit for an interactive picker')
    .addHelpText('after', `
Targets are <agent>@<version>. Use 'default' for the alias of the global default version.

This re-syncs the version home immediately, AND the choice sticks: every later
'agents run' for this agent+version re-applies the active preset before launch
(skip-fast when nothing changed), so a preset set here never goes stale even if
something changes it again without running 'switch' — you don't need to re-run
'switch' or 'sync' by hand before the next launch.

Examples:
  # Persist the cautious preset for claude 2.1.111
  agents rules switch claude@2.1.111 --preset cautious

  # Reset back to the literal default preset
  agents rules switch claude@default --preset default

  # Pick interactively
  agents rules switch codex@0.116.0
`)
    .action(async (target: string, options: { preset?: string }) => {
      try {
        const [rawAgent, rawVersion] = target.split('@');
        const agentId = resolveAgentName(rawAgent);
        if (!agentId) {
          console.log(chalk.red(formatAgentError(rawAgent)));
          process.exit(1);
        }
        const version = resolveVersionAlias(agentId, rawVersion);
        if (!version) {
          console.log(chalk.red(`Pass a version: ${agentId}@<version>. Try 'default' or 'agents view ${agentId}'.`));
          process.exit(1);
        }
        const installed = listInstalledVersions(agentId);
        if (!installed.includes(version)) {
          console.log(chalk.red(`Version ${version} not installed for ${agentLabel(agentId)}.`));
          console.log(chalk.gray(`Installed: ${installed.join(', ') || 'none'}`));
          process.exit(1);
        }

        // Discover available presets across layers (highest-priority defines, lowers union in).
        const layers = discoverRulesLayers();
        const presetSet = new Set<string>();
        for (const layer of layers) {
          const yamlPath = path.join(layer.rulesDir, 'rules.yaml');
          if (!fs.existsSync(yamlPath)) continue;
          try {
            const parsed = yaml.parse(fs.readFileSync(yamlPath, 'utf-8')) as { presets?: Record<string, unknown> } | null;
            for (const name of Object.keys(parsed?.presets || {})) presetSet.add(name);
          } catch { /* malformed yaml — skip */ }
        }
        const presets = Array.from(presetSet).sort();
        if (presets.length === 0) {
          console.log(chalk.red('No presets found. Define presets in ~/.agents/.system/rules/rules.yaml or ~/.agents/rules/rules.yaml.'));
          process.exit(1);
        }

        let chosen = options.preset;
        if (chosen) {
          if (!presets.includes(chosen)) {
            console.log(chalk.red(`Unknown preset: ${chosen}`));
            console.log(chalk.gray(`Available: ${presets.join(', ')}`));
            process.exit(1);
          }
        } else {
          if (!isInteractiveTerminal()) {
            requireInteractiveSelection('Selecting a rule preset', [
              `agents rules switch ${agentId}@${version} --preset default`,
              `agents rules switch ${agentId}@${version} --preset cautious`,
            ]);
          }
          const current = getActiveRulesPreset(agentId, version);
          chosen = await select({
            message: `Active rule preset for ${agentLabel(agentId)}@${version}`,
            default: current,
            choices: presets.map((p) => ({ name: p === current ? `${p} (current)` : p, value: p })),
          });
        }

        setActiveRulesPreset(agentId, version, chosen);
        const spinner = ora(`Re-syncing ${agentLabel(agentId)}@${version} with preset '${chosen}'`).start();
        const result = syncResourcesToVersion(agentId, version);
        spinner.succeed(`Switched ${agentLabel(agentId)}@${version} to '${chosen}'`);
        if (result.memory.length > 0) {
          console.log(chalk.gray(`  Wrote ${result.memory[0]} from preset '${chosen}'.`));
        }
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.gray('\nCancelled'));
          return;
        }
        console.error(chalk.red(`Failed to switch preset: ${(err as Error).message}`));
        process.exit(1);
      }
    });

}
