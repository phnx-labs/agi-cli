import type { Command } from 'commander';
import { addHostOption } from '../lib/hosts/option.js';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import { select, confirm, checkbox } from '@inquirer/prompts';

import {
  AGENTS,
  MANAGED_AGENT_IDS,
  accountOrgBadge,
  getAccountEmail,
  getAccountInfo,
  agentLabel,
  warnAgentDeprecated,
  isAgentHardDeprecated,
  hardDeprecationError,
  isSelfUpdatingAgent,
} from '../lib/agents.js';
import type { AccountInfo } from '../lib/agents.js';
import type { UsageSnapshot } from '../lib/accounting/usage.js';
import {
  formatUsageSummary,
  getUsageInfoForIdentity,
  getUsageInfoByIdentity,
  getUsageLookupKey,
  isUsageHeadlessScopeError,
} from '../lib/accounting/usage.js';
import { resolveConfiguredModel, formatAgentIdentity } from '../lib/models.js';
import type { AgentId } from '../lib/types.js';
import { readManifest, writeManifest, createDefaultManifest } from '../lib/manifest.js';
import {
  installVersion,
  removeVersion,
  removeAllVersions,
  listInstalledVersions,
  isVersionInstalled,
  isLatestInstalled,
  isOldestInstalled,
  getGlobalDefault,
  setGlobalDefault,
  markVersionIsolated,
  setIsolatedDefault,
  isVersionIsolated,
  getVersionHomePath,
  getVersionDir,
  resolveManagedInstallation,
  ensureHarnessInstallation,
  MANAGED_INSTALLATION_LABEL,
  syncResourcesToVersion,
  parseAgentSpec,
  promptResourceSelection,
  promptNewResourceSelection,
  type AvailableResources,
  getAvailableResources,
  getActuallySyncedResources,
  getNewResources,
  getProjectOnlyResources,
  hasNewResources,
  printTrashFooter,
  type ResourceSelection,
} from '../lib/installations/versions.js';
import { supportsPinnedUpdate, updateInstallation } from '../lib/installations/index.js';
import { carryForwardSettings } from '../lib/settings-manifest.js';
import {
  createShim,
  createVersionedAlias,
  supportsIsolatedInstall,
  isIsolationProtected,
  CONFIG_ENV_ISOLATED_AGENTS,
  removeShim,
  shimExists,
  getShimsDir,
  getShimPath,
  getPathShadowingExecutable,
  isShimsInPath,
  getPathSetupInstructions,
  addShimsToPath,
  switchConfigSymlink,
  switchHomeFileSymlinks,
} from '../lib/installations/shims.js';
import { isInteractiveTerminal, isPromptCancelled, requireInteractiveSelection } from './utils.js';
import { redactSecrets } from '../lib/redact.js';
import { tryAutoPullSystemRepo } from '../lib/git.js';
import { getAgentsDir, getTrashVersionsDir } from '../lib/state.js';
import { setHelpSections } from '../lib/help.js';
import { updateSessionFilePaths } from '../lib/session/db.js';

export function planManagedAdd(input: { explicitPin: boolean; managedInstalled: boolean }): 'reuse' | 'pin' | 'install' {
  if (!input.managedInstalled) return 'install';
  return input.explicitPin ? 'pin' : 'reuse';
}

function fixSessionFilePaths(agent: AgentId, version: string, oldVersionDir: string): void {
  const trashAgentDir = path.join(getTrashVersionsDir(), agent, version);
  if (!fs.existsSync(trashAgentDir)) return;
  const stamps = fs.readdirSync(trashAgentDir).sort().reverse();
  if (stamps.length === 0) return;
  const trashPath = path.join(trashAgentDir, stamps[0]);
  updateSessionFilePaths(oldVersionDir, trashPath);
}

function formatAccountHint(
  info: AccountInfo,
  usage: UsageSnapshot | null,
  unverified = false,
  headless = false,
): string {
  const parts: string[] = [];
  if (info.email) {
    const badge = accountOrgBadge(info);
    parts.push(badge ? `${info.email} (${badge})` : info.email);
  }
  const usageSummary = formatUsageSummary(info.plan, usage, 3, {
    unverified: unverified && !headless,
    headless,
  });
  if (usageSummary) parts.push(usageSummary);
  if (parts.length === 0) return '';
  return chalk.gray(` [${parts.join(', ')}]`);
}

function buildAutomaticSelection(resources: AvailableResources): ResourceSelection {
  const selection: ResourceSelection = {};
  if (resources.commands.length > 0) selection.commands = resources.commands;
  if (resources.skills.length > 0) selection.skills = resources.skills;
  if (resources.hooks.length > 0) selection.hooks = resources.hooks;
  if (resources.memory.length > 0) selection.memory = resources.memory;
  if (resources.mcp.length > 0) selection.mcp = resources.mcp;
  if (resources.permissions.length > 0) selection.permissions = resources.permissions;
  if (resources.subagents.length > 0) selection.subagents = resources.subagents;
  if (resources.plugins.length > 0) selection.plugins = resources.plugins;
  return selection;
}

async function setDefaultVersion(
  agent: AgentId,
  installedVersion: string,
): Promise<void> {
  setGlobalDefault(agent, installedVersion);
  createShim(agent);
  createVersionedAlias(agent, installedVersion);
  const symlinkResult = await switchConfigSymlink(agent, installedVersion);
  if (symlinkResult.success) {
    console.log(chalk.green(isSelfUpdatingAgent(agent) ? '  Set as active config profile' : '  Set as default'));
    if (symlinkResult.backupPath) {
      console.log(chalk.gray(`  Backed up existing config to: ${symlinkResult.backupPath}`));
    }
  }
  switchHomeFileSymlinks(agent, installedVersion);
  warnIfShimShadowed(agent);
}

function warnIfShimShadowed(agent: AgentId): void {
  const shadowedBy = getPathShadowingExecutable(agent);
  if (!shadowedBy) {
    return;
  }

  console.log(chalk.yellow(`  Warning: ${AGENTS[agent].cliCommand} currently resolves to ${shadowedBy}`));
  console.log(chalk.gray(`  Managed shim: ${getShimPath(agent)}`));

  const result = addShimsToPath();
  if (!result.success) {
    console.log(chalk.gray(`  ${getPathSetupInstructions().split('\n').join('\n  ')}`));
    return;
  }
  if (result.alreadyPresent) {
    console.log(chalk.gray(`  Shim PATH entry already set — ${AGENTS[agent].cliCommand} is shadowed by another binary. Remove or reorder it so ${getShimPath(agent)} takes priority.`));
    return;
  }
  console.log(chalk.green(`  Added shim directory to ${result.location}.`));
  console.log(chalk.gray(`  ${result.reloadHint}`));
}

function finalizeIsolatedInstall(agent: AgentId, version: string): void {
  const agentConfig = AGENTS[agent];
  const label = agentLabel(agentConfig.id);

  createVersionedAlias(agent, version);
  markVersionIsolated(agent, version);

  console.log(chalk.green(`  Installed ${label}@${version} as an isolated copy.`));
  console.log(chalk.gray(`  Your existing ${agentConfig.configDir} and default ${label} are untouched.`));
  console.log(chalk.gray(`  Run it:     agents run ${agent}@${version} "your prompt"`));
  console.log(chalk.gray(`  It has its own config and login — sign in the first time you run it.`));
  console.log(chalk.gray(`  Remove it:  agents remove ${agent}@${version} --isolated`));
}

type VersionPruneVerb = 'prune' | 'remove';

async function versionPruneAction(
  specs: string[],
  options: { project?: boolean; isolated?: boolean },
  commandName: VersionPruneVerb,
): Promise<void> {
  const isProject = options.project;
  const isIsolated = options.isolated;
  const moved: Array<{ agent: AgentId; version: string }> = [];

  for (const spec of specs) {
    const parsed = parseAgentSpec(spec);
    if (!parsed) {
      console.log(chalk.red(`Invalid agent: ${spec}`));
      console.log(chalk.gray(`Format: <agent>[@version]. Available: ${MANAGED_AGENT_IDS.join(', ')}`));
      continue;
    }

    const { agent, version } = parsed;
    const agentConfig = AGENTS[agent];

    if (isIsolated && !supportsIsolatedInstall(agent)) {
      console.log(chalk.gray(`${agentLabel(agentConfig.id)} has no isolated installs (--isolated is not supported for it).`));
      continue;
    }

    const isLiteralLatestInstalled =
      version === 'latest' && spec.includes('@') && isVersionInstalled(agent, 'latest');

    if (!isLiteralLatestInstalled && (version === 'latest' || version === 'oldest' || !spec.includes('@'))) {
      const versions = listInstalledVersions(agent)
        .filter((v) => !isIsolated || isVersionIsolated(agent, v));
      if (versions.length === 0) {
        console.log(chalk.gray(isIsolated
          ? `No isolated ${agentLabel(agentConfig.id)} installs`
          : `No versions of ${agentLabel(agentConfig.id)} installed`));
        continue;
      }

      if (!isInteractiveTerminal()) {
        requireInteractiveSelection(`Selecting ${agentLabel(agentConfig.id)} versions to ${commandName}`, [
          `agents ${commandName} ${agent}@${versions[0]}`,
        ]);
      }

      const globalDefault = getGlobalDefault(agent);

      const sortedVersions = [...versions].sort((a, b) => {
        if (a === globalDefault) return -1;
        if (b === globalDefault) return 1;
        return 0;
      });

      try {
        const toRemove = await checkbox({
          message: `Select ${agentLabel(agentConfig.id)} versions to ${commandName}:`,
          choices: sortedVersions.map((v) => ({
            name: v === globalDefault ? `${v} ${chalk.green('(default)')}` : v,
            value: v,
            checked: false,
          })),
        });

        if (toRemove.length === 0) {
          console.log(chalk.gray('No versions selected'));
          continue;
        }

        for (const v of toRemove) {
          const versionDir = getVersionDir(agent, v);
          const removed = removeVersion(agent, v);
          if (!removed) {
            console.log(chalk.red(`Failed to move ${agentLabel(agentConfig.id)}@${v} to trash — a file may be locked by a running process. Close any active sessions and try again.`));
            continue;
          }
          fixSessionFilePaths(agent, v, versionDir);
          console.log(chalk.green(`Moved ${agentLabel(agentConfig.id)}@${v} to trash`));
          if (isIsolated) {
            console.log(chalk.gray(`  Your real ${agentConfig.configDir} and default ${agentLabel(agentConfig.id)} were untouched.`));
          }
          moved.push({ agent, version: v });
        }


        const remaining = listInstalledVersions(agent);
        if (remaining.length === 0) {
          removeShim(agent);
        }
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.gray('Cancelled'));
          continue;
        }
        throw err;
      }
    } else if (!isVersionInstalled(agent, version)) {
      console.log(chalk.gray(`${agentLabel(agentConfig.id)}@${version} not installed`));
    } else if (isIsolated && !isVersionIsolated(agent, version)) {
      console.log(chalk.yellow(`${agentLabel(agentConfig.id)}@${version} is not an isolated install; refusing to remove it under --isolated.`));
      console.log(chalk.gray(`  Drop --isolated to remove a normal version: agents ${commandName} ${agent}@${version}`));
    } else {
      const versionDir = getVersionDir(agent, version);
      const removed = removeVersion(agent, version);
      if (!removed) {
        console.log(chalk.red(`Failed to move ${agentLabel(agentConfig.id)}@${version} to trash — a file may be locked by a running process. Close any active sessions and try again.`));
        continue;
      }
      fixSessionFilePaths(agent, version, versionDir);
      console.log(chalk.green(`Moved ${agentLabel(agentConfig.id)}@${version} to trash`));
      if (isIsolated) {
        console.log(chalk.gray(`  Your real ${agentConfig.configDir} and default ${agentLabel(agentConfig.id)} were untouched.`));
      }
      moved.push({ agent, version });

      const remaining = listInstalledVersions(agent);
      if (remaining.length === 0) {
        removeShim(agent);
      }
    }

    if (isProject) {
      const projectManifestPath = path.join(process.cwd(), '.agents', 'agents.yaml');
      if (fs.existsSync(projectManifestPath)) {
        const manifest = readManifest(process.cwd());
        if (manifest?.agents?.[agent]) {
          delete manifest.agents[agent];
          writeManifest(process.cwd(), manifest);
          console.log(chalk.gray(`  Removed from .agents/agents.yaml`));
        }
      }
    }
  }

  printTrashFooter(moved);
}

function configureVersionPruneCommand(cmd: Command, commandName: VersionPruneVerb): void {
  const isAlias = commandName === 'remove';
  cmd
    .description(isAlias
      ? 'Alias for agents prune. Uninstalls agent CLI versions.'
      : 'Uninstall agent CLI versions. Moves version data to trash for recovery.')
    .option('-p, --project', 'Also clear the pinned version from .agents/agents.yaml in the current project')
    .option('--isolated', 'Only act on isolated installs (created with `agents add --isolated`). Refuses to remove a normal/default install and never touches your real ~/.<agent>.');

  setHelpSections(cmd, {
    examples: `
      # Prune a specific version
      agents ${commandName} claude@2.0.50

      # Pick interactively if you omit the version
      agents ${commandName} claude

      # Prune and also clear the project pin
      agents ${commandName} claude@2.0.50 --project

      # Cleanly remove an isolated copy, leaving your normal install alone
      agents ${commandName} claude@2.1.112 --isolated
    `,
    notes: `
      - Pruned version directories move to trash with their home/ data intact.
      - Session file paths are rewritten so session history remains readable.
      - Removing the default version unsets the default; run 'agents use' to pick a new one.
      - --isolated restricts the operation to isolated installs and refuses to remove a normal/default version, so your existing setup is never disturbed.
      - Reinstall any time with 'agents add'.
    `,
  });

  cmd.action((specs: string[], options) => versionPruneAction(specs, options, commandName));
}

export function registerVersionsCommands(program: Command): void {
  const addCmd = program
    .command('add <specs...>')
    .description('Download and install agent CLI versions. Enables subsidized API usage through managed binaries.')
    .option('-p, --project', 'Lock this version to the current project directory only, stored in project-root agents.yaml')
    .option('--isolated', 'Install a fully self-contained copy that never touches your existing ~/.<agent> or default. Launch it explicitly with `agents run <agent>@<version>`. Cannot be combined with --project.')
    .option('-y, --yes', 'Auto-accept defaults without prompting (useful for scripts and CI)');

  setHelpSections(addCmd, {
    examples: `
      # Install the one managed installation of an agent
      agents add claude

      # Pin that same installation to a specific release (same as 'agents update claude --to 2.1.112')
      agents add claude@2.1.112

      # Move it back to tracking the latest release
      agents add claude@latest

      # Install multiple agents at once
      agents add claude codex

      # Lock this project to the managed installation (won't affect global default)
      agents add claude --project

      # Install a clean, separate copy that leaves your existing setup alone
      agents add claude@2.1.112 --isolated
    `,
    notes: `
      - One managed installation per harness: bare 'agents add <harness>' installs it (as <harness>@main) or reuses the one already there.
      - '<harness>@<release>' pins that SAME installation — it is 'agents update <harness> --to <release>', not a second home. A second, separate copy requires --isolated.
      - Add another account with 'agents accounts add <harness> [name]'.
      - The first version you install becomes the default automatically.
      - 'add' does NOT change the default if a default already exists. Use 'agents use' to switch.
      - --isolated installs a self-contained copy: it never sets the default, never creates the bare '<agent>' shim, and never backs up or symlinks your real ~/.<agent>. Run it with 'agents run <agent>@<version>' and remove it with 'agents remove <agent>@<version> --isolated'. Mutually exclusive with --project.
    `,
  });

  addCmd.action(async (specs: string[], options) => {
      const isProject = options.project;
      const isIsolated = options.isolated;
      const skipPrompts = options.yes || !isInteractiveTerminal();

      if (isIsolated && isProject) {
        console.log(chalk.red('--isolated and --project cannot be combined.'));
        console.log(chalk.gray('An isolated copy is global-but-separate; a project pin selects a shared install for one directory.'));
        return;
      }

      for (const spec of specs) {
        const parsed = parseAgentSpec(spec);
        if (!parsed) {
          console.log(chalk.red(`Invalid agent: ${spec}`));
          console.log(chalk.gray(`Format: <agent>[@version]. Available: ${MANAGED_AGENT_IDS.join(', ')}`));
          continue;
        }

        const { agent, version } = parsed;
        const agentConfig = AGENTS[agent];

        if (isAgentHardDeprecated(agent)) {
          console.error(chalk.red(hardDeprecationError(agent)));
          process.exitCode = 1;
          continue;
        }

        warnAgentDeprecated(agent);

        if (!isIsolated && isIsolationProtected(agent)) {
          console.log(chalk.red(`${agentLabel(agentConfig.id)} is installed only as isolated copies.`));
          console.log(chalk.gray(`  A normal install would adopt ${agentConfig.configDir} and your ${agentConfig.cliCommand} launcher.`));
          console.log(chalk.gray(`  Keep the sandbox:  agents add ${agent}@${version ?? 'latest'} --isolated`));
          console.log(chalk.gray('  Or manage it normally by removing the isolated copies first:'));
          for (const v of listInstalledVersions(agent)) {
            console.log(chalk.gray(`    agents remove ${agent}@${v} --isolated`));
          }
          continue;
        }

        if (isIsolated && !supportsIsolatedInstall(agent)) {
          console.log(chalk.red(`${agentLabel(agentConfig.id)} does not support --isolated installs.`));
          console.log(chalk.gray(`  It has no config-directory env var, so it can only isolate by adopting ${agentConfig.configDir} — which --isolated deliberately avoids.`));
          console.log(chalk.gray(`  Supported with --isolated: ${CONFIG_ENV_ISOLATED_AGENTS.join(', ')}.`));
          continue;
        }

        if (!agentConfig.npmPackage && !agentConfig.installScript) {
          console.log(chalk.yellow(`${agentLabel(agentConfig.id)} has no npm package. Install manually.`));
          continue;
        }

        let installedAsVersion = version;
        const managed = isIsolated ? null : resolveManagedInstallation(agent);
        const namesManagedLabel = version === MANAGED_INSTALLATION_LABEL || (managed !== null && version === managed.label);
        const addPlan = planManagedAdd({ explicitPin: spec.includes('@') && !namesManagedLabel, managedInstalled: managed !== null });

        if (addPlan === 'pin' && managed) {
          if (version !== 'latest' && !supportsPinnedUpdate(agent)) {
            console.log(chalk.red(`${agentLabel(agentConfig.id)} is a single self-updating binary with no pinnable releases — drop the @${version}, or use @latest.`));
            process.exitCode = 1;
            continue;
          }
          console.log(chalk.gray(`${agentLabel(agentConfig.id)} has one managed installation (${agent}@${managed.label}, release ${managed.releaseVersion}); pinning it to ${version} — the same as 'agents update ${agent} --to ${version}'.`));
          console.log(chalk.gray(`  A second, separate copy is the expert path: agents add ${agent}@${version} --isolated`));
          try {
            const outcome = await updateInstallation(managed, {
              to: version,
              updatePolicy: version === 'latest' ? 'latest' : 'pinned',
              onProgress: (message) => console.log(chalk.gray(`  ${message}`)),
            });
            if (outcome.deferred) {
              console.log(chalk.yellow(`${agent}@${managed.label}: ${outcome.deferred} Still on release ${outcome.installation.releaseVersion}.`));
              continue;
            }
            console.log(outcome.unchanged
              ? chalk.gray(`${agent}@${managed.label} is already on release ${outcome.toRelease}.`)
              : chalk.green(`Pinned ${agent}@${managed.label}: release ${outcome.fromRelease} -> ${outcome.toRelease}`));
          } catch (err) {
            console.log(chalk.red(redactSecrets((err as Error).message)));
            process.exitCode = 1;
            continue;
          }
          installedAsVersion = managed.label;
        } else if (addPlan === 'reuse' && managed) {
          console.log(chalk.gray(`${agentLabel(agentConfig.id)} is already installed. Your account home is unchanged.`));
          console.log(chalk.gray(`  Accounts: agents view ${agent}. Update now: agents update ${agent}.`));
          installedAsVersion = managed.label;

          createShim(agent);
        } else if (isIsolated) {
          let alreadyInstalled = false;
          if (version === 'latest') {
            const latestCheck = await isLatestInstalled(agent);
            if (latestCheck.installed && latestCheck.version) {
              alreadyInstalled = true;
              installedAsVersion = latestCheck.version;
            }
          } else if (version === 'oldest') {
            const oldestCheck = await isOldestInstalled(agent);
            if (oldestCheck.installed && oldestCheck.version) {
              alreadyInstalled = true;
              installedAsVersion = oldestCheck.version;
            }
          } else {
            alreadyInstalled = isVersionInstalled(agent, version);
          }

          if (alreadyInstalled) {
            if (!isVersionIsolated(agent, installedAsVersion)) {
              console.log(chalk.yellow(`${agentLabel(agentConfig.id)}@${installedAsVersion} is already installed as a normal (default-eligible) version.`));
              console.log(chalk.gray(`  Remove it first (agents remove ${agent}@${installedAsVersion}) then re-add with --isolated, or pick a different version.`));
              continue;
            }
            finalizeIsolatedInstall(agent, installedAsVersion);
            continue;
          }

          const spinner = ora(`Installing ${agentLabel(agentConfig.id)}@${version}...`).start();
          const result = await installVersion(agent, version, (msg) => {
            spinner.text = msg;
          });
          if (!result.success) {
            spinner.fail(`Failed to install ${agentLabel(agentConfig.id)}@${version}`);
            console.error(chalk.gray(redactSecrets(result.error || 'Unknown error')));
            continue;
          }
          finalizeIsolatedInstall(agent, result.installedVersion || version);
          continue;
        } else {
          const installRelease = namesManagedLabel ? 'latest' : version;
          const spinner = ora(`Installing ${agentLabel(agentConfig.id)}@${installRelease}...`).start();

          let ensured;
          try {
            ensured = await ensureHarnessInstallation(agent, {
              release: installRelease,
              onProgress: (msg) => { spinner.text = msg; },
            });
          } catch (err) {
            spinner.fail(`Failed to install ${agentLabel(agentConfig.id)}@${installRelease}`);
            console.error(chalk.gray(redactSecrets((err as Error).message)));
            continue;
          }

          {
            const installedVersion = ensured.installation.label;
            const installedModel = resolveConfiguredModel(agentConfig.id, ensured.installation.releaseVersion)?.model;
            const installedIdentity = formatAgentIdentity(
              `${agentLabel(agentConfig.id)}@${installedVersion}`,
              installedModel ? chalk.yellow(installedModel) : null,
            );
            spinner.succeed(`Installed ${installedIdentity}`);

            installedAsVersion = installedVersion;

            if (!shimExists(agent)) {
              createShim(agent);
              console.log(chalk.gray(`  Created shim: ${getShimsDir()}/${agentConfig.cliCommand}`));
            }

            const carrySource = getGlobalDefault(agent);
            if (carrySource && carrySource !== installedVersion) {
              const carried = carryForwardSettings(
                agent,
                getVersionHomePath(agent, carrySource),
                getVersionHomePath(agent, installedVersion)
              );
              if (carried.applied.length > 0) {
                console.log(chalk.gray(`  Carried settings from ${agent}@${carrySource}: ${carried.applied.map(r => path.basename(r)).join(', ')}`));
              }
            }

            const available = getAvailableResources();
            const actuallySynced = getActuallySyncedResources(agent, installedVersion);
            const newResources = getNewResources(available, actuallySynced, getProjectOnlyResources());

            const hasAnySynced = actuallySynced.commands.length > 0 ||
              actuallySynced.skills.length > 0 ||
              actuallySynced.hooks.length > 0 ||
              actuallySynced.memory.length > 0 ||
              actuallySynced.mcp.length > 0 ||
              actuallySynced.permissions.length > 0 ||
              actuallySynced.plugins.length > 0;

            let selection: ResourceSelection | undefined;

            try {
              if (skipPrompts) {
                if (!hasAnySynced) {
                  selection = buildAutomaticSelection(available);
                } else if (hasNewResources(newResources, agent)) {
                  selection = buildAutomaticSelection(newResources);
                }
              } else if (!hasAnySynced) {
                const userSelection = await promptResourceSelection(agent);
                if (userSelection) {
                  selection = userSelection;
                }
              } else if (hasNewResources(newResources, agent, installedVersion)) {
                const userSelection = await promptNewResourceSelection(agent, newResources, installedVersion);
                if (userSelection) {
                  selection = userSelection;
                }
              }
            } catch (err) {
              if (isPromptCancelled(err)) {
                console.log(chalk.gray('Skipped resource selection'));
              } else {
                throw err;
              }
            }

            if (selection && Object.keys(selection).length > 0) {
              const syncResult = syncResourcesToVersion(agent, installedVersion, selection);
              const synced: string[] = [];
              if (syncResult.commands) synced.push('commands');
              if (syncResult.skills) synced.push('skills');
              if (syncResult.hooks) synced.push('hooks');
              if (syncResult.memory.length > 0) synced.push('memory');
              if (syncResult.permissions) synced.push('permissions');
              if (syncResult.mcp.length > 0) synced.push('mcp');
              if (syncResult.plugins.length > 0) synced.push('plugins');

              if (synced.length > 0) {
                console.log(chalk.green(`  Synced: ${synced.join(', ')}`));
              }
            }

            const currentDefault = getGlobalDefault(agent);
            if (currentDefault !== installedVersion) {
              if (!currentDefault) {
                await setDefaultVersion(agent, installedVersion);
              } else if (skipPrompts) {
                console.log(chalk.gray(`  Default remains ${agentLabel(agentConfig.id)}@${currentDefault}. Run 'agents use ${agent}@${installedVersion}' to switch.`));
              } else {
                try {
                  const home = getVersionHomePath(agent, installedVersion);
                  const info = await getAccountInfo(agent, home);
                  const usage = await getUsageInfoForIdentity({
                    agentId: agent,
                    home,
                    cliVersion: installedVersion,
                    info,
                  });
                  const headless = isUsageHeadlessScopeError(usage.error);
                  const accountHint = formatAccountHint(
                    info,
                    usage.snapshot,
                    !headless && !!usage.snapshot && !!usage.error,
                    headless,
                  );

                  const message = `Switch default from ${agentLabel(agentConfig.id)}@${currentDefault} to ${agentLabel(agentConfig.id)}@${installedVersion}${accountHint}?`;

                  const setAsDefault = await confirm({
                    message,
                    default: true,
                  });

                  if (setAsDefault) {
                    await setDefaultVersion(agent, installedVersion);
                  }
                } catch (err) {
                  if (isPromptCancelled(err)) {
                    console.log(chalk.gray('Skipped setting default'));
                  } else {
                    throw err;
                  }
                }
              }
            }

            if (!isShimsInPath()) {
              const pathResult = addShimsToPath();
              if (pathResult.success && !pathResult.alreadyPresent) {
                console.log(chalk.green(`  Added shims to ${pathResult.location}`));
                console.log(chalk.gray('  ' + pathResult.reloadHint));
              } else if (!pathResult.success) {
                console.log(chalk.yellow('\nCould not auto-add shims to PATH:'));
                console.log(chalk.gray(getPathSetupInstructions()));
              }
            }
          }
        }

        if (isProject) {
          const projectManifestDir = path.join(process.cwd(), '.agents');
          const projectManifestPath = path.join(projectManifestDir, 'agents.yaml');

          if (!fs.existsSync(projectManifestDir)) {
            fs.mkdirSync(projectManifestDir, { recursive: true });
          }

          const manifest = fs.existsSync(projectManifestPath)
            ? readManifest(process.cwd()) || createDefaultManifest()
            : createDefaultManifest();

          manifest.agents = manifest.agents || {};
          manifest.agents[agent] = installedAsVersion;

          writeManifest(process.cwd(), manifest);
          console.log(chalk.green(`  Pinned ${agentLabel(agentConfig.id)}@${installedAsVersion} in .agents/agents.yaml`));
        }
      }
    });

  configureVersionPruneCommand(program.command('prune <specs...>'), 'prune');
  configureVersionPruneCommand(
    program.command('remove <specs...>', { hidden: true }).aliases(['rm', 'purge']),
    'remove',
  );

  const useCmd = program
    .command('use <agent> [version]')
    .description('Switch the active version for an agent. This is the only command that sets the default.')
    .option('-p, --project', 'Pin to this project directory only (stored in .agents/agents.yaml)')
    .option('-y, --yes', 'Auto-sync resources without prompting');

  setHelpSections(useCmd, {
    examples: `
      # Set global default (interactive picker if version omitted)
      agents use claude
      agents use claude@2.1.112

      # Pin this project to a version (overrides the global default in this directory)
      agents use claude@2.1.100 --project

      # Switch accounts — each installed version has its own auth
      agents use claude@2.1.50
    `,
    notes: `
      - 'agents add' installs but does NOT set the default. Always follow with 'agents use'.
      - --project pins to the current directory only via .agents/agents.yaml.
    `,
  });

  useCmd.action(async (agentArg: string, versionArg: string | undefined, options) => {
      try {
        const skipPrompts = options.yes || !isInteractiveTerminal();
        const agentsDir = getAgentsDir();
        const pullResult = await tryAutoPullSystemRepo(agentsDir);
        if (pullResult.refused) {
          console.error(
            chalk.red(
              `Refusing to auto-sync ~/.agents/.system: its origin (${pullResult.actualRemote}) is not the expected system repo.`,
            ),
          );
          console.error(
            chalk.gray(
              'The system repo ships hooks that run on tool events; a fast-forward from an unexpected origin is not applied. ' +
                'Re-point it (git -C ~/.agents/.system remote set-url origin <expected>) or set AGENTS_SYSTEM_REPO, then re-run `agents setup --force`.',
            ),
          );
        } else if (pullResult.pulled) {
          console.log(chalk.gray('Synced ~/.agents/.system from remote'));
        }

        let agent: string;
        let version: string | undefined;

        if (agentArg.includes('@')) {
          const parsed = parseAgentSpec(agentArg);
          if (!parsed) {
            console.log(chalk.red(`Invalid agent: ${agentArg}`));
            console.log(chalk.gray(`Format: <agent>[@version]. Available: ${MANAGED_AGENT_IDS.join(', ')}`));
            return;
          }
          agent = parsed.agent;
          version = (parsed.version === 'latest' || parsed.version === 'oldest') ? undefined : parsed.version;
        } else {
          const agentLower = agentArg.toLowerCase();
          if (!AGENTS[agentLower as AgentId]) {
            console.log(chalk.red(`Invalid agent: ${agentArg}`));
            console.log(chalk.gray(`Available: ${MANAGED_AGENT_IDS.join(', ')}`));
            return;
          }
          agent = agentLower;
          version = versionArg;
        }

        const agentId = agent as AgentId;
        const agentConfig = AGENTS[agentId];

        let selectedVersion = version;

        if (!version) {
          const versions = listInstalledVersions(agentId).filter((v) => !isVersionIsolated(agentId, v));
          if (versions.length === 0) {
            console.log(chalk.red(`No versions of ${agentLabel(agentConfig.id)} installed`));
            console.log(chalk.gray(`Run: agents add ${agentId}@latest`));
            return;
          }

          if (!isInteractiveTerminal()) {
            requireInteractiveSelection(`Selecting a ${agentLabel(agentConfig.id)} version`, [
              `agents use ${agentId}@${versions[versions.length - 1]}`,
              `agents view ${agentId}`,
            ]);
          }

          const globalDefault = getGlobalDefault(agentId);

          const sortedVersions = [...versions].sort((a, b) => {
            if (a === globalDefault) return -1;
            if (b === globalDefault) return 1;
            return 0;
          });

          const pickerAccounts = await Promise.all(
            sortedVersions.map((v) =>
              getAccountInfo(agentId, getVersionHomePath(agentId, v)).then((info) => ({ v, info }))
            )
          );
          const pickerAccountMap = new Map(pickerAccounts.map(({ v, info }) => [v, info]));
          const { usageByKey } = await getUsageInfoByIdentity(
            pickerAccounts.map(({ v, info }) => ({
              agentId,
              home: getVersionHomePath(agentId, v),
              cliVersion: v,
              info,
            }))
          );

          const maxLabelLen = Math.max(...sortedVersions.map((v) => (v === globalDefault ? `${v} (default)` : v).length));
          const maxEmailLen = Math.max(0, ...pickerAccounts.map(({ info }) => info.email?.length || 0));
          selectedVersion = await select({
            message: `Select ${agentLabel(agentConfig.id)} version:`,
            choices: sortedVersions.map((v) => {
              let label = v === globalDefault ? `${v}${chalk.green(' (default)')}` : v;
              const padLen = maxLabelLen - (v === globalDefault ? `${v} (default)` : v).length;
              if (padLen > 0) label += ' '.repeat(padLen);
              const accountInfo = pickerAccountMap.get(v);
              const email = accountInfo?.email || '';
              const usageKey = getUsageLookupKey(accountInfo);
              const versionUsage = usageKey ? usageByKey.get(usageKey) : undefined;
              const headless = isUsageHeadlessScopeError(versionUsage?.error);
              const usageSummary = usageKey
                ? formatUsageSummary(null, versionUsage?.snapshot || null, 3, {
                    unverified: !headless && !!versionUsage?.snapshot && !!versionUsage.error,
                    headless,
                  })
                : '';

              if (maxEmailLen > 0) {
                label += '  ';
                label += email ? chalk.cyan(email.padEnd(maxEmailLen)) : ' '.repeat(maxEmailLen);
              }
              if (usageSummary) {
                label += `  ${usageSummary}`;
              }
              return { name: label, value: v };
            }),
          });
        }

        if (!selectedVersion || !isVersionInstalled(agentId, selectedVersion)) {
          console.log(chalk.red(`${agentLabel(agentConfig.id)}@${selectedVersion ?? 'unknown'} not installed`));
          console.log(chalk.gray(`Run: agents add ${agentId}@${selectedVersion ?? 'latest'}`));
          return;
        }

        const finalVersion = selectedVersion;

        if (isVersionIsolated(agentId, finalVersion)) {
          if (options.project) {
            console.log(chalk.yellow(`${agentLabel(agentConfig.id)}@${finalVersion} is an isolated install; --project pins are for shared versions.`));
            console.log(chalk.gray(`Run it directly instead: agents run ${agentId}@${finalVersion}`));
            return;
          }
          setIsolatedDefault(agentId, finalVersion);
          console.log(chalk.green(`Set ${agentLabel(agentConfig.id)}@${finalVersion} as your default ISOLATED copy.`));
          console.log(chalk.gray(`  agents run ${agentId}   now reaches it (no @version needed).`));
          const globalDefault = getGlobalDefault(agentId);
          if (globalDefault) {
            console.log(chalk.gray(`  Your default ${agentConfig.cliCommand} is still ${globalDefault}; ${agentConfig.configDir} is untouched.`));
          } else {
            console.log(chalk.gray(`  ${agentConfig.configDir} and your ${agentConfig.cliCommand} launcher are untouched.`));
          }
          return;
        }

        if (options.project) {
          const projectManifestDir = path.join(process.cwd(), '.agents');
          const projectManifestPath = path.join(projectManifestDir, 'agents.yaml');

          if (!fs.existsSync(projectManifestDir)) {
            fs.mkdirSync(projectManifestDir, { recursive: true });
          }

          const manifest = fs.existsSync(projectManifestPath)
            ? readManifest(process.cwd()) || createDefaultManifest()
            : createDefaultManifest();

          manifest.agents = manifest.agents || {};
          manifest.agents[agentId] = finalVersion;

          writeManifest(process.cwd(), manifest);
          const projEmail = await getAccountEmail(agentId, getVersionHomePath(agentId, finalVersion));
          const projModel = resolveConfiguredModel(agentId, finalVersion)?.model;
          const projIdentity = formatAgentIdentity(
            chalk.green(`${agentLabel(agentConfig.id)}@${finalVersion}`),
            projModel ? chalk.yellow(projModel) : null,
            projEmail ? chalk.cyan(projEmail) : null,
          );
          console.log(`Set ${projIdentity} for this project`);
        } else {
          const available = getAvailableResources();
          const actuallySynced = getActuallySyncedResources(agentId, finalVersion);
          const newResources = getNewResources(available, actuallySynced, getProjectOnlyResources());

          const hasAnySynced = actuallySynced.commands.length > 0 ||
            actuallySynced.skills.length > 0 ||
            actuallySynced.hooks.length > 0 ||
            actuallySynced.memory.length > 0 ||
            actuallySynced.mcp.length > 0 ||
            actuallySynced.permissions.length > 0;

          try {
            if (skipPrompts) {
              let selection: ResourceSelection | undefined;
              if (!hasAnySynced) {
                selection = buildAutomaticSelection(available);
              } else if (hasNewResources(newResources, agentId)) {
                selection = buildAutomaticSelection(newResources);
              }

              if (selection && Object.keys(selection).length > 0) {
                const syncResult = syncResourcesToVersion(agentId, finalVersion, selection);
                const syncedTypes: string[] = [];
                if (syncResult.commands) syncedTypes.push('commands');
                if (syncResult.skills) syncedTypes.push('skills');
                if (syncResult.hooks) syncedTypes.push('hooks');
                if (syncResult.memory.length > 0) syncedTypes.push('memory');
                if (syncResult.permissions) syncedTypes.push('permissions');
                if (syncResult.mcp.length > 0) syncedTypes.push('mcp');
                if (syncResult.plugins.length > 0) syncedTypes.push('plugins');

                if (syncedTypes.length > 0) {
                  console.log(chalk.green(`Synced: ${syncedTypes.join(', ')}`));
                }
              }
            } else if (!hasAnySynced) {
              console.log(chalk.yellow(`\n${agentLabel(agentConfig.id)}@${finalVersion} has no synced resources.`));
              const userSelection = await promptResourceSelection(agentId);
              if (userSelection && Object.keys(userSelection).length > 0) {
                const syncResult = syncResourcesToVersion(agentId, finalVersion, userSelection);
                const syncedTypes: string[] = [];
                if (syncResult.commands) syncedTypes.push('commands');
                if (syncResult.skills) syncedTypes.push('skills');
                if (syncResult.hooks) syncedTypes.push('hooks');
                if (syncResult.memory.length > 0) syncedTypes.push('memory');
                if (syncResult.permissions) syncedTypes.push('permissions');
                if (syncResult.mcp.length > 0) syncedTypes.push('mcp');
                if (syncResult.plugins.length > 0) syncedTypes.push('plugins');

                if (syncedTypes.length > 0) {
                  console.log(chalk.green(`Synced: ${syncedTypes.join(', ')}`));
                }
              }
            } else if (hasNewResources(newResources, agentId, finalVersion)) {
              const userSelection = await promptNewResourceSelection(agentId, newResources, finalVersion);
              if (userSelection && Object.keys(userSelection).length > 0) {
                const syncResult = syncResourcesToVersion(agentId, finalVersion, userSelection);
                const syncedTypes: string[] = [];
                if (syncResult.commands) syncedTypes.push('commands');
                if (syncResult.skills) syncedTypes.push('skills');
                if (syncResult.hooks) syncedTypes.push('hooks');
                if (syncResult.memory.length > 0) syncedTypes.push('memory');
                if (syncResult.permissions) syncedTypes.push('permissions');
                if (syncResult.mcp.length > 0) syncedTypes.push('mcp');
                if (syncResult.plugins.length > 0) syncedTypes.push('plugins');

                if (syncedTypes.length > 0) {
                  console.log(chalk.green(`Synced: ${syncedTypes.join(', ')}`));
                }
              }
            }
          } catch (err) {
            if (isPromptCancelled(err)) {
              console.log(chalk.gray('No changes made'));
              return;
            } else {
              throw err;
            }
          }

          const previousDefault = getGlobalDefault(agentId);

          if (previousDefault && previousDefault !== finalVersion) {
            const carried = carryForwardSettings(
              agentId,
              getVersionHomePath(agentId, previousDefault),
              getVersionHomePath(agentId, finalVersion)
            );
            if (carried.applied.length > 0) {
              console.log(chalk.gray(`Carried settings from ${agentId}@${previousDefault}: ${carried.applied.map(r => path.basename(r)).join(', ')}`));
              if (carried.backupDir) {
                console.log(chalk.gray(`  Pre-merge backup: ${carried.backupDir}`));
              }
            }
          }

          setGlobalDefault(agentId, finalVersion);

          createShim(agentId);
          createVersionedAlias(agentId, finalVersion);

          const symlinkResult = await switchConfigSymlink(agentId, finalVersion);
          if (!symlinkResult.success) {
            console.log(chalk.yellow(`Warning: Could not update config symlink: ${symlinkResult.error}`));
          } else if (symlinkResult.backupPath) {
            console.log(chalk.gray(`Backed up existing config to: ${symlinkResult.backupPath}`));
          }

          switchHomeFileSymlinks(agentId, finalVersion);
          warnIfShimShadowed(agentId);

          const useEmail = await getAccountEmail(agentId, getVersionHomePath(agentId, finalVersion));
          const useModel = resolveConfiguredModel(agentId, finalVersion)?.model;
          const useModelStr = useModel ? chalk.yellow(useModel) : null;
          const useAcctStr = useEmail ? chalk.cyan(useEmail) : null;
          if (isSelfUpdatingAgent(agentId)) {
            const identity = formatAgentIdentity(chalk.green(agentLabel(agentConfig.id)), useModelStr, useAcctStr);
            console.log(`Switched ${identity} to config profile ${chalk.green(finalVersion)}`);
          } else {
            const identity = formatAgentIdentity(chalk.green(`${agentLabel(agentConfig.id)}@${finalVersion}`), useModelStr, useAcctStr);
            console.log(`Set ${identity} as global default`);
          }
        }
      } catch (err) {
        if (isPromptCancelled(err)) return;
        throw err;
      }
    });

}
